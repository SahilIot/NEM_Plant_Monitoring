# create,view,update and filter machine monitoring rules
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.routes.auth import get_current_user
from app.services.rule_state import state_for_rule
from app.db.session import get_db
from app.models import Asset, MonitoringRule, MonitoringRuleTemplate, Variable, User
from app.schemas.rule import RuleCreate, RuleRead, RuleUpdate
from app.services.legacy_parameters import serialize_legacy_parameters
from app.services.notification_settings import settings_for_rule
from app.services.rule_visibility import can_view_template, request_user
from app.services.access_scope import access_scope
from app.services.labels import apply_label_filter, assign_labels
from app.services.event_log import emit_event
from app.core.timeutils import utc_now
from app.services.parameter_validation import validate_targets
from app.services.rule_parameters import serialize_parameters
from app.services import rule_update as _rule_update
from app.services.rule_update import apply_rule_update, rule_or_404
from app.services.signal_mappings import (configured_cycle_signal_mapping, configured_runtime_signal_mapping,
                                          is_mapping_bypass_enabled)
from app.core.constants import (
    LIFECYCLE_STATUS,
    RULE_MULTI_PARAMETER,
    RULE_TYPE,
    STATUS_COMPLETED,
    STATUS_DEACTIVATED,
    STATUS_IN_PROGRESS,
    STATUS_NORMAL,
    STATUS_UNKNOWN,
    EVENT_RULE_CREATED,
)

router = APIRouter(prefix="/rules", tags=["monitoring rules"])

# These now live in services/rule_update.py; they stay importable from here for the route modules that use them.
lock_rule = _rule_update.lock_rule
TEMPLATE_VALUE_FIELDS = _rule_update.TEMPLATE_VALUE_FIELDS

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


#Update a rule
@router.patch("/{rule_id}", response_model=RuleRead)
def update_rule(
    rule_id: int,
    payload: RuleUpdate,
    request: Request,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MonitoringRule:
    return apply_rule_update(session, request.app.state, rule_id, payload, user)