# Rule lifecycle transitions (suspend, resume, activate, deactivate) shared by the rule routes.
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.constants import (
    RULE_GENERIC,
    STATUS_DEACTIVATED,
    STATUS_IN_PROGRESS,
    STATUS_SUSPENDED,
)
from app.models import MonitoringRule
from app.services.access_scope import require_rule_access
from app.services.event_log import emit_event
from app.services.monitoring_engine import set_rule_enabled_state
from app.services.parameter_validation import validate_targets
from app.services.rule_parameters import ParameterConfigError
from app.services.signal_mappings import (
    configured_cycle_signal_mapping,
    configured_runtime_signal_mapping,
    is_mapping_bypass_enabled,
)


# The one implementation of a rule's suspend / resume / activate / deactivate transition. It commits its own change
# (callers that loop over rules, such as Activate All, rely on that and roll back a failed rule themselves).
def transition_rule_lifecycle(
    session: Session,
    rule_id: int,
    action: str,
    app_state: Any,
) -> MonitoringRule:
    rule = session.scalar(
        select(MonitoringRule)
        .where(MonitoringRule.id == rule_id)
        .with_for_update()
    )
    if rule is None:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    require_rule_access(session, rule)

    now = datetime.now(timezone.utc)
    current = rule.lifecycle_status
    if action == "suspend":
        if current != STATUS_IN_PROGRESS or not rule.is_enabled:
            raise HTTPException(status_code=409, detail="Only an active rule can be suspended.")
        set_rule_enabled_state(session, rule, False, at=now)
        rule.lifecycle_status = STATUS_SUSPENDED
        event_type = "rule_suspended"
    elif action in {"resume", "activate"}:
        expected = STATUS_SUSPENDED if action == "resume" else STATUS_DEACTIVATED
        if current != expected or rule.is_enabled:
            raise HTTPException(status_code=409, detail=f"Only a {expected} rule can be {action}d.",)
        if rule.rule_type == RULE_GENERIC:
            raise HTTPException(status_code=422, detail="This rule type has no monitoring evaluator.")
        validate_targets(
            session,
            rule.target_asset_id,
            rule.variable_id,
            rule.rule_type,
            rule.operator,
            rule.threshold,
            rule.parameters,
            configured_cycle_signal_mapping(app_state, rule.variable_id),
            configured_runtime_signal_mapping(app_state, rule.variable_id),
            is_mapping_bypass_enabled(app_state),
        )
        try:
            set_rule_enabled_state(session, rule, True, at=now)
        except ParameterConfigError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        rule.lifecycle_status = STATUS_IN_PROGRESS
        rule.completed_at = None
        event_type = "rule_resumed" if action == "resume" else "rule_activated"
    elif action == "deactivate":
        if current not in {STATUS_IN_PROGRESS, STATUS_SUSPENDED}:
            raise HTTPException(status_code=409, detail="Only an active or suspended rule can be deactivated.")
        if rule.is_enabled:
            set_rule_enabled_state(session, rule, False, at=now)
        rule.lifecycle_status = STATUS_DEACTIVATED
        event_type = "rule_deactivated"
    else:
        raise HTTPException(status_code=422, detail="Unsupported lifecycle action.")

    emit_event(
        session,
        event_type=event_type,
        message=(f"Rule '{rule.name}' "
            f"{ {'suspend': STATUS_SUSPENDED, 'resume': 'resumed', 'activate': 'activated', 'deactivate': STATUS_DEACTIVATED}[action] }."),
        occurred_at=now,
        asset_id=rule.target_asset_id,
        rule_id=rule.id,
    )
    session.commit()
    session.refresh(rule)
    return rule
