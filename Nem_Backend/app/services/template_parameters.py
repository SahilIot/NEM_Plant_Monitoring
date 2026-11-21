# Rule-template management service.
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, Request
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import Alert, Asset, MonitoringRule, MonitoringRuleTemplate, RuleCollection, RuleParameter, Variable
from app.schemas.rule import RuleCreate
from app.schemas.rule_parameters import RuleParameterIn
from app.services.access_scope import internal_propagation_scope
from app.services.labels import assign_labels
from app.services.monitoring_engine import evaluate_rules
from app.services.notification_settings import NOTIFICATION_SETTINGS_KEY
from app.services.parameter_validation import check_parameters, measured_source, validate_targets
from app.services.rule_parameters import archive_removed_parameter, reset_parameter_baseline
from app.services.rule_visibility import enforce_template_edit_permission, record_template_changes, request_user
from app.services.signal_mappings import configured_cycle_signal_mapping, configured_runtime_signal_mapping, is_mapping_bypass_enabled
from app.core.constants import (
    AGGREGATION,
    BOOLEAN,
    COLLECTION_FULL_MESSAGE,
    COLLECTION_KEEP_RULE_MESSAGE,
    COLLECTION_MAX_RULES,
    COUNTER,
    CYCLE,
    INTERVAL,
    INTERVAL_PARAMETER,
    KIND,
    LIFECYCLE_STATUS,
    NUMBER,
    ROLE_ADMINISTRATOR,
    RULE_BOOLEAN_COUNT_THRESHOLD,
    RULE_MULTI_PARAMETER,
    RULE_RUNTIME_DURATION,
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

# Checks whether a rule template can be assigned to a particular rule collection.
def validate_template_collection(
    session: Session,
    collection_id: int | None,
    excluded_template_id: int | None = None,
) -> None:
        if collection_id is None:
            return
        if session.get(RuleCollection, collection_id) is None:
            raise HTTPException(status_code=404, detail="Rule collection was not found")
        query = select(func.count()).select_from(MonitoringRuleTemplate).where(MonitoringRuleTemplate.collection_id == collection_id)
        if excluded_template_id is not None:
            query = query.where(MonitoringRuleTemplate.id != excluded_template_id)
        if (session.scalar(query) or 0) >= COLLECTION_MAX_RULES:
            raise HTTPException(status_code=422,detail=COLLECTION_FULL_MESSAGE,)

# A rule may only leave a collection (be moved out or deleted) if at least one other rule stays in it.
# The collection row is locked so two concurrent removals cannot both pass the check.
def ensure_collection_keeps_rule(session: Session, collection_id: int | None, leaving_template_id: int) -> None:
    if collection_id is None:
        return
    if session.scalar(select(RuleCollection.id).where(RuleCollection.id == collection_id).with_for_update()) is None:
        return
    remaining = session.scalar(
        select(func.count()).select_from(MonitoringRuleTemplate).where(
            MonitoringRuleTemplate.collection_id == collection_id,
            MonitoringRuleTemplate.id != leaving_template_id,
        )
    ) or 0
    if remaining == 0:
        raise HTTPException(status_code=422, detail=COLLECTION_KEEP_RULE_MESSAGE)

#Helper function for assigning templates -> finds variables on a target asset that are compatible with a template
def template_variables(
    session: Session,
    template: MonitoringRuleTemplate,
    asset_id: int,
    *,
    mapping_bypass_enabled: bool = False,
    request: Request | None = None,
) -> list[Variable]:
        if not template.required_variable_types:
            return []
        query = select(Variable)
        query = query.where(
                Variable.asset_id == asset_id,
                Variable.is_active.is_(True),
                Variable.data_type.in_(template.required_variable_types),
            )
        candidates = session.scalars(
            query.order_by(Variable.name, Variable.id)
        ).all()
        if not mapping_bypass_enabled:
            return candidates
        required_role = (
            RUNNING
            if template.rule_type == RULE_RUNTIME_DURATION
            or (
                template.rule_type == "duration"
                and isinstance(
                    (template.parameters or {}).get("expected_value"), bool
                )
            )
            else CYCLE
            if template.rule_type == RULE_BOOLEAN_COUNT_THRESHOLD
            else None
        )
        if required_role is None:
            return candidates
        configured_variable_ids = set()
        if request is not None:
            mapping_function = (
                configured_runtime_signal_mapping
                if required_role == RUNNING
                else configured_cycle_signal_mapping
            )
            configured_variable_ids = {
                variable.id
                for variable in candidates
                if mapping_function(request.app.state, variable.id)
                == (asset_id, variable.id)
            }
        return [
            variable
            for variable in candidates
            if variable.signal_role == required_role
            or variable.id in configured_variable_ids
        ]

#Function decides which compatible variable to use
def _mapped_template_variable(
        template: MonitoringRuleTemplate,
        candidates: list[Variable],
        requested_variable_id: int | None,
) -> Variable | None:
        if not template.required_variable_types:
            if requested_variable_id is not None:
                raise HTTPException(status_code=422,detail=f"Rule '{template.name}' does not require a variable",)
            return None
        if requested_variable_id is not None:
            mapped = next((item for item in candidates if item.id == requested_variable_id), None)
            if mapped is None:
                raise HTTPException(status_code=422,detail=(f"Variable {requested_variable_id} is not an active compatible "
                        f"variable on the target asset for '{template.name}'"),)
            return mapped

        if template.variable_key:
            key_matches = [item
                for item in candidates
                if item.key.casefold() == template.variable_key.casefold()
            ]
            if len(key_matches) == 1:
                return key_matches[0]
        if len(candidates) == 1:
            return candidates[0]
        if not candidates:
            raise HTTPException(status_code=422,detail=(f"No active compatible variable is available for "
                    f"'{template.name}' on the target asset"),)
        raise HTTPException(status_code=422,detail=f"Choose a variable for '{template.name}' on the target asset",)

#function converts a reusable template into the definition of a rule for a specific asset
def template_rule_definition(
        session: Session,
        template: MonitoringRuleTemplate,
        asset_id: int,
        request: Request,
        requested_variable_id: int | None,
        *,
        allow_disabled: bool = False,
        activate: bool = False,
        parameter_mappings: dict[str, int] | None = None,
) -> dict[str, Any]:
        if not template.is_enabled and not allow_disabled:
            raise HTTPException(status_code=422, detail=f"Rule template '{template.name}' is disabled")
        if is_multi(template):
            return instance_definition(
                session, request, template, asset_id, parameter_mappings, activate=activate)
        candidates = template_variables(
            session,
            template,
            asset_id,
            mapping_bypass_enabled=is_mapping_bypass_enabled(request.app.state),
            request=request,
        )
        variable = _mapped_template_variable(template, candidates, requested_variable_id)
        definition = {
            "name": template.name,
            "description": template.description,
            RULE_TYPE: template.rule_type,
            "target_asset_id": asset_id,
            "variable_id": variable.id if variable else None,
            "operator": template.operator,
            "threshold": template.threshold,
            "parameters": template.parameters,
            "severity": template.severity,
            "is_enabled": activate,
            LIFECYCLE_STATUS: STATUS_IN_PROGRESS if activate else STATUS_DEACTIVATED,
            "evaluation_interval_seconds": template.evaluation_interval_seconds,
            "stale_after_seconds": template.stale_after_seconds,
            "source_template_id": template.id,
        }
        try:
            validated = RuleCreate.model_validate(definition)
        except ValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        validate_targets(
            session,
            validated.target_asset_id,
            validated.variable_id,
            validated.rule_type,
            validated.operator,
            validated.threshold,
            validated.parameters,
            configured_cycle_signal_mapping(request.app.state, validated.variable_id),
            configured_runtime_signal_mapping(request.app.state, validated.variable_id),
            is_mapping_bypass_enabled(request.app.state),
        )
        return definition

#Update the shared rule -> main business-logic function.
def apply_template_update(
    session: Session,
    request: Request,
    template: MonitoringRuleTemplate,
    values: dict[str, Any],
    labels: list[str] | None,
) -> None:

    # Lock order for every writer of rules.parameters on shared rules: the shared rule first, then its asset rules by id.
    session.scalar(select(MonitoringRuleTemplate.id).where(MonitoringRuleTemplate.id == template.id)
                   .with_for_update().execution_options(populate_existing=True))
    enforce_template_edit_permission(session, template, values,labels,)
    if values["collection_id"] != template.collection_id:
        ensure_collection_keeps_rule(session, template.collection_id, template.id)
        validate_template_collection(session, values["collection_id"], excluded_template_id=template.id)
    semantic_fields = (
        RULE_TYPE,
        "required_variable_types",
        "variable_key",
        "operator",
        "threshold",
        "parameters",
        "severity",
        "evaluation_interval_seconds",
        "stale_after_seconds",
    )
    definition_changed = any(
        getattr(template, field) != values[field]
        for field in semantic_fields
    )
    if (values[RULE_TYPE] == RULE_MULTI_PARAMETER) != is_multi(template) and session.scalar(
        select(MonitoringRule.id).where(MonitoringRule.source_template_id == template.id).limit(1)):
        raise HTTPException(status_code=409, detail="A shared rule that is already assigned cannot switch between single-parameter and multi-parameter")
    record_template_changes(session, template, values,labels,)
    for field, value in values.items():
        setattr(template, field, value)
    if labels is not None:
        assign_labels(session, template, labels)
    if definition_changed:
        assigned_rules = session.scalars(
            select(MonitoringRule).where(
                MonitoringRule.source_template_id == template.id,
            ).order_by(MonitoringRule.id).with_for_update().execution_options(populate_existing=True)
        ).all()
        editor = request_user(session)
        is_admin = editor is not None and editor.role == ROLE_ADMINISTRATOR

        with internal_propagation_scope(session):
            for rule in assigned_rules:
                try:
                    if is_multi(template):
                        sync_instance(session, request, rule, template)
                        continue
                    definition = template_rule_definition(
                        session,
                        template,
                        rule.target_asset_id,
                        request,
                        rule.variable_id,
                        allow_disabled=True,
                    )
                except HTTPException:
                    if is_admin:
                        raise
                    raise HTTPException(status_code=409,detail="The change could not be applied to every asset using this shared rule. Contact an Administrator.",) from None
                for field in (
                    "name",
                    "description",
                    RULE_TYPE,
                    "operator",
                    "threshold",
                    "parameters",
                    "severity",
                    "evaluation_interval_seconds",
                    "stale_after_seconds",
                ):
                    value = definition[field]
                    # The template does not know the asset rule's own notification settings; keep them.
                    kept = (rule.parameters or {}).get(NOTIFICATION_SETTINGS_KEY) if field == "parameters" else None
                    if kept is not None:
                        value = {**(value or {}), NOTIFICATION_SETTINGS_KEY: kept}
                    setattr(rule, field, value)
        session.flush()
        settings = request.app.state.settings
        for rule in assigned_rules:
            if rule.is_enabled:
                evaluate_rules(
                    session,
                    rule_id=rule.id,
                    stale_after_seconds=settings.monitoring_default_stale_after_seconds,
                    runtime_gap_seconds=settings.runtime_freshness_seconds,
                )

# Rule-copy and template-assignment helpers moved from the dashboard compatibility routes.
def mapped_variable(
    session: Session,
    source_variable_id: int | None,
    target_asset_id: int,
) -> Variable | None:
    if source_variable_id is None:
        return None
    source = session.get(Variable, source_variable_id)
    if source is None:
        raise HTTPException(status_code=422, detail="The source rule variable no longer exists")
    matches = session.scalars(
        select(Variable).where(
            Variable.asset_id == target_asset_id,
            Variable.is_active.is_(True),
            func.lower(Variable.key) == source.key.lower(),
            Variable.data_type == source.data_type,
        )
    ).all()
    if len(matches) != 1:
        raise HTTPException(status_code=422,detail=(f"Rule variable '{source.key}' must have exactly one active variable with the same key and data type on the target asset"),)
    return matches[0]

def rule_definition(
    source: MonitoringRule,
    target_asset_id: int,
    variable: Variable | None,
) -> dict[str, Any]:
    return {
        "name": source.name,
        "description": source.description,
        RULE_TYPE: source.rule_type,
        "target_asset_id": target_asset_id,
        "source_template_id": source.source_template_id,
        "component_identifier": source.component_identifier,
        "variable_id": variable.id if variable else None,
        "operator": source.operator,
        "threshold": source.threshold,
        "parameters": source.parameters,
        "severity": source.severity,
        "is_enabled": False,
        LIFECYCLE_STATUS: STATUS_DEACTIVATED,
        "evaluation_interval_seconds": source.evaluation_interval_seconds,
        "stale_after_seconds": source.stale_after_seconds,
    }

# Per-rule notification settings are not part of what a rule monitors, so they never make two rules "different".
def _definition_value(field: str, value: Any) -> Any:
    if field == "parameters" and isinstance(value, dict):
        return {key: item for key, item in value.items() if key != NOTIFICATION_SETTINGS_KEY}
    return value

def same_rule_definition(rule: MonitoringRule, definition: dict[str, Any]) -> bool:
    return all(
        _definition_value(field, getattr(rule, field)) == _definition_value(field, definition[field])
        for field in (
            "name",
            "description",
            RULE_TYPE,
            "target_asset_id",
            "variable_id",
            "operator",
            "threshold",
            "parameters",
            "severity",
        )
    )

#used to suggest a variable rather than requie a final selection
def suggested_template_variable(template: MonitoringRuleTemplate, candidates: list[Variable]) -> Variable | None:
        if not template.required_variable_types:
            return None
        if template.variable_key:
            key_matches = [
                item
                for item in candidates
                if item.key.casefold() == template.variable_key.casefold()
            ]
            if len(key_matches) == 1:
                return key_matches[0]
        return candidates[0] if len(candidates) == 1 else None
