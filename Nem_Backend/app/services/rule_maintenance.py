# Creation and sync of maintenance schedules from eligible rules.
from __future__ import annotations
import logging
from datetime import date, datetime, timezone
from typing import Any
from sqlalchemy import event, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, attributes
from app.models import Alert, Asset, MaintenanceRecord, MaintenanceSchedule, MonitoringRule, RuleParameter, RuleParameterState
from app.services.email_notifications import enqueue_alert_notifications
from app.core.config import get_settings
from app.services.monitoring_engine import emit_event
from app.services.rule_parameters import (_aware, _refresh_rule_state, calendar_last_reset_at, change_parameter_lifecycle, effective_stale_after,)
from app.core.constants import (
    APPROVAL_NOT_REQUIRED,
    CATEGORY_INTERVAL_BASED,
    COUNTER,
    ELIGIBILITY_NOT_DUE,
    ELIGIBILITY_READY,
    EVENT_ALERT_RESOLVED,
    INTERVAL,
    INTERVAL_PARAMETER,
    PROGRESS_RESET,
    PROGRESS_RETAINED,
    RULE_MULTI_PARAMETER,
    RULE_TYPE,
    SCHEDULE_MODE_RULE,
    STATUS_ACTIVE,
    STATUS_ALERT,
    STATUS_CANCELLED,
    STATUS_COMPLETED,
    STATUS_DEACTIVATED,
    STATUS_IN_PROGRESS,
    STATUS_NORMAL,
    STATUS_PLANNED,
    STATUS_RESOLVED,
    STATUS_SUSPENDED,
    STATUS_UNKNOWN,
    TIME,
    STATUS_WARNING,
)
from app.services.rule_calendar import (calendar_cycle,)

LOGGER = logging.getLogger(__name__)

MODE = SCHEDULE_MODE_RULE
# Parameter statuses that mean "Due reached" (warning = Due, alert = Overdue), as produced by interval_status().
DUE_STATUSES = {STATUS_WARNING, STATUS_ALERT}
# A displayed progress value is only rewritten when it moved by at least this much (running hours / cycles),
# so a continuously running machine does not rewrite the schedule on every evaluation pass.
_PROGRESS_STEP = {"hours": 0.01, "cycles": 1.0}
# Start only tolerates a saved timestamp this far ahead of the current time (clock difference between backend instances).
_START_CLOCK_SKEW_SECONDS = 5.0

def _now() -> datetime:
    return datetime.now(timezone.utc)

# Determines whether a rule can create maintenance schedules.
def is_eligible_rule(rule: MonitoringRule) -> bool:
    return (
        rule.rule_type == RULE_MULTI_PARAMETER
        and rule.target_asset_id is not None
        and (rule.parameters or {}).get("category") == CATEGORY_INTERVAL_BASED
    )


def _unit(parameter: RuleParameter) -> str:
    config = parameter.config or {}

    if (
        config.get(INTERVAL_PARAMETER) == TIME
        and config.get("time_mode") == "calendar"
    ):
        return config.get("time_unit", "days")

    return "cycles" if config.get(INTERVAL_PARAMETER) == COUNTER else "hours"

# Checks rule and parameter lifecycle.
def _rule_running(rule: MonitoringRule, parameter: RuleParameter) -> bool:
    return (
        bool(rule.is_enabled)
        and rule.lifecycle_status == STATUS_IN_PROGRESS
        and parameter.lifecycle_status == STATUS_ACTIVE
    )

# Finds the active schedule for a parameter.
def _open_schedule(session: Session, parameter_id: int) -> MaintenanceSchedule | None:
   # The one open (not completed, not cancelled) schedule of a parameter, locked for update
    return session.scalar(
        select(MaintenanceSchedule)
        .where(MaintenanceSchedule.source_parameter_id == parameter_id, MaintenanceSchedule.status == STATUS_ACTIVE)
        .with_for_update()
    )

# Finds the latest historical schedule.
def _last_schedule(session: Session, parameter_id: int) -> MaintenanceSchedule | None:
    return session.scalar(
        select(MaintenanceSchedule)
        .where(MaintenanceSchedule.source_parameter_id == parameter_id)
        .order_by(MaintenanceSchedule.id.desc())
        .limit(1)
    )

# Retrieves the maintenance job for a schedule, if any.
def _job(session: Session, schedule: MaintenanceSchedule) -> MaintenanceRecord | None:
    if schedule.current_occurrence_id is None:
        return None
    return session.get(MaintenanceRecord, schedule.current_occurrence_id)

# Builds the context dictionary that is stored in the maintenance job for a rule-based schedule.
def _context(schedule: MaintenanceSchedule) -> dict[str, Any]:
    return {
        "rule_id": schedule.source_rule_id,
        "rule_name": schedule.source_rule_name,
        RULE_TYPE: schedule.source_rule_type,
        "parameter_id": schedule.source_parameter_id,
        "parameter_name": schedule.source_parameter_name,
        "due_threshold": schedule.due_threshold,
        "overdue_threshold": schedule.overdue_threshold,
        "threshold_unit": schedule.threshold_unit,
        "due_value": schedule.due_value,
        "became_due_at": schedule.became_due_at.isoformat() if schedule.became_due_at else None,
        "schedule_created_at": schedule.created_at.isoformat() if schedule.created_at else None,
    }

# Synchronizes the job's eligibility and context with the schedule.
def _sync_job(schedule: MaintenanceSchedule, job: MaintenanceRecord | None) -> None:
    if job is None:
        return
    job.start_eligibility = schedule.eligibility or ELIGIBILITY_NOT_DUE
    job.rule_context = _context(schedule)

# Emits an event about a schedule or job.
def _event(session: Session, schedule: MaintenanceSchedule, event_type: str, message: str, now: datetime,
           alert: Alert | None = None, link_rule: bool = True) -> None:
    emit_event(
        session, event_type=event_type, message=message, occurred_at=now,
        asset_id=schedule.asset_id, rule_id=schedule.source_rule_id if link_rule else None,
        alert_id=alert.id if alert is not None else None, severity=STATUS_WARNING if alert is not None else None,
        metadata={"maintenance_schedule_id": schedule.id, "parameter_id": schedule.source_parameter_id,
                  "eligibility": schedule.eligibility},
    )

# Validates that a rule and parameter are consistent and exist in the database.
def _valid_relationship(session: Session, rule: MonitoringRule, parameter: RuleParameter) -> bool:

    if rule.id is None or parameter.id is None or parameter.rule_id != rule.id or parameter.kind != INTERVAL:
        return False
    if not is_eligible_rule(rule) or (parameter.config or {}).get("due") is None:
        return False
    row = session.execute(
        select(MonitoringRule.target_asset_id, RuleParameter.id)
        .join(RuleParameter, RuleParameter.rule_id == MonitoringRule.id)
        .where(MonitoringRule.id == rule.id, RuleParameter.id == parameter.id)
    ).first()
    if row is None or row[0] != rule.target_asset_id:
        return False
    return session.scalar(select(Asset.id).where(Asset.id == rule.target_asset_id)) is not None

# Creates a new maintenance schedule and its first job, without checking for existing schedules.
def _create_schedule_unsafe(session: Session, rule: MonitoringRule, parameter: RuleParameter, now: datetime) -> MaintenanceSchedule:
    config = parameter.config or {}
    today = now.date()
    parameter.maintenance_scheduled_at = now
    is_calendar_time = (
        parameter.kind == INTERVAL
        and config.get(INTERVAL_PARAMETER) == TIME
        and config.get("time_mode") == "calendar"
    )

    if is_calendar_time:
        last_completed_at = calendar_last_reset_at(session, parameter.id, parameter.cycle_baseline_at)
        baseline, first_due, _ = calendar_cycle(config, last_completed_at)
        calendar_start = baseline.date() if isinstance(baseline, datetime) else baseline
        calendar_first_due = first_due.date() if isinstance(first_due, datetime) else first_due
    else:
        calendar_start = today
        calendar_first_due = today
    schedule = MaintenanceSchedule(
        asset_id=rule.target_asset_id,
        title=f"{rule.name} – {parameter.name}"[:200],
        maintenance_type="preventive",
        priority="medium",
        description=rule.description,
        instruction_document_ids=list((rule.parameters or {}).get("document_ids") or []),
        schedule_mode=MODE,
        status=STATUS_ACTIVE,
        approval_status=APPROVAL_NOT_REQUIRED,
        schedule_start_date=calendar_start,
        current_period_start_date=calendar_start,
        first_due_date=calendar_first_due,
        current_progress=0.0,
        recurrence_enabled=False,
        source_rule_id=rule.id,
        source_parameter_id=parameter.id,
        source_parameter_key=parameter.key,
        source_rule_name=rule.name,
        source_parameter_name=parameter.name,
        source_rule_type=CATEGORY_INTERVAL_BASED,
        eligibility=ELIGIBILITY_NOT_DUE,
        due_threshold=float(config["due"]) if config.get("due") is not None else None,
        overdue_threshold=float(config["overdue"]) if config.get("overdue") is not None else None,
        threshold_unit=_unit(parameter),
        created_at=now,
    )
    session.add(schedule)
    session.flush()
    job = MaintenanceRecord(
        asset_id=schedule.asset_id, summary=schedule.title, notes=schedule.description,
        performed_by="Unassigned", maintenance_type=schedule.maintenance_type, status=STATUS_PLANNED,
        # Sets the initial planned dates, using the calculated calendar due date when applicable.
        planned_start_at=now,
        planned_end_at=now,
        planned_due_date=calendar_first_due if is_calendar_time else None,
        priority=schedule.priority,
        schedule_id=schedule.id, start_eligibility=ELIGIBILITY_NOT_DUE,
    )
    session.add(job)
    session.flush()
    schedule.current_occurrence_id = job.id
    _sync_job(schedule, job)
    _event(session, schedule, "maintenance_schedule_created",f"Maintenance schedule created for {schedule.title}; it can start once the rule reaches Due.", now)
    return schedule

# Creates a schedule safely.
def _create_schedule(session: Session, rule: MonitoringRule, parameter: RuleParameter, now: datetime) -> MaintenanceSchedule | None:

    if not _valid_relationship(session, rule, parameter):
        LOGGER.warning("Not creating a maintenance schedule: rule %s / parameter %s is missing or inconsistent",
                       rule.id, parameter.id)
        return None
    try:
        with session.begin_nested():
            return _create_schedule_unsafe(session, rule, parameter, now)
    except IntegrityError:
        LOGGER.info("Schedule for parameter %s was created concurrently; keeping the existing one", parameter.id)
        return None

# Cancels an unfinished Not due schedule.
def _close(session: Session, schedule: MaintenanceSchedule, job: MaintenanceRecord | None, now: datetime, reason: str,
           link_rule: bool = True) -> None:
   # Cancel an unfinished, not yet started schedule. Its history stays; nothing is deleted.
    schedule.status = STATUS_CANCELLED
    if job is not None and job.status == STATUS_PLANNED:
        job.status = STATUS_CANCELLED
        job.completion_notes = reason
    alert = session.scalar(select(Alert).where(
        Alert.maintenance_schedule_id == schedule.id, Alert.status == STATUS_ACTIVE).with_for_update())
    if alert is not None:
        alert.status, alert.resolved_at, alert.last_updated_at = STATUS_RESOLVED, now, now
    _event(session, schedule, "maintenance_schedule_cancelled", f"{schedule.title}: {reason}", now, link_rule=link_rule)

# Sync schedule thresholds and names.
def _refresh_thresholds(session: Session, schedule: MaintenanceSchedule, rule: MonitoringRule,
                        parameter: RuleParameter, now: datetime) -> None:

    config = parameter.config or {}
    due = float(config["due"]) if config.get("due") is not None else None
    overdue = float(config["overdue"]) if config.get("overdue") is not None else None
    changed = (due, overdue) != (schedule.due_threshold, schedule.overdue_threshold)
    schedule.source_rule_name, schedule.source_parameter_name = rule.name, parameter.name
    schedule.source_parameter_key = parameter.key
    schedule.title = f"{rule.name} – {parameter.name}"[:200]
    if not changed:
        job = _job(session, schedule)
        if job is not None and job.status == STATUS_PLANNED:
            job.summary = schedule.title
        return
    schedule.due_threshold, schedule.overdue_threshold = due, overdue
    schedule.threshold_unit = _unit(parameter)
    job = _job(session, schedule)
    if schedule.eligibility == ELIGIBILITY_READY and job is not None and job.status == STATUS_PLANNED:
        schedule.eligibility, schedule.became_due_at, schedule.due_value = ELIGIBILITY_NOT_DUE, None, None
        alert = session.scalar(select(Alert).where(
            Alert.maintenance_schedule_id == schedule.id, Alert.status == STATUS_ACTIVE).with_for_update())
        if alert is not None:
            alert.status, alert.resolved_at, alert.last_updated_at = STATUS_RESOLVED, now, now
        job.alert_id = None
        _event(session, schedule, "maintenance_eligibility_reset",
               f"{schedule.title}: the Due limit changed, so Start is locked until the rule reaches Due again.", now)
    if job is not None and job.status == STATUS_PLANNED:
        # Work already started keeps the Due information it began with.
        job.summary = schedule.title
        _sync_job(schedule, job)

# Sync schedules after rule changes.
def sync_rule_schedules(session: Session, rule: MonitoringRule, now: datetime | None = None) -> None:
    if not is_eligible_rule(rule):
        if rule.id is None:
            return
        now = now or _now()
        for schedule in session.scalars(select(MaintenanceSchedule).where(
                MaintenanceSchedule.source_rule_id == rule.id, MaintenanceSchedule.status == STATUS_ACTIVE,
                MaintenanceSchedule.eligibility == ELIGIBILITY_NOT_DUE).with_for_update()).all():
            _close(session, schedule, _job(session, schedule), now,
                   "The monitoring rule is no longer an interval-based rule, so this maintenance was cancelled before it became due.")
        return
    now = now or _now()
    for parameter in list(rule.parameter_items):
        if parameter.kind != INTERVAL or parameter.id is None:
            continue
        schedule = _open_schedule(session, parameter.id)
        running = _rule_running(rule, parameter)
        if schedule is None:
            if not running:
                continue
            last = _last_schedule(session, parameter.id)
            first = last is None and parameter.maintenance_scheduled_at is None
            if first or (last is not None and last.status == STATUS_CANCELLED):
                _create_schedule(session, rule, parameter, now)
            continue
        _refresh_thresholds(session, schedule, rule, parameter, now)
        # Only deactivation cancels; a suspended rule also has is_enabled False but keeps every schedule untouched.
        deactivated = rule.lifecycle_status == STATUS_DEACTIVATED or parameter.lifecycle_status == STATUS_DEACTIVATED
        if deactivated and schedule.eligibility == ELIGIBILITY_NOT_DUE:
            _close(session, schedule, _job(session, schedule), now, "The monitoring rule was deactivated before this maintenance became due.")

# Cancels eligible schedules for removed rules/parameters.
def cancel_for_removed(session: Session, *, parameter_ids: set[int], rule_ids: set[int], now: datetime | None = None) -> None:
    if not parameter_ids and not rule_ids:
        return
    now = now or _now()
    conditions = []
    if parameter_ids:
        conditions.append(MaintenanceSchedule.source_parameter_id.in_(parameter_ids))
    if rule_ids:
        conditions.append(MaintenanceSchedule.source_rule_id.in_(rule_ids))
    for schedule in session.scalars(select(MaintenanceSchedule).where(
            MaintenanceSchedule.status == STATUS_ACTIVE, MaintenanceSchedule.eligibility == ELIGIBILITY_NOT_DUE, or_(*conditions)).with_for_update()).all():
        # link_rule=False: the rule row is being deleted in this same flush, so the event must not point at it.
        _close(session, schedule, _job(session, schedule), now,"The monitoring rule or parameter was removed before this maintenance became due.", link_rule=False)

# Applies the authoritative parameter evaluation result.
def apply_evaluation(session: Session, rule: MonitoringRule, parameter: RuleParameter, status: str,
                     value: Any, now: datetime) -> bool:

    if parameter.kind != INTERVAL or parameter.id is None or not is_eligible_rule(rule):
        return False
    if status == STATUS_UNKNOWN:  # a stale or unavailable signal says nothing about Due either way
        return False
    number = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
    schedule = _open_schedule(session, parameter.id)
    if schedule is None:
        last = _last_schedule(session, parameter.id)
        first = last is None and parameter.maintenance_scheduled_at is None
        marker = parameter.maintenance_scheduled_at
        # A job completed WITHOUT a progress reset never starts a new cycle by itself (the user declined it).
        next_cycle = (last is not None and last.status == STATUS_COMPLETED and status == STATUS_NORMAL
                      and last.progress_reset != PROGRESS_RETAINED
                      and (marker is None or last.updated_at is None or marker <= last.updated_at))
        if _rule_running(rule, parameter) and (first or next_cycle):
            schedule = _create_schedule(session, rule, parameter, now)
            if schedule is None:
                return False
        else:
            return False
    if schedule.created_at is not None and _aware(now) < _aware(schedule.created_at):
        return False  # calculated before this cycle began (a confirmed reset was committed meanwhile): not for this cycle
    job = _job(session, schedule)
    became_ready = False
    unit = schedule.threshold_unit or _unit(parameter)
    if number is not None and schedule.eligibility == ELIGIBILITY_NOT_DUE:
        step = _PROGRESS_STEP.get(unit, 0.01)
        if abs(number - (schedule.current_progress or 0.0)) >= step:
            schedule.current_progress = max(0.0, number)
    if status in DUE_STATUSES:
        if schedule.eligibility == ELIGIBILITY_NOT_DUE and job is not None and job.status == STATUS_PLANNED:
            _make_ready(session, rule, parameter, schedule, job, number, now)
            became_ready = True
    elif status == STATUS_NORMAL and schedule.eligibility == ELIGIBILITY_READY and job is not None and job.status == STATUS_PLANNED:
        # Below Due again before anyone started the work (for example the limit was raised): Start must lock.
        schedule.eligibility, schedule.became_due_at, schedule.due_value = ELIGIBILITY_NOT_DUE, None, None
        alert = session.scalar(select(Alert).where(
            Alert.maintenance_schedule_id == schedule.id, Alert.status == STATUS_ACTIVE).with_for_update())
        if alert is not None:
            alert.status, alert.resolved_at, alert.last_updated_at = STATUS_RESOLVED, now, now
        job.alert_id = None
        _sync_job(schedule, job)
        _event(session, schedule, "maintenance_eligibility_reset",
               f"{schedule.title}: the parameter is below Due again, so Start is locked.", now)
    return became_ready

# Marks a schedule as ready and creates an alert.
def _make_ready(session: Session, rule: MonitoringRule, parameter: RuleParameter, schedule: MaintenanceSchedule,
                job: MaintenanceRecord, value: float | None, now: datetime) -> None:
    schedule.eligibility = ELIGIBILITY_READY
    schedule.became_due_at = now
    schedule.due_value = value
    if value is not None:
        schedule.current_progress = max(0.0, value)
    unit = schedule.threshold_unit or ""
    shown = "n/a" if value is None else f"{value:g} {unit}".strip()
    alert = Alert(
        rule_id=None,
        maintenance_schedule_id=schedule.id,
        maintenance_due_date=now.date(),
        target_asset_id=schedule.asset_id,
        severity=STATUS_WARNING,
        title=f"Maintenance ready to start: {schedule.title}"[:200],
        message=f"{schedule.title}: the rule reached its Due limit ({shown}). Maintenance can now be started.",
        trigger_value=value,
        status=STATUS_ACTIVE,
        started_at=now,
        last_updated_at=now,
    )
    session.add(alert)
    session.flush()
    job.alert_id = alert.id
    _sync_job(schedule, job)
    _event(session, schedule, "maintenance_ready_to_start", alert.message, now, alert)
    asset = session.get(Asset, schedule.asset_id)
    if asset is None:
        return
    from app.core.config import get_settings

    settings = get_settings()
    base = (settings.frontend_base_url or "").rstrip("/")
    enqueue_alert_notifications(session, alert, asset, None, None, extra={
        "notification_kind": "maintenance_ready",
        "rule_name": rule.name,
        RULE_TYPE: "Interval based",
        "parameter_name": parameter.name,
        "due_threshold": schedule.due_threshold,
        "overdue_threshold": schedule.overdue_threshold,
        "threshold_unit": schedule.threshold_unit,
        "schedule_id": schedule.id,
        "link": f"{base}/assets/{asset.id}/maintenance/schedules/{schedule.id}/details" if base else None,
    })

# Cancels a schedule whose rule and parameter are no longer available.  
def cancel_unavailable(session: Session, schedule_id: int, *, user_id: int | None, user_name: str, reason: str,
                       now: datetime | None = None) -> MaintenanceSchedule:
    now = now or _now()
    schedule = session.scalar(select(MaintenanceSchedule).where(MaintenanceSchedule.id == schedule_id)
                              .with_for_update().execution_options(populate_existing=True))
    if schedule is None:
        raise LookupError("The maintenance schedule was not found.")
    if schedule.schedule_mode != MODE:
        raise ValueError("Only schedules created from a monitoring rule can be cancelled this way.")
    if schedule.status != STATUS_ACTIVE:
        raise ValueError("Only an active schedule can be cancelled.")
    job = session.scalar(select(MaintenanceRecord).where(MaintenanceRecord.id == schedule.current_occurrence_id)
                         .with_for_update().execution_options(populate_existing=True)) if schedule.current_occurrence_id else None
    if job is None or job.status != STATUS_PLANNED:
        raise ValueError("Only a schedule whose maintenance has not been started can be cancelled. "
                         "Maintenance in progress must be completed.")
    available = False
    if schedule.source_rule_id is not None and schedule.source_parameter_id is not None:
        available = session.scalar(select(RuleParameter.id).where(
            RuleParameter.id == schedule.source_parameter_id, RuleParameter.rule_id == schedule.source_rule_id)) is not None
    if available:
        raise ValueError("The monitoring rule and parameter still exist, so this schedule cannot be cancelled here. "
                         "Deactivate the rule instead.")
    schedule.status = STATUS_CANCELLED
    schedule.cancelled_at, schedule.cancelled_by_id, schedule.cancelled_by_name = now, user_id, user_name
    schedule.cancellation_reason, schedule.cancellation_kind = reason, "rule_unavailable"
    job.status = STATUS_CANCELLED
    job.completion_notes = f"Cancelled: {reason}"
    alert = session.scalar(select(Alert).where(
        Alert.maintenance_schedule_id == schedule.id, Alert.status == STATUS_ACTIVE).with_for_update())
    if alert is not None:
        alert.status, alert.resolved_at, alert.last_updated_at = STATUS_RESOLVED, now, now
    _event(session, schedule, "maintenance_schedule_cancelled",
           f"{schedule.title}: cancelled by {user_name} because its monitoring rule is no longer available. Reason: {reason}",
           now, link_rule=False)
    return schedule

# Find and validate the monitoring rule and parameter associated with a maintenance schedule before resetting their progress.
def prepare_progress_reset(session: Session, schedule: MaintenanceSchedule) -> tuple[MonitoringRule, RuleParameter]:
    gone = ("The monitoring rule or parameter this maintenance was created from no longer exists, so its progress "
            "cannot be reset. Complete the maintenance without a reset.")
    if schedule.source_rule_id is None or schedule.source_parameter_id is None:
        raise ValueError(gone)
    rule = session.scalar(select(MonitoringRule).where(MonitoringRule.id == schedule.source_rule_id)
                          .with_for_update().execution_options(populate_existing=True))
    parameter = session.scalar(select(RuleParameter).where(RuleParameter.id == schedule.source_parameter_id,
                                                           RuleParameter.rule_id == schedule.source_rule_id)
                               .with_for_update().execution_options(populate_existing=True))
    if rule is None or parameter is None:
        raise ValueError(gone)
    if not is_eligible_rule(rule) or not _valid_relationship(session, rule, parameter):
        raise ValueError("The monitoring rule is no longer an interval-based rule for this parameter, so its progress "
                         "cannot be reset. Complete the maintenance without a reset.")
    return rule, parameter

# Stop the maintenance cycle when an operator chooses complete without reset.
def _stop_retained_cycle(session: Session, schedule: MaintenanceSchedule, now: datetime, meta: dict[str, Any]) -> None:
    if schedule.source_rule_id is None or schedule.source_parameter_id is None:
        return  # the rule or parameter was deleted: nothing is left to stop
    rule = session.scalar(select(MonitoringRule).where(MonitoringRule.id == schedule.source_rule_id)
                          .with_for_update().execution_options(populate_existing=True))
    parameter = session.scalar(select(RuleParameter).where(RuleParameter.id == schedule.source_parameter_id,
                                                           RuleParameter.rule_id == schedule.source_rule_id)
                               .with_for_update().execution_options(populate_existing=True))
    if rule is None or parameter is None:
        return
    if parameter.lifecycle_status in (STATUS_ACTIVE, STATUS_SUSPENDED):
        change_parameter_lifecycle(session, rule, parameter, "deactivate", now)
    if rule.is_enabled and not any(item.lifecycle_status == STATUS_ACTIVE for item in rule.parameter_items):
        from app.services.monitoring_engine import set_rule_enabled_state

        set_rule_enabled_state(session, rule, False, at=now)  # also deactivates the rule and closes its open alerts
        emit_event(session, event_type="rule_deactivated", occurred_at=now,
                   message=(f"Rule '{rule.name}' was deactivated after maintenance was completed without resetting "
                            "progress. Its progress is kept; start a new cycle explicitly."),
                   asset_id=schedule.asset_id, rule_id=rule.id, metadata=meta)
    session.flush()


# The one implementation of "restart this interval's progress", used by the maintenance reset below and by the manual
# reset: the cycle baseline (unless the caller derives it elsewhere), the saved checkpoint, the parameter state, and the
# alerts of THIS parameter only. Callers emit their own audit event and decide about the maintenance schedule.
def _reset_interval_progress(session: Session, rule: MonitoringRule, parameter: RuleParameter, *, now: datetime,
                             set_baseline: bool, state_message: str, alert_note: str, outcome: str,
                             asset_id: int | None, meta: dict[str, Any]) -> None:
    if set_baseline:
        parameter.cycle_baseline_at = now
    state = session.scalar(select(RuleParameterState).where(RuleParameterState.parameter_id == parameter.id)
                           .with_for_update().execution_options(populate_existing=True))
    if state is not None:
        state.aggregate_state = None
        state.status, state.latest_value, state.error_message = STATUS_NORMAL, 0.0, None
        state.message = state_message
        state.last_evaluated_at = now
        state.completed_at = None
    for alert in session.scalars(select(Alert).where(
            Alert.rule_id == rule.id, Alert.parameter_id == parameter.id, Alert.status == STATUS_ACTIVE).with_for_update()).all():
        alert.status, alert.resolved_at, alert.last_updated_at = STATUS_RESOLVED, now, now
        emit_event(session, event_type=EVENT_ALERT_RESOLVED, occurred_at=now,
                   message=f"Alert resolved: {rule.name} — {parameter.name} ({alert_note}).",
                   asset_id=asset_id, rule_id=rule.id, alert_id=alert.id, severity=alert.severity,
                   metadata={**meta, "outcome": outcome})


# Why an interval cannot be reset manually right now (None = it can). Locks the parameter's open schedule.
def manual_reset_problem(session: Session, rule: MonitoringRule, parameter: RuleParameter) -> str | None:
    if not is_eligible_rule(rule) or parameter.kind != INTERVAL:
        return "Only interval parameters of interval-based rules have progress to reset."
    if not _valid_relationship(session, rule, parameter):
        return "The rule and parameter are inconsistent, so the progress cannot be reset."
    if not rule.is_enabled or rule.lifecycle_status != STATUS_IN_PROGRESS:
        return f"The rule is {rule.lifecycle_status.replace('_', ' ')}; activate it before resetting progress."
    if parameter.lifecycle_status != STATUS_ACTIVE:
        return f"The parameter is {parameter.lifecycle_status}; activate it before resetting progress."
    job = _job(session, schedule) if (schedule := _open_schedule(session, parameter.id)) is not None else None
    if job is not None and job.status == STATUS_IN_PROGRESS:
        return "Maintenance for this interval is in progress. Complete it (with or without a reset) instead."
    return None


# Manual reset of one interval: no maintenance is completed. An unstarted maintenance schedule of the interval is
# cancelled (its ready alert resolved) and a fresh one is created for the new cycle, so nothing is duplicated.
def manual_reset_parameter(session: Session, rule: MonitoringRule, parameter: RuleParameter, *, user_id: int | None,
                           user_name: str, scope: str, now: datetime | None = None) -> dict[str, Any]:
    now = now or _now()
    problem = manual_reset_problem(session, rule, parameter)
    if problem:
        raise ValueError(problem)
    state = session.scalar(select(RuleParameterState).where(RuleParameterState.parameter_id == parameter.id))
    meta = {"rule_id": rule.id, "rule_name": rule.name, "parameter_id": parameter.id, "parameter_key": parameter.key,
            "parameter_name": parameter.name, "reset_by_id": user_id, "reset_by": user_name, "reset_at": now.isoformat(),
            "scope": scope, "previous_status": state.status if state else None,
            "previous_value": state.latest_value if state else None, "cycle_baseline_at": now.isoformat()}
    schedule = _open_schedule(session, parameter.id)
    if schedule is not None:
        _close(session, schedule, _job(session, schedule), now,
               "Progress was reset manually before this maintenance was started.")
        schedule.cancelled_at, schedule.cancelled_by_id, schedule.cancelled_by_name = now, user_id, user_name
        schedule.cancellation_reason, schedule.cancellation_kind = "Progress was reset manually.", "progress_reset"
        meta["cancelled_schedule_id"] = schedule.id
        session.flush()
    _reset_interval_progress(
        session, rule, parameter, now=now, set_baseline=True,
        state_message=f"Progress was reset manually by {user_name}; counting restarted at {now.isoformat()}.",
        alert_note="progress reset manually", outcome="manual_progress_reset", asset_id=rule.target_asset_id, meta=meta)
    emit_event(session, event_type="interval_progress_reset_manual", occurred_at=now,
               message=f"Progress of '{parameter.name}' in rule '{rule.name}' was reset manually by {user_name} ({scope}).",
               asset_id=rule.target_asset_id, rule_id=rule.id, metadata=meta)
    session.flush()
    _refresh_rule_state(session, rule, now)
    if _rule_running(rule, parameter) and _open_schedule(session, parameter.id) is None:
        new = _create_schedule(session, rule, parameter, now)
        meta["new_schedule_id"] = new.id if new is not None else None
    return meta


# Main decision making func. decides what happens after the operator completes maintenance.
def apply_completion_decision(session: Session, schedule: MaintenanceSchedule, *, reset_progress: bool,
                              completed_at: datetime, now: datetime, user_name: str) -> MaintenanceSchedule | None:
    meta = {"maintenance_schedule_id": schedule.id, "parameter_id": schedule.source_parameter_id,
            "completed_by": user_name, "completed_at": completed_at.isoformat(), "reset_progress": bool(reset_progress)}
    schedule.progress_reset_at = now
    if not reset_progress:
        schedule.progress_reset = PROGRESS_RETAINED
        emit_event(session, event_type="maintenance_completed_without_reset", occurred_at=now,
                   message=(f"{schedule.title}: maintenance completed without resetting progress. The accumulated "
                            "progress is kept and no new maintenance cycle was started."),
                   asset_id=schedule.asset_id, rule_id=schedule.source_rule_id, metadata=meta)
        _stop_retained_cycle(session, schedule, now, meta)
        return None
    rule, parameter = prepare_progress_reset(session, schedule)
    schedule.progress_reset = PROGRESS_RESET
    config = parameter.config or {}

    is_calendar_time = (
        parameter.kind == INTERVAL
        and config.get(INTERVAL_PARAMETER) == TIME
        and config.get("time_mode") == "calendar"
    )

    # Calendar Time does not use cycle_baseline_at here: its next cycle is derived by calendar_cycle() from the actual
    # completion time of this reset (schedule.last_completed_at, flushed above), so Due and Overdue are the
    # configured intervals after that moment. Other interval types use the cycle baseline.
    _reset_interval_progress(
        session, rule, parameter, now=now, set_baseline=not is_calendar_time,
        state_message=(
            f"Maintenance completed. The next calendar cycle starts from the maintenance completion time "
            f"({_aware(completed_at).astimezone(timezone.utc).isoformat()})."
            if is_calendar_time
            else f"Progress was reset after maintenance; counting restarted at {now.isoformat()}."
        ),
        alert_note="maintenance completed and progress reset", outcome="maintenance_progress_reset",
        asset_id=schedule.asset_id, meta=meta)
    emit_event(session, event_type="maintenance_completed_progress_reset", occurred_at=now,
               message=f"{schedule.title}: maintenance completed and progress reset. A new maintenance cycle starts from zero.",
               asset_id=schedule.asset_id, rule_id=rule.id, metadata={**meta, "cycle_baseline_at": now.isoformat()})
    session.flush()
    _refresh_rule_state(session, rule, now)

    if _rule_running(rule, parameter) and _open_schedule(session, parameter.id) is None:
        return _create_schedule(session, rule, parameter, now)
    return None

# Verfies that a job may start. Validate whether an operator allowed to start a maintenance job.
def ensure_startable(session: Session, record: MaintenanceRecord) -> None:
    if record.schedule_id is None:
        return  # not rule-controlled
    schedule = session.scalar(select(MaintenanceSchedule).where(MaintenanceSchedule.id == record.schedule_id)
                              .with_for_update().execution_options(populate_existing=True))
    if schedule is None or schedule.schedule_mode != MODE:
        return  # calendar, runtime, usage and manual maintenance keep their own rules
    if record.start_eligibility != ELIGIBILITY_READY or schedule.eligibility != ELIGIBILITY_READY:
        raise ValueError("This maintenance is not due yet. It can be started once its rule reaches Due.")
    if schedule.status != STATUS_ACTIVE or schedule.current_occurrence_id != record.id:
        raise ValueError("This maintenance is no longer the active occurrence of its schedule.")
    gone = ("The monitoring rule or parameter this maintenance was created from has been deleted, so it can no longer "
            "be started. Its schedule and history are kept.")
    if schedule.source_rule_id is None or schedule.source_parameter_id is None:
        raise ValueError(gone)

    rule = session.scalar(select(MonitoringRule).where(MonitoringRule.id == schedule.source_rule_id)
                          .with_for_update(read=True).execution_options(populate_existing=True))
    parameter = session.scalar(select(RuleParameter).where(RuleParameter.id == schedule.source_parameter_id,
                                                           RuleParameter.rule_id == schedule.source_rule_id)
                               .with_for_update(read=True).execution_options(populate_existing=True))
    if rule is None or parameter is None:
        raise ValueError(gone)
    if not _rule_running(rule, parameter):
        raise ValueError("The monitoring rule or parameter is suspended or deactivated, so this maintenance cannot be started. "
            "It stays ready and can be started once the rule is active again."
        )
    if not is_eligible_rule(rule) or not _valid_relationship(session, rule, parameter):
        raise ValueError("The monitoring rule is no longer an interval-based rule for this parameter, so this maintenance "
                         "cannot be started. Its schedule and history are kept.")

    state = session.scalar(select(RuleParameterState).where(RuleParameterState.parameter_id == parameter.id)
                           .execution_options(populate_existing=True))
    if state is None or state.last_evaluated_at is None:
        raise ValueError("The rule has no saved evaluation for this parameter yet, so this maintenance cannot be started.")
    if state.status == STATUS_NORMAL:
        raise ValueError("The rule is below its Due limit again, so this maintenance cannot be started.")
    if state.status == STATUS_UNKNOWN:
        raise ValueError("The rule's current status for this parameter is unknown (no valid signal), so this maintenance "
                         "cannot be started until the rule reports Due or Overdue again.")
    if state.status not in DUE_STATUSES:
        raise ValueError("The rule has not reported this parameter as Due or Overdue, so this maintenance cannot be started.")
    now = _now()
    # Same freshness limit as rule evaluation. The evaluation time may be as old as the rule's own evaluation cadence.
    stale_after = effective_stale_after(rule)
    cadence = rule.evaluation_interval_seconds or get_settings().monitoring_evaluation_interval_seconds
    evaluated_age = (now - _aware(state.last_evaluated_at)).total_seconds()
    if evaluated_age > max(stale_after, cadence) or evaluated_age < -_START_CLOCK_SKEW_SECONDS:
        raise ValueError("The rule's Due evaluation is out of date, so this maintenance cannot be started until the rule "
                         "evaluates again.")
    if parameter.variable_id is not None:
       
        if state.reading_at is None:
            raise ValueError("The signal has no reading, so this maintenance cannot be started.")
        reading_age = (now - _aware(state.reading_at)).total_seconds()
        if reading_age > stale_after or reading_age < -_START_CLOCK_SKEW_SECONDS:
            raise ValueError("The signal for this rule is stale (no recent reading), so this maintenance cannot be started "
                             "until it reports again.")
        if state.error_message in {"stale_reading", "variable_inactive", "awaiting_fresh_reading", "invalid_value"}:
            raise ValueError("The signal for this rule is not currently valid, so this maintenance cannot be started.")


_SYNC_KEY = "_rule_maintenance_rules"
_BUSY_KEY = "_rule_maintenance_busy"

# SQLAlchemy hook for deleted rules and parameters.
@event.listens_for(Session, "before_flush")
def _cancel_for_removals(session: Session, flush_context: object, instances: object) -> None:
    if session.info.get(_BUSY_KEY):
        return
    parameters, rules = set(), set()
    for instance in session.deleted:
        if isinstance(instance, RuleParameter) and instance.id is not None:
            parameters.add(instance.id)
        elif isinstance(instance, MonitoringRule) and instance.id is not None:
            rules.add(instance.id)
    for instance in session.dirty:
        if isinstance(instance, MonitoringRule) and instance.rule_type == RULE_MULTI_PARAMETER:
            for removed in attributes.get_history(instance, "parameter_items").deleted:
                if getattr(removed, "id", None) is not None:
                    parameters.add(removed.id)
    if not parameters and not rules:
        return
    session.info[_BUSY_KEY] = True
    try:
        cancel_for_removed(session, parameter_ids=parameters, rule_ids=rules)
    except Exception:  # noqa: BLE001 - never block deleting a rule
        LOGGER.exception("Could not cancel maintenance schedules of removed rules or parameters")
    finally:
        session.info.pop(_BUSY_KEY, None)

# Tracks modified rules and parameters.
@event.listens_for(Session, "after_flush")
def _capture_changes(session: Session, flush_context: object) -> None:
    if session.info.get(_BUSY_KEY):
        return
    touched = session.info.setdefault(_SYNC_KEY, set())
    for instance in (*session.new, *session.dirty):
        if isinstance(instance, MonitoringRule) and instance.id is not None and (
                instance.rule_type == RULE_MULTI_PARAMETER
                # A rule converted away from multi-parameter must still be synced so its unstarted schedules are closed.
                or RULE_MULTI_PARAMETER in attributes.get_history(instance, RULE_TYPE).deleted):
            touched.add(instance.id)
        elif isinstance(instance, RuleParameter) and instance.kind == INTERVAL and instance.rule_id is not None:
            touched.add(instance.rule_id)

# Synchronizes schedules before commit.
@event.listens_for(Session, "before_commit")
def _apply_changes(session: Session) -> None:
    if session.info.get(_BUSY_KEY):
        return
    if session.new or session.dirty or session.deleted:
        session.flush()  # before_commit runs before the commit's own flush; capture this transaction's changes first
    touched = session.info.pop(_SYNC_KEY, None)
    if not touched:
        return
    session.info[_BUSY_KEY] = True
    try:
        with session.begin_nested():
            for rule_id in sorted(touched or ()):
                rule = session.get(MonitoringRule, rule_id)
                if rule is not None:
                    sync_rule_schedules(session, rule)
            session.flush()
    except Exception:  # noqa: BLE001 - the rule itself must still be saved
        LOGGER.exception("Could not update maintenance schedules for changed monitoring rules")
    finally:
        session.info.pop(_BUSY_KEY, None)

# Cleans up after a rollback.
@event.listens_for(Session, "after_rollback")
def _forget(session: Session) -> None:
    for key in (_SYNC_KEY, _BUSY_KEY):
        session.info.pop(key, None)