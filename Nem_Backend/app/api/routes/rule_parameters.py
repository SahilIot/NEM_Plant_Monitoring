# Create and edit rules that hold several parameters ('multi_parameter').
# Existing single-parameter rule endpoints are untouched; this router only adds new URLs.
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, object_session

from app.api.routes.auth import get_current_user
from app.api.routes.rules import (
    configured_cycle_signal_mapping,
    configured_runtime_signal_mapping,
    is_mapping_bypass_enabled,
    rule_or_404,
)
from app.db.session import get_db
from app.models import Asset, InstructionDocument, MonitoringRule, RuleParameter, User, Variable
from app.schemas.rule_parameters import (
    MultiParameterRuleCreate,
    ParameterLifecycleAction,
    RuleParameterIn,
    RuleParametersReplace,
)
from app.services.access_scope import access_scope, hidden_document_ids
from app.services.labels import assign_labels
from app.services.monitoring_engine import emit_event
from app.services.access_scope import require_rule_access
from app.services.legacy_parameters import (
    build_legacy_status_detail,
    legacy_parameter_id,
    rule_update_for_parameter,
    serialize_legacy_parameters,
)
from app.services.rule_parameters import (
    ParameterConfigError, build_status_detail, change_parameter_lifecycle, reset_parameter_baseline, serialize_parameters)
from app.services.rule_visibility import SUPERVISOR_EDITABLE_LIMITS, enforce_template_edit_permission
from app.core.constants import (
    AGGREGATION,
    BOOLEAN,
    COUNTER,
    CYCLE,
    INTERVAL,
    INTERVAL_PARAMETER,
    NUMBER,
    RULE_MULTI_PARAMETER,
    RUNNING,
    STATUS_ACTIVE,
    STATUS_ALERT,
    STATUS_DEACTIVATED,
    STATUS_IN_PROGRESS,
    STATUS_RESOLVED,
    TIMER,
)

router = APIRouter(tags=["multi-parameter rules"])

NUMERIC_TYPES = {NUMBER, "integer"}
# Config keys that only change how the value is judged. Editing them re-evaluates on the next cycle but
# never discards accumulated progress; every other key (interval type, start time) changes what is measured.
LIMIT_CONFIG_KEYS = {"lower_alert", "lower_warning", "upper_warning", "upper_alert", "unit", "due", "overdue", "expected", "severity"}


def _measured_source(variable_id: int | None, aggregation: str, config: dict[str, Any]) -> tuple:
    return (variable_id, aggregation, {key: value for key, value in (config or {}).items() if key not in LIMIT_CONFIG_KEYS})


def _measurement_changed(parameter: RuleParameter, item: RuleParameterIn) -> bool:
    """True when what the parameter MEASURES changed (type, variable, aggregation, interval type or start time).

    Names and limits (including Due/Overdue, expected state, severity and unit) never count, so renames and
    threshold-only edits keep accumulated progress. Used by the full replacement, the single edit and the shared
    rule propagation, so all three decide identically.
    """
    return (parameter.kind, *_measured_source(parameter.variable_id, parameter.aggregation, parameter.config)) != (
        item.kind, *_measured_source(item.variable_id, item.aggregation, item.config))


def _stored_definition(parameter: RuleParameter) -> RuleParameterIn:
    """A stored parameter in the same normalised form as an incoming one, so the two compare fairly."""
    try:
        return RuleParameterIn(key=parameter.key, name=parameter.name, kind=parameter.kind,
                               variable_id=parameter.variable_id, aggregation=parameter.aggregation,
                               config=parameter.config or {})
    except ValueError:  # an older row that no longer passes today's validation: compare it as stored
        return RuleParameterIn.model_construct(key=parameter.key, name=parameter.name, kind=parameter.kind,
                                               variable_id=parameter.variable_id, aggregation=parameter.aggregation,
                                               config=dict(parameter.config or {}))


def _enforce_supervisor_edit(user: User, parameter: RuleParameter, item: RuleParameterIn) -> None:
    """Supervisors may change only the Due and Overdue values of an interval parameter.

    Name, type, variable, aggregation, start time, other limits, expected state, severity and unit stay Administrator-only."""
    if user.role != "Supervisor":
        return
    old = _stored_definition(parameter)
    strip = lambda config: {k: v for k, v in (config or {}).items() if k not in SUPERVISOR_EDITABLE_LIMITS}  # noqa: E731
    if (old.name, old.kind, old.variable_id, old.aggregation, strip(old.config)) != (
            item.name, item.kind, item.variable_id, item.aggregation, strip(item.config)):
        raise HTTPException(status_code=403, detail="Supervisors may only change the Due and Overdue values of a parameter")


def _check_parameters(session: Session,request: Request,asset: Asset,items: list[RuleParameterIn],category: str,
                      current: dict[str, int | None] | None = None) -> None:
    # Checks that need the database; each error names the parameter it belongs to.
    # `current` maps stable keys to the variable each existing parameter is already connected to: keeping that
    # connection stays valid while the variable is temporarily inactive (a new choice must be active).
    bypass = is_mapping_bypass_enabled(request)
    seen: dict[tuple[int, str], str] = {}
    for item in items:
        label = f"Parameter '{item.name}'"
        if item.variable_id is None:
            continue
        variable = session.get(Variable, item.variable_id)
        if variable is None or not access_scope(session).allows(variable.asset_id):
            raise HTTPException(status_code=404, detail=f"{label}: variable {item.variable_id} was not found")
        if variable.asset_id != asset.id:
            raise HTTPException(status_code=422, detail=f"{label}: the variable does not belong to this asset")
        if not variable.is_active and not (item.key and (current or {}).get(item.key) == variable.id):
            raise HTTPException(status_code=422, detail=f"{label}: the variable is inactive")

        boolean = variable.data_type == BOOLEAN
        if item.kind == NUMBER:
            if item.aggregation in {"none", "last"} and variable.data_type not in NUMERIC_TYPES:
                raise HTTPException(status_code=422, detail=f"{label}: Number parameters with {item.aggregation.capitalize()} aggregation need a numeric variable")
            if item.aggregation in {COUNTER, TIMER} and not boolean:
                raise HTTPException(status_code=422, detail=f"{label}: {item.aggregation.capitalize()} aggregation needs a Boolean variable")
        elif item.kind == BOOLEAN:
            if not boolean:
                raise HTTPException(status_code=422, detail=f"{label}: Boolean parameters need a Boolean variable")
            if item.aggregation not in {"none", "last"}:
                raise HTTPException(status_code=422, detail=f"{label}: Boolean parameters support None or Last aggregation only")
        else:
            if not boolean:
                raise HTTPException(status_code=422, detail=f"{label}: interval parameters need a Boolean variable")
            counter = item.config.get(INTERVAL_PARAMETER) == COUNTER
            mapping = (configured_cycle_signal_mapping if counter else configured_runtime_signal_mapping)(request, variable.id)
            bypass_ok = bypass and variable.opcua_node_id is not None and variable.signal_role in {None, CYCLE if counter else RUNNING}
            if mapping != (asset.id, variable.id) and not bypass_ok:
                raise HTTPException(status_code=422, detail=(f"{label}: the variable must be this asset's configured "
                    f"{CYCLE if counter else RUNNING} signal"))

        pair = (variable.id, item.aggregation)
        if pair in seen:
            raise HTTPException(status_code=422, detail=f"{label}: the same variable and aggregation are already used by '{seen[pair]}'")
        seen[pair] = item.name


def _require_time_start(items: list[RuleParameterIn], existing: dict[str, RuleParameter] | None = None) -> None:
    # A Time interval counted from a PLC variable needs its start time. A stored parameter that never had one (older
    # configuration) stays editable as it is: its baseline is not rewritten or invented here.
    for item in items:
        if item.kind != INTERVAL or item.variable_id is None or item.config.get(INTERVAL_PARAMETER) != "time":
            continue
        if item.config.get("activation_at"):
            continue
        old = (existing or {}).get(item.key) if item.key else None
        if old is not None and not (old.config or {}).get("activation_at"):
            continue
        raise HTTPException(status_code=422, detail=f"Parameter '{item.name}': a start time is required for Time intervals")


def _apply(rule: MonitoringRule, items: list[RuleParameterIn]) -> None:
    # Replace the rule's parameters, matching existing rows by stable key (never by position)
    existing = {parameter.key: parameter for parameter in rule.parameter_items}
    incoming_keys = {item.key for item in items if item.key}
    unknown = incoming_keys - set(existing)
    if unknown:
        raise HTTPException(status_code=422, detail="One or more parameter keys do not belong to this rule")
    for key in set(existing) - incoming_keys:  # removed by the user
        from app.models import Alert

        session = object_session(rule)
        now = datetime.now(timezone.utc)
        # The parameter's own active alerts end with it; other parameters' alerts are untouched.
        for alert in session.scalars(select(Alert).where(
                Alert.parameter_id == existing[key].id, Alert.status == STATUS_ACTIVE)).all():
            alert.status, alert.resolved_at, alert.last_updated_at = STATUS_RESOLVED, now, now
        from app.services.rule_parameters import archive_removed_parameter

        archive_removed_parameter(session, rule, existing[key], "removed by the user")
        rule.parameter_items.remove(existing[key])
    for position, item in enumerate(items):
        parameter = existing.get(item.key) if item.key else None
        if parameter is None:
            rule.parameter_items.append(RuleParameter(
                name=item.name, position=position, kind=item.kind, variable_id=item.variable_id,
                aggregation=item.aggregation, config=item.config))
            continue
        # Editing one parameter must not reset another's state; only a changed MEASUREMENT resets its own.
        changed = _measurement_changed(parameter, item)
        parameter.name, parameter.position = item.name, position
        parameter.kind, parameter.variable_id = item.kind, item.variable_id
        parameter.aggregation, parameter.config = item.aggregation, item.config
        if changed:
            reset_parameter_baseline(object_session(rule), parameter)


def _reset_report(session: Session, rule_id: int | None = None) -> list[tuple[int, int]]:
    """(rule_id, parameter_id) of every parameter whose stored state this request really reset (de-duplicated)."""
    seen = list(dict.fromkeys(session.info.get("parameter_state_resets", [])))
    return [item for item in seen if rule_id is None or item[0] == rule_id]


def _commit(session: Session) -> None:
    """One commit for the whole change. A database conflict (for example a concurrent edit) rolls EVERYTHING back."""
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409, detail="The change conflicted with another update and was not saved. Nothing was changed; try again.") from error


def _require_editor(user: User) -> None:
    if user.role not in {"Administrator", "Supervisor"}:
        raise HTTPException(status_code=403, detail="You are not allowed to configure monitoring rules")


@router.post("/assets/{asset_id}/multi-parameter-rules", status_code=201)
def create_multi_parameter_rule(
    asset_id: int,
    payload: MultiParameterRuleCreate,
    request: Request,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_editor(user)
    asset = session.get(Asset, asset_id)
    if asset is None or not access_scope(session).allows(asset_id):
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    if not asset.is_active:
        raise HTTPException(status_code=422, detail="Rules cannot be created for an inactive asset")
    _check_parameters(session, request, asset, payload.parameters, payload.category)
    _require_time_start(payload.parameters)
    document_ids = sorted(set(payload.document_ids))
    hidden = hidden_document_ids(session)
    for document_id in document_ids:
        document = session.get(InstructionDocument, document_id)
        if document is None or document_id in hidden or document.asset_id not in (None, asset_id):
            raise HTTPException(status_code=422, detail=f"Document {document_id} is not available for this asset")

    rule = MonitoringRule(
        name=payload.name,
        description=payload.description,
        rule_type=RULE_MULTI_PARAMETER,
        target_asset_id=asset_id,
        variable_id=None,
        severity=STATUS_ALERT,
        is_enabled=payload.is_enabled,
        lifecycle_status=STATUS_IN_PROGRESS if payload.is_enabled else STATUS_DEACTIVATED,
        stale_after_seconds=payload.stale_after_seconds,
        parameters={
            "category": payload.category,
            "calculation_period_seconds": payload.calculation_period_seconds,
            "combine": "worst",
            **({"reference_link": payload.reference_link} if payload.reference_link else {}),
            **({"maintenance_instructions": payload.instructions.strip()} if payload.instructions and payload.instructions.strip() else {}),
            **({"document_ids": document_ids} if document_ids else {}),
        },
    )
    session.add(rule)
    session.flush()
    _apply(rule, payload.parameters)
    assign_labels(session, rule, payload.labels)
    emit_event(session, event_type="rule_created", message=f"Rule '{rule.name}' created.",
               occurred_at=datetime.now(timezone.utc), asset_id=asset_id, rule_id=rule.id)
    _commit(session)  # rule and all parameters are saved together or not at all
    session.refresh(rule)
    from app.api.routes.frontend_compat import _rule_row  # deferred: frontend_compat imports the rule routes

    return _rule_row(session, rule)


@router.get("/rules/{rule_id}/parameters")
def list_rule_parameters(rule_id: int, session: Session = Depends(get_db)) -> dict[str, Any]:
    rule = rule_or_404(session, rule_id)
    if rule.rule_type != RULE_MULTI_PARAMETER:
        # Rules created before the parameter system are presented as one parameter (no data is converted).
        return {"rule_id": rule.id, "category": None, "calculation_period_seconds": None,
                "parameters": serialize_legacy_parameters(session, rule)}
    return {
        "rule_id": rule.id,
        "category": (rule.parameters or {}).get("category"),
        "calculation_period_seconds": (rule.parameters or {}).get("calculation_period_seconds"),
        "parameters": serialize_parameters(rule),
    }


@router.get("/rules/{rule_id}/status-detail")
def rule_status_detail(rule_id: int, session: Session = Depends(get_db)) -> dict[str, Any]:
   # Current Status detail for one parent multi-parameter rule (all values computed by the backend).
    rule = rule_or_404(session, rule_id)
    require_rule_access(session, rule)
    if rule.rule_type != RULE_MULTI_PARAMETER:
        return build_legacy_status_detail(session, rule)
    return build_status_detail(session, rule)


@router.put("/rules/{rule_id}/parameters")
def replace_rule_parameters(
    rule_id: int,
    payload: RuleParametersReplace,
    request: Request,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_editor(user)
    rule = rule_or_404(session, rule_id)  # existence and asset access first
    require_rule_access(session, rule)
    if rule.rule_type != RULE_MULTI_PARAMETER:
        raise HTTPException(status_code=422, detail="Only multi-parameter rules have editable parameters")
    asset = session.get(Asset, rule.target_asset_id) if rule.target_asset_id else None
    if asset is None or not access_scope(session).allows(asset.id):
        raise HTTPException(status_code=404, detail=f"Asset {rule.target_asset_id} was not found")
    if rule.source_template_id is not None:
        raise HTTPException(status_code=409, detail="This rule's parameters are managed by its shared rule; edit each parameter individually")
    category = (rule.parameters or {}).get("category")
    if any((item.kind == INTERVAL) != (category == "interval_based") for item in payload.parameters):
        raise HTTPException(status_code=422, detail="Parameter types do not match this rule's category")
    names = [item.name.casefold() for item in payload.parameters]
    if len(set(names)) != len(names):
        raise HTTPException(status_code=422, detail="Parameter names must be unique within a rule")
    keys = [item.key for item in payload.parameters if item.key]
    if len(set(keys)) != len(keys):
        raise HTTPException(status_code=422, detail="Parameter keys must be unique within a rule")
    existing = {parameter.key: parameter for parameter in rule.parameter_items}
    if set(keys) - set(existing):
        raise HTTPException(status_code=422, detail="One or more parameter keys do not belong to this rule")
    for item in payload.parameters:
        if item.key and item.kind != existing[item.key].kind:  # same rule as the single edit
            raise HTTPException(status_code=422, detail="A parameter's type cannot be changed; add a new parameter instead")
    if user.role == "Supervisor":
        # Same policy as every other edit: only Due and Overdue. No adding, removing, reordering or renaming.
        if [item.key for item in payload.parameters] != [parameter.key for parameter in rule.parameter_items]:
            raise HTTPException(status_code=403, detail="Supervisors may only change the Due and Overdue values of a parameter")
        if (payload.calculation_period_seconds is not None
                and payload.calculation_period_seconds != (rule.parameters or {}).get("calculation_period_seconds")):
            raise HTTPException(status_code=403, detail="Supervisors may only change the Due and Overdue values of a parameter")
        for item in payload.parameters:
            _enforce_supervisor_edit(user, existing[item.key], item)
    _check_parameters(session, request, asset, payload.parameters, category,
                      current={key: parameter.variable_id for key, parameter in existing.items()})
    if rule.source_template_id is None:
        _require_time_start(payload.parameters, existing)
    if payload.calculation_period_seconds is not None:
        rule.parameters = {**(rule.parameters or {}), "calculation_period_seconds": payload.calculation_period_seconds}
    _apply(rule, payload.parameters)
    resets = _reset_report(session, rule.id)
    _commit(session)  # removals (snapshot event, alert resolution, row deletion) and edits succeed or fail together
    session.refresh(rule)
    return {"rule_id": rule.id, "parameters": serialize_parameters(rule),
            "state_reset": bool(resets), "reset_parameter_ids": [parameter_id for _rule, parameter_id in resets]}


@router.patch("/rules/{rule_id}/parameters/{parameter_id}")
def update_rule_parameter(
    rule_id: int,
    parameter_id: int,
    payload: RuleParameterIn,
    request: Request,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    # Edit ONE parameter of a multi-parameter rule.

    # Only this parameter's row (and, if what it measures changed, its own evaluation state) is written. The
    # parent rule, the other parameters, their progress and every alert or history row are left as they are.

    _require_editor(user)
    rule = rule_or_404(session, rule_id)
    require_rule_access(session, rule)
    if rule.rule_type != RULE_MULTI_PARAMETER:
        return _update_legacy_parameter(rule, parameter_id, payload, request, session, user)
    asset = session.get(Asset, rule.target_asset_id) if rule.target_asset_id else None
    if asset is None or not access_scope(session).allows(asset.id):
        raise HTTPException(status_code=404, detail=f"Asset {rule.target_asset_id} was not found")
    parameter = next((item for item in rule.parameter_items if item.id == parameter_id), None)
    if parameter is None:
        raise HTTPException(status_code=404, detail=f"Parameter {parameter_id} was not found in rule {rule_id}")
    if payload.key is not None and payload.key != parameter.key:
        raise HTTPException(status_code=422, detail="The parameter key does not match this parameter")
    if payload.kind != parameter.kind:
        raise HTTPException(status_code=422, detail="A parameter's type cannot be changed; add a new parameter instead")
    others = [item for item in rule.parameter_items if item.id != parameter.id]
    if payload.name.casefold() in {item.name.casefold() for item in others}:
        raise HTTPException(status_code=422, detail="Parameter names must be unique within a rule")
    _enforce_supervisor_edit(user, parameter, payload)
    category = (rule.parameters or {}).get("category")
    _check_parameters(session, request, asset, [payload.model_copy(update={"key": parameter.key})], category,
                      current={parameter.key: parameter.variable_id})
    if rule.source_template_id is None:
        _require_time_start([payload.model_copy(update={"key": parameter.key})], {parameter.key: parameter})
    clash = next((item for item in others if payload.variable_id is not None
                  and (item.variable_id, item.aggregation) == (payload.variable_id, payload.aggregation)), None)
    if clash is not None:
        raise HTTPException(status_code=422, detail=(
            f"Parameter '{payload.name}': the same variable and aggregation are already used by '{clash.name}'"))

    # Only a change to what is measured restarts this parameter's own progress. A rename or new limits keep it.
    changed = _measurement_changed(parameter, payload)
    shared = rule.source_template_id is not None
    if shared:
        # An asset rule made from a shared rule: the definition is shared, the variable stays this asset's own.
        _apply_shared_parameter_edit(rule, parameter, payload, request, session)
    else:
        parameter.name = payload.name
        parameter.variable_id, parameter.aggregation, parameter.config = payload.variable_id, payload.aggregation, payload.config
    if changed:
        reset_parameter_baseline(session, parameter)
    resets = _reset_report(session)
    _commit(session)
    session.refresh(rule)
    own = (rule.id, parameter.id) in resets
    return {
        "rule_id": rule.id,
        "parameter": next(item for item in serialize_parameters(rule) if item["id"] == parameter_id),
        # What really happened to stored progress: this parameter, and (shared rules) the same parameter on other assets.
        "state_reset": own,
        "propagated_resets": [{"rule_id": r, "parameter_id": p} for r, p in resets if (r, p) != (rule.id, parameter.id)],
    }


def _apply_shared_parameter_edit(rule, parameter, payload, request, session) -> None:
    """Edit one parameter of a rule that belongs to a shared rule (template).
    The changed definition is written to the template, which propagates it to every asset using it, exactly as an
    edit of the shared rule does (permissions, audit rows, other parameters and their progress untouched). Only the
    variable choice is kept on this asset's own parameter.
    """
    from app.api.routes import rules as rules_module
    from app.api.routes.frontend_compat import apply_template_update
    from app.models import MonitoringRuleTemplate
    from app.schemas.rule import RuleTemplateCreate
    from pydantic import ValidationError

    template = session.get(MonitoringRuleTemplate, rule.source_template_id)
    if template is None or template.rule_type != RULE_MULTI_PARAMETER:
        raise HTTPException(status_code=409, detail="The shared rule behind this rule is unavailable")
    if not rules_module.can_view_template(session, rules_module.request_user(session), template):
        raise HTTPException(status_code=403, detail="This rule is shared and its configuration is managed by an Administrator")
    defs = [dict(item) for item in (template.parameters or {}).get("parameter_defs", [])]
    target = next((item for item in defs if item["key"] == parameter.key), None)
    if target is None:
        raise HTTPException(status_code=409, detail="This parameter is no longer part of its shared rule")
    target.update({"name": payload.name, AGGREGATION: payload.aggregation, "config": payload.config})
    values = {field: getattr(template, field) for field in rules_module.TEMPLATE_VALUE_FIELDS}
    values["parameters"] = {**(template.parameters or {}), "parameter_defs": defs}
    try:
        validated = RuleTemplateCreate.model_validate({**values, "labels": list(template.labels)})
    except ValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    new_values = validated.model_dump(exclude={"labels"})
    # Being allowed to SEE a shared rule is not permission to EDIT it: check the edit rights before anything is written.
    enforce_template_edit_permission(session, template, new_values, None)
    # Keep this asset's own variable choice first, so the shared update validates against it.
    parameter.variable_id = payload.variable_id
    session.flush()
    apply_template_update(session, request, template, new_values, None)


def _update_legacy_parameter(rule, parameter_id, payload, request, session, user) -> dict[str, Any]:
    """Edit the single parameter of a rule created before the parameter system.
    The change is applied through the existing rule update (same validation, roles, shared-rule propagation and
    immediate re-evaluation); thresholds, progress, alerts and history are never reset.
    """
    from app.api.routes.rules import update_rule
    from app.schemas.rule import RuleUpdate

    if parameter_id != legacy_parameter_id(rule):
        raise HTTPException(status_code=404, detail=f"Parameter {parameter_id} was not found in rule {rule.id}")
    if payload.key is not None and payload.key != f"legacy-{rule.id}":
        raise HTTPException(status_code=422, detail="The parameter key does not match this parameter")
    try:
        changes = rule_update_for_parameter(rule, payload)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if changes:
        update_rule(rule.id, RuleUpdate(**changes), request, session, user)
        session.refresh(rule)
    return {"rule_id": rule.id, "parameter": serialize_legacy_parameters(session, rule)[0], "state_reset": False}


@router.post("/rules/{rule_id}/parameters/{parameter_id}/lifecycle")
def update_parameter_lifecycle(
    rule_id: int,
    parameter_id: int,
    payload: ParameterLifecycleAction,
    request: Request,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:

    allowed = {"Administrator", "Supervisor"} if payload.action == "activate" else {"Administrator"}
    if user.role not in allowed:
        raise HTTPException(status_code=403, detail=(
            "Only Administrators and Supervisors can activate parameters." if payload.action == "activate"
            else "Only Administrators can change a parameter's state."))
    rule = session.get(MonitoringRule, rule_id)  # no lock yet: the legacy transition takes its own
    if rule is None:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    require_rule_access(session, rule)
    if rule.rule_type != RULE_MULTI_PARAMETER:
        # One parameter == the whole rule, so the rule-level lifecycle transition is the parameter's.
        from app.api.routes.frontend_compat import _transition_rule_lifecycle

        if parameter_id != legacy_parameter_id(rule):
            raise HTTPException(status_code=404, detail=f"Parameter {parameter_id} was not found in rule {rule_id}")
        # Nothing is pending on this session, so the transition commits only its own change.
        _transition_rule_lifecycle(rule_id, payload.action, request, session)
        rule = rule_or_404(session, rule_id)
        return {"rule_id": rule.id, "parameter": serialize_legacy_parameters(session, rule)[0]}
    rule = session.scalar(select(MonitoringRule).where(MonitoringRule.id == rule_id).with_for_update()
                          .execution_options(populate_existing=True))
    parameter = next((item for item in rule.parameter_items if item.id == parameter_id), None)
    if parameter is None:
        raise HTTPException(status_code=404, detail=f"Parameter {parameter_id} was not found in rule {rule_id}")
    try:
        change_parameter_lifecycle(session, rule, parameter, payload.action, datetime.now(timezone.utc))
    except ParameterConfigError as error:
        session.rollback()
        raise HTTPException(status_code=422, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    session.commit()
    session.refresh(rule)
    return {
        "rule_id": rule.id,
        "parameter": next(item for item in serialize_parameters(rule) if item["id"] == parameter_id),
    }
