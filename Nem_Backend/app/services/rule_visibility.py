"""Central authorization for shared (reusable) monitoring rule visibility.

* Administrators see and manage every shared rule.
* Supervisors see a shared rule when it is ``all_supervisors`` or when it is
  ``specific_supervisors`` and they are on its list. ``admin_only`` hides it.
* Operators have no access to the global shared-rule section.
* Background/system sessions (no request) are not restricted.

Visibility only governs the shared rule definition and its global edit. It never
grants access to assets: asset-level access stays with ``access_scope``. A rule the
user may not see answers 404, identical to a missing rule.
"""
from __future__ import annotations

from sqlalchemy import and_, false, or_, select, true
from sqlalchemy.orm import Session

from fastapi import HTTPException

from app.models import MonitoringRuleTemplate, User
from app.models.rule_visibility import (
    VISIBILITY_TYPES,
    RuleVisibilityChange,
    rule_template_visibility_supervisors,
)
from app.services.access_scope import REQUEST_SESSION_KEY


def request_user(session: Session) -> User | None:
    user_id = session.info.get("auth_user_id")
    user = session.get(User, user_id) if user_id is not None else None
    return user if user is not None and user.is_active else None


def _is_system_session(session: Session) -> bool:
    return not session.info.get(REQUEST_SESSION_KEY)


def visible_templates_clause(session: Session, user: User | None):
    """SQL condition selecting the shared rules ``user`` may see and manage."""
    if _is_system_session(session):
        return true()
    if user is None or not user.is_active:
        return false()
    if user.role == "Administrator":
        return true()
    if user.role != "Supervisor":
        return false()
    listed = (
        select(rule_template_visibility_supervisors.c.template_id)
        .where(rule_template_visibility_supervisors.c.user_id == user.id)
        .scalar_subquery()
    )
    return or_(
        MonitoringRuleTemplate.visibility_type == "all_supervisors",
        and_(
            MonitoringRuleTemplate.visibility_type == "specific_supervisors",
            MonitoringRuleTemplate.id.in_(listed),
        ),
    )


def can_view_template(session: Session, user: User | None, template: MonitoringRuleTemplate) -> bool:
    if _is_system_session(session):
        return True
    if user is None or not user.is_active:
        return False
    if user.role == "Administrator":
        return True
    if user.role != "Supervisor":
        return False
    if template.visibility_type == "all_supervisors":
        return True
    return template.visibility_type == "specific_supervisors" and any(
        listed.id == user.id for listed in template.visibility_supervisors
    )


def get_visible_template(session: Session, template_id: int) -> MonitoringRuleTemplate:
    """Return the shared rule or raise 404 when missing or not visible to the caller."""
    template = session.get(MonitoringRuleTemplate, template_id)
    if template is None or not can_view_template(session, request_user(session), template):
        raise HTTPException(status_code=404, detail="Rule template was not found")
    return template


def active_supervisors(session: Session, user_ids) -> list[User]:
    """Validate that every id is an existing, active Supervisor."""
    ids = sorted({int(item) for item in user_ids})
    if not ids:
        return []
    users = session.scalars(select(User).where(User.id.in_(ids))).all()
    found = {user.id for user in users}
    missing = [item for item in ids if item not in found]
    invalid = [user for user in users if user.role != "Supervisor" or not user.is_active]
    if missing or invalid:
        raise HTTPException(
            status_code=422,
            detail="Visibility can only be granted to active Supervisors",
        )
    return users


def apply_visibility(
    session: Session,
    template: MonitoringRuleTemplate,
    visibility_type: str,
    supervisor_ids,
    *,
    actor: User,
    source: str,
    request_id: int | None = None,
) -> RuleVisibilityChange | None:
    """Set a shared rule's visibility and record previous/new values.

    Does not commit. Returns None when nothing changed. The creator columns are
    never touched, and ``updated_by_id`` is stamped by the audit listener.
    """
    if visibility_type not in VISIBILITY_TYPES:
        raise HTTPException(status_code=422, detail="Invalid visibility type")
    users = active_supervisors(session, supervisor_ids) if visibility_type == "specific_supervisors" else []
    if visibility_type == "specific_supervisors" and not users:
        raise HTTPException(
            status_code=422,
            detail="Select at least one Supervisor for specific-supervisor visibility",
        )
    previous_type = template.visibility_type
    previous_ids = template.visibility_supervisor_ids
    new_ids = sorted(user.id for user in users)
    if previous_type == visibility_type and previous_ids == new_ids:
        return None
    template.visibility_type = visibility_type
    template.visibility_supervisors = list(users)
    change = RuleVisibilityChange(
        template_id=template.id,
        changed_by_id=actor.id,
        request_id=request_id,
        source=source,
        previous_visibility=previous_type,
        new_visibility=visibility_type,
        previous_user_ids=previous_ids,
        new_user_ids=new_ids,
    )
    session.add(change)
    return change
