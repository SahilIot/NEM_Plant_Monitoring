# Manage maintenance scheduling and due-date processing,
# including recurring date calculations , maintenance status determination,
# detection of valid and orphaned maintenance alerts, automatic creation and resolution of due alerts, email notifications, and maintenance due event generation while preventing duplicate alerts.

from calendar import monthrange

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.models import Alert, Asset, MaintenanceRecord, MaintenanceSchedule
from app.services.email_notifications import enqueue_alert_notifications
from app.services.monitoring_engine import emit_event

RECURRENCE_UNITS = {"days", "weeks", "months", "years"}
# Determine the maintenance status
def due_status(
    due_date: date | None,
    *,
    today: date,
    completed: bool = False,
    cancelled: bool = False,
    awaiting_approval: bool = False,
) -> str:
    if completed:
        return "completed"
    if awaiting_approval:
        return "awaiting_approval"
    if cancelled or due_date is None:
        return "not_scheduled"
    if due_date < today:
        return "overdue"
    if due_date == today:
        return "due_today"
    return "upcoming"

# Calculate the next maintenance date based on days, weeks, months, or years.
def next_due_date(
    anchor: date,
    *,
    interval: int,
    unit: str,
    after: date,
) -> date:
    if interval < 1 or unit not in RECURRENCE_UNITS:
        raise ValueError("Recurrence interval and unit are invalid")
    if unit == "days":
        step_days = interval
        cycles = max(1, (after - anchor).days // step_days + 1)
        return anchor + timedelta(days=cycles * step_days)
    if unit == "weeks":
        step_days = interval * 7
        cycles = max(1, (after - anchor).days // step_days + 1)
        return anchor + timedelta(days=cycles * step_days)

    anchor_month = anchor.year * 12 + anchor.month - 1
    after_month = after.year * 12 + after.month - 1
    step = interval if unit == "months" else interval * 12
    cycles = max(1, (after_month - anchor_month) // step + 1)
    target_month = anchor_month + cycles * step
    year, month_index = divmod(target_month, 12)
    month = month_index + 1
    return date(year, month, min(anchor.day, monthrange(year, month)[1]))

# Checks whether a maintenance record exists for a paritcular schedule and due date, with status.
def _live_occurrence_exists(schedule_id, due_date):
    # A pending occurrence (planned/in progress) for exactly this schedule and due date.
    return exists().where(
        MaintenanceRecord.schedule_id == schedule_id,
        MaintenanceRecord.planned_due_date == due_date,
        MaintenanceRecord.status.in_(("planned", "in_progress")),
    )

# Resolve orphaned maintenance due alerts.
def resolve_orphaned_due_alerts(session: Session) -> int:
    now = datetime.now(timezone.utc)

    orphaned = session.scalars(
        select(Alert)
        .where(
            Alert.maintenance_schedule_id.is_not(None),
            Alert.status == "active",
        )
        .with_for_update()
    ).all()

    resolved_count = 0

    for alert in orphaned:
        schedule = session.get(
            MaintenanceSchedule,
            alert.maintenance_schedule_id,
        )

        # A missing schedule means its maintenance alert is orphaned.
        if schedule is None:
            has_live_occurrence = False

        # Runtime and usage schedules are linked through alert_id
        # because their planned_due_date is NULL.
        elif schedule.schedule_mode in {"runtime", "usage"}:
            linked_records = session.scalars(
                select(MaintenanceRecord)
                .where(
                    MaintenanceRecord.schedule_id == schedule.id,
                    MaintenanceRecord.alert_id == alert.id,
                    MaintenanceRecord.status.in_(("planned", "in_progress")),
                )
                .order_by(MaintenanceRecord.id)
                .limit(2)
            ).all()

            if len(linked_records) == 1:
                live_record = linked_records[0]
                has_live_occurrence = True

                # Restore a missing or stale occurrence pointer.
                if schedule.current_occurrence_id != live_record.id:
                    schedule.current_occurrence_id = live_record.id

                schedule.current_due_date = None
                schedule.due_alerted_for = alert.maintenance_due_date

            elif len(linked_records) > 1:
                # Multiple live records indicate inconsistent data.
                # Keep the alert active and avoid choosing a record blindly.
                has_live_occurrence = True

            else:
                # Backward-compatible fallback: check the existing pointer.
                has_live_occurrence = (
                    schedule.current_occurrence_id is not None
                    and session.scalar(
                        select(MaintenanceRecord.id).where(
                            MaintenanceRecord.id == schedule.current_occurrence_id,
                            MaintenanceRecord.schedule_id == schedule.id,
                            MaintenanceRecord.status.in_(("planned", "in_progress")),
                        )
                    ) is not None
                )
        else:
            has_live_occurrence = (
                session.scalar(
                    select(MaintenanceRecord.id).where(
                        MaintenanceRecord.schedule_id == schedule.id,
                        MaintenanceRecord.planned_due_date == alert.maintenance_due_date,
                        MaintenanceRecord.status.in_(("planned", "in_progress")),
                    ).limit(1)
                )
                is not None
            )

        if not has_live_occurrence:
            alert.status = "resolved"
            alert.resolved_at = now
            alert.last_updated_at = now
            resolved_count += 1

    return resolved_count

# Resolve orphaned alerts , find active schedules with due occurrence, create alert if rqd , send email , commit changes if there any
def emit_due_schedule_events(session: Session, *, today: date) -> int:
    orphans_resolved = resolve_orphaned_due_alerts(session)
    due_schedules = session.scalars(
        select(MaintenanceSchedule)
        .where(
            # No pending occurrence (e.g. it was deleted) means nothing is due.
            _live_occurrence_exists(MaintenanceSchedule.id, MaintenanceSchedule.current_due_date),
            MaintenanceSchedule.schedule_mode == "calendar",
            MaintenanceSchedule.status == "active",
            MaintenanceSchedule.current_due_date <= today,
            MaintenanceSchedule.approval_status.in_(("not_required", "approved")),
        )
        .with_for_update()
    ).all()
    emitted = 0
    changed = orphans_resolved > 0
    now = datetime.now(timezone.utc)
    for schedule in due_schedules:
        state = due_status(schedule.current_due_date, today=today)
        alert = session.scalar(
            select(Alert).where(
                Alert.maintenance_schedule_id == schedule.id,
                Alert.maintenance_due_date == schedule.current_due_date,
                Alert.status == "active",
            )
        )
        alert_title = f"Maintenance {state.replace('_', ' ')}"
        alert_message = f"{schedule.title} was due {schedule.current_due_date}."
        already_alerted = schedule.due_alerted_for == schedule.current_due_date
        if already_alerted and alert is not None:
            if (alert.title != alert_title or alert.message != alert_message):
                alert.title = alert_title
                alert.message = alert_message
                alert.last_updated_at = now
                changed = True
            continue
        if alert is None:
            alert = Alert(
                rule_id=None,
                maintenance_schedule_id=schedule.id,
                maintenance_due_date=schedule.current_due_date,
                target_asset_id=schedule.asset_id,
                severity="warning",
                title=alert_title,
                message=alert_message,
                trigger_value=None,
                threshold=None,
                status="active",
                started_at=now,
                last_updated_at=now,
            )
            session.add(alert)
            session.flush()
            maintenance_asset = session.get(Asset, schedule.asset_id)
            if maintenance_asset is not None:
                enqueue_alert_notifications(session, alert, maintenance_asset, None)
        if already_alerted:
            changed = True
            continue
        emit_event(
            session,
            event_type="maintenance_due",
            message=f"Maintenance {state.replace('_', ' ')}: {schedule.title} was due {schedule.current_due_date}.",
            occurred_at=now,
            asset_id=schedule.asset_id,
            alert_id=alert.id,
            severity="warning",
            metadata={
                "maintenance_schedule_id": schedule.id,
                "due_date": schedule.current_due_date.isoformat(),
            },
        )
        schedule.due_alerted_for = schedule.current_due_date
        emitted += 1
        changed = True
    if changed:
        session.commit()
    return emitted
