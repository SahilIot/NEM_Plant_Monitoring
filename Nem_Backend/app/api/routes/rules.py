# create,view,update and filter machine monitoring rules
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.routes.auth import get_current_user
from app.api.routes.monitoring import state_for_rule
from app.db.session import get_db
from app.models import Asset, Alert, MonitoringRule, MonitoringRuleTemplate, RuleState, Variable, User
from app.schemas.rule import RuleCreate, RuleRead, RuleTemplateCreate, RuleUpdate
from app.services.legacy_parameters import serialize_legacy_parameters
from app.services.notification_settings import settings_for_rule
from app.services.rule_visibility import can_view_template, request_user
from app.services.access_scope import access_scope, rule_asset_id
from app.services.labels import apply_label_filter, assign_labels
from app.services.event_log import emit_event
from app.services.monitoring_engine import evaluate_rules, set_rule_enabled_state
from app.services.monitoring_engine import utc_now
from app.services.parameter_validation import validate_targets
from app.services.rule_parameters import ParameterConfigError, serialize_parameters
from app.services.template_parameters import apply_template_update
from app.services.signal_mappings import (configured_cycle_signal_mapping, configured_runtime_signal_mapping,
                                          is_mapping_bypass_enabled)
from app.core.constants import (
    LIFECYCLE_STATUS,
    RULE_BOOLEAN_COUNT_THRESHOLD,
    RULE_MULTI_PARAMETER,
    RULE_RUNTIME_DURATION,
    RULE_TYPE,
    STATUS_ACTIVE,
    STATUS_COMPLETED,
    STATUS_DEACTIVATED,
    STATUS_IN_PROGRESS,
    STATUS_NORMAL,
    STATUS_UNKNOWN,
    ERR_NO_FIELDS_TO_UPDATE,
    EVENT_RULE_CREATED,
    ROLE_ADMINISTRATOR,
    ROLE_OPERATOR,
    ROLE_SUPERVISOR,
)

router = APIRouter(prefix="/rules", tags=["monitoring rules"])

# Threshold keys inside `parameters` that a Supervisor may change, per rule type.
SUPERVISOR_PARAMETER_KEYS: dict[str, frozenset[str]] = {
    RULE_RUNTIME_DURATION: frozenset({"warning_thresholds_seconds", "alert_threshold_seconds"}),
    RULE_BOOLEAN_COUNT_THRESHOLD: frozenset({"warning_thresholds", "alert_threshold"}),
}

# Fields that live on the shared rule (template) for rules created from one.
SHARED_RULE_FIELDS = frozenset({
    "name", "description", RULE_TYPE, "operator", "threshold", "parameters", "severity",
    "evaluation_interval_seconds", "stale_after_seconds",
})
TEMPLATE_VALUE_FIELDS = (
    "name", "description", "collection_id", RULE_TYPE, "required_variable_types", "variable_key",
    "operator", "threshold", "parameters", "severity", "is_enabled",
    "evaluation_interval_seconds", "stale_after_seconds",
)

# This checks whether a new value is genuinely different from the existing value.
def _field_differs(current, new) -> bool:
    if isinstance(current, Decimal) or isinstance(new, Decimal):
        if current is None or new is None:
            return current is not new
        return Decimal(str(current)) != Decimal(str(new))
    return current != new

# This converts a Pydantic validation errors into readable messages. Makes frontend error handling easier.
def _validation_message(error: ValidationError) -> str:
    parts = []
    for item in error.errors(include_url=False):
        location = ".".join(str(part) for part in item["loc"])
        message = str(item["msg"]).removeprefix("Value error, ")
        parts.append(f"{location}: {message}" if location else message)
    return "; ".join(parts)

#Find the rule safely - whether rule exists and is within the caller`s access scope. If not, raise a 404 error.
def rule_or_404(session: Session, rule_id: int) -> MonitoringRule:
    rule = session.get(MonitoringRule, rule_id)
    # A rule on an asset outside the caller's scope is reported as not found.
    if rule is None or not access_scope(session).allows(rule_asset_id(session, rule)):
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    return rule

# Takes the row lock of a rule and re-reads it, so a writer of rules.parameters (a read-modify-write of one JSON
# column) always starts from the committed value and concurrent writers of the same rule are serialised.
def lock_rule(session: Session, rule: MonitoringRule) -> MonitoringRule:
    locked = session.scalar(select(MonitoringRule).where(MonitoringRule.id == rule.id)
                            .with_for_update().execution_options(populate_existing=True))
    if locked is None:
        raise HTTPException(status_code=404, detail=f"Rule {rule.id} was not found")
    return locked

def _visible_source_template_id(session: Session, rule: MonitoringRule) -> int | None:
    if rule.source_template_id is None:
        return None
    template = session.get(MonitoringRuleTemplate, rule.source_template_id)
    if template is None or not can_view_template(session, request_user(session), template):
        return None
    return rule.source_template_id

#converts a MonitoringRule db object into py dict that fastapi can return as JSON to the frontend
def rule_row(session: Session, rule: MonitoringRule) -> dict[str, Any]:
    state = state_for_rule(session, rule)
    asset = session.get(Asset, rule.target_asset_id) if rule.target_asset_id else None
    variable = session.get(Variable, rule.variable_id) if rule.variable_id else None
    return {
        "id": rule.id,
        "name": rule.name,
        "description": rule.description,
        "labels": rule.labels,
        "asset_id": rule.target_asset_id,
        "asset_name": asset.name if asset else "",
        "severity": rule.severity,
        "state": "activated" if rule.is_enabled else rule.lifecycle_status,
        "is_enabled": rule.is_enabled,
        LIFECYCLE_STATUS: rule.lifecycle_status,
        "completed_at": rule.completed_at,
        "created_at": rule.created_at,
        "updated_at": rule.updated_at,
        # Audit attribution comes from the user foreign keys; None means it was never stored.
        "created_by": rule.created_by,
        "updated_by": rule.updated_by,
        "status": (
            "evaluated"
            if rule.lifecycle_status == STATUS_COMPLETED
            else {STATUS_NORMAL: "ok"}.get(state.status, state.status)
            if rule.is_enabled
            else STATUS_UNKNOWN
        ),
        "current_status": (
            "evaluated"
            if rule.lifecycle_status == STATUS_COMPLETED
            else state.status
        ),
        "evaluation_status": state.status,
        "evaluation_message": state.message,
        "evaluation_error": state.error_message,
        "latest_value": state.latest_value,
        "last_evaluated_at": state.last_evaluated_at,
        "condition_started_at": state.condition_started_at,
        RULE_TYPE: rule.rule_type,
        # Parameter rows exist only for multi-parameter rules; other rule types omit the key.
        # Every rule has a parameter list: parameter rows for multi-parameter rules, one adapted parameter for older ones.
        "parameter_items": (serialize_parameters(rule) if rule.rule_type == RULE_MULTI_PARAMETER
                            else serialize_legacy_parameters(session, rule)),
        # The id of a shared rule is only disclosed to roles that may see shared rules.
        "source_template_id": _visible_source_template_id(session, rule),
        # True when this rule is an asset use of a shared rule: edits change every asset using it.
        "shared_rule": rule.source_template_id is not None,
        "variable_id": rule.variable_id,
        "variable_name": variable.name if variable else None,
        "variable_key": variable.key if variable else None,
        "variable_data_type": variable.data_type if variable else None,
        "variable_unit": variable.unit if variable else None,
        "operator": rule.operator,
        "threshold": float(rule.threshold) if rule.threshold is not None else None,
        "parameters": rule.parameters,
        "notifications": settings_for_rule(rule),
        "component_identifier": rule.component_identifier,
        "evaluation_interval_seconds": rule.evaluation_interval_seconds,
        "stale_after_seconds": rule.stale_after_seconds,
    }


# Create a new rule
@router.post("", response_model=RuleRead, status_code=status.HTTP_201_CREATED)
def create_rule(
    payload: RuleCreate,
    request: Request,
    session: Session = Depends(get_db),
) -> MonitoringRule:
    # Validate the target
    validate_targets(
        session, payload.target_asset_id, payload.variable_id, payload.rule_type,
        payload.operator, payload.threshold, payload.parameters,
        configured_cycle_signal_mapping(request.app.state, payload.variable_id),
        configured_runtime_signal_mapping(request.app.state, payload.variable_id),
        is_mapping_bypass_enabled(request.app.state),
    )
    rule_data = payload.model_dump(exclude={"labels"})
    rule_data[LIFECYCLE_STATUS] = (STATUS_IN_PROGRESS if payload.is_enabled else STATUS_DEACTIVATED)
    rule = MonitoringRule(**rule_data)
    session.add(rule)
    session.flush()
    assign_labels(session, rule, payload.labels)

    emit_event(
        session,
        event_type=EVENT_RULE_CREATED,
        message=f"Rule '{rule.name}' created.",
        occurred_at=utc_now(),
        asset_id=rule.target_asset_id,
        rule_id=rule.id,
    )
    session.commit()
    session.refresh(rule)
    return rule

#list and filter rules
@router.get("")
def list_rules(
    target_asset_id: int | None = Query(default=None, gt=0),
    rule_type: str | None = None,
    severity: str | None = None,
    is_enabled: bool | None = None,
    label_ids: list[int] | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    #Build the database queries
    scope = access_scope(session)
    query = select(MonitoringRule).where(
        MonitoringRule.target_asset_id.is_not(None),
        scope.clause(MonitoringRule.target_asset_id),
    )
    count_query = (
        select(func.count())
        .select_from(MonitoringRule)
        .where(
            MonitoringRule.target_asset_id.is_not(None),
            scope.clause(MonitoringRule.target_asset_id),
        )
    )
    for condition, column in (
        (target_asset_id, MonitoringRule.target_asset_id),
        (rule_type, MonitoringRule.rule_type),
        (severity, MonitoringRule.severity),
        (is_enabled, MonitoringRule.is_enabled),
    ):
        if condition is not None:
            query, count_query = query.where(column == condition), count_query.where(column == condition)
    try:
        query = apply_label_filter(query, MonitoringRule, label_ids)
        count_query = apply_label_filter(count_query, MonitoringRule, label_ids)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    items = session.scalars(query.order_by(MonitoringRule.id).offset(offset).limit(limit)).all()
    return {
        "items": [RuleRead.model_validate(item) for item in items],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }

# retrieve one rule
@router.get("/{rule_id}", response_model=RuleRead)
def get_rule(rule_id: int, session: Session = Depends(get_db)) -> MonitoringRule:
    return rule_or_404(session, rule_id)

# Fields whose change can alter a rule's Normal/Warning/Alert outcome.
EVALUATION_FIELDS = {"operator", "threshold", "parameters", "severity", "stale_after_seconds"}


#Update a rule
@router.patch("/{rule_id}", response_model=RuleRead)
def update_rule(
    rule_id: int,
    payload: RuleUpdate,
    request: Request,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MonitoringRule:
    # Authorization comes first and is based on the authenticated user only.
    if user.role == ROLE_OPERATOR:
        raise HTTPException(status_code=403, detail="Operators are not allowed to edit monitoring rules")
    if user.role not in {ROLE_ADMINISTRATOR, ROLE_SUPERVISOR}:
        raise HTTPException(status_code=403, detail="You are not allowed to edit monitoring rules")

    rule = rule_or_404(session, rule_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail=ERR_NO_FIELDS_TO_UPDATE)
    # Same lock order as apply_template_update: shared rule first (only when its fields change), then this rule.
    if rule.source_template_id is not None and set(changes) & SHARED_RULE_FIELDS:
        session.scalar(select(MonitoringRuleTemplate.id).where(MonitoringRuleTemplate.id == rule.source_template_id)
                       .with_for_update().execution_options(populate_existing=True))
    rule = lock_rule(session, rule)

    # Nested parameters are merged into the stored ones so omitted keys
    # (for example activation_at) are never cleared by a partial update.
    if "parameters" in changes:
        incoming = changes["parameters"]
        if not isinstance(incoming, dict):
            raise HTTPException(status_code=422, detail="parameters must be an object")
        if user.role == ROLE_SUPERVISOR:
            allowed_keys = SUPERVISOR_PARAMETER_KEYS.get(rule.rule_type, frozenset())
            disallowed = set(incoming) - allowed_keys
            if disallowed:
                raise HTTPException(status_code=403,detail=( "Supervisors can only edit Due and Overdue values. "
                        f"Restricted parameters: {', '.join(sorted(disallowed))}"),)
        changes["parameters"] = {**(rule.parameters or {}), **incoming}

    # Only genuine modifications count; values equal to the stored ones are no-ops.
    changes = {
        field: value
        for field, value in changes.items()
        if _field_differs(getattr(rule, field), value)
    }
    if not changes:
        return rule

    if user.role == ROLE_SUPERVISOR:
        # Only the Due and Overdue values (the interval thresholds inside `parameters`) may change.
        allowed_fields = {"parameters"} if rule.rule_type in SUPERVISOR_PARAMETER_KEYS else set()
        restricted = set(changes) - allowed_fields
        if restricted:
            raise HTTPException(status_code=403,detail=("Supervisors can only edit Due and Overdue values. "
                    f"Restricted fields: {', '.join(sorted(restricted))}"),)

    if rule.lifecycle_status == STATUS_COMPLETED and changes.get("is_enabled") is True:
        raise HTTPException(status_code=409,detail="Completed rules cannot be reactivated. Create a new rule instead.",)

    prospective = {
        key: changes.get(key, getattr(rule, key))
        for key in (
            "name", RULE_TYPE, "target_asset_id", "variable_id", "operator",
            "threshold", "parameters", "severity", "is_enabled",
            "evaluation_interval_seconds", "stale_after_seconds",
        )
    }
    try:
        validated = RuleCreate.model_validate(prospective)
    except ValidationError as error:
        raise HTTPException(status_code=422, detail=_validation_message(error)) from error
    validate_targets(
        session, validated.target_asset_id, validated.variable_id, validated.rule_type,
        validated.operator, validated.threshold, validated.parameters,
        configured_cycle_signal_mapping(request.app.state, validated.variable_id),
        configured_runtime_signal_mapping(request.app.state, validated.variable_id),
        is_mapping_bypass_enabled(request.app.state),
    )
    # prevent changing targets after evaluation state exits
    target_fields = {"target_asset_id", "variable_id"}
    #Prevent changing targets while alerts are active
    if target_fields.intersection(changes) and session.scalar(select(RuleState.id).where(RuleState.rule_id == rule.id).limit(1)):
        raise HTTPException(status_code=409,detail="A rule target cannot be changed after evaluation state exists",)
    if target_fields.intersection(changes) and session.scalar(select(Alert.id).where(Alert.rule_id == rule.id, Alert.status == STATUS_ACTIVE).limit(1)):
        raise HTTPException(status_code=409,detail="Resolve active alerts before changing a rule target",)

    # A rule created from a shared rule is a view of it: threshold-type edits go to the shared
    # rule (single source of truth) and propagate to every asset using it, with audit history.
    propagated = set()
    shared_changes = {field: value for field, value in changes.items() if field in SHARED_RULE_FIELDS}
    template = (
        session.get(MonitoringRuleTemplate, rule.source_template_id)
        if rule.source_template_id is not None and shared_changes
        else None
    )
    if template is not None:
        if not can_view_template(session, request_user(session), template):
            raise HTTPException(status_code=403,detail="This rule is shared and its configuration is managed by an Administrator",)
        values = {field: getattr(template, field) for field in TEMPLATE_VALUE_FIELDS}
        for field, value in shared_changes.items():
            values[field] = {**(template.parameters or {}), **(payload.parameters or {})} if field == "parameters" else value
        try:
            validated_template = RuleTemplateCreate.model_validate({**values, "labels": list(template.labels)})
        except ValidationError as error:
            raise HTTPException(status_code=422, detail=_validation_message(error)) from error
        values = validated_template.model_dump(exclude={"labels"})
        apply_template_update(session, request, template, values, None)
        propagated = set(shared_changes) - {"name", "description"}

    #Apply the changes
    for field, value in changes.items():
        if field not in {"is_enabled", "labels"} | propagated:
            setattr(rule, field, value)
    if "labels" in changes:
        assign_labels(session, rule, changes["labels"])
    if "is_enabled" in changes:
        try:
            set_rule_enabled_state(session, rule, changes["is_enabled"])
        except ParameterConfigError as error:
            session.rollback()
            raise HTTPException(status_code=422, detail=str(error)) from error
    # Apply a changed threshold immediately instead of waiting for the next PLC value or evaluation cycle.
    # A shared-rule edit already re-evaluated every rule using it in apply_template_update.
    if template is None and rule.is_enabled and set(changes) & EVALUATION_FIELDS:
        session.flush()
        evaluate_rules(
            session,
            rule_id=rule.id,
            stale_after_seconds=request.app.state.settings.monitoring_default_stale_after_seconds,
            runtime_gap_seconds=request.app.state.settings.runtime_freshness_seconds,
        )
    session.commit()
    session.refresh(rule)
    return rule