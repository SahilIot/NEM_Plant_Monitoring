# Administrator-controlled visibility of shared rules, plus their history and assignments.
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Asset, MonitoringRule, MonitoringRuleTemplate, User
from app.models.rule_visibility import RuleTemplateChange, RuleVisibilityChange
from app.schemas.rule import RuleVisibilityUpdate
from app.services.access_scope import access_scope
from app.services.rule_visibility import (
    apply_visibility,
    get_visible_template,
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


@router.get("/rule-templates/{template_id}/history")
def get_template_history(
    template_id: int = Path(gt=0),
    session: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    """Timeline for a shared rule. Everyone who may see the rule gets its configuration
    changes; visibility changes are Administrator-only."""
    template = get_visible_template(session, template_id)
    user = request_user(session)
    entries: list[dict[str, Any]] = []
    for change in session.scalars(
        select(RuleTemplateChange)
        .where(RuleTemplateChange.template_id == template.id)
        .order_by(RuleTemplateChange.changed_at.desc(), RuleTemplateChange.id.desc())
        .limit(200)
    ).all():
        entries.append({
            "type": "configuration",
            "at": _iso(change.changed_at),
            "by": change.changed_by.username if change.changed_by else None,
            "field": change.field,
            "previous": change.previous_value,
            "new": change.new_value,
        })
    if user is not None and user.role == "Administrator":
        for change in session.scalars(
            select(RuleVisibilityChange)
            .where(RuleVisibilityChange.template_id == template.id)
            .order_by(RuleVisibilityChange.changed_at.desc())
            .limit(100)
        ).all():
            entries.append({
                "type": "visibility",
                "at": _iso(change.changed_at),
                "by": change.changed_by.username if change.changed_by else None,
                "field": "visibility",
                "previous": change.previous_visibility,
                "new": change.new_visibility,
                "source": change.source,
            })
    entries.sort(key=lambda entry: entry["at"] or "", reverse=True)
    return entries[:200]


@router.get("/rule-templates/{template_id}/assignments")
def get_template_assignments(
    template_id: int = Path(gt=0),
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    """Assets using this shared rule, limited to the caller's asset scope."""
    template = get_visible_template(session, template_id)
    user = request_user(session)
    scope = access_scope(session)
    rows = session.execute(
        select(MonitoringRule, Asset.name)
        .join(Asset, Asset.id == MonitoringRule.target_asset_id)
        .where(MonitoringRule.source_template_id == template.id)
        .where(scope.clause(MonitoringRule.target_asset_id))
        .order_by(Asset.name, MonitoringRule.id)
    ).all()
    total = None
    if user is not None and user.role == "Administrator":
        total = len(rows)
    return {
        "total": total,
        "assets": [
            {
                "asset_id": rule.target_asset_id,
                "asset_name": asset_name,
                "rule_id": rule.id,
                "state": "activated" if rule.is_enabled else rule.lifecycle_status,
            }
            for rule, asset_name in rows
        ],
    }
