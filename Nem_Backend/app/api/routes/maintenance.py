# Maintenance records and schedules
import logging
from datetime import date, datetime, time, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql import Executable

from pydantic import ValidationError

from app.services.rule_maintenance import cancel_unavailable, ensure_startable
from app.core.config import get_settings
from app.db.session import get_db
from app.api.routes.auth import get_current_user, require_roles
from app.models import (
    Alert,
    Asset,
    InstructionDocument,
    InstructionDocumentFile,
    MaintenanceRecord,
    MaintenanceSchedule,
    MonitoringEvent,
    User,
    Variable,
)
from app.schemas.maintenance import (
    MaintenanceCompletion,
    MaintenanceCreate,
    MaintenanceRead,
    MaintenanceScheduleConfirm,
    MaintenanceScheduleCreate,
    MaintenanceScheduleRead,
    UnavailableScheduleCancellation,
    MaintenanceScheduleUpdate,
    MaintenanceUpdate,
)
from app.services.access_scope import access_scope
from app.services.maintenance_schedule import due_status, next_due_date
from app.services.live_updates import record_bulk_change
from app.services.monitoring_engine import emit_event, utc_now

router = APIRouter(prefix="/maintenance", tags=["maintenance"])
logger = logging.getLogger(__name__)


def _flush_deletion(session: Session, detail: str) -> None:
    try:
        session.flush()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409, detail=detail) from error

# Performs the actual transaction commit.
def _commit_deletion(session: Session, detail: str) -> None:
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409, detail=detail) from error


def _execute_deletion(
    session: Session,
    statement: Executable,
    detail: str,
) -> None:
    try:
        session.execute(statement)
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409, detail=detail) from error


#Find a maintenance schedule by its db ID
def _schedule_or_404(session: Session, schedule_id: int) -> MaintenanceSchedule:
    schedule = session.get(MaintenanceSchedule, schedule_id)
    return _schedule_in_scope(session, schedule, schedule_id)


# A schedule or record on an asset outside the caller's scope is reported as not found.
def _schedule_in_scope(
    session: Session,
    schedule: MaintenanceSchedule | None,
    schedule_id: int,
) -> MaintenanceSchedule:
    if schedule is None or not access_scope(session).allows(schedule.asset_id):
        raise HTTPException(status_code=404,detail=f"Maintenance schedule {schedule_id} was not found",)
    return schedule

# does same thing as _schedule_in_scope but for an individual maintenance record instead of a schedule
def _record_in_scope(
    session: Session,
    record: MaintenanceRecord | None,
    record_id: int,
) -> MaintenanceRecord:
    if record is None or not access_scope(session).allows(record.asset_id):
        raise HTTPException(status_code=404,detail=f"Maintenance record {record_id} was not found",)
    return record

# Important : restrict operators so they can only start or complete maintenance that is due today or overdue.
RULE_MAINTENANCE_DELETE_MESSAGE = (
    "Maintenance created from a monitoring rule cannot be deleted: it is controlled by its rule and its history is "
    "preserved. Deactivate or edit the rule instead; an unstarted schedule is then cancelled automatically."
)


def _user_label(user: User) -> str:
    return (getattr(user, "full_name", None) or getattr(user, "username", None) or getattr(user, "email", None) or f"User {getattr(user, 'id', '')}".strip())[:200]


def _authorize_operator_due_occurrence(
    session: Session,
    record: MaintenanceRecord,
    user: User,
    *,
    action: str,
) -> None:
    # Non-Operator users continue without this restriction.
    if user.role != "Operator":
        return

    # Operator can only work on scheduled maintenance records.
    if record.schedule_id is None:
        raise HTTPException(status_code=403,detail="Operators may only start or complete scheduled maintenance.",)

    # Fetch the associated maintenance schedule.
    schedule = _schedule_or_404(session, record.schedule_id)

    # Maintenance must be in progress before an Operator can complete it.
    if action == "complete" and record.status != "in_progress":
        raise HTTPException(status_code=403,detail="Maintenance must be in progress before an Operator can complete it.",)

    # Runtime and usage-based schedules do not depend on calendar due dates.
    if schedule.schedule_mode in {"runtime", "usage", "rule"}:

        # Allow Operators only on the active occurrence of the schedule.
        if (
            schedule.current_occurrence_id != record.id
            or schedule.status != "active"
            or schedule.approval_status == "pending"
        ):
            raise HTTPException(status_code=403,
                detail=("Operators may only start or complete the active runtime/usage maintenance occurrence."),)

        # Runtime/usage authorization is complete; skip calendar checks.
        return

    # Due date must be today or overdue.
    if (
        record.planned_due_date is None
        or record.planned_due_date > utc_now().date()
    ):
        raise HTTPException(status_code=403,
            detail=("Operators may only start or complete scheduled maintenance due today or overdue."),)

    # Verify that this is the active occurrence.
    if (
        schedule.current_occurrence_id != record.id
        or schedule.current_due_date != record.planned_due_date
        or schedule.status != "active"
        or schedule.approval_status == "pending"
    ):
        raise HTTPException(status_code=403,detail=("Operators may only start or complete the active maintenance occurrence due today or overdue."),)

# This prepares a db schedule for the frontend
def _validate_instruction_documents(
    session: Session,
    document_ids: list[int],
) -> list[int]:
    normalized_ids = list(dict.fromkeys(document_ids))
    if any(document_id <= 0 for document_id in normalized_ids):
        raise HTTPException(status_code=422,detail="Instruction document IDs must be positive integers",)
    if not normalized_ids:
        return []
    existing_ids = set(session.scalars(
        select(InstructionDocument.id).where(
            InstructionDocument.id.in_(normalized_ids)
        )
    ).all())
    missing_ids = [document_id for document_id in normalized_ids if document_id not in existing_ids]
    if missing_ids:
        raise HTTPException(status_code=422,detail=f"Instruction documents were not found: {missing_ids}",)
    return normalized_ids


def _aware_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _runtime_freshness_seconds() -> int | None:
    # Runtime freshness limit shown to clients so a display never extends a stale signal.
    try:
        return get_settings().runtime_freshness_seconds
    except ValidationError:
        # Settings could not be loaded (incomplete environment): clients then show only the stored value.
        return None


def _schedule_read(
    session: Session,
    schedule: MaintenanceSchedule,
    *,
    today: date | None = None,
) -> MaintenanceScheduleRead:
    # Identify the schedule mode for response calculations.
    is_calendar = schedule.schedule_mode == "calendar"

    # Select the progress unit for the active schedule mode.
    progress_unit = (
        "days"
        if is_calendar
        else "hours"
        if schedule.schedule_mode == "runtime"
        else (schedule.threshold_unit or "hours")
        if schedule.schedule_mode == "rule"
        else "cycles"
    )

    # Use the current date for active schedules.
    progress_date = today or utc_now().date()

    # Preserve the last completion date for completed or cancelled schedules.
    if schedule.status in {"completed", "cancelled"} and schedule.last_completed_at:
        progress_date = schedule.last_completed_at.date()
    document_ids = schedule.instruction_document_ids or []
    documents = session.scalars(
        select(InstructionDocument).where(
            InstructionDocument.id.in_(document_ids)
        )
    ).all() if document_ids else []
    documents_by_id = {document.id: document for document in documents}
    files = session.scalars(
        select(InstructionDocumentFile)
        .where(InstructionDocumentFile.document_id.in_(document_ids))
        .order_by(InstructionDocumentFile.id)
    ).all() if document_ids else []
    files_by_document: dict[int, list[dict[str, object]]] = {}
    for file in files:
        files_by_document.setdefault(file.document_id, []).append({
            "id": file.id,
            "name": file.original_name,
            "size_bytes": file.size_bytes,
            "content_type": file.content_type,
            "view_url": (f"/api/v1/documents/{file.document_id}/files/{file.id}/view"),
            "download_url": (f"/api/v1/documents/{file.document_id}/files/{file.id}/download"),
        })
    instruction_documents = [
        {
            "id": document.id,
            "title": document.title,
            "kind": document.kind,
            "description": document.description,
            "files": files_by_document.get(document.id, []),
        }
        for document_id in document_ids
        if (document := documents_by_id.get(document_id)) is not None
    ]
    return MaintenanceScheduleRead.model_validate(
    {
        column.name: getattr(schedule, column.name)
        for column in MaintenanceSchedule.__table__.columns
    }
    | {
        "created_by": schedule.created_by,
        "updated_by": schedule.updated_by,
        "instruction_documents": instruction_documents,

        # Calculate due status differently for calendar and non-calendar schedules.
        "due_status": (
            due_status(
                schedule.current_due_date,
                today=today or utc_now().date(),
                completed=schedule.status == "completed",
                cancelled=schedule.status == "cancelled",
                awaiting_approval=schedule.approval_status == "pending",
            )
            if is_calendar
            else (
                "completed"
                if schedule.status == "completed"
                else "not_scheduled"
            )
        ),

        # UPDATED: Calculate day count only for calendar-based schedules.
        "current_day_count": (
            max(
                1,
                (progress_date - schedule.current_period_start_date).days + 1,
            )
            if is_calendar
            else 0
        ),
        # UPDATED: Calculate total days only for calendar-based schedules.
        "total_days": (
            max(
                1,
                (
                    (schedule.current_due_date or schedule.first_due_date)
                    - schedule.current_period_start_date
                ).days + 1,
            )
            if is_calendar
            else 0
        ),

        # Return the appropriate progress unit (hours, cycles, or days).
        "progress_unit": progress_unit,
        "runtime_freshness_seconds": (
            _runtime_freshness_seconds()
            if schedule.schedule_mode == "runtime"
            else None
        ),
        "last_signal_age_seconds": (
            max(0.0, (utc_now() - _aware_utc(schedule.last_signal_at)).total_seconds())
            if schedule.schedule_mode == "runtime" and schedule.last_signal_at is not None
            else None
        ),
    }
)

#This function creates an individual maintenance job from a recurring schedule
def _create_occurrence(
    session: Session,
    schedule: MaintenanceSchedule,
    *,
    due_date: date,
) -> MaintenanceRecord:
    record = MaintenanceRecord(
        asset_id=schedule.asset_id,
        summary=schedule.title,
        notes=schedule.description,
        performed_by=schedule.assigned_technician or "Unassigned",
        performed_at=utc_now(),
        maintenance_type=schedule.maintenance_type,
        status="planned",
        planned_start_at=datetime.combine(due_date, time.min, tzinfo=timezone.utc),
        planned_end_at=datetime.combine(due_date, time.max, tzinfo=timezone.utc),
        planned_due_date=due_date,
        priority=schedule.priority,
        assigned_technician=schedule.assigned_technician,
        schedule_id=schedule.id,
    )
    session.add(record)
    session.flush()
    schedule.current_due_date = due_date
    schedule.current_occurrence_id = record.id
    schedule.due_alerted_for = None
    return record

#This creates a monitoring event related to a schedule
def _emit_schedule_event(
    session: Session,
    schedule: MaintenanceSchedule,
    *,
    event_type: str,
    message: str,
    due_date: date | None = None,
) -> None:
    emit_event(
        session,
        event_type=event_type,
        message=message,
        occurred_at=utc_now(),
        asset_id=schedule.asset_id,
        metadata={
            "maintenance_schedule_id": schedule.id,
            "due_date": due_date.isoformat() if due_date else None,
            "approval_status": schedule.approval_status,
        },
    )

# This standardizes datetimes to UTC
def _normalized(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)

#Similar to schedule_or_404, but it looks up a single maintenance record instead of schedule
def _record_or_404(session: Session, record_id: int) -> MaintenanceRecord:
    record = session.get(MaintenanceRecord, record_id)
    return _record_in_scope(session, record, record_id)

#validates an alert associated with a maintenance record
def _validate_alert(
    session: Session,
    *,
    asset_id: int,
    alert_id: int | None,
) -> Alert | None:
    if alert_id is None:
        return None
    alert = session.get(Alert, alert_id)
    if alert is None or not access_scope(session).allows(alert.target_asset_id):
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} was not found")
    if alert.target_asset_id != asset_id:
        raise HTTPException(status_code=422,detail="Alert does not belong to the selected asset",)
    return alert

#Checks that the dates are logically ordered
def _validate_record_dates(record: MaintenanceRecord) -> None:
    planned_start = _normalized(record.planned_start_at)
    planned_end = _normalized(record.planned_end_at)
    actual_start = _normalized(record.actual_started_at)
    actual_end = _normalized(record.actual_completed_at)
    if planned_start is not None and planned_end is not None and planned_end < planned_start:
        raise HTTPException(status_code=422,detail="planned_end_at must not precede planned_start_at",) 
    if actual_start is not None and actual_end is not None and actual_end < actual_start:
        raise HTTPException(status_code=422,detail="actual_completed_at must not precede actual_started_at",)

#this records events for individual maintenance jobs, such as starting or completing a  job.
def _emit_maintenance_event(
    session: Session,
    record: MaintenanceRecord,
    *,
    event_type: str,
    message: str,
    details: dict[str, object] | None = None,
) -> None:
    alert = session.get(Alert, record.alert_id) if record.alert_id is not None else None
    emit_event(
        session,
        event_type=event_type,
        message=message,
        occurred_at=utc_now(),
        asset_id=record.asset_id,
        rule_id=alert.rule_id if alert else None,
        alert_id=record.alert_id,
        metadata={
            "maintenance_record_id": record.id,
            "next_due_at": (
                record.next_due_at.isoformat() if record.next_due_at else None
            ),
        } | (details or {}),
    )

#Create an individual maintenance record
@router.post("", response_model=MaintenanceRead, status_code=status.HTTP_201_CREATED)
def create_maintenance_record(
    payload: MaintenanceCreate,
    session: Session = Depends(get_db),
) -> MaintenanceRecord:
    if session.get(Asset, payload.asset_id) is None or not access_scope(session).allows(payload.asset_id):
        raise HTTPException(status_code=404,detail=f"Asset {payload.asset_id} was not found",)
    _validate_alert(
        session,
        asset_id=payload.asset_id,
        alert_id=payload.alert_id,
    )
    now = utc_now()
    legacy_record = payload.title is None
    title = payload.title or payload.summary
    actual_started_at = payload.actual_started_at
    actual_completed_at = payload.actual_completed_at
    if legacy_record:
        status_value = "completed"
        actual_completed_at = actual_completed_at or payload.performed_at or now
    else:
        status_value = payload.status
        if status_value == "in_progress":
            actual_started_at = actual_started_at or now
        if status_value == "completed":
            actual_completed_at = actual_completed_at or now

    performed_at = (actual_completed_at
        if status_value == "completed"
        else payload.performed_at or now
    )
    record = MaintenanceRecord(
        asset_id=payload.asset_id,
        alert_id=payload.alert_id,
        summary=title or "Maintenance",
        notes=payload.notes,
        performed_by=(
            payload.performed_by
            or payload.assigned_technician
            or "Unassigned"
        ),
        performed_at=performed_at,
        next_due_at=payload.next_due_at,
        planned_due_date=payload.due_date,
        maintenance_type=("inspection" if legacy_record else payload.maintenance_type),
        status=status_value,
        planned_start_at=payload.planned_start_at,
        planned_end_at=payload.planned_end_at,
        actual_started_at=actual_started_at,
        actual_completed_at=actual_completed_at,
        priority=payload.priority,
        assigned_technician=payload.assigned_technician,
        completion_notes=payload.completion_notes,
        parts_used=payload.parts_used,
        checklist=payload.checklist,
    )
    _validate_record_dates(record)
    session.add(record)
    session.flush()
    if status_value == "completed":
        _emit_maintenance_event(
            session,
            record,
            event_type="maintenance_completed",
            message=f"Maintenance completed: {record.summary} by {record.performed_by}.",
        )
    else:
        _emit_maintenance_event(
            session,
            record,
            event_type="maintenance_created",
            message=f"Maintenance scheduled: {record.summary}.",
        )
    session.commit()
    session.refresh(record)
    return record

#Creating a recurring maintenance schedule
@router.post("/schedules",response_model=MaintenanceScheduleRead,status_code=status.HTTP_201_CREATED,)
def create_maintenance_schedule(
    payload: MaintenanceScheduleCreate,
    session: Session = Depends(get_db),
) -> MaintenanceScheduleRead:
    schedule = _create_maintenance_schedule(session, payload)
    session.commit()
    session.refresh(schedule)
    return _schedule_read(session, schedule)


def _create_maintenance_schedule(
    session: Session,
    payload: MaintenanceScheduleCreate,
) -> MaintenanceSchedule:

    # Verify that the asset exists and is accessible.
    asset = session.get(Asset, payload.asset_id)

    if asset is None or not access_scope(session).allows(payload.asset_id):
        raise HTTPException(status_code=404,detail=f"Asset {payload.asset_id} was not found",)

    schedule_mode = payload.schedule_mode

    # Initialize scheduling fields according to the selected mode.
    if schedule_mode == "calendar":
        schedule_start_date = payload.schedule_start_date
        first_due_date = payload.first_due_date
        current_due_date = first_due_date

        recurrence_enabled = payload.recurrence_enabled
        recurrence_interval = payload.recurrence_interval
        recurrence_unit = payload.recurrence_unit

    else:
        # Runtime and usage schedules use the current date as their anchor.
        anchor_date = utc_now().date()

        schedule_start_date = anchor_date
        first_due_date = anchor_date
        current_due_date = None

        # Calendar recurrence does not apply to these modes.
        recurrence_enabled = False
        recurrence_interval = None
        recurrence_unit = None

        expected_role = (
            "running" if schedule_mode == "runtime" else "cycle"
        )

        variable = session.get(Variable, payload.signal_variable_id)

        if (
            variable is None
            or variable.asset_id != payload.asset_id
            or not variable.is_active
            or variable.data_type != "boolean"
            or variable.signal_role != expected_role
        ):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{schedule_mode.capitalize()} maintenance requires "
                    f"an active Boolean variable on this asset with "
                    f"signal role '{expected_role}'."
                ),
            )

    # Validate instruction documents before creating the schedule.
    instruction_document_ids = _validate_instruction_documents(
        session,
        payload.instruction_document_ids,
    )

    # Create the schedule before creating any calendar occurrence.
    schedule = MaintenanceSchedule(
        asset_id=payload.asset_id,
        title=payload.title,
        maintenance_type=payload.maintenance_type,
        priority=payload.priority,
        assigned_technician=payload.assigned_technician,
        description=payload.description,

        instruction_document_ids=instruction_document_ids,

        schedule_start_date=schedule_start_date,
        current_period_start_date=schedule_start_date,
        first_due_date=first_due_date,
        current_due_date=current_due_date,

        recurrence_enabled=recurrence_enabled,
        recurrence_interval=recurrence_interval,
        recurrence_unit=recurrence_unit,

        schedule_mode=schedule_mode,

        signal_variable_id=(
            payload.signal_variable_id
            if schedule_mode in ("runtime", "usage")
            else None
        ),

        runtime_interval_hours=(
            payload.runtime_interval_hours
            if schedule_mode == "runtime"
            else None
        ),

        usage_interval_count=(
            payload.usage_interval_count
            if schedule_mode == "usage"
            else None
        ),

        current_progress=0.0,
        last_signal_value=None,
        last_signal_at=None,

        status="active",
        approval_status="not_required",
    )

    session.add(schedule)
    session.flush()

    # Create an initial occurrence only for calendar schedules.
    if schedule_mode == "calendar":
        _create_occurrence(
            session,
            schedule,
            due_date=first_due_date,
        )

        event_message = (
            f"Maintenance scheduled: {schedule.title}, "
            f"due {first_due_date}."
        )

    elif schedule_mode == "runtime":
        event_message = (
            f"Runtime maintenance scheduled: {schedule.title}. "
            f"Interval: {payload.runtime_interval_hours} running hours."
        )

    else:
        event_message = (
            f"Usage-based maintenance scheduled: {schedule.title}. "
            f"Interval: {payload.usage_interval_count} cycles."
        )

    # Preserve maintenance schedule event logging for all modes.
    _emit_schedule_event(
        session,
        schedule,
        event_type="maintenance_schedule_created",
        message=event_message,
        due_date=first_due_date if schedule_mode == "calendar" else None,
    )

    return schedule

#Listing and viewing schedules
@router.get("/schedules")
def list_maintenance_schedules(
    asset_id: int | None = Query(default=None, gt=0),
    due_state: str | None = Query(
        default=None,
        pattern="^(upcoming|due_today|overdue|completed|not_scheduled|awaiting_approval)$",
    ),
    session: Session = Depends(get_db),
) -> list[MaintenanceScheduleRead]:
    query = select(MaintenanceSchedule).where(
        access_scope(session).clause(MaintenanceSchedule.asset_id)
    ).order_by(
        MaintenanceSchedule.current_due_date.asc().nulls_last(),
        MaintenanceSchedule.id.asc(),
    )
    if asset_id is not None:
        query = query.where(MaintenanceSchedule.asset_id == asset_id)
    schedules = session.scalars(query).all()
    today = utc_now().date()
    results = [_schedule_read(session, schedule, today=today) for schedule in schedules]
    if due_state is not None:
        results = [schedule for schedule in results if schedule.due_status == due_state]
    return results

#Returns one schedule by ID
@router.get("/schedules/{schedule_id}", response_model=MaintenanceScheduleRead)
def get_maintenance_schedule(
    schedule_id: int,
    session: Session = Depends(get_db),
) -> MaintenanceScheduleRead:
    return _schedule_read(session, _schedule_or_404(session, schedule_id))


# Deletes a locked schedule together with ALL of its maintenance records (past, present and future)
# and its alerts in one transaction. Events are audit history: they are kept, only unlinked from the alerts.
def _mark_schedule_cancelled(schedule: MaintenanceSchedule, user: User) -> None:
    # Record who cancelled an ordinary schedule and when, so Jobs & History can show it (rule schedules set the same
    # fields in rule_maintenance.cancel_unavailable). The first cancellation wins.
    if schedule.cancelled_at is None:
        schedule.cancelled_at = utc_now()
        schedule.cancelled_by_id = getattr(user, "id", None)
        schedule.cancelled_by_name = _user_label(user)
        schedule.cancellation_kind = schedule.cancellation_kind or "manual"


def _delete_schedule_tree(session: Session, schedule: MaintenanceSchedule, user: User) -> None:
    schedule_id = schedule.id
    records = session.scalars(
        select(MaintenanceRecord)
        .where(MaintenanceRecord.schedule_id == schedule_id)
        .with_for_update()
    ).all()
    if any(record.status == "in_progress" for record in records):
        raise HTTPException(status_code=409,detail=("This maintenance is currently in progress and cannot be deleted. "
                "Complete or cancel that work first."),)

    alert_ids = sorted(session.scalars(select(Alert.id).where(Alert.maintenance_schedule_id == schedule_id)).all())
    if alert_ids and session.scalar(
        select(MaintenanceRecord.id)
        .where(
            MaintenanceRecord.alert_id.in_(alert_ids),
            or_(MaintenanceRecord.schedule_id.is_(None), MaintenanceRecord.schedule_id != schedule_id),
        )
        .limit(1)
    ):
        raise HTTPException(status_code=409,detail=("A maintenance record outside this series references one of its alerts. "
                "Remove that alert link before deleting it."),)

    schedule_title = schedule.title
    asset_id = schedule.asset_id
    record_ids = sorted(record.id for record in records)
    logger.warning(
        "Deleting maintenance schedule id=%s asset_id=%s: deleting record(s) %s and alert(s) %s (requested by user %s)",
        schedule_id, asset_id, record_ids, alert_ids, user.id,
    )
    detail = "Related data prevents deleting this maintenance."
    try:
        for record in records:
            session.delete(record)
        _flush_deletion(session, detail)
        if alert_ids:
            # The two bulk statements below bypass the ORM, so describe them for live updates (published after commit only).
            unlinked_event_ids = session.scalars(select(MonitoringEvent.id).where(MonitoringEvent.alert_id.in_(alert_ids))).all()
            alert_rows = session.execute(
                select(Alert.id, Alert.rule_id, Alert.target_asset_id, Alert.maintenance_schedule_id).where(Alert.id.in_(alert_ids))
            ).all()
            _execute_deletion(
                session,
                update(MonitoringEvent)
                .where(MonitoringEvent.alert_id.in_(alert_ids))
                .values(alert_id=None)
                .execution_options(synchronize_session=False),
                detail,
            )
            removed = session.execute(
                delete(Alert).where(Alert.id.in_(alert_ids)).execution_options(synchronize_session=False)
            )
            if removed.rowcount != len(alert_ids):
                raise HTTPException(status_code=409, detail=detail)
            record_bulk_change(session, "nem_monitoring_events", operation="updated", asset_ids={asset_id},
                               entity_ids=unlinked_event_ids)
            record_bulk_change(
                session, "nem_alerts", operation="deleted",
                asset_ids={asset_id, *(row.target_asset_id for row in alert_rows)},
                entity_ids={value for row in alert_rows for value in (row.id, row.rule_id, row.maintenance_schedule_id)},
            )
        session.delete(schedule)
        _flush_deletion(session, detail)
        emit_event(
            session,
            event_type="maintenance_schedule_permanently_deleted",
            message=f"Maintenance '{schedule_title}' and its schedule were permanently deleted.",
            occurred_at=utc_now(),
            asset_id=asset_id,
            metadata={
                "deleted_schedule_id": schedule_id,
                "deleted_schedule_title": schedule_title,
                "deleted_record_ids": record_ids,
                "deleted_alert_ids": alert_ids,
            },
        )
        _commit_deletion(session, detail)
    except HTTPException:
        session.rollback()
        raise
    except Exception:
        session.rollback()
        logger.exception("Deleting maintenance schedule id=%s failed; rolled back", schedule_id)
        raise

@router.post("/schedules/{schedule_id}/cancel-unavailable", response_model=MaintenanceScheduleRead)
def cancel_unavailable_rule_schedule(
    payload: UnavailableScheduleCancellation,
    schedule_id: int = Path(gt=0),
    session: Session = Depends(get_db),
    user: User = Depends(require_roles("Administrator")),  # Supervisors and Operators are rejected with 403
) -> MaintenanceScheduleRead:
    # Cancel a rule schedule whose rule or parameter was deleted. History is kept; see rule_maintenance.
    existing = session.get(MaintenanceSchedule, schedule_id)
    if existing is None or not access_scope(session).allows(existing.asset_id):
        raise HTTPException(status_code=404, detail=f"Maintenance schedule {schedule_id} was not found",)
    try:
        schedule = cancel_unavailable(session, schedule_id, user_id=user.id, user_name=_user_label(user), reason=payload.reason)
    except LookupError as exc:
        session.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    session.commit()
    session.refresh(schedule)
    return _schedule_read(session, schedule)


@router.delete("/schedules/{schedule_id}/permanent",status_code=status.HTTP_204_NO_CONTENT,)
def permanently_delete_maintenance_schedule(
    schedule_id: int = Path(gt=0),
    session: Session = Depends(get_db),
    user: User = Depends(require_roles("Administrator")),
) -> None:
    schedule = session.scalar(
        select(MaintenanceSchedule)
        .where(MaintenanceSchedule.id == schedule_id)
        .with_for_update()
    )
    if schedule is None or not access_scope(session).allows(schedule.asset_id):
        raise HTTPException(status_code=404,detail=f"Maintenance schedule {schedule_id} was not found",)
    is_rule_schedule = schedule.schedule_mode == "rule"
    if is_rule_schedule:
        # Only a rule schedule that is already cancelled (for example rule unavailable) and holds only finished
        # records may be removed; an active rule schedule is controlled by its rule.
        if schedule.status != "cancelled":
            raise HTTPException(status_code=409, detail=RULE_MAINTENANCE_DELETE_MESSAGE)
        if session.scalar(
            select(MaintenanceRecord.id)
            .where(MaintenanceRecord.schedule_id == schedule_id, MaintenanceRecord.status.notin_(("completed", "cancelled")))
            .limit(1)
        ) is not None:
            raise HTTPException(status_code=409, detail="This rule schedule still has unfinished maintenance and cannot be deleted.")
        if session.scalar(
            select(Alert.id).where(Alert.maintenance_schedule_id == schedule_id, Alert.status == "active").limit(1)
        ) is not None:
            raise HTTPException(status_code=409, detail="This rule schedule has an active alert. Resolve it before deleting the schedule.")
        _delete_schedule_tree(session, schedule, user)
        return
    if schedule.status == "cancelled":
        # A cancelled ordinary schedule is history: an Administrator may remove it together with its own records and
        # alerts (an in-progress record still blocks it inside _delete_schedule_tree).
        _delete_schedule_tree(session, schedule, user)
        return
    # Refuse schedule deletion while any occurrence exists so linked and completed history is never erased.
    linked_record_id = session.scalar(
        select(MaintenanceRecord.id)
        .where(MaintenanceRecord.schedule_id == schedule_id)
        .with_for_update()
        .limit(1)
    )
    if linked_record_id is not None:
        raise HTTPException(status_code=409,detail=(
                "This schedule has linked maintenance records or occurrences and cannot be deleted. "
                "Cancel the schedule to stop future maintenance while preserving its history."
            ),
        )
    _delete_schedule_tree(session, schedule, user)

# User can change selected fields without sending the entire schedule again.
@router.patch("/schedules/{schedule_id}", response_model=MaintenanceScheduleRead)
def update_maintenance_schedule(schedule_id: int,payload: MaintenanceScheduleUpdate,session: Session = Depends(get_db), user: User = Depends(get_current_user),) -> MaintenanceScheduleRead:
    schedule = session.scalar(
        select(MaintenanceSchedule)
        .where(MaintenanceSchedule.id == schedule_id)
        .with_for_update()
    )
    if schedule is None or not access_scope(session).allows(schedule.asset_id):
        raise HTTPException(status_code=404,detail=f"Maintenance schedule {schedule_id} was not found",)

    current_occurrence = None
    if schedule.current_occurrence_id is not None:
        current_occurrence = session.scalar(
            select(MaintenanceRecord)
            .where(MaintenanceRecord.id == schedule.current_occurrence_id)
            .with_for_update()
        )
        if current_occurrence is not None and current_occurrence.status == "in_progress":
            raise HTTPException(status_code=409,detail="In-progress maintenance cannot be edited.",)

    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422,detail="Provide at least one field to update",)

    # A cancelled schedule is terminal and cannot be reactivated.
    if (
        schedule.status == "cancelled"
        and changes.get("status") in {"active", "paused"}
    ):
        raise HTTPException(status_code=409, detail=("A cancelled maintenance schedule cannot be reactivated. Create a new schedule instead."),)
    # Prevent changing the scheduling mode of an existing schedule.
    if (
        "schedule_mode" in changes
        and changes["schedule_mode"] != schedule.schedule_mode
    ):
        raise HTTPException(status_code=409,detail="Changing the maintenance schedule mode is not supported. Create a new schedule instead.",)

    if schedule.schedule_mode == "rule":
        blocked = set(changes) - {"title", "priority", "assigned_technician", "description", "instruction_document_ids"}
        if blocked:
            raise HTTPException(status_code=409,detail="This schedule is controlled by its monitoring rule. Only its title, priority, assigned technician, description and documents can be edited here.",)
    is_calendar = schedule.schedule_mode == "calendar"
    if not is_calendar and "status" in changes:
        allowed_runtime_statuses = {"active", "paused", "cancelled"}

        if changes["status"] not in allowed_runtime_statuses:
            raise HTTPException(status_code=422,detail=("Runtime/usage schedules support only active, paused, and cancelled statuses."),)

    calendar_fields = {
        "schedule_start_date",
        "first_due_date",
        "recurrence_enabled",
        "recurrence_interval",
        "recurrence_unit",
    }

    runtime_usage_fields = {
        "signal_variable_id",
        "runtime_interval_hours",
        "usage_interval_count",
    }

    if is_calendar:
        supplied_runtime_fields =  runtime_usage_fields.intersection(changes)
        if supplied_runtime_fields:
            raise HTTPException(status_code=422,detail="Runtime and usage configuration cannot be added to a calendar schedule.",)
        for field in ("schedule_start_date", "first_due_date"):
            if field in changes and changes[field] is None:
                raise HTTPException(status_code=422,detail=f"{field} cannot be null for a calendar schedule.",)

    else:
        supplied_calendar_fields = calendar_fields.intersection(changes)

        if supplied_calendar_fields:
            raise HTTPException(status_code=422,detail="Calendar dates and recurrence cannot be edited for runtime/usage schedules.",)

        if "recurrence_enabled" in changes and changes["recurrence_enabled"] is not False:
            raise HTTPException(status_code=422,detail="Runtime/usage schedules do not support calendar recurrence.",)

        target_signal_id = changes.get(
            "signal_variable_id",
            schedule.signal_variable_id,
        )

        target_runtime_interval = changes.get(
            "runtime_interval_hours",
            schedule.runtime_interval_hours,
        )

        target_usage_interval = changes.get(
            "usage_interval_count",
            schedule.usage_interval_count,
        )

        if schedule.schedule_mode == "runtime":
            if (
                target_runtime_interval is None
                or target_usage_interval is not None
            ):
                raise HTTPException(status_code=422,detail="Runtime schedules require runtime_interval_hours and cannot use usage_interval_count.",)

        elif schedule.schedule_mode == "usage":
            if (
                target_usage_interval is None
                or target_runtime_interval is not None
            ):
                raise HTTPException(status_code=422,detail="Usage schedules require usage_interval_count and cannot use runtime_interval_hours.",)

        configuration_changed = bool(runtime_usage_fields.intersection(changes))

        if configuration_changed and schedule.current_occurrence_id is not None:
            raise HTTPException(status_code=409,detail="Signal and interval settings cannot be changed while a maintenance occurrence is pending.", )

        if configuration_changed:
            expected_role = (
                "running"
                if schedule.schedule_mode == "runtime"
                else "cycle"
            )
            variable = session.get(Variable, target_signal_id)

            if (
                variable is None
                or variable.asset_id != schedule.asset_id
                or not variable.is_active
                or variable.data_type != "boolean"
                or variable.signal_role != expected_role
            ):
                raise HTTPException(status_code=422,detail=(f"This schedule requires an active Boolean variable "
                        f"with signal role '{expected_role}' on the same asset."),)
            if target_signal_id != schedule.signal_variable_id:
                schedule.last_signal_value = None
                schedule.last_signal_at = None
    
    # Role-based field restrictions for editing maintenance schedules
    if user.role == "Operator":
        raise HTTPException(status_code=403, detail="Operators are not allowed to edit maintenance schedules")
    if user.role == "Supervisor":
        allowed_supervisor_fields = {
            "schedule_start_date",
            "first_due_date",
            "recurrence_interval",
            "recurrence_unit",
        }
        restricted = set(changes.keys()) - allowed_supervisor_fields
        if restricted:
            raise HTTPException(status_code=403,detail=("Supervisors can only edit schedule dates and recurrence "
                    f"intervals. Restricted fields: {', '.join(sorted(restricted))}"
                ),
            )
        if (
            {"recurrence_interval", "recurrence_unit"}.intersection(changes)
            and not schedule.recurrence_enabled
        ):
            raise HTTPException(status_code=409,detail="Only recurring maintenance schedules have editable recurrence intervals.",)

    if "instruction_document_ids" in changes:
        changes["instruction_document_ids"] = _validate_instruction_documents(session, changes["instruction_document_ids"] or [])

    previous_due_date = schedule.current_due_date

    administrator_can_reanchor = user.role == "Administrator"
    if (
        "first_due_date" in changes
        and changes["first_due_date"] != schedule.first_due_date
        and (
            schedule.approval_status == "pending"
            or schedule.last_completed_at is not None
        )
        and not administrator_can_reanchor
    ):
        raise HTTPException(status_code=409,detail="The first due date cannot change after an occurrence has been completed",)

    if (
        "schedule_start_date" in changes
        and changes["schedule_start_date"] != schedule.schedule_start_date
    ):
        if schedule.last_completed_at is not None and not administrator_can_reanchor:
            raise HTTPException(status_code=409,detail="The schedule anchor cannot change after an occurrence has been completed",)

        if schedule.current_occurrence_id is not None:
            current_occurrence = session.get(MaintenanceRecord,schedule.current_occurrence_id,)
            completed_occurrence_reanchor = (
                administrator_can_reanchor
                and schedule.last_completed_at is not None
                and current_occurrence is not None
                and current_occurrence.status == "completed"
            )
            if (
                not completed_occurrence_reanchor
                and (
                    current_occurrence is None
                    or current_occurrence.status != "planned"
                )
            ):
                raise HTTPException(status_code=409,detail="The schedule start date cannot change after maintenance starts",)

    # Clear the signal baseline when pausing runtime/usage maintenance.
    # This prevents paused time from being included after the schedule resumes.
    if (
        not is_calendar
        and changes.get("status") == "paused"
        and schedule.status != "paused"
    ):
        schedule.last_signal_value = None
        schedule.last_signal_at = None

    for field, value in changes.items():
        setattr(schedule, field, value)

    if current_occurrence is not None and current_occurrence.status == "planned":
        occurrence_fields = {
            "title": "summary",
            "maintenance_type": "maintenance_type",
            "priority": "priority",
            "assigned_technician": "assigned_technician",
            "description": "notes",
        }
        for schedule_field, occurrence_field in occurrence_fields.items():
            if schedule_field in changes:
                if schedule_field == "title":
                    value = schedule.title
                elif schedule_field == "description":
                    value = schedule.description
                else:
                    value = getattr(schedule, schedule_field)
                setattr(current_occurrence, occurrence_field, value)
        if "assigned_technician" in changes:
            current_occurrence.performed_by = schedule.assigned_technician or "Unassigned"

    if "schedule_start_date" in changes and schedule.last_completed_at is None:
        schedule.current_period_start_date = schedule.schedule_start_date

    if is_calendar and (
        schedule.first_due_date is None
        or schedule.schedule_start_date is None
        or schedule.first_due_date < schedule.schedule_start_date
        ):
        raise HTTPException(status_code=422,detail="first_due_date must not precede schedule_start_date",)

    if schedule.recurrence_enabled and (
        schedule.recurrence_interval is None
        or schedule.recurrence_unit is None
    ):
        raise HTTPException(status_code=422,detail="recurrence_interval and recurrence_unit are required",)

    if not schedule.recurrence_enabled:
        schedule.recurrence_interval = None
        schedule.recurrence_unit = None

        if schedule.approval_status == "pending":
            schedule.proposed_due_date = None
            schedule.approval_status = "declined"

            if schedule.status == "awaiting_approval":
                schedule.status = "completed"

    if (
        "first_due_date" in changes
        and schedule.approval_status != "pending"
        and schedule.last_completed_at is None
        and schedule.current_occurrence_id is not None
    ):
        occurrence = session.get(MaintenanceRecord,schedule.current_occurrence_id, )

        if occurrence is None or occurrence.status != "planned":
            raise HTTPException(status_code=409,detail="The first due date can only change before maintenance starts",)
        occurrence.planned_due_date = schedule.first_due_date
        occurrence.planned_start_at = datetime.combine(
            schedule.first_due_date,
            time.min,
            tzinfo=timezone.utc,
        )
        occurrence.planned_end_at = datetime.combine(
            schedule.first_due_date,
            time.max,
            tzinfo=timezone.utc,
        )
        schedule.current_period_start_date = schedule.schedule_start_date

        if previous_due_date is not None:
            alerts = session.scalars(
                select(Alert).where(
                    Alert.maintenance_schedule_id == schedule.id,
                    Alert.maintenance_due_date == previous_due_date,
                    Alert.status == "active",
                )
            ).all()

            now = utc_now()
            for alert in alerts:
                alert.status = "resolved"
                alert.resolved_at = now
                alert.last_updated_at = now

        schedule.current_due_date = schedule.first_due_date
        schedule.due_alerted_for = None
        
    # Keep a pending proposal aligned with edits to its recurrence settings.
    if (
        schedule.recurrence_enabled
        and schedule.approval_status == "pending"
        and {
            "first_due_date",
            "recurrence_interval",
            "recurrence_unit",
        }.intersection(changes)
    ):
        if schedule.current_due_date is None:
            raise HTTPException(status_code=409,detail="The current maintenance due date is missing",)

        schedule.proposed_due_date = next_due_date(
            schedule.first_due_date,
            interval=schedule.recurrence_interval or 1,
            unit=schedule.recurrence_unit or "months",
            after=schedule.current_due_date,
        )
        # Cancel the current planned occurrence, but preserve history.
        if current_occurrence is not None:
            if current_occurrence.status == "planned":
                current_occurrence.status = "cancelled"

            # Do not retain a pointer to a cancelled or historical occurrence.
            if schedule.current_occurrence_id == current_occurrence.id:
                schedule.current_occurrence_id = None

    if schedule.status == "cancelled":
        _mark_schedule_cancelled(schedule, user)
        # Cancelled schedules must not retain proposals or active due alerts.
        schedule.proposed_due_date = None
        schedule.approval_status = "declined"

        # Cancel the current planned occurrence, but preserve historical records.
        if current_occurrence is not None:
            if current_occurrence.status == "planned":
                current_occurrence.status = "cancelled"

            # Clear the pointer so the schedule does not reference a cancelled occurrence.
            if schedule.current_occurrence_id == current_occurrence.id:
                schedule.current_occurrence_id = None

        now = utc_now()

        active_due_alerts = session.scalars(
            select(Alert).where(
                Alert.maintenance_schedule_id == schedule.id,
                Alert.status == "active",
            )
        ).all()

        for alert in active_due_alerts:
            alert.status = "resolved"
            alert.resolved_at = now
            alert.last_updated_at = now

        _emit_schedule_event(
            session,
            schedule,
            event_type="maintenance_schedule_cancelled",
            message=f"Maintenance schedule cancelled: {schedule.title}.",
        )
    session.commit()
    session.refresh(schedule)
    return _schedule_read(session, schedule)

# Confirm the proposed date or save a replacement date selected by the user.
@router.post("/schedules/{schedule_id}/confirm-next",response_model=MaintenanceScheduleRead,)
def confirm_next_occurrence(
    schedule_id: int,
    payload: MaintenanceScheduleConfirm,
    session: Session = Depends(get_db),
) -> MaintenanceScheduleRead:
    schedule = session.scalar(
        select(MaintenanceSchedule)
        .where(MaintenanceSchedule.id == schedule_id)
        .with_for_update()
    )

    if schedule is None or not access_scope(session).allows(schedule.asset_id):
        raise HTTPException(status_code=404,detail=f"Maintenance schedule {schedule_id} was not found",)
    if schedule.schedule_mode != "calendar":
        raise HTTPException(status_code=409,detail="Next occurrence approval is only available for calendar-based maintenance schedules.", )

    # Make repeated requests safe after an occurrence has been created.
    if (schedule.approval_status == "approved"and schedule.current_occurrence_id):
        return _schedule_read(session, schedule)

    # A proposal can be confirmed while pending.
    # A declined proposal can be replaced with a new date.
    if schedule.approval_status not in {"pending", "declined"}:
        raise HTTPException(status_code=409,detail="No proposed date or declined proposal is awaiting confirmation",)

    if schedule.status in {"cancelled", "completed"}:
        raise HTTPException(status_code=409,detail="A cancelled or completed schedule cannot receive another occurrence",)

    if not schedule.recurrence_enabled:
        raise HTTPException(status_code=409,detail="This schedule is not configured for recurrence",)

    selected_date = payload.due_date

    # When a proposal is pending, accept either the latest proposed date
    # or a replacement date selected by the user.
    if schedule.approval_status == "pending":
        if schedule.proposed_due_date is None:
            raise HTTPException(status_code=409,detail="There is no proposed next due date to confirm",)

    # Validate the date selected by the user.
    if selected_date <= schedule.schedule_start_date:
        raise HTTPException(status_code=422,detail="Next due date must be after the schedule start date",)

    if (schedule.last_completed_at is not None and selected_date <= schedule.last_completed_at.date()):
        raise HTTPException(status_code=422,detail="Next due date must be after the last completion date",)

    if (schedule.current_due_date is not None and selected_date <= schedule.current_due_date):
        raise HTTPException(status_code=422,detail="Next due date must be after the previous scheduled due date",)

    previous_due_date = schedule.current_due_date

    # Save the confirmed or replacement date.
    schedule.current_due_date = selected_date
    schedule.proposed_due_date = None
    schedule.approval_status = "approved"
    schedule.status = "active"

    # Create the next planned maintenance occurrence.
    try:
        _create_occurrence(
            session,
            schedule,
            due_date=selected_date,
        )
        if previous_due_date is not None:
            schedule.current_period_start_date = previous_due_date + timedelta(days=1)

        _emit_schedule_event(
            session,
            schedule,
            event_type="maintenance_next_occurrence_approved",
            message=f"Next maintenance confirmed for {selected_date}.",
            due_date=selected_date,
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409,detail="The next maintenance occurrence already exists or the schedule changed concurrently.", ) from error
    session.refresh(schedule)

    return _schedule_read(session, schedule)

# Decline the proposed date without ending the recurring schedule.
@router.post("/schedules/{schedule_id}/decline-next",response_model=MaintenanceScheduleRead,)
def decline_next_occurrence(schedule_id: int,
    session: Session = Depends(get_db),
) -> MaintenanceScheduleRead:
    schedule = session.scalar(
        select(MaintenanceSchedule)
        .where(MaintenanceSchedule.id == schedule_id)
        .with_for_update()
    )
    if schedule is None or not access_scope(session).allows(schedule.asset_id):
        raise HTTPException(status_code=404,detail=f"Maintenance schedule {schedule_id} was not found",)

    if schedule.schedule_mode != "calendar":
        raise HTTPException(status_code=409,detail="Next occurrence approval is only available for calendar-based maintenance schedules.",)
    # A repeated decline is safe if the proposal has already been cleared.
    if (schedule.approval_status == "declined" and schedule.proposed_due_date is None):
        return _schedule_read(session, schedule)

    if (schedule.approval_status != "pending" or schedule.proposed_due_date is None):
        raise HTTPException(status_code=409,detail="No proposed occurrence awaits approval",)

    rejected_date = schedule.proposed_due_date
    # Clear only the proposed date. Keep the recurring schedule available.
    schedule.proposed_due_date = None
    schedule.approval_status = "declined"
    schedule.status = "active"

    _emit_schedule_event(session,
        schedule,
        event_type="maintenance_next_occurrence_declined",
        message=( f"Proposed maintenance date {rejected_date} was declined. A replacement date must be selected."),
        due_date=rejected_date,)
    session.commit()
    session.refresh(schedule)
    return _schedule_read(session, schedule)

# returns individual maintenance jobs,rather than schedule definitions
@router.get("")
def list_maintenance_records(
    asset_id: int | None = Query(default=None, gt=0),
    alert_id: int | None = Query(default=None, gt=0),
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    start, end = _normalized(start_time), _normalized(end_time)
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422,detail="start_time must not be later than end_time",)

    # Only records on assets the caller may reach (administrators: all records).
    conditions = [access_scope(session).clause(MaintenanceRecord.asset_id)]
    if asset_id is not None:
        conditions.append(MaintenanceRecord.asset_id == asset_id)
    if alert_id is not None:
        conditions.append(MaintenanceRecord.alert_id == alert_id)
    if start is not None:
        conditions.append(MaintenanceRecord.performed_at >= start)
    if end is not None:
        conditions.append(MaintenanceRecord.performed_at <= end)

    query = select(MaintenanceRecord)
    count_query = select(func.count()).select_from(MaintenanceRecord)
    for condition in conditions:
        query = query.where(condition)
        count_query = count_query.where(condition)

    rows = session.scalars(
        query.order_by(
            MaintenanceRecord.planned_start_at.desc().nulls_last(),
            MaintenanceRecord.performed_at.desc(),
            MaintenanceRecord.id.desc(),
        )
        .offset(offset)
        .limit(limit)
    ).all()
    return {
        "items": [MaintenanceRead.model_validate(row) for row in rows],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }

# returns a single maintenanace record
@router.get("/{record_id}", response_model=MaintenanceRead)
def get_maintenance_record(
    record_id: int,
    session: Session = Depends(get_db),
) -> MaintenanceRecord:
    return _record_or_404(session, record_id)

@router.delete("/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
@router.delete("/{record_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
def permanently_delete_maintenance_record(
    record_id: int = Path(gt=0),
    session: Session = Depends(get_db),
    user: User = Depends(require_roles("Administrator")),
) -> None:
    record = session.scalar(
        select(MaintenanceRecord)
        .where(MaintenanceRecord.id == record_id)
        .with_for_update()
    )
    if record is None or not access_scope(session).allows(record.asset_id):
        raise HTTPException(status_code=404,detail=f"Maintenance record {record_id} was not found",)
    if record.status == "in_progress":
        raise HTTPException(status_code=409,detail="Maintenance currently in progress cannot be permanently deleted.",)
    if record.rule_context is not None and record.status not in {"completed", "cancelled"}:
        # Finished rule history (completed or cancelled) may be removed by an Administrator, one record at a time.
        # Open rule work stays controlled by its rule.
        raise HTTPException(status_code=409, detail=RULE_MAINTENANCE_DELETE_MESSAGE)

    if record.status == "planned" and record.schedule_id is not None:
        # Deleting a planned maintenance removes its whole series, records and alerts.
        schedule = session.scalar(
            select(MaintenanceSchedule).where(MaintenanceSchedule.id == record.schedule_id).with_for_update()
        )
        if schedule is not None:
            _delete_schedule_tree(session, schedule, user)
            return

    schedule_id = record.schedule_id
    if schedule_id is not None:
        schedule = session.scalar(
            select(MaintenanceSchedule)
            .where(MaintenanceSchedule.id == schedule_id)
            .with_for_update()
        )
        # Only unfinished planned work is tied to an active due alert. Completed and cancelled records are history: the
        # alert belongs to the schedule/due date, is not removed with the record, and must not block cleaning it up.
        if record.status == "planned" and session.scalar(
            select(Alert.id)
            .where(
                Alert.maintenance_schedule_id == schedule_id,
                Alert.maintenance_due_date == record.planned_due_date,
                Alert.status == "active",
            )
            .limit(1)
        ) is not None:
            raise HTTPException(status_code=409,detail="This maintenance has an active due alert. Complete the alert before deleting it.",)
        if schedule is not None and schedule.current_occurrence_id == record.id:
            schedule.current_occurrence_id = None

    deleted_title = record.title
    deleted_asset_id = record.asset_id
    record_id_value = record.id
    deleted_alert_id = record.alert_id
    logger.warning(
        "Deleting maintenance record id=%s schedule_id=%s asset_id=%s status=%s (requested by user %s)",
        record_id_value, schedule_id, deleted_asset_id, record.status, user.id,
    )
    # Delete by primary key and verify exactly one row was removed.
    try:
        result = session.execute(delete(MaintenanceRecord).where(MaintenanceRecord.id == record_id_value))
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409, detail="Related maintenance history prevents deleting this record.") from error
    if result.rowcount != 1:
        session.rollback()
        logger.error("Maintenance delete of id=%s affected %s rows; rolled back", record_id_value, result.rowcount)
        raise HTTPException(status_code=409, detail="The maintenance record could not be deleted safely.")
    session.expunge(record)
    # The bulk DELETE above is invisible to the ORM change tracking: register it (published only after the commit).
    record_bulk_change(session, "nem_maintenance_records", operation="deleted", asset_ids={deleted_asset_id},
                       entity_ids={record_id_value, deleted_alert_id, schedule_id})
    emit_event(
        session,
        event_type="maintenance_record_permanently_deleted",
        message=f"Maintenance '{deleted_title}' was permanently deleted.",
        occurred_at=utc_now(),
        asset_id=deleted_asset_id,
        metadata={
            "deleted_record_id": record_id_value,
            "deleted_record_title": deleted_title,
            "schedule_id": schedule_id,
        },
    )
    _commit_deletion(session, "Related maintenance history prevents deleting this record.",)


# Modifies a maintenance record; completed records cannot be edited.
@router.patch("/{record_id}", response_model=MaintenanceRead)
def update_maintenance_record(
    record_id: int,
    payload: MaintenanceUpdate,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MaintenanceRecord:
    record = session.scalar(
        select(MaintenanceRecord)
        .where(MaintenanceRecord.id == record_id)
        .with_for_update()
    )
    if record is None or not access_scope(session).allows(record.asset_id):
        raise HTTPException(status_code=404,detail=f"Maintenance record {record_id} was not found",)
    if record.status == "in_progress":
        raise HTTPException(status_code=409,detail="In-progress maintenance cannot be edited.",)

    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail="Provide at least one field to update")

    # Role-based field restrictions for editing maintenance records
    if user.role == "Operator":
        raise HTTPException(status_code=403, detail="Operators are not allowed to edit maintenance records")
    if user.role == "Supervisor":
        allowed_supervisor_fields = {"planned_start_at", "planned_end_at"}
        restricted = set(changes.keys()) - allowed_supervisor_fields
        if restricted:
            raise HTTPException(status_code=403,detail=f"Supervisors can only edit planned maintenance dates. Restricted fields: {', '.join(sorted(restricted))}",)

    if record.status == "completed":
        raise HTTPException(status_code=409,detail="Completed maintenance cannot be edited",)
    if record.rule_context is not None:
        # A job created by a monitoring rule: its rule information, eligibility and timestamps are read-only.
        blocked = set(changes) - {"title", "priority", "assigned_technician", "notes"}
        if blocked:
            raise HTTPException(status_code=409, detail="This maintenance is controlled by its monitoring rule. Only its title, priority, assigned technician and description can be edited.")
    if record.schedule_id is not None and {
        "planned_start_at",
        "planned_end_at",
    }.intersection(changes):
        raise HTTPException(status_code=409,detail="Change scheduled dates through the maintenance schedule",)
    if "alert_id" in changes:
        _validate_alert(
            session,
            asset_id=record.asset_id,
            alert_id=changes["alert_id"],
        )
    for field, value in changes.items():
        if field == "title":
            if value is not None:
                record.summary = value
        else:
            setattr(record, field, value)
    if record.status in {"planned", "in_progress"} and (record.planned_start_at is None or record.planned_end_at is None):
        raise HTTPException(status_code=422,detail="planned_start_at and planned_end_at are required", )
    _validate_record_dates(record)
    session.commit()
    session.refresh(record)
    return record

#Only records  in planned status can be started
@router.post("/{record_id}/start", response_model=MaintenanceRead)
def start_maintenance_record(
    record_id: int,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MaintenanceRecord:
    record = _record_or_404(session, record_id)
    # Lock the schedule first, then the record (the same order as Complete and the evaluator), so these paths can
    # never deadlock; then re-read the row so two simultaneous Start requests cannot both see "planned".
    if record.schedule_id is not None:
        session.execute(select(MaintenanceSchedule.id).where(MaintenanceSchedule.id == record.schedule_id).with_for_update())
    session.refresh(record, with_for_update=True)
    _authorize_operator_due_occurrence(
        session, record, user, action="start"
    )
    if record.status != "planned":
        raise HTTPException(status_code=409,detail="Only planned maintenance can be started",)
    # Server-side eligibility (every role): a disabled button in the browser is never the only protection.
    try:
        ensure_startable(session, record)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    record.status = "in_progress"
    record.actual_started_at = record.actual_started_at or utc_now()
    record.started_by_id = user.id
    record.started_by_name = _user_label(user)
    _emit_maintenance_event(
        session,
        record,
        event_type="maintenance_started",
        message=f"Maintenance started: {record.summary}.",
    )
    session.commit()
    session.refresh(record)
    return record

#important functions in maintenance system -> locks the record and rejects jobs that are already completed or cancelled
@router.post("/{record_id}/complete", response_model=MaintenanceRead)
def complete_maintenance_record(
    record_id: int,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    payload: MaintenanceCompletion | None = None,
) -> MaintenanceRecord:
    record = session.get(MaintenanceRecord, record_id)

    if record is None or not access_scope(session).allows(record.asset_id):
        raise HTTPException(status_code=404,detail=f"Maintenance record {record_id} was not found",)
    schedule = None

    if record.schedule_id is not None:
        schedule = session.scalar(
            select(MaintenanceSchedule)
            .where(MaintenanceSchedule.id == record.schedule_id)
            .with_for_update()
        )

        if schedule is None:
            raise HTTPException(status_code=404,detail="The maintenance schedule was not found",)

    record = session.scalar(
        select(MaintenanceRecord)
        .where(MaintenanceRecord.id == record_id)
        .with_for_update()
    )

    if record is None or not access_scope(session).allows(record.asset_id):
        raise HTTPException(status_code=404,detail=f"Maintenance record {record_id} was not found",)

    _authorize_operator_due_occurrence(
        session, record,
        user,action="complete",)

    if record.status in {"completed", "cancelled"}:
        raise HTTPException(status_code=409,detail="Completed or cancelled maintenance cannot be completed",)
    if schedule is not None and schedule.schedule_mode == "rule" and record.status != "in_progress":
        raise HTTPException(status_code=409, detail="Maintenance must be started before it can be completed.")

    # Persist submitted registration fields before running the existing completion workflow.
    if payload is not None and payload.model_fields_set:
        # Only details that were actually entered replace the stored ones; blank optional fields keep what the
        # job already has (the technician column cannot be empty, so it keeps its current value).
        if payload.actual_completed_at is not None:
            record.actual_completed_at = payload.actual_completed_at
        if payload.performed_by is not None:
            record.performed_by = payload.performed_by
        if payload.notes is not None:
            record.notes = payload.notes
        if payload.completion_notes is not None:
            record.completion_notes = payload.completion_notes
        if "parts_used" in payload.model_fields_set:
            record.parts_used = payload.parts_used
        if "checklist" in payload.model_fields_set:
            record.checklist = payload.checklist

    is_usage_based = (
        schedule is not None
        and schedule.schedule_mode in {"runtime", "usage"}
    )

    if schedule is not None:
        if schedule.current_occurrence_id != record.id:
            raise HTTPException(status_code=409,detail="Only the current scheduled maintenance occurrence can be completed.",)

        if (
            not is_usage_based
            and schedule.current_due_date != record.planned_due_date
        ):
            raise HTTPException(status_code=409,detail="Only the current scheduled maintenance occurrence can be completed.",)

    completed_at = record.actual_completed_at or utc_now()

    record.actual_completed_at = completed_at
    record.actual_started_at = record.actual_started_at or completed_at

    _validate_record_dates(record)

    record.performed_at = completed_at
    record.status = "completed"
    record.completed_by_id = user.id
    record.completed_by_name = _user_label(user)

    actual_start = _normalized(record.actual_started_at)
    normalized_completed_at = _normalized(completed_at)

    if schedule is not None:

        # Resolve the alert associated with this occurrence.
        if (is_usage_based or schedule.schedule_mode == "rule") and record.alert_id is not None:
            due_alert = session.scalar(
                select(Alert)
                .where(
                    Alert.id == record.alert_id,
                    Alert.maintenance_schedule_id == schedule.id,
                    Alert.status == "active",
                )
                .with_for_update()
            )
        else:
            due_alert = session.scalar(
                select(Alert)
                .where(
                    Alert.maintenance_schedule_id == schedule.id,
                    Alert.maintenance_due_date == record.planned_due_date,
                    Alert.status == "active",
                )
                .with_for_update()
            )

        if due_alert is not None:
            due_alert.status = "resolved"
            due_alert.resolved_at = completed_at
            due_alert.last_updated_at = completed_at

        schedule.last_completed_at = completed_at

        if is_usage_based:
            # Reset only maintenance-owned progress.
            # Monitoring rule counters remain untouched.
            schedule.current_progress = 0.0
            schedule.last_signal_value = None
            schedule.last_signal_at = None

            schedule.current_occurrence_id = None
            schedule.current_due_date = None
            schedule.due_alerted_for = None
            schedule.approval_status = "not_required"
            schedule.proposed_due_date = None

            # Keep the schedule active unless it was paused/cancelled.
            if schedule.status not in {"paused", "cancelled"}:
                schedule.status = "active"

            _emit_schedule_event(
                session,
                schedule,
                event_type="maintenance_schedule_progress_reset",
                message=(
                    f"{schedule.schedule_mode.capitalize()} maintenance "
                    f"completed: {schedule.title}. "
                    f"Progress reset for the next interval."
                ),
                due_date=None,
            )

        elif schedule.recurrence_enabled and schedule.status != "cancelled":
            anchor_due = record.planned_due_date or schedule.current_due_date

            if anchor_due is not None:
                schedule.proposed_due_date = next_due_date(
                    schedule.first_due_date,
                    interval=schedule.recurrence_interval or 1,
                    unit=schedule.recurrence_unit or "months",
                    after=anchor_due,
                )

                schedule.approval_status = "pending"

                if schedule.status != "paused":
                    schedule.status = "awaiting_approval"
            else:
                schedule.status = "completed"

            _emit_schedule_event(
                session,
                schedule,
                event_type=(
                    "maintenance_next_due_proposed"
                    if schedule.approval_status == "pending"
                    else "maintenance_schedule_completed"
                ),
                message=(
                    f"Next maintenance proposed for {schedule.proposed_due_date}."
                    if schedule.proposed_due_date
                    else f"Maintenance schedule completed: {schedule.title}."
                ),
                due_date=schedule.proposed_due_date,
            )

        elif schedule.status != "cancelled":
            schedule.status = "completed"
            schedule.approval_status = "not_required"

            _emit_schedule_event(
                session,
                schedule,
                event_type="maintenance_schedule_completed",
                message=f"Maintenance schedule completed: {schedule.title}.",
                due_date=None,
            )

    _emit_maintenance_event(
        session,
        record,
        event_type="maintenance_completed",
        message=f"Maintenance completed: {record.summary}.",
        details={
            "title": record.summary,
            "maintenance_type": record.maintenance_type,
            "priority": record.priority,
            "assigned_technician": (
                record.assigned_technician or record.performed_by
            ),
            "notes": record.notes,
            "completion_notes": record.completion_notes,
            "parts_used": record.parts_used,
            "checklist": record.checklist,
            "planned_start_at": (
                record.planned_start_at.isoformat()
                if record.planned_start_at
                else None
            ),
            "planned_end_at": (
                record.planned_end_at.isoformat()
                if record.planned_end_at
                else None
            ),
            "actual_started_at": (
                actual_start.isoformat() if actual_start else None
            ),
            "actual_completed_at": (
                normalized_completed_at.isoformat()
                if normalized_completed_at
                else None
            ),
            "actual_duration_seconds": max(
                0,
                int(
                    (
                        normalized_completed_at - actual_start
                    ).total_seconds()
                ),
            ),
            "schedule_id": record.schedule_id,
            "planned_due_date": (
                record.planned_due_date.isoformat()
                if record.planned_due_date
                else None
            ),
        },
    )

    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409,detail=("Maintenance could not be completed because related ""data changed concurrently." ),
        ) from error

    session.refresh(record)
    return record

#cancels a planned job; completed and in-progress work, and jobs controlled by a monitoring rule, are rejected
@router.post("/{record_id}/cancel", response_model=MaintenanceRead)
def cancel_maintenance_record(
    record_id: int,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),  
) -> MaintenanceRecord:
    record = _record_or_404(session, record_id)
    if record.schedule_id is not None:
        session.execute(select(MaintenanceSchedule.id).where(MaintenanceSchedule.id == record.schedule_id).with_for_update())
    session.refresh(record, with_for_update=True)
    if record.status == "completed":
        raise HTTPException(status_code=409,detail="Completed maintenance cannot be cancelled",)
    if record.status == "in_progress":
        raise HTTPException(status_code=409,detail="Maintenance that is in progress cannot be cancelled. Complete it instead.",)
    linked_schedule = session.get(MaintenanceSchedule, record.schedule_id) if record.schedule_id is not None else None
    if record.rule_context or (linked_schedule is not None and linked_schedule.schedule_mode == "rule"):

        raise HTTPException(status_code=409,detail="Maintenance created from a monitoring rule cannot be cancelled here. Deactivate or edit the rule; "
                   "if the rule was deleted, an Administrator can cancel the unavailable schedule.",)
    if record.status != "cancelled":
        record.status = "cancelled"
        if record.schedule_id is not None:
            schedule = _schedule_or_404(session, record.schedule_id)

            schedule.status = "cancelled"
            _mark_schedule_cancelled(schedule, user)
            schedule.proposed_due_date = None
            schedule.approval_status = "declined"

            # Clear the pointer only when it references this record.
            if schedule.current_occurrence_id == record.id:
                schedule.current_occurrence_id = None
            now = utc_now()
            active_alerts = session.scalars(
                select(Alert).where(
                    Alert.maintenance_schedule_id == schedule.id,
                    Alert.status == "active",
                )
            ).all()
            for alert in active_alerts:
                alert.status = "resolved"
                alert.resolved_at = now
                alert.last_updated_at = now
        _emit_maintenance_event(
            session,
            record,
            event_type="maintenance_cancelled",
            message=f"Maintenance cancelled: {record.summary}.",
        )
        session.commit()
        session.refresh(record)
    return record
# connects the frontend to your maintenance db and business logic, it creates jobs,manages recurring schedules,track start/completion/cancellation,calculates
# the next proposed due date,waits for approval and emits events so maintenanace activity can be reflected in monitoring system.