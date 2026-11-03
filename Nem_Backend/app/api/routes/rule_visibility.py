# Shared-rule visibility management and the Supervisor visibility request workflow.
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import MonitoringRuleTemplate, User
from app.models.rule_visibility import RuleVisibilityChange, RuleVisibilityRequest
from app.schemas.rule import (
    RuleVisibilityReject,
    RuleVisibilityRequestCreate,
    RuleVisibilityUpdate,
)
from app.services.rule_visibility import (
    active_supervisors,
    apply_visibility,
    can_view_template,
    request_user,
)

router = APIRouter(tags=["rule visibility"])


def _require_user(session: Session, *roles: str) -> User:
    user = request_user(session)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if user.role not in roles:
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    return user


def _names(session: Session, ids: list[int]) -> list[dict[str, Any]]:
    if not ids:
        return []
    users = session.scalars(select(User).where(User.id.in_(ids)).order_by(User.username)).all()
    return [{"id": user.id, "username": user.username} for user in users]


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _request_row(session: Session, item: RuleVisibilityRequest) -> dict[str, Any]:
    return {
        "id": item.id,
        "template_id": item.template_id,
        "rule_name": item.rule_name,
        "requested_by": item.requested_by,
        "requested_by_name": item.requester.username if item.requester else None,
        "current_visibility": item.current_visibility,
        "requested_visibility": item.requested_visibility,
        "requested_user_ids": list(item.requested_user_ids or []),
        "requested_users": _names(session, list(item.requested_user_ids or [])),
        "reason": item.reason,
        "status": item.status,
        "created_at": _iso(item.created_at),
        "reviewed_by": item.reviewed_by,
        "reviewed_by_name": item.reviewer.username if item.reviewer else None,
        "reviewed_at": _iso(item.reviewed_at),
        "rejection_reason": item.rejection_reason,
    }


def _visibility_detail(session: Session, template: MonitoringRuleTemplate) -> dict[str, Any]:
    history = session.scalars(
        select(RuleVisibilityChange)
        .where(RuleVisibilityChange.template_id == template.id)
        .order_by(RuleVisibilityChange.changed_at.desc(), RuleVisibilityChange.id.desc())
        .limit(20)
    ).all()
    return {
        "template_id": template.id,
        "visibility_type": template.visibility_type,
        "supervisors": _names(session, template.visibility_supervisor_ids),
        "history": [
            {
                "id": change.id,
                "changed_by": change.changed_by.username if change.changed_by else None,
                "changed_at": _iso(change.changed_at),
                "source": change.source,
                "request_id": change.request_id,
                "previous_visibility": change.previous_visibility,
                "new_visibility": change.new_visibility,
                "previous_user_ids": change.previous_user_ids,
                "new_user_ids": change.new_user_ids,
            }
            for change in history
        ],
    }


@router.get("/rule-visibility/supervisors")
def list_selectable_supervisors(session: Session = Depends(get_db)) -> list[dict[str, Any]]:
    _require_user(session, "Administrator")
    users = session.scalars(
        select(User)
        .where(User.role == "Supervisor", User.is_active.is_(True))
        .order_by(User.username)
    ).all()
    return [{"id": user.id, "username": user.username} for user in users]


@router.get("/rule-templates/{template_id}/visibility")
def get_template_visibility(template_id: int, session: Session = Depends(get_db)) -> dict[str, Any]:
    _require_user(session, "Administrator")
    template = session.get(MonitoringRuleTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Rule template was not found")
    return _visibility_detail(session, template)


@router.put("/rule-templates/{template_id}/visibility")
def set_template_visibility(
    template_id: int,
    payload: RuleVisibilityUpdate,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    admin = _require_user(session, "Administrator")
    template = session.get(MonitoringRuleTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Rule template was not found")
    apply_visibility(session, template, payload.visibility_type, payload.supervisor_ids,
        actor=admin, source="admin",)
    session.commit()
    session.refresh(template)
    return _visibility_detail(session, template)


@router.get("/rule-visibility-requests/requestable")
def list_requestable_rules(session: Session = Depends(get_db)) -> list[dict[str, Any]]:
    """Names only: lets a Supervisor pick a rule to ask for. No rule definition is returned."""
    user = _require_user(session, "Supervisor")
    templates = session.scalars(
        select(MonitoringRuleTemplate)
        .where(MonitoringRuleTemplate.visibility_type != "all_supervisors")
        .order_by(MonitoringRuleTemplate.name, MonitoringRuleTemplate.id)
    ).all()
    return [
        {
            "id": template.id,
            "name": template.name,
            "visibility_type": template.visibility_type,
            "has_access": can_view_template(session, user, template),
        }
        for template in templates
    ]


@router.post("/rule-visibility-requests", status_code=201)
def submit_visibility_request(
    payload: RuleVisibilityRequestCreate,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _require_user(session, "Supervisor")
    template = session.get(MonitoringRuleTemplate, payload.template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Rule template was not found")
    if template.visibility_type == "all_supervisors":
        raise HTTPException(status_code=409, detail="This rule is already visible to all Supervisors")
    if payload.request_type == "self":
        if can_view_template(session, user, template):
            raise HTTPException(status_code=409, detail="You already have access to this rule")
        requested_visibility, requested_ids = "specific_supervisors", [user.id]
    else:
        requested_visibility, requested_ids = "all_supervisors", []
    key = ",".join(str(item) for item in requested_ids)
    duplicate = session.scalar(
        select(RuleVisibilityRequest.id).where(
            RuleVisibilityRequest.template_id == template.id,
            RuleVisibilityRequest.status == "pending",
            RuleVisibilityRequest.requested_visibility == requested_visibility,
            RuleVisibilityRequest.requested_key == key,
        )
    )
    if duplicate is not None:
        raise HTTPException(status_code=409,detail="A pending request for this rule and visibility already exists",)
    item = RuleVisibilityRequest(
        template_id=template.id,
        rule_name=template.name,
        requested_by=user.id,
        current_visibility=template.visibility_type,
        requested_visibility=requested_visibility,
        requested_user_ids=requested_ids,
        requested_key=key,
        reason=payload.reason,
        status="pending",
    )
    session.add(item)
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409,detail="A pending request for this rule and visibility already exists",) from error
    session.refresh(item)
    return _request_row(session, item)


@router.get("/rule-visibility-requests")
def list_visibility_requests(
    status: str | None = None,
    session: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    user = _require_user(session, "Administrator", "Supervisor")
    query = select(RuleVisibilityRequest)
    if user.role != "Administrator":
        query = query.where(RuleVisibilityRequest.requested_by == user.id)
    if status:
        if status not in {"pending", "approved", "rejected"}:
            raise HTTPException(status_code=422, detail="Invalid request status")
        query = query.where(RuleVisibilityRequest.status == status)
    items = session.scalars(query.order_by(RuleVisibilityRequest.created_at.desc(), RuleVisibilityRequest.id.desc())
    ).all()
    return [_request_row(session, item) for item in items]


def _pending_request(session: Session, request_id: int) -> RuleVisibilityRequest:
    item = session.scalar(select(RuleVisibilityRequest).where(RuleVisibilityRequest.id == request_id).with_for_update())
    if item is None:
        raise HTTPException(status_code=404, detail="Visibility request was not found")
    if item.status != "pending":
        raise HTTPException(status_code=409, detail="This request has already been reviewed")
    return item


@router.post("/rule-visibility-requests/{request_id}/approve")
def approve_visibility_request(request_id: int, session: Session = Depends(get_db)) -> dict[str, Any]:
    admin = _require_user(session, "Administrator")
    item = _pending_request(session, request_id)
    template = session.scalar(
        select(MonitoringRuleTemplate)
        .where(MonitoringRuleTemplate.id == item.template_id)
        .with_for_update()
    )
    if template is None:
        raise HTTPException(status_code=404, detail="The requested rule no longer exists")
    requested_ids = list(item.requested_user_ids or [])
    if item.requested_visibility == "all_supervisors":
        apply_visibility(session, template, "all_supervisors", [], actor=admin,
                         source="request", request_id=item.id)
    elif template.visibility_type != "all_supervisors":
        active_supervisors(session, requested_ids)  # requester must still be an active Supervisor
        still_valid = set(session.scalars(
            select(User.id).where(
                User.id.in_(template.visibility_supervisor_ids or [0]),
                User.role == "Supervisor",
                User.is_active.is_(True),
            )
        ).all())
        merged = still_valid | set(requested_ids)
        apply_visibility(session, template, "specific_supervisors", merged, actor=admin,
                         source="request", request_id=item.id)
    item.status = "approved"
    item.reviewed_by = admin.id
    item.reviewed_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(item)
    return _request_row(session, item)


@router.post("/rule-visibility-requests/{request_id}/reject")
def reject_visibility_request(
    request_id: int,
    payload: RuleVisibilityReject | None = None,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    admin = _require_user(session, "Administrator")
    item = _pending_request(session, request_id)
    item.status = "rejected"
    item.reviewed_by = admin.id
    item.reviewed_at = datetime.now(timezone.utc)
    reason = (payload.reason or "").strip() if payload else ""
    item.rejection_reason = reason or None
    session.commit()
    session.refresh(item)
    return _request_row(session, item)
