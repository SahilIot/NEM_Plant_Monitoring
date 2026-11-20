# Rule-template management service.
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models import Alert, Asset, MonitoringRule, MonitoringRuleTemplate, RuleParameter, Variable
from app.schemas.rule_parameters import RuleParameterIn
from app.services.parameter_validation import check_parameters, measured_source
from app.services.rule_parameters import archive_removed_parameter, reset_parameter_baseline
from app.services.signal_mappings import configured_cycle_signal_mapping, configured_runtime_signal_mapping, is_mapping_bypass_enabled
from app.core.constants import (
    AGGREGATION,
    BOOLEAN,
    COUNTER,
    CYCLE,
    INTERVAL,
    INTERVAL_PARAMETER,
    KIND,
    LIFECYCLE_STATUS,
    NUMBER,
    RULE_MULTI_PARAMETER,
    RULE_TYPE,
    RUNNING,
    STATUS_ACTIVE,
    STATUS_ALERT,
    STATUS_DEACTIVATED,
    STATUS_IN_PROGRESS,
    STATUS_RESOLVED,
    AGGREGATION_LAST,
    AGGREGATION_NONE,
)

TEMPLATE_META_KEYS = ("category", "calculation_period_seconds", "combine", "reference_link", "maintenance_instructions")
NUMERIC = {NUMBER, "integer"}

# Check whether the template is a multi-parameter rule.
def is_multi(template: MonitoringRuleTemplate) -> bool:
    return template.rule_type == RULE_MULTI_PARAMETER

# Retrives parameter definitions stored in the template`s JSON feild
def template_defs(template: MonitoringRuleTemplate) -> list[dict[str, Any]]:
    return list((template.parameters or {}).get("parameter_defs") or [])

# Copies additional template settings into the actual asset rule.
def rule_meta(template: MonitoringRuleTemplate) -> dict[str, Any]:
    source = template.parameters or {}
    return {key: source[key] for key in TEMPLATE_META_KEYS if source.get(key) is not None}

# Determines which PLC variable dtypes are compatible with a parameter.
def _compatible_types(definition: dict[str, Any]) -> set[str]:
    kind, aggregation = definition[KIND], definition[AGGREGATION]
    if kind == NUMBER and aggregation in {AGGREGATION_NONE, AGGREGATION_LAST}:
        return set(NUMERIC)
    return {BOOLEAN}

# Finds all PLC variables that can be selected for a particular rule parameter.
def candidates_for(session: Session, request: Request, asset: Asset, definition: dict[str, Any],
                   keep_variable_ids: set[int] | None = None) -> list[Variable]:
    if not definition.get("uses_variable", True):
        return []
    variables = session.scalars(select(Variable).where(
        Variable.asset_id == asset.id,
        or_(Variable.is_active.is_(True), Variable.id.in_(keep_variable_ids or {0})),
        Variable.data_type.in_(_compatible_types(definition))).order_by(Variable.name, Variable.id)).all()
    if definition[KIND] != INTERVAL:
        return list(variables)
    counter = (definition["config"] or {}).get(INTERVAL_PARAMETER) == COUNTER
    mapping = configured_cycle_signal_mapping if counter else configured_runtime_signal_mapping
    bypass = is_mapping_bypass_enabled(request.app.state)
    return [v for v in variables if mapping(request.app.state, v.id) == (asset.id, v.id)
            or (bypass and v.opcua_node_id is not None and v.signal_role in {None, CYCLE if counter else RUNNING})]

# Automatically suggests a variable when creating a rule.
def suggested_variable(definition: dict[str, Any], candidates: list[Variable]) -> Variable | None:
    hint = (definition.get("variable_key") or "").casefold()
    if hint:
        matches = [v for v in candidates if v.key.casefold() == hint]
        if len(matches) == 1:
            return matches[0]
    return candidates[0] if len(candidates) == 1 else None

# This function actually resolves the variable selected for a parameter.
def resolve_variable(session: Session, request: Request, asset: Asset, definition: dict[str, Any],
                     requested: int | None, taken: set[tuple[int, str]]) -> Variable | None:
    if not definition.get("uses_variable", True):
        return None
    label = f"Parameter '{definition['name']}'"
    candidates = candidates_for(session, request, asset, definition)
    if requested is not None:
        chosen = next((v for v in candidates if v.id == requested), None)
        if chosen is None:
            raise HTTPException(status_code=422, detail=f"{label}: variable {requested} is not an active compatible variable on this asset")
        return chosen
    if not candidates:
        raise HTTPException(status_code=422, detail=f"{label}: no active compatible variable is available on this asset")
    chosen = suggested_variable(definition, [v for v in candidates if (v.id, definition[AGGREGATION]) not in taken] or candidates)
    if chosen is None:
        raise HTTPException(status_code=422, detail=f"{label}: choose a variable for this parameter on the target asset")
    return chosen

# This function prepare the parameter rows when creating a rule from a template.
def build_items(session: Session, request: Request, asset: Asset, template: MonitoringRuleTemplate,
                mappings: dict[str, int] | None) -> list[dict[str, Any]]:
    # RuleParameter column values for an asset rule made from the template, validated like a hand-made rule.
    mappings = mappings or {}
    unknown = set(mappings) - {d["key"] for d in template_defs(template)}
    if unknown:
        raise HTTPException(status_code=422, detail="A variable mapping refers to a parameter that is not in this template")
    items: list[dict[str, Any]] = []
    taken: set[tuple[int, str]] = set()
    for position, definition in enumerate(template_defs(template)):
        variable = resolve_variable(session, request, asset, definition, mappings.get(definition["key"]), taken)
        if variable is not None:
            taken.add((variable.id, definition[AGGREGATION]))
        items.append({"key": definition["key"], "name": definition["name"], "position": position,
                      KIND: definition[KIND], "variable_id": variable.id if variable else None,
                      AGGREGATION: definition[AGGREGATION], "config": definition["config"]})
    check_parameters(session, request.app.state, asset,
                      [RuleParameterIn(key=i["key"], name=i["name"], kind=i[KIND], variable_id=i["variable_id"],
                                       aggregation=i[AGGREGATION], config=i["config"]) for i in items],
                      (template.parameters or {}).get("category"))
    return items

# This function builds the complete rule definition for a specific asset.
def instance_definition(session: Session, request: Request, template: MonitoringRuleTemplate, asset_id: int,
                        mappings: dict[str, int] | None, *, activate: bool) -> dict[str, Any]:
    # Definition dict for MonitoringRule (the private _parameter_items key is popped by instantiate).
    if not template.is_enabled:
        raise HTTPException(status_code=422, detail=f"Rule template '{template.name}' is disabled")
    asset = session.get(Asset, asset_id)
    items = build_items(session, request, asset, template, mappings)
    return {
        "name": template.name, "description": template.description, RULE_TYPE: RULE_MULTI_PARAMETER,
        "target_asset_id": asset_id, "variable_id": None, "operator": None, "threshold": None,
        "parameters": rule_meta(template), "severity": STATUS_ALERT, "is_enabled": activate,
        LIFECYCLE_STATUS: STATUS_IN_PROGRESS if activate else STATUS_DEACTIVATED,
        "evaluation_interval_seconds": template.evaluation_interval_seconds,
        "stale_after_seconds": template.stale_after_seconds, "source_template_id": template.id,
        "_parameter_items": items,
    }

# Removes internal/private keys before passing the dictionary into the SQLAlchemy model.
def plain(definition: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in definition.items() if not key.startswith("_")}

# This function creates the actual SQLAlchemy rule object.
def instantiate(definition: dict[str, Any]) -> MonitoringRule:
    # The rule plus its parameter rows (saved together with the session transaction).
    rule = MonitoringRule(**plain(definition))
    for item in definition.get("_parameter_items") or []:
        rule.parameter_items.append(RuleParameter(**item))
    return rule

# This func. sync. an existing asset rule with changes made to its shared template.
def sync_instance(session: Session, request: Request, rule: MonitoringRule, template: MonitoringRuleTemplate) -> None:

    asset = session.get(Asset, rule.target_asset_id)
    meta = rule_meta(template)
    kept = {k: v for k, v in (rule.parameters or {}).items() if k in {"document_ids", "notifications"}}
    rule.parameters = {**meta, **kept}
    defs = {d["key"]: d for d in template_defs(template)}
    existing = {p.key: p for p in rule.parameter_items}
    now = datetime.now(timezone.utc)
    for key in set(existing) - set(defs):
        for alert in session.scalars(select(Alert).where(Alert.parameter_id == existing[key].id, Alert.status == STATUS_ACTIVE)).all():
            alert.status, alert.resolved_at, alert.last_updated_at = STATUS_RESOLVED, now, now
        archive_removed_parameter(session, rule, existing[key], "removed from the shared rule")
        rule.parameter_items.remove(existing[key])
    taken = {(p.variable_id, p.aggregation) for key, p in existing.items() if key in defs and p.variable_id}
    for position, (key, definition) in enumerate(defs.items()):
        parameter = existing.get(key)
        if parameter is None:
            variable = resolve_variable(session, request, asset, definition, None, taken)
            if variable is not None:
                taken.add((variable.id, definition[AGGREGATION]))
            rule.parameter_items.append(RuleParameter(
                key=key, name=definition["name"], position=position, kind=definition[KIND],
                variable_id=variable.id if variable else None, aggregation=definition[AGGREGATION],
                config=definition["config"]))
            continue
        if parameter.kind != definition[KIND]:
            raise HTTPException(status_code=409, detail=f"Parameter '{definition['name']}' cannot change its type; add a new parameter instead")
        variable_id = parameter.variable_id if definition.get("uses_variable", True) else None
        if variable_id is not None:
            allowed = {v.id for v in candidates_for(session, request, asset, definition, {variable_id})}
            if variable_id not in allowed:
                raise HTTPException(status_code=409, detail=(f"Parameter '{definition['name']}': the connected variable on asset {asset.name} is not compatible "
                    "with the new configuration"))
        changed = measured_source(parameter.variable_id, parameter.aggregation, parameter.config) != measured_source(
            variable_id, definition[AGGREGATION], definition["config"])
        parameter.name, parameter.position = definition["name"], position
        parameter.variable_id, parameter.aggregation, parameter.config = variable_id, definition[AGGREGATION], definition["config"]
        if changed:
            reset_parameter_baseline(session, parameter)
    session.flush()
    check_parameters(session, request.app.state, asset,
                      [RuleParameterIn(key=p.key, name=p.name, kind=p.kind, variable_id=p.variable_id,
                                       aggregation=p.aggregation, config=p.config) for p in rule.parameter_items],
                      meta.get("category"), current={p.key: p.variable_id for p in rule.parameter_items})
