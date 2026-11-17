# Parameter view of rules created before the parameter system (read and edit adapter).
#
# Older rules keep their original storage (MonitoringRule columns, RuleState, RuleCounterState, alerts), and
# their evaluators are unchanged. This module only PRESENTS each one as a single parameter with the same shape
# as a RuleParameter, so the UI treats every rule the same way, and translates edits and lifecycle actions on
# that parameter back into the existing rule update / lifecycle logic. Nothing here writes new tables or columns.
#
#   boolean_count_threshold  -> Interval / Counter  (Due = first warning, Overdue = alert threshold)
#   runtime_duration         -> Interval / Usage    (hours; Due = first warning, Overdue = alert threshold)
#
# Both warning stages are reported as "warning" by the evaluator, so showing only the first one (Due) is status
# equivalent. The middle threshold is left untouched unless Due or Overdue is edited.
# Other legacy types are shown as one read-only parameter (`editable` false, with a reason); they are not converted.
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Alert, Asset, MonitoringRule, RuleState, Variable
from app.services.rule_parameters import SECONDS_PER_HOUR, _alert_view, _aware, overall_summary

LEGACY_ID_OFFSET = 0  # a legacy parameter's id is the NEGATIVE rule id, so it can never collide with a row id


def legacy_parameter_id(rule: MonitoringRule) -> int:
    return -rule.id


def _numbers(values: Any) -> list[float] | None:
    try:
        return [float(v) for v in values]
    except (TypeError, ValueError):
        return None


def mapping(rule: MonitoringRule) -> dict[str, Any]:
    # How this rule appears as a parameter: kind/config/aggregation, unit and whether it can be edited.
    p = rule.parameters or {}
    if rule.rule_type == "boolean_count_threshold":
        w, alert = _numbers(p.get("warning_thresholds")), p.get("alert_threshold")
        if w and len(w) == 2 and isinstance(alert, (int, float)):
            return {"editable": True, "kind": "interval", "aggregation": "counter", "unit": "cycles",
                    "default_name": "Cycle count", "scale": 1.0,
                    "config": {"interval_parameter": "counter", "due": int(w[0]), "overdue": int(alert)}}
    if rule.rule_type == "runtime_duration" and "warning_thresholds_seconds" in p:
        w, alert = _numbers(p.get("warning_thresholds_seconds")), p.get("alert_threshold_seconds")
        if w and len(w) == 2 and isinstance(alert, (int, float)):
            config = {"interval_parameter": "usage", "due": w[0] / SECONDS_PER_HOUR, "overdue": float(alert) / SECONDS_PER_HOUR}
            if p.get("activation_at"):
                config["activation_at"] = p["activation_at"]
            return {"editable": True, "kind": "interval", "aggregation": "timer", "unit": "hours",
                    "default_name": "Running time", "scale": SECONDS_PER_HOUR, "config": config}
    reason = {
        "duration": "Time-period rules are shown for monitoring only; their schedule cannot be edited as a parameter yet.",
        "parameter_threshold": "Single-threshold rules are shown for monitoring only; they cannot be edited as a parameter yet.",
    }.get(rule.rule_type, "This rule's configuration cannot be edited as a parameter yet.")
    return {"editable": False, "reason": reason, "kind": "number", "aggregation": "none", "unit": None,
            "default_name": rule.name, "scale": 1.0, "config": {}}


def parameter_name(rule: MonitoringRule, info: dict[str, Any]) -> str:
    return str((rule.parameters or {}).get("parameter_name") or info["default_name"])


def _lifecycle(rule: MonitoringRule) -> str:
    if rule.lifecycle_status == "in_progress" and rule.is_enabled:
        return "active"
    return {"suspended": "suspended", "deactivated": "deactivated", "completed": "completed"}.get(
        rule.lifecycle_status, "deactivated")


def _state(session: Session, rule: MonitoringRule) -> RuleState | None:
    return session.scalar(select(RuleState).where(RuleState.rule_id == rule.id))


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
        "position": 0, "kind": info["kind"], "variable_id": rule.variable_id,
        "aggregation": info["aggregation"], "config": info["config"],
        "lifecycle_status": _lifecycle(rule), "status": state.status if state else "unknown",
        "value": value, "raw_value": None, "message": state.message if state else "",
        "error": state.error_message if state else None,
        "last_evaluated_at": state.last_evaluated_at if state else None, "reading_at": None,
        "last_valid_value": None, "last_valid_at": None,
        "legacy": True, "editable": info["editable"], "not_editable_reason": info.get("reason"),
        "unit": info["unit"],
    }]


def build_legacy_status_detail(session: Session, rule: MonitoringRule, now: datetime | None = None) -> dict[str, Any]:
    # Same payload as build_status_detail, for a rule that has no parameter rows.
    now = now or datetime.now(timezone.utc)
    asset = session.get(Asset, rule.target_asset_id) if rule.target_asset_id else None
    rule_state = _state(session, rule)
    item = serialize_legacy_parameters(session, rule)[0]
    variable = session.get(Variable, rule.variable_id) if rule.variable_id else None
    info = mapping(rule)
    active = rule.is_enabled and rule.lifecycle_status == "in_progress"
    item["variable_name"] = variable.name if variable else None
    item["unit"] = info["unit"] or (variable.unit if variable else None)
    item["reading_age_seconds"] = None
    stale = bool(item["error"]) and "stale" in str(item["error"]).lower()
    item["is_stale"] = stale
    item["evaluating"] = active
    if not active:
        item["status"], item["value"] = "unknown", None
    item["availability"] = ("inactive" if not active else "available" if item["status"] != "unknown"
                            else "stale" if stale else "unavailable")
    item["schedule"] = None
    item["live"] = None
    start = (item["config"] or {}).get("activation_at")
    if start:
        try:
            item["schedule"] = {"start_at": max(_aware(rule.created_at),
                                                _aware(datetime.fromisoformat(str(start).replace("Z", "+00:00"))))}
        except ValueError:
            pass
    alerts = [_alert_view(a) for a in session.scalars(
        select(Alert).where(Alert.rule_id == rule.id, Alert.parameter_id.is_(None))
        .order_by(Alert.started_at.desc(), Alert.id.desc()).limit(200)).all()]
    item["active_alert"] = next((a for a in alerts if a["status"] == "active"), None) if active else None
    item["alert_history"] = alerts[:10]

    parameters = [item]
    evaluated = [item] if item["evaluating"] else []
    summary = overall_summary([(item["name"], item["status"])] ) if evaluated else {"status": "unknown"}
    lifecycle = item["lifecycle_status"]
    counts = {name: int(lifecycle == name) for name in ("active", "suspended", "deactivated")}
    mode = "evaluating" if evaluated else "rule_inactive"
    return {
        "rule": {
            "id": rule.id, "name": rule.name, "rule_type": rule.rule_type, "type": "interval_based",
            "is_enabled": rule.is_enabled, "lifecycle_status": rule.lifecycle_status, "completed_at": rule.completed_at,
            "asset_id": rule.target_asset_id, "asset_name": asset.name if asset else None,
            "calculation_period_seconds": None,
            "stale_after_seconds": rule.stale_after_seconds or 300, "legacy": True,
        },
        "overall": {
            "status": summary["status"] if evaluated else "unknown", "evaluating": bool(evaluated), "mode": mode,
            "counts": counts, "strategy": "worst_parameter_wins",
            "determined_by": [item["id"]] if evaluated else [],
            "unavailable_ids": [item["id"]] if evaluated and item["status"] == "unknown" else [],
            "parameter_count": 1,
            "rule_state_status": rule_state.status if rule_state else None,
            "message": rule_state.message if rule_state else "",
            "last_evaluated_at": rule_state.last_evaluated_at if rule_state else None,
        },
        "parameters": parameters,
        "server_time": now,
    }


def rule_update_for_parameter(rule: MonitoringRule, payload: Any) -> dict[str, Any]:
    # RuleUpdate fields that apply an edit of the (single) parameter. Raises ValueError with a user message.
    info = mapping(rule)
    if not info["editable"]:
        raise ValueError(info["reason"])
    if payload.kind != info["kind"]:
        raise ValueError("A parameter's type cannot be changed.")
    if payload.variable_id is None:
        raise ValueError("Connect a variable.")
    config = payload.config or {}
    if config.get("interval_parameter") != info["config"]["interval_parameter"]:
        raise ValueError("The interval type of an existing rule cannot be changed.")
    if payload.aggregation != info["aggregation"]:
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
    if info["config"]["interval_parameter"] == "counter":
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
        start = config.get("activation_at")
        if start and start != current.get("activation_at"):
            parameters["activation_at"] = start
    if parameters:
        changes["parameters"] = parameters
    return changes


def _middle(existing: float, due: float, overdue: float, unit: float, changed: bool) -> float:
    # Keep the stored second warning when it still fits; otherwise use the wizard convention (one unit below Overdue).
    if due < existing < overdue:
        return existing
    middle = overdue - unit
    if not due < middle < overdue:
        raise ValueError("Overdue must be at least two units above Due.")
    return int(middle)
