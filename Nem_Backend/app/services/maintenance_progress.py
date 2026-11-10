# Implement runtime- and usage-based maintenance progress tracking from machine Boolean signals,
# including running-hour accumulation, cycle counting through False-to-True transitions,
# stale and out-of-order reading protection, signal baseline management, maintenance threshold detection, duplicate alert and occurrence prevention, automatic maintenance record creation, email notifications, and maintenance event generation within the existing database transaction.from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.asset import Asset
from app.models.maintenance import MaintenanceRecord, MaintenanceSchedule
from app.models.reading import Reading
from app.models.rule import Alert
from app.models.variable import Variable
from app.services.email_notifications import enqueue_alert_notifications
from app.services.monitoring_engine import emit_event


def _as_utc(value: datetime) -> datetime:
    """Normalize timestamps before comparing readings."""
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def update_maintenance_progress(
    session: Session,
    readings: list[Reading],
    *,
    stale_after_seconds: int,
) -> int:
    """
    Update runtime- and usage-based maintenance progress.

    This function does not commit. The calling reading-ingestion
    transaction owns the commit or rollback.
    """
    if not readings:
        return 0

    if stale_after_seconds < 1:
        raise ValueError("stale_after_seconds must be positive")

    created_occurrences = 0

    # Process readings in deterministic timestamp and ID order.
    ordered_readings = sorted(
        readings,
        key=lambda item: (_as_utc(item.recorded_at), item.id or 0),
    )

    for reading in ordered_readings:
        if not isinstance(reading.value, bool):
            continue

        schedules = session.scalars(
            select(MaintenanceSchedule)
            .where(
                MaintenanceSchedule.signal_variable_id == reading.variable_id,
                MaintenanceSchedule.asset_id == reading.asset_id,
                MaintenanceSchedule.schedule_mode.in_(("runtime", "usage")),
                MaintenanceSchedule.status == "active",
            )
            .with_for_update()
        ).all()

        for schedule in schedules:
            # Do not accumulate progress while an occurrence is awaiting work.
            if schedule.current_occurrence_id is not None:
                continue

            variable = session.get(Variable, schedule.signal_variable_id)
            if variable is None or not variable.is_active:
                continue

            expected_role = (
                "running" if schedule.schedule_mode == "runtime" else "cycle"
            )
            if variable.data_type != "boolean" or variable.signal_role != expected_role:
                continue

            current_at = _as_utc(reading.recorded_at)

            # Ignore out-of-order or duplicate timestamps.
            previous_at = (
                _as_utc(schedule.last_signal_at)
                if schedule.last_signal_at is not None
                else None
            )
            if previous_at is not None and current_at <= previous_at:
                continue

            elapsed_seconds = (
                (current_at - previous_at).total_seconds()
                if previous_at is not None
                else None
            )
            fresh_previous_sample = (
                elapsed_seconds is not None
                and 0 < elapsed_seconds <= stale_after_seconds
            )

            if schedule.schedule_mode == "runtime":
                # Count only the interval during which the previous sample
                # confirmed that the machine was running.
                if schedule.last_signal_value is True and fresh_previous_sample:
                    schedule.current_progress += elapsed_seconds / 3600.0

                threshold = schedule.runtime_interval_hours

            else:
                # Count only a confirmed False -> True transition.
                # A stale gap cannot establish a reliable cycle transition.
                if (
                    schedule.last_signal_value is False
                    and reading.value is True
                    and fresh_previous_sample
                ):
                    schedule.current_progress += 1.0

                threshold = schedule.usage_interval_count

            # Always move the signal baseline forward.
            schedule.last_signal_value = reading.value
            schedule.last_signal_at = current_at

            if threshold is None or schedule.current_progress < threshold:
                continue


            # The alert constraint requires a non-null maintenance due date.
            occurrence_date = current_at.date()

            # Check all active alerts for this schedule, not only today's alert.
            active_alerts = session.scalars(
                select(Alert)
                .where(
                    Alert.maintenance_schedule_id == schedule.id,
                    Alert.status == "active",
                )
                .order_by(Alert.id)
                .with_for_update()
            ).all()

            # Check whether a live occurrence already exists for this schedule.
            live_records = session.scalars(
                select(MaintenanceRecord)
                .where(
                    MaintenanceRecord.schedule_id == schedule.id,
                    MaintenanceRecord.status.in_(("planned", "in_progress")),
                )
                .order_by(MaintenanceRecord.id)
                .with_for_update()
            ).all()

            if len(live_records) == 1:
                # Restore the pointer instead of creating a duplicate occurrence.
                live_record = live_records[0]
                schedule.current_occurrence_id = live_record.id
                schedule.current_due_date = None

                linked_alert = next(
                    (
                        item for item in active_alerts
                        if item.id == live_record.alert_id
                    ),
                    None,
                )

                schedule.due_alerted_for = (
                    linked_alert.maintenance_due_date
                    if linked_alert is not None
                    else occurrence_date
                )
                continue

            if len(live_records) > 1:
                # Multiple live records indicate inconsistent data.
                # Do not create another occurrence or choose a record blindly.
                continue

            if len(active_alerts) > 1:
                # Multiple active alerts also require manual reconciliation.
                continue

            alert_created = False

            if active_alerts:
                # Reuse the existing active alert if it has no live occurrence.
                alert = active_alerts[0]
            else:
                alert = Alert(
                    rule_id=None,
                    maintenance_schedule_id=schedule.id,
                    maintenance_due_date=occurrence_date,
                    target_asset_id=schedule.asset_id,
                    target_variable_id=schedule.signal_variable_id,
                    severity="warning",
                    title=(
                        "Runtime maintenance due"
                        if schedule.schedule_mode == "runtime"
                        else "Usage maintenance due"
                    ),
                    message=(
                        f"{schedule.title} reached its "
                        f"{threshold} {'running hours' if schedule.schedule_mode == 'runtime' else 'cycles'} "
                        f"maintenance interval."
                    ),
                    trigger_value=schedule.current_progress,
                    threshold=Decimal(str(threshold)),
                    status="active",
                    started_at=current_at,
                    last_updated_at=current_at,
                )
                session.add(alert)
                session.flush()
                alert_created = True

            # Create an occurrence only after confirming no live record exists.
            record = MaintenanceRecord(
                asset_id=schedule.asset_id,
                summary=schedule.title,
                notes=schedule.description,
                performed_by=schedule.assigned_technician or "Unassigned",
                maintenance_type=schedule.maintenance_type,
                status="planned",
                planned_start_at=current_at,
                planned_end_at=current_at,
                planned_due_date=None,
                priority=schedule.priority,
                assigned_technician=schedule.assigned_technician,
                schedule_id=schedule.id,
                alert_id=alert.id,
            )
            session.add(record)
            session.flush()

            schedule.current_occurrence_id = record.id
            schedule.current_due_date = None
            schedule.due_alerted_for = alert.maintenance_due_date

            asset = session.get(Asset, schedule.asset_id)
            if asset is not None and alert_created:
                enqueue_alert_notifications(session, alert, asset, None)

            emit_event(
                session,
                event_type=(
                    "maintenance_runtime_due"
                    if schedule.schedule_mode == "runtime"
                    else "maintenance_usage_due"
                ),
                message=alert.message,
                occurred_at=current_at,
                asset_id=schedule.asset_id,
                alert_id=alert.id,
                severity="warning",
                metadata={
                    "maintenance_schedule_id": schedule.id,
                    "maintenance_record_id": record.id,
                    "schedule_mode": schedule.schedule_mode,
                    "progress": schedule.current_progress,
                    "threshold": threshold,
                    "progress_unit": (
                        "hours" if schedule.schedule_mode == "runtime" else "cycles"
                    ),
                    "signal_variable_id": schedule.signal_variable_id,
                },
            )

            created_occurrences += 1

    return created_occurrences