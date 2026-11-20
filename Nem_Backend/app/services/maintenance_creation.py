# Creation of a recurring maintenance schedule and its first occurrence, shared by the maintenance routes,
# rule suggestions and configuration import. The caller owns the transaction and commits.
from __future__ import annotations

from datetime import date, datetime, time, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.constants import (
    APPROVAL_NOT_REQUIRED,
    BOOLEAN,
    CALENDAR,
    CYCLE,
    RUNNING,
    RUNTIME,
    STATUS_ACTIVE,
    STATUS_PLANNED,
    USAGE,
)
from app.models import Asset, InstructionDocument, MaintenanceRecord, MaintenanceSchedule, Variable
from app.schemas.maintenance import MaintenanceScheduleCreate
from app.services.access_scope import access_scope
from app.services.event_log import emit_event
from app.services.monitoring_engine import utc_now


# Checks that the attached instruction documents exist and returns the de-duplicated ids.
def validate_instruction_documents(
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
        ).with_for_update(read=True)  # shared lock: a document cannot be deleted while it is being attached
    ).all())
    missing_ids = [document_id for document_id in normalized_ids if document_id not in existing_ids]
    if missing_ids:
        raise HTTPException(status_code=422,detail=f"Instruction documents were not found: {missing_ids}",)
    return normalized_ids


#This function creates an individual maintenance job from a recurring schedule
def create_occurrence(
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
        status=STATUS_PLANNED,
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
def emit_schedule_event(
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


def create_maintenance_schedule(
    session: Session,
    payload: MaintenanceScheduleCreate,
) -> MaintenanceSchedule:

    # Verify that the asset exists and is accessible.
    asset = session.get(Asset, payload.asset_id)

    if asset is None or not access_scope(session).allows(payload.asset_id):
        raise HTTPException(status_code=404,detail=f"Asset {payload.asset_id} was not found",)

    schedule_mode = payload.schedule_mode

    # Initialize scheduling fields according to the selected mode.
    if schedule_mode == CALENDAR:
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

        expected_role = RUNNING if schedule_mode == RUNTIME else CYCLE

        variable = session.get(Variable, payload.signal_variable_id)

        if (
            variable is None
            or variable.asset_id != payload.asset_id
            or not variable.is_active
            or variable.data_type != BOOLEAN
            or variable.signal_role != expected_role
        ):
            raise HTTPException(status_code=422,detail=(f"{schedule_mode.capitalize()} maintenance requires "
                    f"an active Boolean variable on this asset with "
                    f"signal role '{expected_role}'."),)

    # Validate instruction documents before creating the schedule.
    instruction_document_ids = validate_instruction_documents(session,
        payload.instruction_document_ids,)

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
            if schedule_mode in (RUNTIME, USAGE)
            else None
        ),

        runtime_interval_hours=(
            payload.runtime_interval_hours
            if schedule_mode == RUNTIME
            else None
        ),

        usage_interval_count=(
            payload.usage_interval_count
            if schedule_mode == USAGE
            else None
        ),

        current_progress=0.0,
        last_signal_value=None,
        last_signal_at=None,

        status=STATUS_ACTIVE,
        approval_status=APPROVAL_NOT_REQUIRED,
    )

    session.add(schedule)
    session.flush()

    # Create an initial occurrence only for calendar schedules.
    if schedule_mode == CALENDAR:
        create_occurrence(
            session,
            schedule,
            due_date=first_due_date,
        )

        event_message = (f"Maintenance scheduled: {schedule.title}, "
            f"due {first_due_date}.")

    elif schedule_mode == RUNTIME:
        event_message = (f"Runtime maintenance scheduled: {schedule.title}. "
            f"Interval: {payload.runtime_interval_hours} running hours.")

    else:
        event_message = (f"Usage-based maintenance scheduled: {schedule.title}. "
            f"Interval: {payload.usage_interval_count} cycles.")

    # Preserve maintenance schedule event logging for all modes.
    emit_schedule_event(
        session,
        schedule,
        event_type="maintenance_schedule_created",
        message=event_message,
        due_date=first_due_date if schedule_mode == CALENDAR else None,
    )

    return schedule
