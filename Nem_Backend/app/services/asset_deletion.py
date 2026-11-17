"""Dependency discovery and transactional, ordered deletion for assets and variables.
Deactivation never touches data. Permanent deletion is a separate operation that:
   shows exactly what will be removed first (``asset_deletion_summary``),
   refuses (blockers) when something outside the deleted hierarchy still points at it
    or the OPC UA collector is configured to poll it,
   removes everything in dependency order inside the caller's single transaction.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.models import (
    Alert,
    Asset,
    AssetSupervisor,
    EmailNotification,
    InstructionDocument,
    MachineMonitoringState,
    MaintenanceRecord,
    MaintenanceSchedule,
    MonitoringEvent,
    MonitoringRule,
    MonitoringRuleTemplate,
    Reading,
    RuleCounterState,
    RuleParameter,
    RuleParameterState,
    RuleState,
    Variable,
)


def _count(session: Session, column, ids) -> int:
    if not ids:
        return 0
    return session.scalar(select(func.count()).select_from(column.class_).where(column.in_(ids))) or 0


def hierarchy(session: Session, root: Asset) -> list[dict[str, Any]]:
    # Root first, then descendants breadth-first, each with its depth (cycle-safe).
    rows = [{"id": root.id, "name": root.name, "asset_type": root.asset_type,
             "parent_asset_id": root.parent_asset_id, "is_active": root.is_active, "depth": 0}]
    seen = {root.id}
    frontier = [root.id]
    depth = 0
    while frontier:
        depth += 1
        children = session.scalars(select(Asset).where(Asset.parent_asset_id.in_(frontier)).order_by(Asset.name, Asset.id)).all()
        frontier = []
        for child in children:
            if child.id in seen:
                continue
            seen.add(child.id)
            frontier.append(child.id)
            rows.append({"id": child.id, "name": child.name, "asset_type": child.asset_type,
                         "parent_asset_id": child.parent_asset_id, "is_active": child.is_active, "depth": depth})
    return rows


_MAPPING_GUIDANCE = ("Remove that entry from OPC_UA_MACHINE_MAPPINGS in the backend configuration and restart the backend, "
    "or deactivate instead to keep everything."
)

def _collector_blockers(session: Session, collector: Any, asset_ids: set[int], variable_ids: set[int]) -> list[str]:
    # One message per mapped signal that names the asset, variable, signal role and NodeId.
    if collector is None:
        return []
    messages: list[str] = []
    for mapping in getattr(collector, "mappings", []) or []:
        signals = [(mapping.cycle_signal, "cycle signal"), (mapping.running_signal, "running signal"),
                   *((signal, "reading") for signal in mapping.readings)]
        hits = [(signal, role) for signal, role in signals
                if signal is not None and (signal.variable_id in variable_ids)]
        if mapping.asset_id not in asset_ids and not hits:
            continue
        asset = session.get(Asset, mapping.asset_id)
        label = f"Asset {mapping.asset_id}" + (f" \"{asset.name}\"" if asset else "")
        if not hits:
            messages.append(f"{label} has an OPC UA machine mapping. {_MAPPING_GUIDANCE}")
        for signal, role in hits:
            variable = session.get(Variable, signal.variable_id)
            name = f" \"{variable.name}\"" if variable else ""
            messages.append(
                f"{label}: variable {signal.variable_id}{name} is mapped as the {role} to NodeId {signal.node_id}. "
                f"{_MAPPING_GUIDANCE}")
    return messages


def asset_deletion_summary(session: Session, asset: Asset, collector: Any = None) -> dict[str, Any]:
    tree = hierarchy(session, asset)
    asset_ids = [row["id"] for row in tree]
    id_set = set(asset_ids)

    variables = session.scalars(select(Variable).where(Variable.asset_id.in_(asset_ids))).all()
    variable_ids = [v.id for v in variables]
    rule_ids = list(session.scalars(select(MonitoringRule.id).where(MonitoringRule.target_asset_id.in_(asset_ids))).all())
    alert_ids = list(session.scalars(select(Alert.id).where(Alert.target_asset_id.in_(asset_ids))).all())
    schedule_ids = list(session.scalars(select(MaintenanceSchedule.id).where(MaintenanceSchedule.asset_id.in_(asset_ids))).all())
    parameter_ids = list(session.scalars(select(RuleParameter.id).where(RuleParameter.rule_id.in_(rule_ids))).all()) if rule_ids else []

    active_alerts = (session.scalar(select(func.count()).select_from(Alert).where(
        Alert.target_asset_id.in_(asset_ids), Alert.status == "active")) or 0)
    events = session.scalar(select(func.count()).select_from(MonitoringEvent).where(
        (MonitoringEvent.asset_id.in_(asset_ids))
        | (MonitoringEvent.rule_id.in_(rule_ids) if rule_ids else False)
        | (MonitoringEvent.alert_id.in_(alert_ids) if alert_ids else False))) or 0
    notifications = _count(session, EmailNotification.alert_id, alert_ids)
    parameter_states = _count(session, RuleParameterState.parameter_id, parameter_ids)
    docs = _count(session, InstructionDocument.asset_id, asset_ids)

    counts = {
        "child_assets": len(tree) - 1,
        "variables": len(variables),
        "inactive_variables": sum(1 for v in variables if not v.is_active),
        "readings": _count(session, Reading.asset_id, asset_ids),
        "rules": len(rule_ids),
        "rule_parameters": len(parameter_ids),
        "rule_parameter_states": parameter_states,
        "rule_states": _count(session, RuleState.target_asset_id, asset_ids),
        "rule_counter_states": _count(session, RuleCounterState.asset_id, asset_ids),
        "runtime_records": _count(session, MachineMonitoringState.asset_id, asset_ids),
        "alerts": len(alert_ids),
        "active_alerts": active_alerts,
        "alert_notifications": notifications,
        "monitoring_events": events,
        "maintenance_schedules": len(schedule_ids),
        "maintenance_records": _count(session, MaintenanceRecord.asset_id, asset_ids),
        "supervisor_assignments": _count(session, AssetSupervisor.asset_id, asset_ids),
    }
    retained = []
    if docs:
        retained.append({"kind": "instruction_documents", "count": docs,
                         "action": "Kept; only their link to the deleted asset is cleared."})

    legacy_templates = session.scalar(select(func.count()).select_from(MonitoringRuleTemplate).where(
        MonitoringRuleTemplate.legacy_rule_id.in_(rule_ids))) if rule_ids else 0
    if legacy_templates:
        retained.append({"kind": "rule_templates", "count": legacy_templates,
                         "action": "Kept; reusable templates created from these rules are not deleted."})
    blockers = _collector_blockers(session, collector, id_set, set(variable_ids))
    # Rows outside the deleted hierarchy that point into it would be orphaned or violate constraints.
    external = [
        ("monitoring rules on other assets use these variables",
         select(func.count()).select_from(MonitoringRule).where(MonitoringRule.variable_id.in_(variable_ids), MonitoringRule.target_asset_id.not_in(asset_ids))),
        ("rule parameters of other assets use these variables",
         select(func.count()).select_from(RuleParameter).where(RuleParameter.variable_id.in_(variable_ids), RuleParameter.rule_id.not_in(rule_ids or [0]))),
        ("maintenance schedules of other assets use these variables",
         select(func.count()).select_from(MaintenanceSchedule).where(MaintenanceSchedule.signal_variable_id.in_(variable_ids), MaintenanceSchedule.asset_id.not_in(asset_ids))),
        ("readings on other assets reference these variables",
         select(func.count()).select_from(Reading).where(Reading.variable_id.in_(variable_ids), Reading.asset_id.not_in(asset_ids))),
        ("alerts on other assets reference these rules",
         select(func.count()).select_from(Alert).where(Alert.rule_id.in_(rule_ids or [0]), Alert.target_asset_id.not_in(asset_ids))),
        ("maintenance records on other assets reference these alerts or schedules",
         select(func.count()).select_from(MaintenanceRecord).where(MaintenanceRecord.asset_id.not_in(asset_ids),
             (MaintenanceRecord.alert_id.in_(alert_ids or [0])) | (MaintenanceRecord.schedule_id.in_(schedule_ids or [0])))),
        ("alerts on other assets reference these maintenance schedules",
         select(func.count()).select_from(Alert).where(Alert.maintenance_schedule_id.in_(schedule_ids or [0]), Alert.target_asset_id.not_in(asset_ids))),
    ] if variable_ids or rule_ids or alert_ids or schedule_ids else []
    for label, query in external:
        found = session.scalar(query) or 0
        if found:
            blockers.append(f"{found} record(s) outside this hierarchy remain: {label}.")

    dependency_total = sum(counts[k] for k in (
        "child_assets", "variables", "readings", "rules", "rule_parameters", "rule_states",
        "rule_counter_states", "runtime_records", "alerts", "monitoring_events",
        "maintenance_schedules", "maintenance_records"))
    return {
        "asset": {"id": asset.id, "name": asset.name, "is_active": asset.is_active},
        "hierarchy": tree,
        "counts": counts,
        "retained": retained,
        "blockers": blockers,
        "can_delete": not blockers,
        "has_dependencies": dependency_total > 0,
        "requires_confirmation": dependency_total > 0,
        "alternative": ("Deactivate the asset instead: it stops monitoring and preserves every record, "
                        "and it can be reactivated later."),
    }

def delete_asset_tree(session: Session, asset: Asset) -> dict[str, int]:
    # Delete the asset, its descendants and everything depending on them. Caller commits or rolls back.
    tree = hierarchy(session, asset)
    asset_ids = [row["id"] for row in tree]
    # Lock the rows so concurrent writers wait instead of re-creating dependants mid-delete.
    session.execute(select(Asset.id).where(Asset.id.in_(asset_ids)).with_for_update())
    variable_ids = list(session.scalars(select(Variable.id).where(Variable.asset_id.in_(asset_ids))).all())
    rule_ids = list(session.scalars(select(MonitoringRule.id).where(MonitoringRule.target_asset_id.in_(asset_ids))).all())
    alert_ids = list(session.scalars(select(Alert.id).where(Alert.target_asset_id.in_(asset_ids))).all())
    schedule_ids = list(session.scalars(select(MaintenanceSchedule.id).where(MaintenanceSchedule.asset_id.in_(asset_ids))).all())
    parameter_ids = list(session.scalars(select(RuleParameter.id).where(RuleParameter.rule_id.in_(rule_ids))).all()) if rule_ids else []

    removed: dict[str, int] = {}

    def run(name: str, statement) -> None:
        removed[name] = session.execute(statement).rowcount or 0

    if alert_ids:
        run("alert_notifications", delete(EmailNotification).where(EmailNotification.alert_id.in_(alert_ids)))
    event_filter = MonitoringEvent.asset_id.in_(asset_ids)
    if rule_ids:
        event_filter = event_filter | MonitoringEvent.rule_id.in_(rule_ids)
    if alert_ids:
        event_filter = event_filter | MonitoringEvent.alert_id.in_(alert_ids)
    run("monitoring_events", delete(MonitoringEvent).where(event_filter))
    run("maintenance_records", delete(MaintenanceRecord).where(MaintenanceRecord.asset_id.in_(asset_ids)))
    run("alerts", delete(Alert).where(Alert.target_asset_id.in_(asset_ids)))
    if parameter_ids:
        run("rule_parameter_states", delete(RuleParameterState).where(RuleParameterState.parameter_id.in_(parameter_ids)))
        run("rule_parameters", delete(RuleParameter).where(RuleParameter.id.in_(parameter_ids)))
    run("rule_counter_states", delete(RuleCounterState).where(RuleCounterState.asset_id.in_(asset_ids)))
    run("rule_states", delete(RuleState).where(RuleState.target_asset_id.in_(asset_ids)))
    if rule_ids:
        run("rules", delete(MonitoringRule).where(MonitoringRule.id.in_(rule_ids)))
    run("readings", delete(Reading).where(Reading.asset_id.in_(asset_ids)))
    if schedule_ids:
        run("maintenance_schedules", delete(MaintenanceSchedule).where(MaintenanceSchedule.id.in_(schedule_ids)))
    run("runtime_records", delete(MachineMonitoringState).where(MachineMonitoringState.asset_id.in_(asset_ids)))
    run("supervisor_assignments", delete(AssetSupervisor).where(AssetSupervisor.asset_id.in_(asset_ids)))
    run("instruction_documents_unlinked", update(InstructionDocument).where(InstructionDocument.asset_id.in_(asset_ids)).values(asset_id=None))
    if variable_ids:
        run("variables", delete(Variable).where(Variable.id.in_(variable_ids)))
    removed["assets"] = 0
    for row in sorted(tree, key=lambda r: r["depth"], reverse=True):  # children before parents
        removed["assets"] += session.execute(delete(Asset).where(Asset.id == row["id"])).rowcount or 0
    session.expire_all()
    return removed


def variable_deletion_summary(session: Session, variable: Variable, collector: Any = None) -> dict[str, Any]:
    rules = session.execute(
        select(MonitoringRule.id, MonitoringRule.name, MonitoringRule.rule_type, MonitoringRule.is_enabled)
        .where(MonitoringRule.variable_id == variable.id).order_by(MonitoringRule.id)).all()
    parameters = session.execute(
        select(RuleParameter.id, RuleParameter.name, RuleParameter.rule_id, MonitoringRule.name)
        .join(MonitoringRule, MonitoringRule.id == RuleParameter.rule_id)
        .where(RuleParameter.variable_id == variable.id).order_by(RuleParameter.id)).all()
    schedules = session.execute(
        select(MaintenanceSchedule.id, MaintenanceSchedule.asset_id).where(MaintenanceSchedule.signal_variable_id == variable.id)).all()
    alerts = session.scalar(select(func.count()).select_from(Alert).where(Alert.target_variable_id == variable.id)) or 0
    active_alerts = session.scalar(select(func.count()).select_from(Alert).where(
        Alert.target_variable_id == variable.id, Alert.status == "active")) or 0
    states = session.scalar(select(func.count()).select_from(RuleState).where(RuleState.target_variable_id == variable.id)) or 0
    readings = session.scalar(select(func.count()).select_from(Reading).where(Reading.variable_id == variable.id)) or 0

    blockers: list[str] = []
    if rules:
        blockers.append(f"{len(rules)} monitoring rule(s) use this variable. Remove or remap them first.")
    if parameters:
        blockers.append(f"{len(parameters)} rule parameter(s) are mapped to this variable. Remap or remove them first.")
    if schedules:
        blockers.append(f"{len(schedules)} maintenance schedule(s) use this variable as their signal.")
    if alerts or states:
        blockers.append(f"{alerts} alert(s) and {states} rule state(s) reference this variable; that history is kept. Deactivate the variable instead.")
    blockers.extend(_collector_blockers(session, collector, set(), {variable.id}))
    return {
        "variable": {"id": variable.id, "name": variable.name, "asset_id": variable.asset_id, "is_active": variable.is_active},
        "counts": {"readings": readings, "rules": len(rules), "rule_parameters": len(parameters),
                   "maintenance_schedules": len(schedules), "alerts": alerts, "active_alerts": active_alerts,
                   "rule_states": states},
        "rules": [{"id": r[0], "name": r[1], "rule_type": r[2], "is_enabled": r[3]} for r in rules],
        "parameters": [{"id": p[0], "name": p[1], "rule_id": p[2], "rule_name": p[3]} for p in parameters],
        "blockers": blockers,
        "can_delete": not blockers,
        "requires_confirmation": readings > 0,
        "what_happens": ("Deleting removes only the variable and its raw readings. Rules, parameters, alerts and "
                         "maintenance configuration are never deleted with it; while any exist, deletion is refused."),
        "alternative": "Deactivate the variable to pause monitoring while keeping its rules, readings, alerts and history.",
    }
