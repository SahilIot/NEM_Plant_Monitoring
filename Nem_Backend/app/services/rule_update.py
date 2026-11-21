# Business logic of a monitoring-rule update (PATCH /rules/{rule_id}), shared by the rules route and any other
# caller that needs the same behaviour. The caller owns the request-scoped session; this function takes the row
# locks, commits (unless nothing really changed) and refreshes the rule, exactly as the route used to.
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.constants import (
    ERR_NO_FIELDS_TO_UPDATE,
    ROLE_ADMINISTRATOR,
    ROLE_OPERATOR,
    ROLE_SUPERVISOR,
    RULE_BOOLEAN_COUNT_THRESHOLD,
    RULE_RUNTIME_DURATION,
    RULE_TYPE,
    STATUS_ACTIVE,
    STATUS_COMPLETED,
)
from app.models import Alert, MonitoringRule, MonitoringRuleTemplate, RuleState, User
from app.schemas.rule import RuleCreate, RuleTemplateCreate, RuleUpdate
from app.services.access_scope import access_scope, rule_asset_id
from app.services.labels import assign_labels
from app.services.monitoring_engine import evaluate_rules, set_rule_enabled_state
from app.services.parameter_validation import validate_targets
from app.services.rule_parameters import ParameterConfigError
from app.services.rule_visibility import can_view_template, request_user
from app.services.signal_mappings import (configured_cycle_signal_mapping, configured_runtime_signal_mapping,
                                          is_mapping_bypass_enabled)
from app.services.template_parameters import apply_template_update

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

# Fields whose change can alter a rule's Normal/Warning/Alert outcome.
EVALUATION_FIELDS = {"operator", "threshold", "parameters", "severity", "stale_after_seconds"}


# apply_template_update still takes a FastAPI Request but only ever reads request.app.state (and passes the request
# on to helpers that do the same), so it is given an object that carries just that.
def _request_with_state(app_state: Any) -> Any:
    return SimpleNamespace(app=SimpleNamespace(state=app_state))



def apply_rule_update(
    session: Session,
    app_state: Any,
    rule_id: int,
    payload: RuleUpdate,
    user: User,
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
        configured_cycle_signal_mapping(app_state, validated.variable_id),
        configured_runtime_signal_mapping(app_state, validated.variable_id),
        is_mapping_bypass_enabled(app_state),
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
        apply_template_update(session, _request_with_state(app_state), template, values, None)
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
            stale_after_seconds=app_state.settings.monitoring_default_stale_after_seconds,
            runtime_gap_seconds=app_state.settings.runtime_freshness_seconds,
        )
    session.commit()
    session.refresh(rule)
    return rule
