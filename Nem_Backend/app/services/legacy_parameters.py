from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Alert, Asset, MonitoringRule, RuleState, Variable
from app.services.rule_parameters import SECONDS_PER_HOUR, _alert_view, _aware, overall_summary
from app.core.constants import (
    ACTIVATION_AT,
    AGGREGATION,
    COUNTER,
    INTERVAL,
    INTERVAL_PARAMETER,
    KIND,
    LIFECYCLE_STATUS,
    NUMBER,
    RULE_BOOLEAN_COUNT_THRESHOLD,
    RULE_PARAMETER_THRESHOLD,
    RULE_RUNTIME_DURATION,
    RULE_TYPE,
    SCHEDULE,
    STATUS_ACTIVE,
    STATUS_COMPLETED,
    STATUS_DEACTIVATED,
    STATUS_IN_PROGRESS,
    STATUS_SUSPENDED,
    STATUS_UNKNOWN,
    TIMER,
    USAGE,
    AGGREGATION_NONE,
    CATEGORY_INTERVAL_BASED,
)

# Generates a unique-looking parameter ID for an old rule.
def legacy_parameter_id(rule: MonitoringRule) -> int:
    return -rule.id

# Converts values into floating-point numbers.
def _numbers(values: Any) -> list[float] | None:
    try:
        return [float(v) for v in values]
    except (TypeError, ValueError):
        return None

# IMP -> This func determines how an old monitoring rule should appear as a parameter in the newer system.
def mapping(rule: MonitoringRule) -> dict[str, Any]:
    # How this rule appears as a parameter: kind/config/aggregation, unit and whether it can be edited.
    p = rule.parameters or {}
    if rule.rule_type == RULE_BOOLEAN_COUNT_THRESHOLD:
        w, alert = _numbers(p.get("warning_thresholds")), p.get("alert_threshold")
        if w and len(w) == 2 and isinstance(alert, (int, float)):
            return {"editable": True, KIND: INTERVAL, AGGREGATION: COUNTER, "unit": "cycles",
                    "default_name": "Cycle count", "scale": 1.0,
                    "config": {INTERVAL_PARAMETER: COUNTER, "due": int(w[0]), "overdue": int(alert)}}
    if rule.rule_type == RULE_RUNTIME_DURATION and "warning_thresholds_seconds" in p:
        w, alert = _numbers(p.get("warning_thresholds_seconds")), p.get("alert_threshold_seconds")
        if w and len(w) == 2 and isinstance(alert, (int, float)):
            config = {INTERVAL_PARAMETER: USAGE, "due": w[0] / SECONDS_PER_HOUR, "overdue": float(alert) / SECONDS_PER_HOUR}
            if p.get(ACTIVATION_AT):
                config[ACTIVATION_AT] = p[ACTIVATION_AT]
            return {"editable": True, KIND: INTERVAL, AGGREGATION: TIMER, "unit": "hours",
                    "default_name": "Running time", "scale": SECONDS_PER_HOUR, "config": config}
    reason = {
        "duration": "Time-period rules are shown for monitoring only; their schedule cannot be edited as a parameter yet.",
        RULE_PARAMETER_THRESHOLD: "Single-threshold rules are shown for monitoring only; they cannot be edited as a parameter yet.",
    }.get(rule.rule_type, "This rule's configuration cannot be edited as a parameter yet.")
    return {"editable": False, "reason": reason, KIND: NUMBER, AGGREGATION: AGGREGATION_NONE, "unit": None,
            "default_name": rule.name, "scale": 1.0, "config": {}}

# Determine the display name of the virtual parameter.
def parameter_name(rule: MonitoringRule, info: dict[str, Any]) -> str:
    return str((rule.parameters or {}).get("parameter_name") or info["default_name"])

# Converts the old rule lifecycle into the lifecycle representation expected by the frontend
def _lifecycle(rule: MonitoringRule) -> str:
    if rule.lifecycle_status == STATUS_IN_PROGRESS and rule.is_enabled:
        return STATUS_ACTIVE
    return {STATUS_SUSPENDED: STATUS_SUSPENDED, STATUS_DEACTIVATED: STATUS_DEACTIVATED, STATUS_COMPLETED: STATUS_COMPLETED}.get(
        rule.lifecycle_status, STATUS_DEACTIVATED)

# Retrieves the latest stored evaluation state for a rule.
def _state(session: Session, rule: MonitoringRule) -> RuleState | None:
    return session.scalar(select(RuleState).where(RuleState.rule_id == rule.id))

# This function converts an old rule into a parameter-shaped dictionary
def serialize_legacy_parameters(session: Session, rule: MonitoringRule) -> list[dict[str, Any]]:
    info = mapping(rule)
    state = _state(session, rule)
    value = None
    if state is not None and state.latest_value is not None:
        try:
            value = float(state.latest_value) / info["scale"]
        except (TypeError, ValueError):
            value = None
    return [{
        "id": legacy_parameter_id(rule), "key": f"legacy-{rule.id}", "name": parameter_name(rule, info),
        "position": 0, KIND: info[KIND], "variable_id": rule.variable_id,
        AGGREGATION: info[AGGREGATION], "config": info["config"],
        LIFECYCLE_STATUS: _lifecycle(rule), "status": state.status if state else STATUS_UNKNOWN,
        "value": value, "raw_value": None, "message": state.message if state else "",
        "error": state.error_message if state else None,
        "last_evaluated_at": state.last_evaluated_at if state else None, "reading_at": None,
        "last_valid_value": None, "last_valid_at": None,
        "legacy": True, "editable": info["editable"], "not_editable_reason": info.get("reason"),
        "unit": info["unit"],
    }]

# responsible for building the detailed monitoring response for an old rule.
def build_legacy_status_detail(session: Session, rule: MonitoringRule, now: datetime | None = None) -> dict[str, Any]:
    # Same payload as build_status_detail, for a rule that has no parameter rows.
    now = now or datetime.now(timezone.utc)
    asset = session.get(Asset, rule.target_asset_id) if rule.target_asset_id else None
    rule_state = _state(session, rule)
    item = serialize_legacy_parameters(session, rule)[0]
    variable = session.get(Variable, rule.variable_id) if rule.variable_id else None
    info = mapping(rule)
    active = rule.is_enabled and rule.lifecycle_status == STATUS_IN_PROGRESS
    item["variable_name"] = variable.name if variable else None
    item["unit"] = info["unit"] or (variable.unit if variable else None)
    item["reading_age_seconds"] = None
    stale = bool(item["error"]) and "stale" in str(item["error"]).lower()
    item["is_stale"] = stale
    item["evaluating"] = active
    if not active:
        item["status"], item["value"] = STATUS_UNKNOWN, None
    item["availability"] = ("inactive" if not active else "available" if item["status"] != STATUS_UNKNOWN
                            else "stale" if stale else "unavailable")
    item[SCHEDULE] = None
    item["live"] = None
    start = (item["config"] or {}).get(ACTIVATION_AT)
    if start:
        try:
            item[SCHEDULE] = {"start_at": max(_aware(rule.created_at),
                                                _aware(datetime.fromisoformat(str(start).replace("Z", "+00:00"))))}
        except ValueError:
            pass
    alerts = [_alert_view(a) for a in session.scalars(
        select(Alert).where(Alert.rule_id == rule.id, Alert.parameter_id.is_(None))
        .order_by(Alert.started_at.desc(), Alert.id.desc()).limit(200)).all()]
    item["active_alert"] = next((a for a in alerts if a["status"] == STATUS_ACTIVE), None) if active else None
    item["alert_history"] = alerts[:10]

    parameters = [item]
    evaluated = [item] if item["evaluating"] else []
    summary = overall_summary([(item["name"], item["status"])] ) if evaluated else {"status": STATUS_UNKNOWN}
    lifecycle = item[LIFECYCLE_STATUS]
    counts = {name: int(lifecycle == name) for name in (STATUS_ACTIVE, STATUS_SUSPENDED, STATUS_DEACTIVATED)}
    mode = "evaluating" if evaluated else "rule_inactive"
    return {
        "rule": {
            "id": rule.id, "name": rule.name, RULE_TYPE: rule.rule_type, "type": CATEGORY_INTERVAL_BASED,
            "is_enabled": rule.is_enabled, LIFECYCLE_STATUS: rule.lifecycle_status, "completed_at": rule.completed_at,
            "asset_id": rule.target_asset_id, "asset_name": asset.name if asset else None,
            "calculation_period_seconds": None,
            "stale_after_seconds": rule.stale_after_seconds or 300, "legacy": True,
        },
        "overall": {
            "status": summary["status"] if evaluated else STATUS_UNKNOWN, "evaluating": bool(evaluated), "mode": mode,
            "counts": counts, "strategy": "worst_parameter_wins",
            "determined_by": [item["id"]] if evaluated else [],
            "unavailable_ids": [item["id"]] if evaluated and item["status"] == STATUS_UNKNOWN else [],
            "parameter_count": 1,
            "rule_state_status": rule_state.status if rule_state else None,
            "message": rule_state.message if rule_state else "",
            "last_evaluated_at": rule_state.last_evaluated_at if rule_state else None,
        },
        "parameters": parameters,
        "server_time": now,
    }

# Allow supported legacy rules to be edited through the newer parameter editing interface.
def rule_update_for_parameter(rule: MonitoringRule, payload: Any) -> dict[str, Any]:
    # RuleUpdate fields that apply an edit of the (single) parameter. Raises ValueError with a user message.
    info = mapping(rule)
    if not info["editable"]:
        raise ValueError(info["reason"])
    if payload.kind != info[KIND]:
        raise ValueError("A parameter's type cannot be changed.")
    if payload.variable_id is None:
        raise ValueError("Connect a variable.")
    config = payload.config or {}
    if config.get(INTERVAL_PARAMETER) != info["config"][INTERVAL_PARAMETER]:
        raise ValueError("The interval type of an existing rule cannot be changed.")
    if payload.aggregation != info[AGGREGATION]:
        raise ValueError("The aggregation of an existing rule cannot be changed.")
    changes: dict[str, Any] = {}
    parameters: dict[str, Any] = {}
    if rule.variable_id != payload.variable_id:
        changes["variable_id"] = payload.variable_id
    name = payload.name.strip()
    if name != parameter_name(rule, info):
        parameters["parameter_name"] = name
    current = rule.parameters or {}
    scale = info["scale"]
    due, overdue = float(config["due"]), float(config["overdue"])
    if info["config"][INTERVAL_PARAMETER] == COUNTER:
        old_due, old_overdue = current["warning_thresholds"][0], current["alert_threshold"]
        new_due, new_overdue = int(due), int(overdue)
        if (new_due, new_overdue) != (old_due, old_overdue):
            middle = _middle(current["warning_thresholds"][1], new_due, new_overdue, 1,
                             changed=(new_due != old_due or new_overdue != old_overdue))
            parameters["warning_thresholds"] = [new_due, middle]
            parameters["alert_threshold"] = new_overdue
    else:
        old_due, old_overdue = current["warning_thresholds_seconds"][0], current["alert_threshold_seconds"]
        new_due, new_overdue = round(due * scale), round(overdue * scale)
        if (new_due, new_overdue) != (round(old_due), round(old_overdue)):
            middle = _middle(current["warning_thresholds_seconds"][1], new_due, new_overdue, 1, changed=True)
            parameters["warning_thresholds_seconds"] = [new_due, middle]
            parameters["alert_threshold_seconds"] = new_overdue
        start = config.get(ACTIVATION_AT)
        if start and start != current.get(ACTIVATION_AT):
            parameters[ACTIVATION_AT] = start
    if parameters:
        changes["parameters"] = parameters
    return changes

# This function manages the intermediate warning threshold.
def _middle(existing: float, due: float, overdue: float, unit: float, changed: bool) -> float:
    # Keep the stored second warning when it still fits; otherwise use the wizard convention (one unit below Overdue).
    if due < existing < overdue:
        return existing
    middle = overdue - unit
    if not due < middle < overdue:
        raise ValueError("Overdue must be at least two units above Due.")
    return int(middle)
