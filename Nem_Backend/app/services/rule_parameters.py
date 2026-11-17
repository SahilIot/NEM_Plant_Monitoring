# Evaluation of 'multi_parameter' rules.
#
# Each parameter is evaluated on its own and keeps its own RuleParameterState. The rule's single
# RuleState (and therefore its single alert) shows the WORST parameter status, and its message names
# the parameter(s) responsible, so one parameter's Normal value can never hide another's Alert.
#
# Aggregations are computed from stored readings, so nothing here changes OPC UA collection, the
# runtime/cycle counters or maintenance progress:
#   none     the latest reading
#   last     the latest reading inside the calculation period
#   timer    seconds the Boolean variable was ON            (period window, or cumulative for intervals)
#   counter  number of OFF-to-ON transitions                (period window, or cumulative for intervals)
# Boundaries are inclusive (>= / <=), like the existing threshold and interval evaluators.
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Alert, Asset, MonitoringRule, Reading, RuleParameter, RuleParameterState, RuleState, Variable

LOGGER = logging.getLogger("nem_backend.monitoring")

SEVERITY_ORDER = {"normal": 0, "unknown": 1, "warning": 2, "alert": 3}
SECONDS_PER_HOUR = 3600.0
# Largest reading id the database accepts as a query parameter (INTEGER). A paused/resumed checkpoint uses it as
# "skip everything recorded at or before the resume instant"; larger values make PostgreSQL reject the query.
MAX_READING_ID = 2**31 - 1
# Readings folded into a cumulative checkpoint per pass; a larger backlog is drained over the following passes.
CUMULATIVE_BATCH_LIMIT = 50_000


def effective_stale_after(rule: MonitoringRule, default: int | None = None) -> int:
    """The one place that decides how old a reading may be: the rule's own limit, else the caller's default, else the
    configured default. Evaluation, pausing and the status detail all use it, so they can never disagree."""
    if rule.stale_after_seconds:
        return int(rule.stale_after_seconds)
    if default:
        return int(default)
    from app.core.config import get_settings

    return int(get_settings().monitoring_default_stale_after_seconds)


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


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value == value and abs(value) != float("inf") else None


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def number_status(value: float, config: dict[str, Any]) -> tuple[str, str]:
    # (status, message) for a Number parameter. Inclusive boundaries.
    upper_alert, upper_warning = config.get("upper_alert"), config.get("upper_warning")
    lower_alert, lower_warning = config.get("lower_alert"), config.get("lower_warning")
    if upper_alert is not None and value >= upper_alert:
        return "alert", f"Upper alert limit {upper_alert:g} reached (value {value:g})."
    if lower_alert is not None and value <= lower_alert:
        return "alert", f"Lower alert limit {lower_alert:g} reached (value {value:g})."
    if upper_warning is not None and value >= upper_warning:
        return "warning", f"Upper warning limit {upper_warning:g} reached (value {value:g})."
    if lower_warning is not None and value <= lower_warning:
        return "warning", f"Lower warning limit {lower_warning:g} reached (value {value:g})."
    return "normal", f"Within limits (value {value:g})."


def interval_status(value: float, config: dict[str, Any], unit: str) -> tuple[str, str]:
    due, overdue = config["due"], config["overdue"]
    if value >= overdue:
        return "alert", f"Overdue: {value:g} {unit} reached the Overdue limit {overdue:g}."
    if value >= due:
        return "warning", f"Due: {value:g} {unit} reached the Due limit {due:g}."
    return "normal", f"Normal: {value:g} {unit} (Due at {due:g})."


def _latest_reading(session: Session, variable: Variable, not_after: datetime | None = None) -> Reading | None:
    query = select(Reading).where(Reading.variable_id == variable.id)
    if not_after is not None:
        query = query.where(Reading.recorded_at <= not_after)
    return session.scalar(query.order_by(Reading.recorded_at.desc(), Reading.id.desc()).limit(1))


def _window_aggregate(
    session: Session, variable: Variable, start: datetime, now: datetime, stale_after: int
) -> tuple[float, int]:
    # Seconds ON and OFF-to-ON count for a Boolean variable inside [start, now].
    previous = _latest_reading(session, variable, not_after=start - timedelta(microseconds=1))
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
        at = _aware(reading.recorded_at)
        if state is True and last_confirmed is not None:
            credited_until = min(at, last_confirmed + timedelta(seconds=stale_after))
            on_seconds += max(0.0, (credited_until - max(cursor, last_confirmed)).total_seconds())
        value = _as_bool(reading.value)
        if value is True and state is False:
            count += 1
        if value is not None:
            state = value
        cursor, last_confirmed = at, at
    if state is True and last_confirmed is not None:
        credited_until = min(now, last_confirmed + timedelta(seconds=stale_after))
        on_seconds += max(0.0, (credited_until - max(cursor, last_confirmed)).total_seconds())
    return on_seconds, count


def _cumulative_aggregate(
    session: Session,
    parameter_state: RuleParameterState,
    variable: Variable,
    start: datetime,
    now: datetime,
    stale_after: int,
    drain: bool = False,
) -> tuple[float, int]:
    # Running seconds and cycle count since `start`, advanced incrementally from a stored checkpoint.
    # One pass folds in at most CUMULATIVE_BATCH_LIMIT readings (the rest are picked up on the next pass); `drain`
    # keeps going until nothing is left, which pausing needs because readings recorded while paused are skipped.
    checkpoint = dict(parameter_state.aggregate_state or {})
    if checkpoint.get("start") != start.isoformat():
        checkpoint = {"start": start.isoformat(), "cursor": None, "reading_id": 0,
                      "seconds": 0.0, "count": 0, "prev": None, "prev_at": None}
    while True:
        cursor = datetime.fromisoformat(checkpoint["cursor"]) if checkpoint["cursor"] else None
        query = select(Reading).where(Reading.variable_id == variable.id, Reading.recorded_at >= start)
        if cursor is not None:
            query = query.where(or_(
                Reading.recorded_at > cursor,
                and_(Reading.recorded_at == cursor, Reading.id > min(int(checkpoint["reading_id"]), MAX_READING_ID)),
            ))
        batch = session.scalars(query.order_by(Reading.recorded_at, Reading.id).limit(CUMULATIVE_BATCH_LIMIT)).all()
        for reading in batch:
            at = _aware(reading.recorded_at)
            value = _as_bool(reading.value)
            prev_at = datetime.fromisoformat(checkpoint["prev_at"]) if checkpoint["prev_at"] else None
            if checkpoint["prev"] is True and prev_at is not None:
                credited = min(at, prev_at + timedelta(seconds=stale_after))
                checkpoint["seconds"] += max(0.0, (credited - prev_at).total_seconds())
            if value is True and checkpoint["prev"] is False:
                checkpoint["count"] += 1
            if value is not None:
                checkpoint["prev"], checkpoint["prev_at"] = value, at.isoformat()
            checkpoint["cursor"], checkpoint["reading_id"] = at.isoformat(), reading.id
        if not drain or len(batch) < CUMULATIVE_BATCH_LIMIT:
            break
    parameter_state.aggregate_state = checkpoint
    seconds = float(checkpoint["seconds"])
    if checkpoint["prev"] is True and checkpoint["prev_at"]:
        prev_at = datetime.fromisoformat(checkpoint["prev_at"])
        seconds += max(0.0, (min(now, prev_at + timedelta(seconds=stale_after)) - prev_at).total_seconds())
    return seconds, int(checkpoint["count"])


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
    unknown = lambda message, code, value=None, raw=None: ("unknown", value, raw, message, code)  # noqa: E731

    if parameter.kind == "interval":
        interval = config.get("interval_parameter")
        unit = "cycles" if interval == "counter" else "hours"
        activation = config.get("activation_at")
        start = _aware(rule.created_at)
        if activation:
            try:
                start = max(start, _aware(datetime.fromisoformat(str(activation).replace("Z", "+00:00"))))
            except ValueError:
                return unknown("Scheduled start time is invalid.", "invalid_activation")
        if now < start:
            return "normal", 0, None, f"Counting starts at {start.isoformat()}.", None
        if parameter.variable_id is None:  # calendar-based Time interval: no PLC variable
            value = (now - start).total_seconds() / SECONDS_PER_HOUR
            status, message = interval_status(value, config, unit)
            return status, value, None, message, None

    variable = session.get(Variable, parameter.variable_id) if parameter.variable_id else None
    if variable is not None and variable.asset_id == asset.id and not variable.is_active:
        return unknown("The connected variable is inactive; monitoring is paused until it is reactivated and reports a fresh reading.", "variable_inactive")
    if variable is None or variable.asset_id != asset.id:
        return unknown("The connected variable is unavailable or inactive.", "variable_unavailable")

    latest = _latest_reading(session, variable)
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
    if parameter.kind == "boolean":
        if aggregation == "last" and period:
            window_start = now - timedelta(seconds=period)
            reading = _latest_reading(session, variable)
            if _aware(reading.recorded_at) < window_start:
                return unknown("No reading inside the calculation period.", "no_reading_in_period", raw=raw)
        state = _as_bool(raw)
        if state is None:
            return unknown("The latest value is not a valid Boolean.", "invalid_value", raw=raw)
        expected = config["expected"]
        if state == expected:
            return "normal", state, raw, f"State is {str(state).upper()} as expected.", None
        return (config.get("severity", "alert"), state, raw,
                f"State is {str(state).upper()}, expected {str(expected).upper()}.", None)

    if parameter.kind == "number":
        if aggregation in {"none", "last"}:
            if aggregation == "last" and period and _aware(latest.recorded_at) < now - timedelta(seconds=period):
                return unknown("No reading inside the calculation period.", "no_reading_in_period", raw=raw)
            value = _as_number(raw)
            if value is None:
                return unknown("The latest value is not a valid number.", "invalid_value", raw=raw)
            status, message = number_status(value, config)
            return status, value, raw, message, None
        if _as_bool(raw) is None:
            return unknown("The latest value is not a valid Boolean.", "invalid_value", raw=raw)
        window = period or 3600
        seconds, count = _window_aggregate(session, variable, now - timedelta(seconds=window), now, stale_after)
        value = seconds if aggregation == "timer" else float(count)
        status, message = number_status(value, config)
        return status, value, raw, f"{aggregation.capitalize()} over the period: " + message, None

    # interval parameter with a variable
    if _as_bool(raw) is None:
        return unknown("The latest value is not a valid Boolean.", "invalid_value", raw=raw)
    interval = config["interval_parameter"]
    start = _aware(rule.created_at)
    if config.get("activation_at"):
        start = max(start, _aware(datetime.fromisoformat(str(config["activation_at"]).replace("Z", "+00:00"))))
    seconds, count = _cumulative_aggregate(session, parameter_state, variable, start, now, stale_after)
    if interval == "counter":
        value, unit = float(count), "cycles"
    else:
        value, unit = seconds / SECONDS_PER_HOUR, "hours"
    status, message = interval_status(value, config, unit)
    return status, value, raw, message, None


def triggered_limit(parameter: RuleParameter, status: str, value: Any) -> tuple[float | None, str | None]:
    """The limit a Warning/Alert status crossed, and a short label for it (None for Boolean)."""
    config = parameter.config or {}
    if status not in {"warning", "alert"} or not isinstance(value, (int, float)) or isinstance(value, bool):
        return None, None
    if parameter.kind == "interval":
        key = "overdue" if status == "alert" else "due"
        return config.get(key), key.capitalize()
    if parameter.kind == "number":
        for key, upper in ((f"upper_{status}", True), (f"lower_{status}", False)):
            limit = config.get(key)
            if limit is not None and (value >= limit if upper else value <= limit):
                return limit, key.replace("_", " ").title()
    return None, None


def _sync_parameter_alert(
    session: Session, rule: MonitoringRule, asset: Asset, parameter: RuleParameter,
    parameter_state: RuleParameterState, status: str, value: Any, message: str, now: datetime,
) -> None:
    """Raise, update or resolve THIS parameter's alert only. Unknown never resolves or hides an alert."""
    from app.services.email_notifications import enqueue_alert_notifications
    from app.services.monitoring_engine import emit_event

    active = session.scalar(
        select(Alert).where(
            Alert.rule_id == rule.id, Alert.target_asset_id == asset.id,
            Alert.parameter_id == parameter.id, Alert.status == "active",
        ).order_by(Alert.id.desc()).limit(1)
    )
    meta = {"parameter_id": parameter.id, "parameter_key": parameter.key, "parameter_name": parameter.name}
    if status in {"warning", "alert"}:
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
                threshold=threshold, status="active", started_at=now, last_updated_at=now,
            )
            try:
                with session.begin_nested():
                    session.add(alert)
                    session.flush()
            except IntegrityError:
                return  # another worker raised it first
            enqueue_alert_notifications(session, alert, asset, rule)
            emit_event(session, event_type="warning_triggered" if status == "warning" else "alert_triggered",
                       message=text, occurred_at=now, asset_id=asset.id, rule_id=rule.id,
                       alert_id=alert.id, severity=status, metadata=meta)
            return
        if active.severity != status:
            previous = active.severity
            active.severity = status
            enqueue_alert_notifications(session, active, asset, rule)
            emit_event(session, event_type="alert_severity_changed",
                       message=f"Alert severity changed to {status}: {text}", occurred_at=now,
                       asset_id=asset.id, rule_id=rule.id, alert_id=active.id, severity=status,
                       metadata={**meta, "previous_severity": previous, "new_severity": status})
        active.message, active.trigger_value, active.threshold = text, value, threshold
        active.last_updated_at = now
    elif status == "normal":
        parameter_state.completed_at = None
        if active is not None:
            active.status, active.resolved_at, active.last_updated_at = "resolved", now, now
            emit_event(session, event_type="alert_resolved",
                       message=f"Condition cleared: {rule.name} — {parameter.name}", occurred_at=now,
                       asset_id=asset.id, rule_id=rule.id, alert_id=active.id, severity=active.severity,
                       metadata=meta)


def overall_summary(results: list[tuple[str, str]]) -> dict[str, Any]:
    """The explicit overall-status strategy, shared by the evaluator and the API.

    `results` is [(parameter name, status)]. Worst Parameter Wins with the order
    Alert > Warning > Not Evaluated (unknown) > Normal:
      * any Alert/Warning decides the overall status, even if other parameters are unavailable, so an
        unavailable parameter can never hide an active Alert;
      * with no Alert/Warning, any unavailable/stale/not-evaluated parameter makes the overall status
        Not Evaluated, never Normal;
      * Normal only when every parameter is Normal.
    Unavailable parameters are always listed separately in `unavailable`.
    """
    worst = max((s for _n, s in results), key=lambda s: SEVERITY_ORDER[s], default="unknown")
    return {
        "status": worst,
        "determined_by": [n for n, s in results if s == worst],
        "unavailable": [n for n, s in results if s == "unknown"],
    }


def evaluate_multi_parameter(
    session: Session,
    rule: MonitoringRule,
    asset: Asset,
    state: RuleState | None,
    now: datetime,
    stale_after_seconds: int,
) -> RuleState:
    """Evaluate every parameter, raise/clear each parameter's own alert, record the worst on the rule."""
    stale_after = effective_stale_after(rule, stale_after_seconds)
    results: list[tuple[RuleParameter, str, Any, str]] = []
    for parameter in list(rule.parameter_items):
        if parameter.lifecycle_status != "active":
            continue  # suspended/deactivated: no evaluation and no alerts; progress and history are kept
        parameter_state = parameter.state
        if parameter_state is None:
            parameter_state = RuleParameterState(parameter_id=parameter.id, status="unknown", message="")
            session.add(parameter_state)
            parameter.state = parameter_state
        try:
            with session.begin_nested():
                status, value, raw, message, error = _evaluate_parameter(
                    session, rule, parameter, parameter_state, asset, now, stale_after
                )
        except Exception:
            # An unexpected failure in one parameter is shown as unavailable; the others still evaluate.
            LOGGER.exception("Parameter %s of rule %s could not be evaluated", parameter.id, rule.id)
            status, value, raw, message, error = (
                "unknown", None, None, "This parameter could not be evaluated.", "evaluation_error")
        try:
            # Result, alert and events of ONE parameter are written together or not at all.
            with session.begin_nested():
                if status != "unknown":
                    parameter_state.last_valid_value = raw if raw is not None else value
                    parameter_state.last_valid_at = parameter_state.reading_at or now
                previous_error = parameter_state.error_message
                parameter_state.status, parameter_state.latest_value, parameter_state.raw_value = status, value, raw
                parameter_state.message, parameter_state.error_message = message, error
                parameter_state.last_evaluated_at = now
                _sync_parameter_alert(session, rule, asset, parameter, parameter_state, status, value, message, now)
                if error == "stale_reading" and previous_error != "stale_reading":
                    from app.services.monitoring_engine import emit_event
                    emit_event(session, event_type="stale_data_detected", message=f"{parameter.name}: {message}",
                               occurred_at=now, asset_id=asset.id, rule_id=rule.id,
                               metadata={"parameter_id": parameter.id, "parameter_name": parameter.name})
        except Exception:
            # The savepoint undid everything written for this parameter. Record that it could not be saved so the
            # parameter is not shown with a stale result, keep its evaluated status in the rule's overall result (an
            # Alert is never hidden), and carry on with the remaining parameters; the next pass retries.
            LOGGER.exception("Result or alert of parameter %s of rule %s could not be saved", parameter.id, rule.id)
            try:
                with session.begin_nested():
                    parameter_state.status, parameter_state.latest_value, parameter_state.raw_value = "unknown", None, None
                    parameter_state.message = "The result of this parameter could not be saved; it will be retried."
                    parameter_state.error_message, parameter_state.last_evaluated_at = "evaluation_error", now
            except Exception:
                LOGGER.exception("Parameter %s of rule %s could not be marked as failed", parameter.id, rule.id)
        results.append((parameter, status, value, message))

    if state is None:
        state = RuleState(rule_id=rule.id, target_asset_id=asset.id, target_variable_id=None,
                          status="unknown", message="No evaluation has been completed",
                          last_evaluated_at=now, last_transition_at=now)
        session.add(state)
    if not results:
        items = list(rule.parameter_items)
        if not items:
            overall, message, headline, error = "unknown", "This rule has no parameters.", None, "no_parameters"
        else:
            overall, headline, error = "unknown", None, "no_active_parameters"
            message = _no_active_message(items)
    else:
        summary = overall_summary([(p.name, s) for p, s, _v, _m in results])
        overall = summary["status"]
        if overall == "normal":
            message = f"All {len(results)} parameters are normal."
        else:
            culprits = [f"{p.name}: {m}" for p, s, _v, m in results if s == overall]
            others = len(results) - len(culprits)
            message = " ".join(culprits) + (f" ({others} other parameter(s) not in this state.)" if others else "")
        headline = next((v for _p, s, v, _m in results if s == overall), None)
        error = "parameter_unavailable" if overall == "unknown" else None
    if state.status != overall:
        state.last_transition_at = now
    state.status = overall
    state.latest_value = headline if isinstance(headline, (int, float)) and not isinstance(headline, bool) else None
    state.message, state.error_message = message, error
    state.last_evaluated_at, state.condition_started_at = now, None
    return state


def _pause_one(session: Session, rule: MonitoringRule, parameter: RuleParameter, now: datetime,
               message: str, error: str) -> None:
    """Bank a cumulative interval parameter's progress up to the last confirmed sample and mark it paused.
    Idempotent: a parameter that is already paused is not banked twice. Limits and progress are kept."""
    parameter_state = parameter.state
    if parameter_state is None:
        return
    if parameter.kind == "interval" and parameter.variable_id is not None:
        variable = session.get(Variable, parameter.variable_id)
        if variable is not None and not (parameter_state.aggregate_state or {}).get("paused"):
            config = parameter.config or {}
            start = _aware(rule.created_at)
            if config.get("activation_at"):
                try:
                    start = max(start, _aware(datetime.fromisoformat(str(config["activation_at"]).replace("Z", "+00:00"))))
                except ValueError:
                    pass
            seconds, count = _cumulative_aggregate(session, parameter_state, variable, start, now,
                                                   effective_stale_after(rule), drain=True)
            parameter_state.latest_value = float(count) if config.get("interval_parameter") == "counter" else seconds / SECONDS_PER_HOUR
            checkpoint = dict(parameter_state.aggregate_state or {})
            # Bank the time already credited since the last confirmed sample (never more than the stale limit), so the
            # progress shown at the moment of pausing is exactly what is kept and resuming cannot lower it.
            checkpoint.update(seconds=seconds, prev=None, prev_at=None)
            checkpoint["paused"] = True
            parameter_state.aggregate_state = checkpoint
    parameter_state.status = "unknown"
    parameter_state.message = message
    parameter_state.error_message = error
    parameter_state.last_evaluated_at = now


def _resume_one(parameter: RuleParameter, now: datetime) -> None:
    """Keep banked interval progress but skip readings recorded while paused, so the paused period is
    never counted. Normal signal-freshness rules apply from the next evaluation."""
    parameter_state = parameter.state
    if parameter_state is None:
        return
    checkpoint = dict(parameter_state.aggregate_state or {})
    if checkpoint.get("paused"):
        checkpoint.update(paused=False, cursor=now.isoformat(), reading_id=MAX_READING_ID, prev=None, prev_at=None)
        parameter_state.aggregate_state = checkpoint
    parameter_state.completed_at = None


def pause_parameters(session: Session, rule: MonitoringRule, now: datetime) -> None:
    """Rule suspended/deactivated: pause every parameter that is itself active. Parameters the user
    suspended or deactivated individually are already paused and keep their own state."""
    for parameter in rule.parameter_items:
        if parameter.lifecycle_status == "active":
            _pause_one(session, rule, parameter, now, "Rule is not active; the parameter is not being evaluated.", "rule_inactive")


def resume_parameters(session: Session, rule: MonitoringRule, now: datetime) -> None:
    """Rule resumed/activated: resume only parameters that are themselves active."""
    for parameter in rule.parameter_items:
        if parameter.lifecycle_status == "active":
            _resume_one(parameter, now)


def _no_active_message(items: list[RuleParameter]) -> str:
    suspended = sum(1 for p in items if p.lifecycle_status == "suspended")
    if suspended == len(items):
        return "All parameters are suspended; nothing is being evaluated."
    if suspended == 0:
        return "All parameters are deactivated; nothing is being evaluated."
    return "No parameter is being evaluated (all are suspended or deactivated)."


PARAMETER_LIFECYCLE_ACTIONS = {
    # action: (allowed current states, new state)
    "suspend": ({"active"}, "suspended"),
    "resume": ({"suspended"}, "active"),
    "deactivate": ({"active", "suspended"}, "deactivated"),
    "activate": ({"deactivated"}, "active"),
}


def change_parameter_lifecycle(session: Session, rule: MonitoringRule, parameter: RuleParameter, action: str,
                               now: datetime) -> None:
    """Suspend, resume, deactivate or activate ONE parameter. Other parameters and the parent rule are not
    touched; the parent's stored status is recomputed from the parameters that are still evaluated."""
    from app.services.monitoring_engine import emit_event

    allowed, target = PARAMETER_LIFECYCLE_ACTIONS[action]
    if parameter.lifecycle_status not in allowed:
        raise ValueError(f"A {parameter.lifecycle_status} parameter cannot be {action}d.")
    asset = session.get(Asset, rule.target_asset_id) if rule.target_asset_id else None
    rule_running = rule.is_enabled and rule.lifecycle_status == "in_progress"
    meta = {"parameter_id": parameter.id, "parameter_key": parameter.key, "parameter_name": parameter.name,
            "previous": parameter.lifecycle_status, "new": target}
    if target == "active":
        parameter.lifecycle_status = "active"
        if rule_running:
            _resume_one(parameter, now)  # a paused rule resumes it later, together with the rule
        if parameter.state is not None:
            parameter.state.status, parameter.state.error_message = "unknown", None
            parameter.state.message = ("Resumed; waiting for evaluation." if rule_running
                                       else "Rule is not active; the parameter is not being evaluated.")
            parameter.state.completed_at = None
    else:
        parameter.lifecycle_status = target
        # Same as a rule being turned off: this parameter's open alert is closed, its history stays.
        for alert in session.scalars(select(Alert).where(
                Alert.parameter_id == parameter.id, Alert.status == "active")).all():
            alert.status, alert.resolved_at, alert.last_updated_at = "resolved", now, now
        _pause_one(session, rule, parameter, now, f"Parameter is {target}; it is not being evaluated.", f"parameter_{target}")
        if parameter.state is not None:
            parameter.state.completed_at = None
    emit_event(session, event_type=f"parameter_{ {'suspend': 'suspended', 'resume': 'resumed', 'deactivate': 'deactivated', 'activate': 'activated'}[action] }",
               message=f"Parameter '{parameter.name}' of rule '{rule.name}' {target if target != 'active' else 'activated'}.",
               occurred_at=now, asset_id=asset.id if asset else None, rule_id=rule.id, metadata=meta)
    session.flush()
    _refresh_rule_state(session, rule, now)


def _refresh_rule_state(session: Session, rule: MonitoringRule, now: datetime) -> None:
    """Recompute the parent's stored status from the parameters that are still evaluated, so it never keeps
    a Normal/Alert that belonged to a parameter that was just switched off."""
    if not (rule.is_enabled and rule.lifecycle_status == "in_progress"):
        return
    state = session.scalar(select(RuleState).where(RuleState.rule_id == rule.id))
    if state is None:
        return
    live = [p for p in rule.parameter_items if p.lifecycle_status == "active"]
    if not live:
        overall, message, error = "unknown", _no_active_message(list(rule.parameter_items)), "no_active_parameters"
    else:
        # A parameter that was just resumed has no fresh result yet, so it counts as Not Evaluated.
        summary = overall_summary([(p.name, p.state.status if p.state else "unknown") for p in live])
        overall, error = summary["status"], ("parameter_unavailable" if summary["status"] == "unknown" else None)
        message = (f"All {len(live)} evaluated parameter(s) are normal." if overall == "normal"
                   else f"Worst parameter: {', '.join(summary['determined_by'])}.")
    if state.status != overall:
        state.last_transition_at = now
    state.status, state.message, state.error_message = overall, message, error
    if not live:
        state.latest_value = None


def reset_parameter_baseline(session: Session, parameter: RuleParameter) -> bool:
    """Restart ONLY this parameter's own progress after what it measures changed.

    Returns whether a stored state was really reset (a parameter that was never evaluated has nothing to reset), and
    records it on the session so an API response can report exactly what was reset, including shared-rule propagation.
    """
    state = parameter.state
    if state is None:
        return False
    state.aggregate_state = None
    state.status, state.message = "unknown", "Parameter was edited; waiting for evaluation."
    session.info.setdefault("parameter_state_resets", []).append((parameter.rule_id, parameter.id))
    return True


def archive_removed_parameter(session: Session, rule: MonitoringRule, parameter: RuleParameter, reason: str) -> None:
    """Keep a permanent record of a parameter that is being removed from a rule.

    Its alerts stay (resolved, with the parameter's name kept on them) and earlier events are untouched. The parameter's
    latest evaluation and progress would otherwise disappear with the row, so they are written to the event log first.
    """
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
        "parameter_id": parameter.id, "key": parameter.key, "name": parameter.name, "kind": parameter.kind,
        "variable_id": parameter.variable_id, "aggregation": parameter.aggregation, "config": plain(parameter.config),
        "lifecycle_status": parameter.lifecycle_status, "created_at": plain(parameter.created_at), "reason": reason,
        "last_state": None if state is None else plain({
            "status": state.status, "value": state.latest_value, "raw_value": state.raw_value, "message": state.message,
            "last_evaluated_at": state.last_evaluated_at, "last_valid_value": state.last_valid_value,
            "last_valid_at": state.last_valid_at, "aggregate_state": state.aggregate_state}),
    }
    emit_event(session, event_type="parameter_removed", message=f"Parameter '{parameter.name}' was removed from the rule.",
               occurred_at=datetime.now(timezone.utc), asset_id=rule.target_asset_id, rule_id=rule.id, metadata=snapshot)


def serialize_parameters(rule: MonitoringRule) -> list[dict[str, Any]]:
    """API view of a rule's parameters, including each parameter's own latest evaluation."""
    items = []
    for parameter in rule.parameter_items:
        state = parameter.state
        items.append({
            "id": parameter.id,
            "key": parameter.key,
            "name": parameter.name,
            "position": parameter.position,
            "kind": parameter.kind,
            "variable_id": parameter.variable_id,
            "aggregation": parameter.aggregation,
            "config": parameter.config,
            "lifecycle_status": parameter.lifecycle_status,
            "status": state.status if state else "unknown",
            # Evaluated (aggregated) value, distinct from the raw PLC value.
            "value": state.latest_value if state else None,
            "raw_value": state.raw_value if state else None,
            "message": state.message if state else "",
            "error": state.error_message if state else None,
            "last_evaluated_at": state.last_evaluated_at if state else None,
            "reading_at": state.reading_at if state else None,
            "last_valid_value": state.last_valid_value if state else None,
            "last_valid_at": state.last_valid_at if state else None,
        })
    return items


def _alert_view(alert: Alert) -> dict[str, Any]:
    return {
        "id": alert.id, "severity": alert.severity, "status": alert.status, "message": alert.message,
        "trigger_value": alert.trigger_value,
        "threshold": float(alert.threshold) if alert.threshold is not None else None,
        "started_at": alert.started_at, "last_updated_at": alert.last_updated_at,
        "resolved_at": alert.resolved_at, "acknowledged_at": alert.acknowledged_at,
        "acknowledged_by": alert.acknowledged_by,
        # Active alerts are open until completed; resolved ones were completed or cleared.
        "workflow": ("completed" if alert.status == "resolved" else
                     "acknowledged" if alert.acknowledged_at else "open"),
    }


def build_status_detail(session: Session, rule: MonitoringRule, now: datetime | None = None) -> dict[str, Any]:
    """Everything the Current Status detail view shows, computed by the backend only.

    The parent status is `overall_summary` over the stored per-parameter statuses (the same function and
    inputs the evaluator uses), and `rule_state_status` is the status stored on the rule itself, so the
    UI can show they agree. Nothing here re-evaluates readings and the frontend never recomputes it.
    """
    now = now or datetime.now(timezone.utc)
    stale_after = effective_stale_after(rule)
    asset = session.get(Asset, rule.target_asset_id) if rule.target_asset_id else None
    rule_state = session.scalar(select(RuleState).where(RuleState.rule_id == rule.id))
    parameters = serialize_parameters(rule)
    alerts_by_parameter: dict[int, list[Alert]] = {}
    for alert in session.scalars(
        select(Alert).where(Alert.rule_id == rule.id, Alert.parameter_id.is_not(None))
        .order_by(Alert.started_at.desc(), Alert.id.desc()).limit(200)
    ).all():
        alerts_by_parameter.setdefault(alert.parameter_id, []).append(alert)
    variables = {v.id: v for v in session.scalars(
        select(Variable).where(Variable.id.in_([p["variable_id"] for p in parameters if p["variable_id"]]))
    ).all()} if parameters else {}

    active = rule.is_enabled and rule.lifecycle_status == "in_progress"
    for item in parameters:
        variable = variables.get(item["variable_id"])
        item["variable_name"] = variable.name if variable else None
        item["unit"] = (variable.unit if variable else None) or (
            "hours" if item["kind"] == "interval" and (item["config"] or {}).get("interval_parameter") in {"usage", "time"}
            else "cycles" if item["kind"] == "interval" else None)
        reading_at = item["reading_at"]
        age = (now - _aware(reading_at)).total_seconds() if reading_at else None
        item["reading_age_seconds"] = age
        item["is_stale"] = bool(item["variable_id"]) and (age is None or age > stale_after)
        # A parameter that is not in a usable state is reported on its own and never counted as Normal.
        lifecycle = item["lifecycle_status"]
        evaluating = active and lifecycle == "active"
        item["evaluating"] = evaluating
        if not active:
            # A suspended/deactivated rule is not evaluating: never show a leftover value or status.
            item["status"], item["value"], item["active_alert"] = "unknown", None, None
        elif lifecycle != "active":
            # Suspended/deactivated parameter: no status, but its preserved progress stays visible.
            item["status"] = "unknown"
        item["availability"] = ("inactive" if not active else
                                lifecycle if lifecycle != "active" else
                                "available" if item["status"] != "unknown" else
                                "variable_inactive" if item["error"] == "variable_inactive" else
                                "awaiting_reading" if item["error"] == "awaiting_fresh_reading" else
                                "stale" if item["error"] == "stale_reading" else "unavailable")
        item["schedule"] = None
        if item["kind"] == "interval":
            config = item["config"] or {}
            start = _aware(rule.created_at)
            if config.get("activation_at"):
                try:
                    start = max(start, _aware(datetime.fromisoformat(str(config["activation_at"]).replace("Z", "+00:00"))))
                except ValueError:
                    pass
            item["schedule"] = {"start_at": start}
            if config.get("interval_parameter") == "time" and config.get("due") is not None:
                # Calendar intervals: the dates the Due and Overdue limits fall on (hours after activation).
                item["schedule"]["due_at"] = start + timedelta(hours=float(config["due"]))
                item["schedule"]["overdue_at"] = start + timedelta(hours=float(config["overdue"]))
        # How the UI may advance an interval duration between evaluations (display only, no accounting):
        #   timer    running-time interval: advances while the latest reading is a valid, fresh TRUE, and never
        #            past reading_at + stale limit, exactly the window the evaluator credits;
        #   calendar elapsed time since the schedule start;
        #   None     counters and Number/Boolean parameters stay event-driven.
        item["live"] = None
        if item["kind"] == "interval" and evaluating and item["status"] != "unknown" and item["last_evaluated_at"]:
            config = item["config"] or {}
            if item["variable_id"] is None and config.get("interval_parameter") == "time":
                item["live"] = {"mode": "calendar", "baseline_at": item["last_evaluated_at"]}
            elif item["aggregation"] == "timer" and config.get("interval_parameter") == "usage":
                fresh_until = _aware(item["reading_at"]) + timedelta(seconds=stale_after) if item["reading_at"] else None
                # The evaluator credits an ON segment up to its last reading's timestamp even when that stamp is a
                # little later than the evaluation instant, so the value is exact as of the later of the two.
                baseline = max(_aware(item["last_evaluated_at"]), _aware(item["reading_at"])) if item["reading_at"] else item["last_evaluated_at"]
                item["live"] = {
                    "mode": "timer",
                    "baseline_at": baseline,
                    "running": bool(_as_bool(item["raw_value"]) is True and fresh_until is not None),
                    "running_until": fresh_until,
                }
        history = [_alert_view(a) for a in alerts_by_parameter.get(item["id"], [])]
        item["active_alert"] = next((a for a in history if a["status"] == "active"), None)
        item["alert_history"] = history[:10]

    # Only parameters that are actually being evaluated take part in the parent status.
    evaluated_items = [p for p in parameters if p["evaluating"]]
    summary = overall_summary([(p["name"], p["status"]) for p in evaluated_items])
    determined_by = [p["id"] for p in evaluated_items if p["status"] == summary["status"]]
    counts = {name: sum(1 for p in parameters if p["lifecycle_status"] == name) for name in ("active", "suspended", "deactivated")}
    if not active:
        mode = "rule_inactive"
    elif evaluated_items:
        mode = "evaluating"
    elif parameters and counts["deactivated"] == len(parameters):
        mode = "all_deactivated"
    elif parameters and counts["suspended"] == len(parameters):
        mode = "all_suspended"
    else:
        mode = "no_active_parameters"
    evaluated = [p["last_evaluated_at"] for p in parameters if p["last_evaluated_at"]]
    category = (rule.parameters or {}).get("category")
    return {
        "rule": {
            "id": rule.id, "name": rule.name, "rule_type": rule.rule_type,
            "type": "interval_based" if category == "interval_based" else "parameter_threshold",
            "is_enabled": rule.is_enabled, "lifecycle_status": rule.lifecycle_status, "completed_at": rule.completed_at,
            "asset_id": rule.target_asset_id, "asset_name": asset.name if asset else None,
            "calculation_period_seconds": (rule.parameters or {}).get("calculation_period_seconds"),
            "stale_after_seconds": stale_after,
        },
        "overall": {
            "status": summary["status"] if evaluated_items else "unknown",
            "evaluating": bool(evaluated_items),
            "mode": mode,
            "counts": counts,
            "strategy": "worst_parameter_wins",
            "determined_by": determined_by,
            "unavailable_ids": [p["id"] for p in evaluated_items if p["status"] == "unknown"],
            "parameter_count": len(parameters),
            "rule_state_status": rule_state.status if rule_state else None,
            "message": rule_state.message if rule_state else "",
            "last_evaluated_at": (rule_state.last_evaluated_at if rule_state else None) or (max(evaluated) if evaluated else None),
        },
        "parameters": parameters,
        "server_time": now,
    }
