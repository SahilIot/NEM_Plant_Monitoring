# Multi-parameter rule evaluation and status calculation.
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from pydantic import ValidationError

from app.models import Alert, Asset, MaintenanceSchedule, MonitoringRule, Reading, RuleParameter, RuleParameterState, RuleState, Variable
from app.core.constants import (
    ACTIVATION_AT,
    AGGREGATION,
    BOOLEAN,
    CALENDAR,
    COUNTER,
    INTERVAL,
    INTERVAL_PARAMETER,
    KIND,
    LIFECYCLE_STATUS,
    NUMBER,
    RULE_PARAMETER_THRESHOLD,
    RULE_TYPE,
    SCHEDULE,
    STATUS_ACTIVE,
    STATUS_ALERT,
    STATUS_COMPLETED,
    STATUS_DEACTIVATED,
    STATUS_IN_PROGRESS,
    STATUS_NORMAL,
    STATUS_RESOLVED,
    STATUS_SUSPENDED,
    STATUS_UNKNOWN,
    STATUS_WARNING,
    TIME,
    TIMER,
    USAGE,
    AGGREGATION_LAST,
    AGGREGATION_NONE,
    CATEGORY_INTERVAL_BASED,
    EVENT_ALERT_RESOLVED,
    EVENT_ALERT_SEVERITY_CHANGED,
    EVENT_STALE_DATA_DETECTED,
    EVENT_WARNING_TRIGGERED,
)
from app.services.rule_calendar import (
    calculate_calendar_date,
    calculate_next_calendar_cycle,
    calendar_start_at,
    calculate_calendar_cycle_at,
)

LOGGER = logging.getLogger("nem_backend.monitoring")

SEVERITY_ORDER = {STATUS_NORMAL: 0, STATUS_UNKNOWN: 1, STATUS_WARNING: 2, STATUS_ALERT: 3}
SECONDS_PER_HOUR = 3600.0
# Largest reading id the database accepts as a query parameter (INTEGER). A paused/resumed checkpoint uses it as
# "skip everything recorded at or before the resume instant"; larger values make PostgreSQL reject the query.
MAX_READING_ID = 2**31 - 1
# Readings folded into a cumulative checkpoint per pass; a larger backlog is drained over the following passes.
CUMULATIVE_BATCH_LIMIT = 50_000
# Batches folded in when a parameter is paused. A pause must not block the request for an unbounded backlog: anything
# beyond this is folded in by the normal passes after the parameter resumes (see `gaps` in _cumulative_aggregate).
PAUSE_BATCH_LIMIT = 4
# How many readings before a window are searched for the signal's last parseable state.
WINDOW_LOOKBACK_READINGS = 100
# ... in at most this many pages of that size, so a long run of unparseable values cannot make the search unbounded.
# If no parseable state is found the signal is treated as unknown, which credits no time and counts no cycle.
WINDOW_LOOKBACK_PAGES = 10

# Determines the reading freshness limit.
def effective_stale_after(rule: MonitoringRule, default: int | None = None) -> int:
    if rule.stale_after_seconds:
        return int(rule.stale_after_seconds)
    if default:
        return int(default)
    from app.core.config import get_settings

    return int(get_settings().monitoring_default_stale_after_seconds)

# Longest gap after a confirmed running sample that may still be credited as running time.
def runtime_credit_limit(stale_after: int, source_id: str | None) -> int:

    from app.core.config import get_settings
    from app.services.monitoring_engine import OPCUA_SOURCE_ID

    if source_id != OPCUA_SOURCE_ID:
        return stale_after
    return min(stale_after, get_settings().runtime_freshness_seconds)

# Converts supported values into Boolean states.
def _as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"true", "1", "on"}:
            return True
        if text in {"false", "0", "off"}:
            return False
    return None

# Validates numeric readings.
def _as_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value == value and abs(value) != float("inf") else None


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

# Progress of an interval parameter is counted from the later of the rule's creation / activation time and the start of
# its current maintenance cycle (RuleParameter.cycle_baseline_at, set only by a user-confirmed reset). The baseline is
# part of the cumulative checkpoint's identity, so a checkpoint from a previous cycle is never reused.
def _with_cycle_baseline(start: datetime, parameter: RuleParameter) -> datetime:
    baseline = parameter.cycle_baseline_at
    return max(start, _aware(baseline)) if baseline is not None else start

# Evaluates number thresholds.
def number_status(value: float, config: dict[str, Any]) -> tuple[str, str]:
    upper_alert, upper_warning = config.get("upper_alert"), config.get("upper_warning")
    lower_alert, lower_warning = config.get("lower_alert"), config.get("lower_warning")
    if upper_alert is not None and value >= upper_alert:
        return STATUS_ALERT, f"Upper alert limit {upper_alert:g} reached (value {value:g})."
    if lower_alert is not None and value <= lower_alert:
        return STATUS_ALERT, f"Lower alert limit {lower_alert:g} reached (value {value:g})."
    if upper_warning is not None and value >= upper_warning:
        return STATUS_WARNING, f"Upper warning limit {upper_warning:g} reached (value {value:g})."
    if lower_warning is not None and value <= lower_warning:
        return STATUS_WARNING, f"Lower warning limit {lower_warning:g} reached (value {value:g})."
    return STATUS_NORMAL, f"Within limits (value {value:g})."

# Evaluates Due and overdue limits.
def interval_status(value: float, config: dict[str, Any], unit: str) -> tuple[str, str]:
    due, overdue = config["due"], config["overdue"]
    if value >= overdue:
        return STATUS_ALERT, f"Overdue: {value:g} {unit} reached the Overdue limit {overdue:g}."
    if value >= due:
        return STATUS_WARNING, f"Due: {value:g} {unit} reached the Due limit {due:g}."
    return STATUS_NORMAL, f"Normal: {value:g} {unit} (Due at {due:g})."

# Fetches the latest variable reading.
def _latest_reading(session: Session, variable: Variable, not_after: datetime | None = None) -> Reading | None:
    query = select(Reading).where(Reading.variable_id == variable.id)
    if not_after is not None:
        query = query.where(Reading.recorded_at <= not_after)
    return session.scalar(query.order_by(Reading.recorded_at.desc(), Reading.id.desc()).limit(1))

# Calculates timer and counter values over a time window.
def _window_aggregate(
    session: Session, variable: Variable, start: datetime, now: datetime, stale_after: int
) -> tuple[float, int]:
    previous = None
    for page in range(WINDOW_LOOKBACK_PAGES):
        earlier = session.scalars(
            select(Reading)
            .where(Reading.variable_id == variable.id, Reading.recorded_at <= start - timedelta(microseconds=1))
            .order_by(Reading.recorded_at.desc(), Reading.id.desc())
            .offset(page * WINDOW_LOOKBACK_READINGS)
            .limit(WINDOW_LOOKBACK_READINGS)
        ).all()
        previous = next((r for r in earlier if _as_bool(r.value) is not None), None)
        if previous is not None or len(earlier) < WINDOW_LOOKBACK_READINGS:
            break
    state = _as_bool(previous.value) if previous else None
    cursor = start
    on_seconds, count = 0.0, 0
    readings = session.scalars(
        select(Reading)
        .where(Reading.variable_id == variable.id, Reading.recorded_at >= start, Reading.recorded_at <= now)
        .order_by(Reading.recorded_at, Reading.id)
    ).all()
    last_confirmed = (_aware(previous.recorded_at) if previous else None)
    for reading in readings:
        value = _as_bool(reading.value)
        if value is None:
            continue  # not a sample: it must not confirm the signal or extend how long an old TRUE stays fresh
        at = _aware(reading.recorded_at)
        if state is True and last_confirmed is not None:
            credited_until = min(at, last_confirmed + timedelta(seconds=stale_after))
            on_seconds += max(0.0, (credited_until - max(cursor, last_confirmed)).total_seconds())
        if value is True and state is False:
            count += 1
        state = value
        cursor, last_confirmed = at, at
    if state is True and last_confirmed is not None:
        credited_until = min(now, last_confirmed + timedelta(seconds=stale_after))
        on_seconds += max(0.0, (credited_until - max(cursor, last_confirmed)).total_seconds())
    return on_seconds, count

# Maintains cumulative running hours and cycles.
def _cumulative_aggregate(
    session: Session,
    parameter_state: RuleParameterState,
    variable: Variable,
    start: datetime,
    now: datetime,
    stale_after: int,
    max_batches: int = 1,
) -> tuple[float, int]:
    checkpoint = dict(parameter_state.aggregate_state or {})
    if checkpoint.get("start") != start.isoformat():
        checkpoint = {"start": start.isoformat(), "cursor": None, "reading_id": 0,
                      "seconds": 0.0, "count": 0, "prev": None, "prev_at": None}
    gaps = [(datetime.fromisoformat(g[0]), datetime.fromisoformat(g[1])) for g in checkpoint.get("gaps") or []]

    def close_gap() -> datetime:
        gap_from, gap_to = gaps.pop(0)
        if checkpoint["prev"] is True and checkpoint["prev_at"]:
            prev_at = datetime.fromisoformat(checkpoint["prev_at"])
            checkpoint["seconds"] += max(0.0, (min(gap_from, prev_at + timedelta(seconds=stale_after)) - prev_at).total_seconds())
        checkpoint["prev"], checkpoint["prev_at"] = None, None
        return gap_to

    exhausted, batches = False, 0
    while True:
        cursor = datetime.fromisoformat(checkpoint["cursor"]) if checkpoint["cursor"] else None
        query = select(Reading).where(Reading.variable_id == variable.id, Reading.recorded_at >= start, Reading.recorded_at <= now)
        if cursor is not None:
            query = query.where(or_(
                Reading.recorded_at > cursor,
                and_(Reading.recorded_at == cursor, Reading.id > min(int(checkpoint["reading_id"]), MAX_READING_ID)),
            ))
        for gap_from, gap_to in gaps:
            query = query.where(or_(Reading.recorded_at <= gap_from, Reading.recorded_at > gap_to))
        batch = session.scalars(query.order_by(Reading.recorded_at, Reading.id).limit(CUMULATIVE_BATCH_LIMIT)).all()
        for reading in batch:
            at = _aware(reading.recorded_at)
            while gaps and at > gaps[0][1]:
                close_gap()
            value = _as_bool(reading.value)
            if value is not None:
                prev_at = datetime.fromisoformat(checkpoint["prev_at"]) if checkpoint["prev_at"] else None
                if checkpoint["prev"] is True and prev_at is not None:
                    credited = min(at, prev_at + timedelta(seconds=stale_after))
                    checkpoint["seconds"] += max(0.0, (credited - prev_at).total_seconds())
                if value is True and checkpoint["prev"] is False:
                    checkpoint["count"] += 1
                checkpoint["prev"], checkpoint["prev_at"] = value, at.isoformat()
            checkpoint["cursor"], checkpoint["reading_id"] = at.isoformat(), reading.id
        batches += 1
        exhausted = len(batch) < CUMULATIVE_BATCH_LIMIT
        if exhausted or batches >= max_batches:
            break
    if exhausted:
        while gaps:
            gap_to = close_gap()
            if checkpoint["cursor"] is None or datetime.fromisoformat(checkpoint["cursor"]) < gap_to:
                checkpoint["cursor"], checkpoint["reading_id"] = gap_to.isoformat(), MAX_READING_ID
    checkpoint["backlog"] = not exhausted
    checkpoint["gaps"] = [[g[0].isoformat(), g[1].isoformat()] for g in gaps]
    parameter_state.aggregate_state = checkpoint
    seconds = float(checkpoint["seconds"])
    if exhausted and checkpoint["prev"] is True and checkpoint["prev_at"]:
        prev_at = datetime.fromisoformat(checkpoint["prev_at"])
        seconds += max(0.0, (min(now, prev_at + timedelta(seconds=stale_after)) - prev_at).total_seconds())
    return seconds, int(checkpoint["count"])

class ParameterConfigError(ValueError):
    """A stored parameter's configuration is not valid, so it must not be activated or evaluated."""


# Re-checks a STORED parameter with the same validator that guards creation and editing (nothing is rewritten).
def parameter_config_problem(parameter: RuleParameter) -> str | None:
    from app.schemas.rule_parameters import RuleParameterIn

    try:
        RuleParameterIn.model_validate(
            {"name": parameter.name or "(unnamed)", "kind": parameter.kind, "variable_id": parameter.variable_id,
             "aggregation": parameter.aggregation, "config": parameter.config or {}},
            context={"stored": True})
    except ValidationError as error:
        first = error.errors()[0]
        message = str(first.get("msg", "invalid configuration")).removeprefix("Value error, ")
        if first.get("loc") and not message.startswith("Parameter '"):
            message = f"Parameter '{parameter.name}': {'.'.join(str(part) for part in first['loc'])}: {message}"
        return message
    return None


# Raises ParameterConfigError naming every parameter that cannot be activated as stored.
def require_valid_parameters(parameters: list[RuleParameter]) -> None:
    problems = [problem for problem in (parameter_config_problem(item) for item in parameters) if problem]
    if problems:
        raise ParameterConfigError("Invalid parameter configuration: " + "; ".join(problems))


# Evaluates one parameter.
def _evaluate_parameter(
    session: Session,
    rule: MonitoringRule,
    parameter: RuleParameter,
    parameter_state: RuleParameterState,
    asset: Asset,
    now: datetime,
    stale_after: int,
) -> tuple[str, Any, Any, str, str | None]:
    # Returns (status, value, raw_value, message, error_code).
    config = parameter.config or {}
    rule_parameters = rule.parameters or {}
    period = rule_parameters.get("calculation_period_seconds")
    unknown = lambda message, code, value=None, raw=None: (STATUS_UNKNOWN, value, raw, message, code)  # noqa: E731

    problem = parameter_config_problem(parameter)
    if problem:
        # Never Normal and never a maintenance schedule from a configuration that cannot be trusted.
        return unknown(f"Invalid configuration: {problem}", "invalid_configuration")

    if parameter.kind == INTERVAL:
        interval = config.get(INTERVAL_PARAMETER)
        unit = "cycles" if interval == COUNTER else "hours"
        # Calendar-based Time uses fixed calendar dates, not elapsed hours.
        if interval == TIME and config.get("time_mode") == "calendar": 
            try:
                start_at = calendar_start_at(config)
                start_date = (
                    start_at.date() if start_at is not None
                    else date.fromisoformat(config["start_date"])
                )
                today = now.date()

                last_completed_at = session.scalar(
                    select(MaintenanceSchedule.last_completed_at)
                    .where(
                        MaintenanceSchedule.source_parameter_id == parameter.id,
                        MaintenanceSchedule.last_completed_at.is_not(None),
                        MaintenanceSchedule.progress_reset == PROGRESS_RESET,
                    )
                    .order_by(MaintenanceSchedule.last_completed_at.desc())
                    .limit(1)
                )
                if start_at is not None:
                    # Calendar Start with a time of day: compare exact moments, not dates.
                    due_date, overdue_date = calculate_calendar_cycle_at(
                        start_at,
                        due_interval=int(config["due"]),
                        overdue_interval=int(config["overdue"]),
                        unit=config["time_unit"],
                        after=_aware(last_completed_at) if last_completed_at is not None else None,
                    )
                    today = _aware(now)
                elif last_completed_at is None:
                    due_date = calculate_calendar_date(
                        start_date,
                        interval=int(config["due"]),
                        unit=config["time_unit"],
                    )
                    overdue_date = calculate_calendar_date(
                        start_date,
                        interval=int(config["overdue"]),
                        unit=config["time_unit"],
                    )
                else:
                    due_date, overdue_date = calculate_next_calendar_cycle(
                        start_date,
                        due_interval=int(config["due"]),
                        overdue_interval=int(config["overdue"]),
                        unit=config["time_unit"],
                        after=_aware(last_completed_at).date(),
                    )
                if today >= overdue_date:
                    return (
                        STATUS_ALERT,
                        None,
                        None,
                        f"Calendar maintenance is overdue. Overdue date: {overdue_date.isoformat()}.",
                        None,
                    )
                if today >= due_date:
                    return (
                        STATUS_WARNING,
                        None,
                        None,
                        f"Calendar maintenance is due. Due date: {due_date.isoformat()}.",
                        None,
                    )
                return (
                    STATUS_NORMAL,
                    None,
                    None,
                    f"Next maintenance is due on {due_date.isoformat()}.",
                    None,
                )
            except (KeyError, TypeError, ValueError):
                return unknown(
                    "Calendar Time configuration is invalid.",
                    "invalid_calendar_time",
                )
        activation = config.get(ACTIVATION_AT)
        start = _aware(rule.created_at)
        if activation:
            try:
                start = max(start, _aware(datetime.fromisoformat(str(activation).replace("Z", "+00:00"))))
            except ValueError:
                return unknown("Scheduled start time is invalid.", "invalid_activation")
        start = _with_cycle_baseline(start, parameter)
        if now < start:
            return STATUS_NORMAL, 0, None, f"Counting starts at {start.isoformat()}.", None
        if parameter.variable_id is None:  # calendar-based Time interval: no PLC variable
            value = (now - start).total_seconds() / SECONDS_PER_HOUR
            status, message = interval_status(value, config, unit)
            return status, value, None, message, None

    variable = session.get(Variable, parameter.variable_id) if parameter.variable_id else None
    if variable is not None and variable.asset_id == asset.id and not variable.is_active:
        return unknown("The connected variable is inactive; monitoring is paused until it is reactivated and reports a fresh reading.", "variable_inactive")
    if variable is None or variable.asset_id != asset.id:
        return unknown("The connected variable is unavailable or inactive.", "variable_unavailable")

    latest = _latest_reading(session, variable, not_after=now)
    if latest is None:
        return unknown("No reading is available for the connected variable.", "no_reading")
    raw = latest.value
    parameter_state.reading_at = _aware(latest.recorded_at)
    if (parameter_state.error_message in {"variable_inactive", "awaiting_fresh_reading"}
            and parameter_state.last_evaluated_at is not None
            and _aware(latest.recorded_at) <= _aware(parameter_state.last_evaluated_at)):
        # Reactivated: ignore the pre-pause reading until a new valid one arrives.
        return unknown("Reactivated; waiting for a fresh reading before monitoring resumes.", "awaiting_fresh_reading", raw=raw)
    age = (now - _aware(latest.recorded_at)).total_seconds()
    if age > stale_after:
        return unknown(f"The latest reading is stale (older than {stale_after} seconds).", "stale_reading", raw=raw)

    aggregation = parameter.aggregation
    credit_limit = runtime_credit_limit(stale_after, latest.source_id)
    if parameter.kind == BOOLEAN:
        if aggregation == AGGREGATION_LAST and period:
            window_start = now - timedelta(seconds=period)
            reading = _latest_reading(session, variable, not_after=now)
            if _aware(reading.recorded_at) < window_start:
                return unknown("No reading inside the calculation period.", "no_reading_in_period", raw=raw)
        state = _as_bool(raw)
        if state is None:
            return unknown("The latest value is not a valid Boolean.", "invalid_value", raw=raw)
        expected = config["expected"]
        if state == expected:
            return STATUS_NORMAL, state, raw, f"State is {str(state).upper()} as expected.", None
        return (config.get("severity", STATUS_ALERT), state, raw,
                f"State is {str(state).upper()}, expected {str(expected).upper()}.", None)

    if parameter.kind == NUMBER:
        if aggregation in {AGGREGATION_NONE, AGGREGATION_LAST}:
            if aggregation == AGGREGATION_LAST and period and _aware(latest.recorded_at) < now - timedelta(seconds=period):
                return unknown("No reading inside the calculation period.", "no_reading_in_period", raw=raw)
            value = _as_number(raw)
            if value is None:
                return unknown("The latest value is not a valid number.", "invalid_value", raw=raw)
            status, message = number_status(value, config)
            return status, value, raw, message, None
        if _as_bool(raw) is None:
            return unknown("The latest value is not a valid Boolean.", "invalid_value", raw=raw)
        window = period or 3600
        seconds, count = _window_aggregate(session, variable, now - timedelta(seconds=window), now, credit_limit)
        value = seconds if aggregation == TIMER else float(count)
        status, message = number_status(value, config)
        return status, value, raw, f"{aggregation.capitalize()} over the period: " + message, None

    # interval parameter with a variable
    if _as_bool(raw) is None:
        return unknown("The latest value is not a valid Boolean.", "invalid_value", raw=raw)
    interval = config[INTERVAL_PARAMETER]
    start = _aware(rule.created_at)
    if config.get(ACTIVATION_AT):
        start = max(start, _aware(datetime.fromisoformat(str(config[ACTIVATION_AT]).replace("Z", "+00:00"))))
    start = _with_cycle_baseline(start, parameter)
    seconds, count = _cumulative_aggregate(session, parameter_state, variable, start, now, credit_limit)
    if interval == COUNTER:
        value, unit = float(count), "cycles"
    else:
        value, unit = seconds / SECONDS_PER_HOUR, "hours"
    status, message = interval_status(value, config, unit)
    return status, value, raw, message, None

# The limit a Warning/Alert status crossed, and a short label for it (None for Boolean)
def triggered_limit(parameter: RuleParameter, status: str, value: Any) -> tuple[float | None, str | None]:
    # The limit a Warning/Alert status crossed, and a short label for it (None for Boolean)
    config = parameter.config or {}
    if status not in {STATUS_WARNING, STATUS_ALERT} or not isinstance(value, (int, float)) or isinstance(value, bool):
        return None, None
    if parameter.kind == INTERVAL:
        key = "overdue" if status == STATUS_ALERT else "due"
        return config.get(key), key.capitalize()
    if parameter.kind == NUMBER:
        for key, upper in ((f"upper_{status}", True), (f"lower_{status}", False)):
            limit = config.get(key)
            if limit is not None and (value >= limit if upper else value <= limit):
                return limit, key.replace("_", " ").title()
    return None, None

# Creates , updates or resolves that parameter`s alert.
def _sync_parameter_alert(
    session: Session, rule: MonitoringRule, asset: Asset, parameter: RuleParameter,
    parameter_state: RuleParameterState, status: str, value: Any, message: str, now: datetime,
    notify: bool = True,
) -> None:
   # Raise, update or resolve THIS parameter's alert only. Unknown never resolves or hides an alert.
    from app.services.email_notifications import enqueue_alert_notifications
    from app.services.monitoring_engine import emit_event

    active = session.scalar(
        select(Alert).where(
            Alert.rule_id == rule.id, Alert.target_asset_id == asset.id,
            Alert.parameter_id == parameter.id, Alert.status == STATUS_ACTIVE,
        ).order_by(Alert.id.desc()).limit(1)
    )
    meta = {"parameter_id": parameter.id, "parameter_key": parameter.key, "parameter_name": parameter.name}
    if status in {STATUS_WARNING, STATUS_ALERT}:
        threshold, limit_name = triggered_limit(parameter, status, value)
        meta = {**meta, "value": value, "threshold": threshold, "limit": limit_name}
        text = f"{parameter.name}: {message}"
        if active is None:
            if parameter_state.completed_at is not None:
                return  # completed by an operator while the condition still holds; re-arm on Normal
            alert = Alert(
                rule_id=rule.id, target_asset_id=asset.id, target_variable_id=parameter.variable_id,
                parameter_id=parameter.id, parameter_name=parameter.name, severity=status,
                title=f"{rule.name} — {parameter.name}", message=text, trigger_value=value,
                threshold=threshold, status=STATUS_ACTIVE, started_at=now, last_updated_at=now,
            )
            try:
                with session.begin_nested():
                    session.add(alert)
                    session.flush()
            except IntegrityError:
                return  # another worker raised it first
            if notify:  # False when the maintenance "ready to start" email already covers this Due moment
                enqueue_alert_notifications(session, alert, asset, rule)
            emit_event(session, event_type=EVENT_WARNING_TRIGGERED if status == STATUS_WARNING else "alert_triggered",
                       message=text, occurred_at=now, asset_id=asset.id, rule_id=rule.id,
                       alert_id=alert.id, severity=status, metadata=meta)
            return
        if active.severity != status:
            previous = active.severity
            active.severity = status
            enqueue_alert_notifications(session, active, asset, rule)
            emit_event(session, event_type=EVENT_ALERT_SEVERITY_CHANGED,
                       message=f"Alert severity changed to {status}: {text}", occurred_at=now,
                       asset_id=asset.id, rule_id=rule.id, alert_id=active.id, severity=status,
                       metadata={**meta, "previous_severity": previous, "new_severity": status})
        active.message, active.trigger_value, active.threshold = text, value, threshold
        active.last_updated_at = now
    elif status == STATUS_NORMAL:
        parameter_state.completed_at = None
        if active is not None:
            active.status, active.resolved_at, active.last_updated_at = STATUS_RESOLVED, now, now
            emit_event(session, event_type=EVENT_ALERT_RESOLVED,
                       message=f"Condition cleared: {rule.name} — {parameter.name}", occurred_at=now,
                       asset_id=asset.id, rule_id=rule.id, alert_id=active.id, severity=active.severity,
                       metadata=meta)

# Calculates the overall status of a multi-parameter rule.
def overall_summary(results: list[tuple[str, str]]) -> dict[str, Any]:
    worst = max((s for _n, s in results), key=lambda s: SEVERITY_ORDER[s], default=STATUS_UNKNOWN)
    return {
        "status": worst,
        "determined_by": [n for n, s in results if s == worst],
        "unavailable": [n for n, s in results if s == STATUS_UNKNOWN],
    }

UNCHANGED_REWRITE_SECONDS = 5

# Returns True if the parameter state is unchanged and does not need to be rewritten.
def _result_unchanged(parameter_state: RuleParameterState, status: str, value: Any, raw: Any, message: str,
                      error: str | None, now: datetime) -> bool:
    if parameter_state.id is None or parameter_state.last_evaluated_at is None:
        return False
    if parameter_state.error_message in {"variable_inactive", "awaiting_fresh_reading"}:
        return False  # these states are cleared by the arrival of a new reading: always record that
    if (now - _aware(parameter_state.last_evaluated_at)).total_seconds() >= UNCHANGED_REWRITE_SECONDS:
        return False
    return (parameter_state.status == status and parameter_state.latest_value == value
            and parameter_state.raw_value == raw and parameter_state.message == message
            and parameter_state.error_message == error)

# True when the parameter's saved cycle baseline differs from the one this evaluation was calculated with.
def _cycle_baseline_moved(session: Session, parameter: RuleParameter) -> bool:
    if parameter.kind != INTERVAL or parameter.id is None:
        return False
    saved = session.scalar(select(RuleParameter.cycle_baseline_at).where(RuleParameter.id == parameter.id))
    held = parameter.cycle_baseline_at
    if saved is None or held is None:
        return (saved is None) != (held is None)
    return _aware(saved) != _aware(held)

# Evaluates all parameters of a multi-parameter rule, updates their states and alerts, and returns the overall rule state.
def evaluate_multi_parameter(
    session: Session,
    rule: MonitoringRule,
    asset: Asset,
    state: RuleState | None,
    now: datetime,
    stale_after_seconds: int,
    skip_unchanged: bool = False,
) -> RuleState:

    stale_after = effective_stale_after(rule, stale_after_seconds)
    results: list[tuple[RuleParameter, str, Any, str]] = []
    skipped = 0
    for parameter in list(rule.parameter_items):
        if parameter.lifecycle_status != STATUS_ACTIVE:
            continue  # suspended/deactivated: no evaluation and no alerts; progress and history are kept
        parameter_state = parameter.state
        if parameter_state is None:
            parameter_state = RuleParameterState(parameter_id=parameter.id, status=STATUS_UNKNOWN, message="")
            session.add(parameter_state)
            parameter.state = parameter_state
        previous_reading_at = parameter_state.reading_at
        try:
            if skip_unchanged:
                # No savepoint here: leaving one flushes, and the flush itself would write the row and publish the
                # event this mode exists to avoid. Nothing is flushed until the result is known to differ.
                with session.no_autoflush:
                    status, value, raw, message, error = _evaluate_parameter(
                        session, rule, parameter, parameter_state, asset, now, stale_after
                    )
                if _result_unchanged(parameter_state, status, value, raw, message, error, now):
                    parameter_state.reading_at = previous_reading_at  # _evaluate_parameter moved it; nothing else changed
                    results.append((parameter, status, value, message))
                    skipped += 1
                    continue
            else:
                with session.begin_nested():
                    status, value, raw, message, error = _evaluate_parameter(
                        session, rule, parameter, parameter_state, asset, now, stale_after
                    )
        except Exception:
            # An unexpected failure in one parameter is shown as unavailable; the others still evaluate.
            LOGGER.exception("Parameter %s of rule %s could not be evaluated", parameter.id, rule.id)
            status, value, raw, message, error = (STATUS_UNKNOWN, None, None, "This parameter could not be evaluated.", "evaluation_error")
        if _cycle_baseline_moved(session, parameter):

            session.refresh(parameter_state)
            results.append((parameter, parameter_state.status, parameter_state.latest_value, parameter_state.message))
            continue
        try:
            # Result, alert and events of ONE parameter are written together or not at all.
            with session.begin_nested():
                if status != STATUS_UNKNOWN:
                    parameter_state.last_valid_value = raw if raw is not None else value
                    parameter_state.last_valid_at = parameter_state.reading_at or now
                previous_error = parameter_state.error_message
                parameter_state.status, parameter_state.latest_value, parameter_state.raw_value = status, value, raw
                parameter_state.message, parameter_state.error_message = message, error
                parameter_state.last_evaluated_at = now
                ready_now = False
                if parameter.kind == INTERVAL and status != STATUS_UNKNOWN:
                    try:
                        with session.begin_nested():
                            from app.services.rule_maintenance import apply_evaluation
                            ready_now = apply_evaluation(session, rule, parameter, status, value, now)
                    except Exception:  # noqa: BLE001 - a maintenance problem must never stop rule evaluation
                        LOGGER.exception("Maintenance eligibility of parameter %s of rule %s could not be updated", parameter.id, rule.id)
                _sync_parameter_alert(session, rule, asset, parameter, parameter_state, status, value, message, now,
                                      notify=not (ready_now and status == STATUS_WARNING))  # an Overdue alert always sends its own email
                if error == "stale_reading" and previous_error != "stale_reading":
                    from app.services.monitoring_engine import emit_event
                    emit_event(session, event_type=EVENT_STALE_DATA_DETECTED, message=f"{parameter.name}: {message}",
                               occurred_at=now, asset_id=asset.id, rule_id=rule.id,
                               metadata={"parameter_id": parameter.id, "parameter_name": parameter.name})
        except Exception:
            LOGGER.exception("Result or alert of parameter %s of rule %s could not be saved", parameter.id, rule.id)
            if status not in {STATUS_WARNING, STATUS_ALERT}:
                status, value, message = STATUS_UNKNOWN, None, "The result of this parameter could not be saved; it will be retried."
            try:
                with session.begin_nested():
                    if status in {STATUS_WARNING, STATUS_ALERT}:
                        parameter_state.status, parameter_state.latest_value, parameter_state.raw_value = status, value, raw
                        parameter_state.message, parameter_state.error_message = message, "alert_not_recorded"
                    else:
                        parameter_state.status, parameter_state.latest_value, parameter_state.raw_value = STATUS_UNKNOWN, None, None
                        parameter_state.message = "The result of this parameter could not be saved; it will be retried."
                        parameter_state.error_message = "evaluation_error"
                    parameter_state.last_evaluated_at = now
            except Exception:
                LOGGER.exception("Parameter %s of rule %s could not be marked as failed", parameter.id, rule.id)
        results.append((parameter, status, value, message))

    if state is None:
        state = RuleState(rule_id=rule.id, target_asset_id=asset.id, target_variable_id=None,
                          status=STATUS_UNKNOWN, message="No evaluation has been completed",
                          last_evaluated_at=now, last_transition_at=now)
        session.add(state)
    if not results:
        items = list(rule.parameter_items)
        if not items:
            overall, message, headline, error = STATUS_UNKNOWN, "This rule has no parameters.", None, "no_parameters"
        else:
            overall, headline, error = STATUS_UNKNOWN, None, "no_active_parameters"
            message = _no_active_message(items)
    else:
        summary = overall_summary([(p.name, s) for p, s, _v, _m in results])
        overall = summary["status"]
        if overall == STATUS_NORMAL:
            message = f"All {len(results)} parameters are normal."
        else:
            culprits = [f"{p.name}: {m}" for p, s, _v, m in results if s == overall]
            others = len(results) - len(culprits)
            message = " ".join(culprits) + (f" ({others} other parameter(s) not in this state.)" if others else "")
        headline = next((v for _p, s, v, _m in results if s == overall), None)
        error = "parameter_unavailable" if overall == STATUS_UNKNOWN else None
    if (skip_unchanged and results and skipped == len(results) and state.id is not None
            and state.status == overall and state.message == message and state.error_message == error):
        return state  # nothing the rule shows has changed
    if state.status != overall:
        state.last_transition_at = now
    state.status = overall
    state.latest_value = headline if isinstance(headline, (int, float)) and not isinstance(headline, bool) else None
    state.message, state.error_message = message, error
    state.last_evaluated_at, state.condition_started_at = now, None
    return state

# Pauses one parameter of a multi-parameter rule, updating its state and alert.
def _pause_one(session: Session, rule: MonitoringRule, parameter: RuleParameter, now: datetime,
               message: str, error: str) -> None:
    parameter_state = parameter.state
    if parameter_state is None:
        return
    if parameter.kind == INTERVAL and parameter.variable_id is not None:
        variable = session.get(Variable, parameter.variable_id)
        if variable is not None and not (parameter_state.aggregate_state or {}).get("paused"):
            config = parameter.config or {}
            start = _aware(rule.created_at)
            if config.get(ACTIVATION_AT):
                try:
                    start = max(start, _aware(datetime.fromisoformat(str(config[ACTIVATION_AT]).replace("Z", "+00:00"))))
                except ValueError:
                    pass
            start = _with_cycle_baseline(start, parameter)
            seconds, count = _cumulative_aggregate(session, parameter_state, variable, start, now,
                                                   effective_stale_after(rule), max_batches=PAUSE_BATCH_LIMIT)
            parameter_state.latest_value = float(count) if config.get(INTERVAL_PARAMETER) == COUNTER else seconds / SECONDS_PER_HOUR
            checkpoint = dict(parameter_state.aggregate_state or {})
            if checkpoint.get("backlog"):
                checkpoint["fold_until"] = now.isoformat()
            else:
                checkpoint.update(seconds=seconds, prev=None, prev_at=None)
            checkpoint["paused"] = True
            parameter_state.aggregate_state = checkpoint
    parameter_state.status = STATUS_UNKNOWN
    parameter_state.message = message
    parameter_state.error_message = error
    parameter_state.last_evaluated_at = now

# Resumes one parameter of a multi-parameter rule, updating its state and alert.
def _resume_one(parameter: RuleParameter, now: datetime) -> None:
    parameter_state = parameter.state
    if parameter_state is None:
        return
    checkpoint = dict(parameter_state.aggregate_state or {})
    if checkpoint.get("paused"):
        fold_until = checkpoint.pop("fold_until", None)
        if fold_until:
            # Backlog from before the pause is still waiting: keep the cursor, and only exclude [pause, resume].
            checkpoint.update(paused=False, gaps=[*(checkpoint.get("gaps") or []), [fold_until, now.isoformat()]])
        else:
            checkpoint.update(paused=False, cursor=now.isoformat(), reading_id=MAX_READING_ID, prev=None, prev_at=None)
        parameter_state.aggregate_state = checkpoint
    parameter_state.completed_at = None

# Pauses parameters evaluation and progress.
def pause_parameters(session: Session, rule: MonitoringRule, now: datetime) -> None:
    for parameter in rule.parameter_items:
        if parameter.lifecycle_status == STATUS_ACTIVE:
            _pause_one(session, rule, parameter, now, "Rule is not active; the parameter is not being evaluated.", "rule_inactive")

# Resumes evaluation.
def resume_parameters(session: Session, rule: MonitoringRule, now: datetime) -> None:
    # Rule resumed/activated: resume only parameters that are themselves active.
    for parameter in rule.parameter_items:
        if parameter.lifecycle_status == STATUS_ACTIVE:
            _resume_one(parameter, now)

# Returns a message explaining why no parameter is being evaluated.
def _no_active_message(items: list[RuleParameter]) -> str:
    suspended = sum(1 for p in items if p.lifecycle_status == STATUS_SUSPENDED)
    if suspended == len(items):
        return "All parameters are suspended; nothing is being evaluated."
    if suspended == 0:
        return "All parameters are deactivated; nothing is being evaluated."
    return "No parameter is being evaluated (all are suspended or deactivated)."


PARAMETER_LIFECYCLE_ACTIONS = {
    # action: (allowed current states, new state)
    "suspend": ({STATUS_ACTIVE}, STATUS_SUSPENDED),
    "resume": ({STATUS_SUSPENDED}, STATUS_ACTIVE),
    "deactivate": ({STATUS_ACTIVE, STATUS_SUSPENDED}, STATUS_DEACTIVATED),
    "activate": ({STATUS_DEACTIVATED}, STATUS_ACTIVE),
}

# Suspends, resumes, deactivates or deactivates one parameter.
def change_parameter_lifecycle(session: Session, rule: MonitoringRule, parameter: RuleParameter, action: str,
                               now: datetime) -> None:
    from app.services.monitoring_engine import emit_event

    allowed, target = PARAMETER_LIFECYCLE_ACTIONS[action]
    if parameter.lifecycle_status not in allowed:
        raise ValueError(f"A {parameter.lifecycle_status} parameter cannot be {action}d.")
    asset = session.get(Asset, rule.target_asset_id) if rule.target_asset_id else None
    rule_running = rule.is_enabled and rule.lifecycle_status == STATUS_IN_PROGRESS
    meta = {"parameter_id": parameter.id, "parameter_key": parameter.key, "parameter_name": parameter.name,
            "previous": parameter.lifecycle_status, "new": target}
    if target == STATUS_ACTIVE:
        require_valid_parameters([parameter])  # before any state change
        parameter.lifecycle_status = STATUS_ACTIVE
        if rule_running:
            _resume_one(parameter, now)  # a paused rule resumes it later, together with the rule
        if parameter.state is not None:
            parameter.state.status, parameter.state.error_message = STATUS_UNKNOWN, None
            parameter.state.message = ("Resumed; waiting for evaluation." if rule_running
                                       else "Rule is not active; the parameter is not being evaluated.")
            parameter.state.completed_at = None
    else:
        parameter.lifecycle_status = target
        # Same as a rule being turned off: this parameter's open alert is closed, its history stays.
        for alert in session.scalars(select(Alert).where(
                Alert.parameter_id == parameter.id, Alert.status == STATUS_ACTIVE)).all():
            alert.status, alert.resolved_at, alert.last_updated_at = STATUS_RESOLVED, now, now
        _pause_one(session, rule, parameter, now, f"Parameter is {target}; it is not being evaluated.", f"parameter_{target}")
        if parameter.state is not None:
            parameter.state.completed_at = None
    emit_event(session, event_type=f"parameter_{ {'suspend': STATUS_SUSPENDED, 'resume': 'resumed', 'deactivate': STATUS_DEACTIVATED, 'activate': 'activated'}[action] }",
               message=f"Parameter '{parameter.name}' of rule '{rule.name}' {target if target != STATUS_ACTIVE else 'activated'}.",
               occurred_at=now, asset_id=asset.id if asset else None, rule_id=rule.id, metadata=meta)
    session.flush()
    _refresh_rule_state(session, rule, now)

# Updates the overall state of a multi-parameter rule, based on the current states of its parameters.
def _refresh_rule_state(session: Session, rule: MonitoringRule, now: datetime) -> None:
    if not (rule.is_enabled and rule.lifecycle_status == STATUS_IN_PROGRESS):
        return
    state = session.scalar(select(RuleState).where(RuleState.rule_id == rule.id))
    if state is None:
        return
    live = [p for p in rule.parameter_items if p.lifecycle_status == STATUS_ACTIVE]
    if not live:
        overall, message, error = STATUS_UNKNOWN, _no_active_message(list(rule.parameter_items)), "no_active_parameters"
    else:
        # A parameter that was just resumed has no fresh result yet, so it counts as Not Evaluated.
        summary = overall_summary([(p.name, p.state.status if p.state else STATUS_UNKNOWN) for p in live])
        overall, error = summary["status"], ("parameter_unavailable" if summary["status"] == STATUS_UNKNOWN else None)
        message = (f"All {len(live)} evaluated parameter(s) are normal." if overall == STATUS_NORMAL
                   else f"Worst parameter: {', '.join(summary['determined_by'])}.")
    if state.status != overall:
        state.last_transition_at = now
    state.status, state.message, state.error_message = overall, message, error
    if not live:
        state.latest_value = None

# Resets an affected parameter`s aggragation baseline
def reset_parameter_baseline(session: Session, parameter: RuleParameter) -> bool:
    state = parameter.state
    if state is None:
        return False
    state.aggregate_state = None
    state.status, state.message = STATUS_UNKNOWN, "Parameter was edited; waiting for evaluation."
    session.info.setdefault("parameter_state_resets", []).append((parameter.rule_id, parameter.id))
    return True

# Preserve the removed parameter`s history`
def archive_removed_parameter(session: Session, rule: MonitoringRule, parameter: RuleParameter, reason: str) -> None:
    from app.services.monitoring_engine import emit_event

    def plain(value: Any) -> Any:
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, dict):
            return {str(k): plain(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [plain(v) for v in value]
        return value if value is None or isinstance(value, (bool, int, float, str)) else str(value)

    state = parameter.state
    snapshot = {
        "parameter_id": parameter.id, "key": parameter.key, "name": parameter.name, KIND: parameter.kind,
        "variable_id": parameter.variable_id, AGGREGATION: parameter.aggregation, "config": plain(parameter.config),
        LIFECYCLE_STATUS: parameter.lifecycle_status, "created_at": plain(parameter.created_at), "reason": reason,
        "last_state": None if state is None else plain({
            "status": state.status, "value": state.latest_value, "raw_value": state.raw_value, "message": state.message,
            "last_evaluated_at": state.last_evaluated_at, "last_valid_value": state.last_valid_value,
            "last_valid_at": state.last_valid_at, "aggregate_state": state.aggregate_state}),
    }
    emit_event(session, event_type="parameter_removed", message=f"Parameter '{parameter.name}' was removed from the rule.",
               occurred_at=datetime.now(timezone.utc), asset_id=rule.target_asset_id, rule_id=rule.id, metadata=snapshot)

# Builds the parameter API data
def serialize_parameters(rule: MonitoringRule) -> list[dict[str, Any]]:
    # API view of a rule's parameters, including each parameter's own latest evaluation.
    items = []
    for parameter in rule.parameter_items:
        state = parameter.state
        items.append({
            "id": parameter.id,
            "key": parameter.key,
            "name": parameter.name,
            "position": parameter.position,
            KIND: parameter.kind,
            "variable_id": parameter.variable_id,
            AGGREGATION: parameter.aggregation,
            "config": parameter.config,
            LIFECYCLE_STATUS: parameter.lifecycle_status,
            "status": state.status if state else STATUS_UNKNOWN,
            # Evaluated (aggregated) value, distinct from the raw PLC value.
            "value": state.latest_value if state else None,
            "raw_value": state.raw_value if state else None,
            "message": state.message if state else "",
            "error": state.error_message if state else None,
            "last_evaluated_at": state.last_evaluated_at if state else None,
            "reading_at": state.reading_at if state else None,
            "last_valid_value": state.last_valid_value if state else None,
            "last_valid_at": state.last_valid_at if state else None,
            "cycle_baseline_at": parameter.cycle_baseline_at,
        })
    return items

# Builds the alert API data
def _alert_view(alert: Alert) -> dict[str, Any]:
    return {
        "id": alert.id, "severity": alert.severity, "status": alert.status, "message": alert.message,
        "trigger_value": alert.trigger_value,
        "threshold": float(alert.threshold) if alert.threshold is not None else None,
        "started_at": alert.started_at, "last_updated_at": alert.last_updated_at,
        "resolved_at": alert.resolved_at, "acknowledged_at": alert.acknowledged_at,
        "acknowledged_by": alert.acknowledged_by,
        # Active alerts are open until completed; resolved ones were completed or cleared.
        "workflow": (STATUS_COMPLETED if alert.status == STATUS_RESOLVED else
                     "acknowledged" if alert.acknowledged_at else "open"),
    }

# Builds the current status response.
def build_status_detail(session: Session, rule: MonitoringRule, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    stale_after = effective_stale_after(rule)
    asset = session.get(Asset, rule.target_asset_id) if rule.target_asset_id else None
    rule_state = session.scalar(select(RuleState).where(RuleState.rule_id == rule.id))
    parameters = serialize_parameters(rule)
    alerts_by_parameter: dict[int, list[Alert]] = {}
    for alert in session.scalars(
        select(Alert)
        .where(
            Alert.rule_id == rule.id,
            Alert.parameter_id.is_not(None)
        )
        .order_by(Alert.started_at.desc(), Alert.id.desc())
        .limit(200)
    ).all():
        alerts_by_parameter.setdefault(alert.parameter_id, []).append(alert)

    variables = {
        v.id: v
        for v in session.scalars(
            select(Variable).where(
                Variable.id.in_([
                    p["variable_id"]
                    for p in parameters
                    if p["variable_id"]
                ])
            )
        ).all()
    } if parameters else {}

    active = (
        rule.is_enabled
        and rule.lifecycle_status == STATUS_IN_PROGRESS
    )

    for item in parameters:

        # Initialize config before accessing it.
        config = item["config"] or {}

        variable = variables.get(item["variable_id"])
        item["variable_name"] = variable.name if variable else None

        item["unit"] = (
            config.get("time_unit")
            if (
                item[KIND] == INTERVAL
                and config.get(INTERVAL_PARAMETER) == TIME
                and config.get("time_mode") == "calendar"
            )
            else (variable.unit if variable else None) or (
                "hours"
                if item[KIND] == INTERVAL
                and config.get(INTERVAL_PARAMETER) in {USAGE, TIME}
                else "cycles"
                if item[KIND] == INTERVAL
                else None
            )
        )

        reading_at = item["reading_at"]
        age = (
            (now - _aware(reading_at)).total_seconds()
            if reading_at else None
        )

        item["reading_age_seconds"] = age
        item["is_stale"] = (
            bool(item["variable_id"])
            and (age is None or age > stale_after)
        )

        # Parameter lifecycle and availability.
        lifecycle = item[LIFECYCLE_STATUS]
        evaluating = active and lifecycle == STATUS_ACTIVE
        item["evaluating"] = evaluating
        if not active:
            item["status"] = STATUS_UNKNOWN
            item["value"] = None
            item["active_alert"] = None

        elif lifecycle != STATUS_ACTIVE:
            item["status"] = STATUS_UNKNOWN

        item["availability"] = (
            "inactive" if not active else
            lifecycle if lifecycle != STATUS_ACTIVE else
            "available" if item["status"] != STATUS_UNKNOWN else
            "variable_inactive" if item["error"] == "variable_inactive" else
            "awaiting_reading" if item["error"] == "awaiting_fresh_reading" else
            "stale" if item["error"] == "stale_reading" else
            "unavailable"
        )

        # Maintenance schedule calculation
        item[SCHEDULE] = None

        # Calendar-based Time interval.
        if (
            item[KIND] == INTERVAL
            and config.get(INTERVAL_PARAMETER) == TIME
            and config.get("time_mode") == "calendar"
        ):
            try:
                start_at = calendar_start_at(config)
                calendar_start = (
                    start_at if start_at is not None
                    else date.fromisoformat(config["start_date"])
                )
                last_completed_at = session.scalar(
                    select(MaintenanceSchedule.last_completed_at)
                    .where(
                        MaintenanceSchedule.source_parameter_id == item["id"],
                        MaintenanceSchedule.last_completed_at.is_not(None),
                        MaintenanceSchedule.progress_reset == PROGRESS_RESET,
                    )
                    .order_by(MaintenanceSchedule.last_completed_at.desc())
                    .limit(1)
                )
                if start_at is not None:
                    calendar_due, calendar_overdue = calculate_calendar_cycle_at(
                        start_at,
                        due_interval=int(config["due"]),
                        overdue_interval=int(config["overdue"]),
                        unit=config["time_unit"],
                        after=_aware(last_completed_at) if last_completed_at is not None else None,
                    )
                elif last_completed_at is None:
                    calendar_due, calendar_overdue = (
                        calculate_calendar_date(
                            calendar_start,
                            interval=int(config["due"]),
                            unit=config["time_unit"],
                            ),
                        calculate_calendar_date(
                            calendar_start,
                            interval=int(config["overdue"]),
                            unit=config["time_unit"],
                            ),
                        )
                else:
                    calendar_due, calendar_overdue = calculate_next_calendar_cycle(
                        calendar_start,
                        due_interval=int(config["due"]),
                        overdue_interval=int(config["overdue"]),
                        unit=config["time_unit"],
                        after=_aware(last_completed_at).date(),
                        )

                item[SCHEDULE] = {
                    "start_at": calendar_start,
                    "due_at": calendar_due,
                    "overdue_at": calendar_overdue,
                    "mode": "calendar_date",
                    }
            except (KeyError, TypeError, ValueError):
                item[SCHEDULE] = {
                    "start_at": None,
                    "due_at": None,
                    "overdue_at": None,
                    "mode": "calendar_date",
                }
        # Runtime, usage and elapsed-time intervals.
        elif item[KIND] == INTERVAL:
            start = _aware(rule.created_at)
            if config.get(ACTIVATION_AT):
                try:
                    activation = datetime.fromisoformat(
                        str(config[ACTIVATION_AT]).replace("Z", "+00:00")
                    )
                    start = max(start, _aware(activation))
                except ValueError:
                    pass
            if item.get("cycle_baseline_at") is not None:
                start = max(
                    start,
                    _aware(item["cycle_baseline_at"])
                )

            item[SCHEDULE] = {
                "start_at": start
            }

            if (
                config.get(INTERVAL_PARAMETER) == TIME
                and config.get("due") is not None
            ):
                item[SCHEDULE]["due_at"] = (
                    start + timedelta(hours=float(config["due"]))
                )

                item[SCHEDULE]["overdue_at"] = (
                    start + timedelta(hours=float(config["overdue"]))
                )

        # Live progress calculation
        item["live"] = None

        if (
            item[KIND] == INTERVAL
            and evaluating
            and item["status"] != STATUS_UNKNOWN
            and item["last_evaluated_at"]
        ):

            # Calendar-free elapsed-time interval.
            if (
                item["variable_id"] is None
                and config.get(INTERVAL_PARAMETER) == TIME
                and config.get("time_mode") != "calendar"
            ):
                item["live"] = {
                    "mode": CALENDAR,
                    "baseline_at": item["last_evaluated_at"],
                }

            # PLC running-hours timer.
            elif (
                item[AGGREGATION] == TIMER
                and config.get(INTERVAL_PARAMETER) in {USAGE, TIME}
            ):

                newest = (
                    _latest_reading(
                        session,
                        variables[item["variable_id"]],
                        not_after=now,
                    )
                    if item["variable_id"] in variables
                    else None
                )

                seen_at = (
                    _aware(newest.recorded_at)
                    if newest
                    else (
                        _aware(item["reading_at"])
                        if item["reading_at"]
                        else None
                    )
                )

                limit = runtime_credit_limit(
                    stale_after,
                    newest.source_id if newest else None
                )

                fresh_until = (
                    seen_at + timedelta(seconds=limit)
                    if seen_at else None
                )

                state_value = (
                    newest.value
                    if newest
                    else item["raw_value"]
                )

                baseline = (
                    max(
                        _aware(item["last_evaluated_at"]),
                        _aware(item["reading_at"]),
                    )
                    if item["reading_at"]
                    else item["last_evaluated_at"]
                )

                item["live"] = {
                    "mode": TIMER,
                    "baseline_at": baseline,
                    "running": bool(
                        _as_bool(state_value) is True
                        and fresh_until is not None
                        and fresh_until > _aware(baseline)
                    ),
                    "running_until": fresh_until,
                }

        # Alert history
        history = [
            _alert_view(a)
            for a in alerts_by_parameter.get(item["id"], [])
        ]

        item["active_alert"] = next(
            (
                a for a in history
                if a["status"] == STATUS_ACTIVE
            ),
            None
        )
        item["alert_history"] = history[:10]

    # Overall multi-parameter rule status
    evaluated_items = [
        p for p in parameters
        if p["evaluating"]
    ]

    summary = overall_summary([
        (p["name"], p["status"])
        for p in evaluated_items
    ])

    determined_by = [
        p["id"]
        for p in evaluated_items
        if p["status"] == summary["status"]
    ]

    counts = {
        name: sum(
            1 for p in parameters
            if p[LIFECYCLE_STATUS] == name
        )
        for name in (
            STATUS_ACTIVE,
            STATUS_SUSPENDED,
            STATUS_DEACTIVATED
        )
    }

    if not active:
        mode = "rule_inactive"

    elif evaluated_items:
        mode = "evaluating"

    elif parameters and counts[STATUS_DEACTIVATED] == len(parameters):
        mode = "all_deactivated"

    elif parameters and counts[STATUS_SUSPENDED] == len(parameters):
        mode = "all_suspended"

    else:
        mode = "no_active_parameters"

    evaluated = [
        p["last_evaluated_at"]
        for p in parameters
        if p["last_evaluated_at"]
    ]

    category = (rule.parameters or {}).get("category")

    return {
        "rule": {
            "id": rule.id,
            "name": rule.name,
            RULE_TYPE: rule.rule_type,

            "type": (
                CATEGORY_INTERVAL_BASED
                if category == CATEGORY_INTERVAL_BASED
                else RULE_PARAMETER_THRESHOLD
            ),

            "is_enabled": rule.is_enabled,
            LIFECYCLE_STATUS: rule.lifecycle_status,
            "completed_at": rule.completed_at,

            "asset_id": rule.target_asset_id,
            "asset_name": asset.name if asset else None,

            "calculation_period_seconds": (
                (rule.parameters or {}).get(
                    "calculation_period_seconds"
                )
            ),

            "stale_after_seconds": stale_after,
        },

        "overall": {
            "status": (
                summary["status"]
                if evaluated_items
                else STATUS_UNKNOWN
            ),

            "evaluating": bool(evaluated_items),
            "mode": mode,
            "counts": counts,
            "strategy": "worst_parameter_wins",
            "determined_by": determined_by,

            "unavailable_ids": [
                p["id"]
                for p in evaluated_items
                if p["status"] == STATUS_UNKNOWN
            ],

            "parameter_count": len(parameters),

            "rule_state_status": (
                rule_state.status
                if rule_state else None
            ),

            "message": (
                rule_state.message
                if rule_state else ""
            ),

            "last_evaluated_at": (
                (rule_state.last_evaluated_at if rule_state else None)
                or (max(evaluated) if evaluated else None)
            ),
        },
        "parameters": parameters,
        "server_time": now,
    }