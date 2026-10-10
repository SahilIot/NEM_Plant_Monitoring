from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import (
    Alert,
    Asset,
    MonitoringEvent,
    MonitoringRule,
    RuleState,
    Variable,
)
from app.schemas.monitoring import (
    AcknowledgeRequest,
    AlertRead,
    EvaluationResult,
    EventRead,
    RuleStateRead,
)
from app.services.monitoring_engine import emit_event, evaluate_rules, utc_now


router = APIRouter(tags=["monitoring", "alerts", "events"])


def normalized(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def state_for_rule(session: Session, rule: MonitoringRule) -> RuleStateRead:
    asset_id = rule.target_asset_id
    if asset_id is None and rule.variable_id is not None:
        variable = session.get(Variable, rule.variable_id)
        asset_id = variable.asset_id if variable else None
    state = session.scalar(
        select(RuleState).where(
            RuleState.rule_id == rule.id,
            RuleState.target_asset_id == asset_id,
        )
    ) if asset_id is not None else None
    if state is None:
        return RuleStateRead(
            rule_id=rule.id,
            target_asset_id=asset_id,
            target_variable_id=rule.variable_id,
            status="unknown",
            message="Rule has not yet been evaluated.",
        )
    return RuleStateRead.model_validate(state)


@router.post("/monitoring/evaluate", response_model=EvaluationResult)
def manually_evaluate(
    request: Request,
    asset_id: int | None = Query(default=None, gt=0),
    rule_id: int | None = Query(default=None, gt=0),
    session: Session = Depends(get_db),
) -> dict[str, int]:
    if asset_id is not None and session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    if rule_id is not None and session.get(MonitoringRule, rule_id) is None:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    counts = evaluate_rules(
        session,
        stale_after_seconds=request.app.state.settings.monitoring_default_stale_after_seconds,
        asset_id=asset_id,
        rule_id=rule_id,
    )
    session.commit()
    return counts


@router.get("/monitoring/status")
def monitoring_status(
    status: str | None = Query(default=None, pattern="^(normal|warning|alert|unknown)$"),
    asset_id: int | None = Query(default=None, gt=0),
    rule_id: int | None = Query(default=None, gt=0),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    query = select(MonitoringRule).where(MonitoringRule.is_enabled.is_(True))
    if rule_id is not None:
        query = query.where(MonitoringRule.id == rule_id)
    rules = session.scalars(query.order_by(MonitoringRule.id)).all()
    rows: list[RuleStateRead] = []
    for rule in rules:
        current = state_for_rule(session, rule)
        if asset_id is not None and current.target_asset_id != asset_id:
            continue
        if status is not None and current.status != status:
            continue
        rows.append(current)
    return {
        "items": rows[offset : offset + limit],
        "total": len(rows),
        "limit": limit,
        "offset": offset,
    }


@router.get("/assets/{asset_id}/monitoring-status")
def asset_monitoring_status(
    asset_id: int,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    rules = session.scalars(
        select(MonitoringRule)
        .where(
            MonitoringRule.is_enabled.is_(True),
            or_(
                MonitoringRule.target_asset_id == asset_id,
                MonitoringRule.variable_id.in_(
                    select(Variable.id).where(Variable.asset_id == asset_id)
                ),
            ),
        )
        .order_by(MonitoringRule.id)
    ).all()
    items = [state_for_rule(session, rule) for rule in rules]
    return {"items": items[offset : offset + limit], "total": len(items), "limit": limit, "offset": offset}


@router.get("/rules/{rule_id}/status", response_model=RuleStateRead)
def rule_status(rule_id: int, session: Session = Depends(get_db)) -> RuleStateRead:
    rule = session.get(MonitoringRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    return state_for_rule(session, rule)


def alert_query(
    session: Session,
    *,
    asset_id: int | None,
    rule_id: int | None,
    severity: str | None,
    lifecycle_status: str | None,
    acknowledged: bool | None,
    start_time: datetime | None,
    end_time: datetime | None,
):
    start, end = normalized(start_time), normalized(end_time)
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="start_time must not be later than end_time")
    query = select(Alert)
    count_query = select(func.count()).select_from(Alert)
    filters = []
    if asset_id is not None:
        filters.append(Alert.target_asset_id == asset_id)
    if rule_id is not None:
        filters.append(Alert.rule_id == rule_id)
    if severity is not None:
        filters.append(Alert.severity == severity)
    if lifecycle_status is not None:
        filters.append(Alert.status == lifecycle_status)
    if acknowledged is True:
        filters.append(Alert.acknowledged_at.is_not(None))
    if acknowledged is False:
        filters.append(Alert.acknowledged_at.is_(None))
    if start is not None:
        filters.append(Alert.started_at >= start)
    if end is not None:
        filters.append(Alert.started_at <= end)
    for condition in filters:
        query, count_query = query.where(condition), count_query.where(condition)
    return query, count_query


@router.get("/alerts/active")
def active_alerts(
    asset_id: int | None = Query(default=None, gt=0),
    rule_id: int | None = Query(default=None, gt=0),
    severity: str | None = Query(default=None, pattern="^(warning|alert)$"),
    acknowledged: bool | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    query, count_query = alert_query(
        session, asset_id=asset_id, rule_id=rule_id, severity=severity,
        lifecycle_status="active", acknowledged=acknowledged,
        start_time=start_time, end_time=end_time,
    )
    rows = session.scalars(
        query.order_by(Alert.started_at.desc(), Alert.id.desc()).offset(offset).limit(limit)
    ).all()
    return {
        "items": [AlertRead.model_validate(row) for row in rows],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }


@router.get("/alerts")
def list_alerts(
    asset_id: int | None = Query(default=None, gt=0),
    rule_id: int | None = Query(default=None, gt=0),
    severity: str | None = Query(default=None, pattern="^(warning|alert)$"),
    lifecycle_status: str | None = Query(default=None, pattern="^(active|resolved)$"),
    acknowledged: bool | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    query, count_query = alert_query(
        session, asset_id=asset_id, rule_id=rule_id, severity=severity,
        lifecycle_status=lifecycle_status, acknowledged=acknowledged,
        start_time=start_time, end_time=end_time,
    )
    rows = session.scalars(
        query.order_by(Alert.started_at.desc(), Alert.id.desc()).offset(offset).limit(limit)
    ).all()
    return {
        "items": [AlertRead.model_validate(row) for row in rows],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }


@router.get("/alerts/{alert_id}", response_model=AlertRead)
def get_alert(alert_id: int, session: Session = Depends(get_db)) -> Alert:
    alert = session.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} was not found")
    return alert


@router.post("/alerts/{alert_id}/acknowledge", response_model=AlertRead)
def acknowledge_alert(
    alert_id: int,
    payload: AcknowledgeRequest | None = None,
    session: Session = Depends(get_db),
) -> Alert:
    alert = session.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} was not found")
    if alert.status != "active":
        raise HTTPException(status_code=409, detail="Resolved alerts cannot be acknowledged")
    if alert.acknowledged_at is None:
        now = utc_now()
        alert.acknowledged_at = now
        alert.acknowledged_by = payload.acknowledged_by if payload else None
        emit_event(
            session,
            event_type="alert_acknowledged",
            message="Active alert acknowledged; the underlying condition is not resolved.",
            occurred_at=now,
            asset_id=alert.target_asset_id,
            rule_id=alert.rule_id,
            alert_id=alert.id,
            severity=alert.severity,
            metadata={"acknowledged_by": alert.acknowledged_by, "identity_verified": False},
        )
        session.commit()
        session.refresh(alert)
    return alert


@router.get("/events")
def list_events(
    asset_id: int | None = Query(default=None, gt=0),
    rule_id: int | None = Query(default=None, gt=0),
    alert_id: int | None = Query(default=None, gt=0),
    event_type: str | None = None,
    severity: str | None = Query(default=None, pattern="^(warning|alert)$"),
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    start, end = normalized(start_time), normalized(end_time)
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="start_time must not be later than end_time")
    query = select(MonitoringEvent)
    count_query = select(func.count()).select_from(MonitoringEvent)
    for value, column in (
        (asset_id, MonitoringEvent.asset_id),
        (rule_id, MonitoringEvent.rule_id),
        (alert_id, MonitoringEvent.alert_id),
        (event_type, MonitoringEvent.event_type),
        (severity, MonitoringEvent.severity),
    ):
        if value is not None:
            query, count_query = query.where(column == value), count_query.where(column == value)
    if start is not None:
        query, count_query = query.where(MonitoringEvent.occurred_at >= start), count_query.where(
            MonitoringEvent.occurred_at >= start
        )
    if end is not None:
        query, count_query = query.where(MonitoringEvent.occurred_at <= end), count_query.where(
            MonitoringEvent.occurred_at <= end
        )
    rows = session.scalars(
        query.order_by(MonitoringEvent.occurred_at.desc(), MonitoringEvent.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    return {
        "items": [EventRead.model_validate(row) for row in rows],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }


@router.get("/events/{event_id}", response_model=EventRead)
def get_event(event_id: int, session: Session = Depends(get_db)) -> MonitoringEvent:
    event = session.get(MonitoringEvent, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail=f"Event {event_id} was not found")
    return event
