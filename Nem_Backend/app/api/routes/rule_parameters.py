# Api router responsible for creating, viewing, editing, replacing and managing the lifecycle of multi-parameter monitoring rules.
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, object_session

from app.api.routes.auth import get_current_user
from app.api.routes.rules import (
    lock_rule,
    configured_cycle_signal_mapping,
    configured_runtime_signal_mapping,
    is_mapping_bypass_enabled,
    rule_or_404,
)
from app.db.session import get_db
from app.models import Asset, InstructionDocument, MonitoringRule, RuleParameter, User, Variable
from app.schemas.rule_parameters import (
    ComponentIdentifierRequest,
    MultiParameterRuleCreate,
    NotificationSettingsRequest,
    ParameterLifecycleAction,
    ProgressResetRequest,
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
    AGGREGATION_LAST,
    AGGREGATION_NONE,
    CATEGORY_INTERVAL_BASED,
    ERR_SUPERVISOR_PARAMETER_EDIT,
    EVENT_RULE_CREATED,
    ROLE_ADMINISTRATOR,
    ROLE_SUPERVISOR,
    TIME,
)

router = APIRouter(tags=["multi-parameter rules"])

NUMERIC_TYPES = {NUMBER, "integer"}
# Config keys that only change how the value is judged. Editing them re-evaluates on the next cycle but
# never discards accumulated progress; every other key (interval type, start time) changes what is measured.
LIMIT_CONFIG_KEYS = {"lower_alert", "lower_warning", "upper_warning", "upper_alert", "unit", "due", "overdue", "expected", "severity"}

# It creates a representation of the measurement configuration
def _measured_source(variable_id: int | None, aggregation: str, config: dict[str, Any]) -> tuple:
    return (variable_id, aggregation, {key: value for key, value in (config or {}).items() if key not in LIMIT_CONFIG_KEYS})

# Compare the existing parameter with the incoming parameter
def _measurement_changed(parameter: RuleParameter, item: RuleParameterIn) -> bool:
    return (parameter.kind, *_measured_source(parameter.variable_id, parameter.aggregation, parameter.config)) != (
        item.kind, *_measured_source(item.variable_id, item.aggregation, item.config))

# Converts an existing db params into a RuleParamIN schema object
def _stored_definition(parameter: RuleParameter) -> RuleParameterIn:
    # A stored parameter in the same normalised form as an incoming one, so the two compare fairly
    try:
        return RuleParameterIn(key=parameter.key, name=parameter.name, kind=parameter.kind,
                               variable_id=parameter.variable_id, aggregation=parameter.aggregation,
                               config=parameter.config or {})
    except ValueError:  # an older row that no longer passes today's validation: compare it as stored
        return RuleParameterIn.model_construct(key=parameter.key, name=parameter.name, kind=parameter.kind,
                                               variable_id=parameter.variable_id, aggregation=parameter.aggregation,
                                               config=dict(parameter.config or {}))

# Controls what a supervisor can edit.
def _enforce_supervisor_edit(user: User, parameter: RuleParameter, item: RuleParameterIn) -> None:
    if user.role != ROLE_SUPERVISOR:
        return
    old = _stored_definition(parameter)
    strip = lambda config: {k: v for k, v in (config or {}).items() if k not in SUPERVISOR_EDITABLE_LIMITS}  # noqa: E731
    if (old.name, old.kind, old.variable_id, old.aggregation, strip(old.config)) != (
            item.name, item.kind, item.variable_id, item.aggregation, strip(item.config)):
        raise HTTPException(status_code=403, detail=ERR_SUPERVISOR_PARAMETER_EDIT)

# Imp -> Its responsibility is to ensure that every param references a valid var and that the var is suitable for the param config.
def _check_parameters(session: Session,request: Request,asset: Asset,items: list[RuleParameterIn],category: str,
                      current: dict[str, int | None] | None = None) -> None:
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
            if item.aggregation in {AGGREGATION_NONE, AGGREGATION_LAST} and variable.data_type not in NUMERIC_TYPES:
                raise HTTPException(status_code=422, detail=f"{label}: Number parameters with {item.aggregation.capitalize()} aggregation need a numeric variable")
            if item.aggregation in {COUNTER, TIMER} and not boolean:
                raise HTTPException(status_code=422, detail=f"{label}: {item.aggregation.capitalize()} aggregation needs a Boolean variable")
        elif item.kind == BOOLEAN:
            if not boolean:
                raise HTTPException(status_code=422, detail=f"{label}: Boolean parameters need a Boolean variable")
            if item.aggregation not in {AGGREGATION_NONE, AGGREGATION_LAST}:
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

# This func handles a special case for Time-Based interval params.
def _require_time_start(items: list[RuleParameterIn], existing: dict[str, RuleParameter] | None = None) -> None:
    for item in items:
        if item.kind != INTERVAL or item.variable_id is None or item.config.get(INTERVAL_PARAMETER) != TIME:
            continue
        if item.config.get("activation_at"):
            continue
        old = (existing or {}).get(item.key) if item.key else None
        if old is not None and not (old.config or {}).get("activation_at"):
            continue
        raise HTTPException(status_code=422, detail=f"Parameter '{item.name}': a start time is required for Time intervals")

# This func actually updates the rule`s param collection.
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

# Collects the parameter states that were actually reset during the current request.
def _reset_report(session: Session, rule_id: int | None = None) -> list[tuple[int, int]]:
    # (rule_id, parameter_id) of every parameter whose stored state this request really reset (de-duplicated).
    seen = list(dict.fromkeys(session.info.get("parameter_state_resets", [])))
    return [item for item in seen if rule_id is None or item[0] == rule_id]


def _commit(session: Session) -> None:
    # One commit for the whole change. A database conflict (for example a concurrent edit) rolls EVERYTHING back.
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409, detail="The change conflicted with another update and was not saved. Nothing was changed; try again.") from error

# Only admin and supervisor can configure theser rules.
def _require_editor(user: User) -> None:
    if user.role not in {ROLE_ADMINISTRATOR, ROLE_SUPERVISOR}:
        raise HTTPException(status_code=403, detail="You are not allowed to configure monitoring rules")

# Below now are the functions that the frontend calls
 
@router.post("/assets/{asset_id}/multi-parameter-rules", status_code=201)
# This creates anew rule under certains asset id
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
        document = session.get(InstructionDocument, document_id, with_for_update={"read": True})  # see delete_document
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
        component_identifier=payload.component_identifier,
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
    emit_event(session, event_type=EVENT_RULE_CREATED, message=f"Rule '{rule.name}' created.",
               occurred_at=datetime.now(timezone.utc), asset_id=asset_id, rule_id=rule.id)
    _commit(session)  # rule and all parameters are saved together or not at all
    session.refresh(rule)
    from app.api.routes.frontend_compat import _rule_row  # deferred: frontend_compat imports the rule routes

    return _rule_row(session, rule)

# Returns all parameters associated with a rule.
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

# This returns the current monitoring information
@router.get("/rules/{rule_id}/status-detail")
def rule_status_detail(rule_id: int, session: Session = Depends(get_db)) -> dict[str, Any]:
   # Current Status detail for one parent multi-parameter rule (all values computed by the backend).
    rule = rule_or_404(session, rule_id)
    require_rule_access(session, rule)
    if rule.rule_type != RULE_MULTI_PARAMETER:
        return build_legacy_status_detail(session, rule)
    return build_status_detail(session, rule)

def _require_reset_role(user: User) -> None:
    if user.role not in {ROLE_ADMINISTRATOR, ROLE_SUPERVISOR}:
        raise HTTPException(status_code=403, detail="Only Administrators and Supervisors can reset interval progress.")


# Locks and returns a multi-parameter rule the user may reset intervals of.
def _rule_for_reset(session: Session, rule_id: int) -> MonitoringRule:
    rule = session.get(MonitoringRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    require_rule_access(session, rule)
    if rule.rule_type != RULE_MULTI_PARAMETER:
        raise HTTPException(status_code=422, detail="Only interval-based multi-parameter rules have progress to reset.")
    return session.scalar(select(MonitoringRule).where(MonitoringRule.id == rule_id).with_for_update()
                          .execution_options(populate_existing=True))


def _interval_view(parameter: RuleParameter, reason: str | None = None) -> dict[str, Any]:
    return {"parameter_id": parameter.id, "name": parameter.name, "reason": reason}


# Manual reset of one interval parameter (Administrator or Supervisor). Reuses the maintenance reset core.
@router.post("/rules/{rule_id}/parameters/{parameter_id}/reset-progress")
def reset_parameter_progress(
    rule_id: int,
    parameter_id: int,
    payload: ProgressResetRequest,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    from app.services.rule_maintenance import manual_reset_parameter, manual_reset_problem

    _require_reset_role(user)
    rule = _rule_for_reset(session, rule_id)
    parameter = next((item for item in rule.parameter_items if item.id == parameter_id), None)
    if parameter is None:
        raise HTTPException(status_code=404, detail=f"Parameter {parameter_id} was not found in rule {rule_id}")
    if payload.dry_run:
        problem = manual_reset_problem(session, rule, parameter)
        session.rollback()
        return {"rule_id": rule_id, "scope": "parameter", "dry_run": True,
                "reset": [] if problem else [_interval_view(parameter)],
                "skipped": [_interval_view(parameter, problem)] if problem else []}
    try:
        manual_reset_parameter(session, rule, parameter, user_id=user.id, user_name=user.username, scope="parameter")
    except ValueError as error:
        session.rollback()
        raise HTTPException(status_code=409, detail=str(error)) from error
    session.commit()
    return {"rule_id": rule_id, "scope": "parameter", "dry_run": False, "reset": [_interval_view(parameter)], "skipped": []}


# Manual reset of every eligible interval of a rule, in one transaction. Other parameters are never touched.
@router.post("/rules/{rule_id}/reset-progress")
def reset_rule_progress(
    rule_id: int,
    payload: ProgressResetRequest,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    from app.services.rule_maintenance import manual_reset_parameter, manual_reset_problem

    _require_reset_role(user)
    rule = _rule_for_reset(session, rule_id)
    intervals = [item for item in rule.parameter_items if item.kind == INTERVAL]
    eligible, skipped = [], []
    for parameter in intervals:
        problem = manual_reset_problem(session, rule, parameter)
        (skipped if problem else eligible).append(_interval_view(parameter, problem) if problem else parameter)
    if payload.dry_run:
        session.rollback()
        return {"rule_id": rule_id, "scope": "rule", "dry_run": True,
                "reset": [_interval_view(item) for item in eligible], "skipped": skipped}
    if not eligible:
        session.rollback()
        raise HTTPException(status_code=409, detail=(
            "None of this rule's intervals can be reset right now."
            + (" " + "; ".join(f"{item['name']}: {item['reason']}" for item in skipped) if skipped else "")))
    try:
        for parameter in eligible:
            manual_reset_parameter(session, rule, parameter, user_id=user.id, user_name=user.username, scope="rule")
    except ValueError as error:  # checked above; a concurrent change aborts the whole reset
        session.rollback()
        raise HTTPException(status_code=409, detail=str(error)) from error
    session.commit()
    return {"rule_id": rule_id, "scope": "rule", "dry_run": False,
            "reset": [_interval_view(item) for item in eligible], "skipped": skipped}


# Per-rule email notification settings (Warning/Alert switches and custom message). Touches only the
# "notifications" key: the rule, its parameters, activation state and alerts are left exactly as they were.
@router.post("/rules/{rule_id}/notification-settings")
def update_notification_settings(
    rule_id: int,
    payload: NotificationSettingsRequest,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    from app.services.notification_settings import (
        NOTIFICATION_SETTINGS_KEY, NotificationSettingsError, normalize_notification_settings, settings_for_rule,
    )

    _require_editor(user)
    rule = rule_or_404(session, rule_id)
    require_rule_access(session, rule)
    try:
        normalized = normalize_notification_settings(payload.notifications)
    except NotificationSettingsError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    rule = lock_rule(session, rule)  # read-modify-write of rules.parameters starts from the committed value
    previous = settings_for_rule(rule)
    if normalized != previous:
        rule.parameters = {**(rule.parameters or {}), NOTIFICATION_SETTINGS_KEY: normalized}
        emit_event(session, event_type="notification_settings_changed",
                   occurred_at=datetime.now(timezone.utc),
                   message=f"Notification settings of rule '{rule.name}' were changed by {user.username}.",
                   asset_id=rule.target_asset_id, rule_id=rule.id,
                   metadata={"rule_id": rule.id, "changed_by_id": user.id, "changed_by": user.username,
                             "previous": previous, "current": normalized})
    session.commit()
    return {"rule_id": rule.id, "notifications": normalized}


# Sets or clears the component identifier of an assigned rule. Touches only that column.
@router.post("/rules/{rule_id}/component-identifier")
def update_component_identifier(
    rule_id: int,
    payload: ComponentIdentifierRequest,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    _require_editor(user)
    rule = rule_or_404(session, rule_id)
    require_rule_access(session, rule)
    previous = rule.component_identifier
    if payload.component_identifier != previous:
        rule.component_identifier = payload.component_identifier
        emit_event(session, event_type="component_identifier_changed",
                   occurred_at=datetime.now(timezone.utc),
                   message=(f"Component identifier of rule '{rule.name}' was changed by {user.username}: "
                            f"{previous or 'none'} -> {payload.component_identifier or 'none'}."),
                   asset_id=rule.target_asset_id, rule_id=rule.id,
                   metadata={"rule_id": rule.id, "changed_by_id": user.id, "changed_by": user.username,
                             "previous": previous, "current": payload.component_identifier})
    session.commit()
    return {"rule_id": rule.id, "component_identifier": rule.component_identifier}


# Replace all parameters , complicated endpoints , allows the frontend to submit an entire parameter collection.
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
    rule = lock_rule(session, rule)  # this request rewrites rules.parameters and parameter rows
    asset = session.get(Asset, rule.target_asset_id) if rule.target_asset_id else None
    if asset is None or not access_scope(session).allows(asset.id):
        raise HTTPException(status_code=404, detail=f"Asset {rule.target_asset_id} was not found")
    if rule.source_template_id is not None:
        raise HTTPException(status_code=409, detail="This rule's parameters are managed by its shared rule; edit each parameter individually")
    category = (rule.parameters or {}).get("category")
    if any((item.kind == INTERVAL) != (category == CATEGORY_INTERVAL_BASED) for item in payload.parameters):
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
    if user.role == ROLE_SUPERVISOR:
        # Same policy as every other edit: only Due and Overdue. No adding, removing, reordering or renaming.
        if [item.key for item in payload.parameters] != [parameter.key for parameter in rule.parameter_items]:
            raise HTTPException(status_code=403, detail=ERR_SUPERVISOR_PARAMETER_EDIT)
        if (payload.calculation_period_seconds is not None
                and payload.calculation_period_seconds != (rule.parameters or {}).get("calculation_period_seconds")):
            raise HTTPException(status_code=403, detail=ERR_SUPERVISOR_PARAMETER_EDIT)
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
    return {"rule_id": rule.id, "parameters": serialize_parameters(rule),"state_reset": bool(resets), "reset_parameter_ids": [parameter_id for _rule, parameter_id in resets]}

# Edit only one param
@router.patch("/rules/{rule_id}/parameters/{parameter_id}")
def update_rule_parameter(
    rule_id: int,
    parameter_id: int,
    payload: RuleParameterIn,
    request: Request,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:

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
        raise HTTPException(status_code=422, detail=(f"Parameter '{payload.name}': the same variable and aggregation are already used by '{clash.name}'"))

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

# This func retrieves shared temp , check if temp exist , check access to template , finding matching params definition , validates the resulting template ,
# Checks template edit permissions , applies the template updates.
def _apply_shared_parameter_edit(rule, parameter, payload, request, session) -> None:
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

# This handles requests involving order single-param rules.
# Instead of converting them into multi-param rules, it transalte the param edit into the existing RuleUpdate format and delegates to the original rule endpoint
def _update_legacy_parameter(rule, parameter_id, payload, request, session, user) -> dict[str, Any]:
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

# Param lifecycle such as activation or deactivation
@router.post("/rules/{rule_id}/parameters/{parameter_id}/lifecycle")
def update_parameter_lifecycle(
    rule_id: int,
    parameter_id: int,
    payload: ParameterLifecycleAction,
    request: Request,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:

    allowed = {ROLE_ADMINISTRATOR, ROLE_SUPERVISOR} if payload.action == "activate" else {ROLE_ADMINISTRATOR}
    if user.role not in allowed:
        raise HTTPException(status_code=403, detail=("Only Administrators and Supervisors can activate parameters." if payload.action == "activate"
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
    return {"rule_id": rule.id,"parameter": next(item for item in serialize_parameters(rule) if item["id"] == parameter_id),}
