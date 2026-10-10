from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Asset, Alert, MonitoringRule, RuleState, Variable
from app.schemas.rule import RuleCreate, RuleRead, RuleUpdate
from app.services.monitoring_engine import emit_event, set_rule_enabled_state
from app.services.monitoring_engine import utc_now


router = APIRouter(prefix="/rules", tags=["monitoring rules"])


def rule_or_404(session: Session, rule_id: int) -> MonitoringRule:
    rule = session.get(MonitoringRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    return rule


def validate_targets(
    session: Session,
    target_asset_id: int | None,
    variable_id: int | None,
    rule_type: str,
    operator: str | None,
    threshold,
    parameters: dict | None,
) -> None:
    if target_asset_id is not None and session.get(Asset, target_asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {target_asset_id} was not found")
    variable = session.get(Variable, variable_id) if variable_id is not None else None
    if variable_id is not None and variable is None:
        raise HTTPException(status_code=404, detail=f"Variable {variable_id} was not found")
    if variable is not None and target_asset_id is not None:
        if variable.asset_id != target_asset_id:
            raise HTTPException(
                status_code=422, detail="Target variable does not belong to target asset"
            )
    if rule_type == "parameter_threshold":
        if variable is None or variable.data_type not in {"number", "integer"}:
            raise HTTPException(
                status_code=422,
                detail="Parameter threshold rules require a numeric variable",
            )
        if operator is None or threshold is None:
            raise HTTPException(
                status_code=422,
                detail="Parameter threshold rules require an operator and threshold",
            )
    if rule_type in {"runtime_duration", "duration"}:
        duration = parameters.get("duration_seconds") if parameters else None
        if not isinstance(duration, int) or isinstance(duration, bool) or duration <= 0:
            raise HTTPException(
                status_code=422,
                detail="Runtime rules require a positive parameters.duration_seconds",
            )


@router.post("", response_model=RuleRead, status_code=status.HTTP_201_CREATED)
def create_rule(payload: RuleCreate, session: Session = Depends(get_db)) -> MonitoringRule:
    validate_targets(
        session, payload.target_asset_id, payload.variable_id, payload.rule_type,
        payload.operator, payload.threshold, payload.parameters,
    )
    rule = MonitoringRule(**payload.model_dump())
    session.add(rule)
    session.flush()
    if not rule.is_enabled:
        emit_event(
            session,
            event_type="rule_disabled",
            message=f"Rule '{rule.name}' created disabled.",
            occurred_at=utc_now(),
            asset_id=rule.target_asset_id,
            rule_id=rule.id,
        )
    session.commit()
    session.refresh(rule)
    return rule


@router.get("")
def list_rules(
    target_asset_id: int | None = Query(default=None, gt=0),
    rule_type: str | None = None,
    severity: str | None = None,
    is_enabled: bool | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    query = select(MonitoringRule)
    count_query = select(func.count()).select_from(MonitoringRule)
    for condition, column in (
        (target_asset_id, MonitoringRule.target_asset_id),
        (rule_type, MonitoringRule.rule_type),
        (severity, MonitoringRule.severity),
        (is_enabled, MonitoringRule.is_enabled),
    ):
        if condition is not None:
            query, count_query = query.where(column == condition), count_query.where(
                column == condition
            )
    items = session.scalars(query.order_by(MonitoringRule.id).offset(offset).limit(limit)).all()
    return {
        "items": [RuleRead.model_validate(item) for item in items],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }


@router.get("/{rule_id}", response_model=RuleRead)
def get_rule(rule_id: int, session: Session = Depends(get_db)) -> MonitoringRule:
    return rule_or_404(session, rule_id)


@router.patch("/{rule_id}", response_model=RuleRead)
def update_rule(
    rule_id: int, payload: RuleUpdate, session: Session = Depends(get_db)
) -> MonitoringRule:
    rule = rule_or_404(session, rule_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail="Provide at least one field to update")
    prospective = {
        key: changes.get(key, getattr(rule, key))
        for key in (
            "name", "rule_type", "target_asset_id", "variable_id", "operator",
            "threshold", "parameters", "severity", "is_enabled",
            "evaluation_interval_seconds", "stale_after_seconds",
        )
    }
    validated = RuleCreate.model_validate(prospective)
    validate_targets(
        session, validated.target_asset_id, validated.variable_id, validated.rule_type,
        validated.operator, validated.threshold, validated.parameters,
    )
    target_fields = {"target_asset_id", "variable_id"}
    if target_fields.intersection(changes) and session.scalar(
        select(RuleState.id).where(RuleState.rule_id == rule.id).limit(1)
    ):
        raise HTTPException(
            status_code=409,
            detail="A rule target cannot be changed after evaluation state exists",
        )
    if target_fields.intersection(changes) and session.scalar(
        select(Alert.id).where(Alert.rule_id == rule.id, Alert.status == "active").limit(1)
    ):
        raise HTTPException(
            status_code=409,
            detail="Resolve active alerts before changing a rule target",
        )
    for field, value in changes.items():
        if field != "is_enabled":
            setattr(rule, field, value)
    if "is_enabled" in changes:
        set_rule_enabled_state(session, rule, changes["is_enabled"])
    session.commit()
    session.refresh(rule)
    return rule
