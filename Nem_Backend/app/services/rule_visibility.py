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
    RuleTemplateChange,
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
        source=source,
        previous_visibility=previous_type,
        new_visibility=visibility_type,
        previous_user_ids=previous_ids,
        new_user_ids=new_ids,
    )
    session.add(change)
    return change


def values_differ(old, new) -> bool:
    """True when two stored/submitted values really differ (Decimal-safe, None-aware)."""
    from decimal import Decimal

    if old is None or new is None:
        return (old is None) != (new is None)
    if isinstance(old, Decimal) or isinstance(new, Decimal):
        return Decimal(str(old)) != Decimal(str(new))
    return old != new


def require_session_roles(session: Session, *roles: str) -> User | None:
    """Route-level role gate (defence in depth behind the middleware).

    Background/system sessions pass. Returns the authenticated user otherwise.
    """
    if _is_system_session(session):
        return None
    user = request_user(session)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if user.role not in roles:
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    return user


# Edit permission is separate from visibility. A Supervisor who can see a shared rule may
# change only its numeric thresholds (the same fields the Rule Library editor offers them).
SUPERVISOR_EDITABLE_FIELDS = frozenset({"threshold", "evaluation_interval_seconds", "parameters"})
SUPERVISOR_EDITABLE_PARAMETERS = frozenset({
    "warning_thresholds", "alert_threshold",
    "warning_thresholds_seconds", "alert_threshold_seconds",
})


def enforce_template_edit_permission(
    session: Session,
    template: MonitoringRuleTemplate,
    new_values: dict,
    new_labels: list[str] | None,
) -> None:
    """Raise 403 unless the caller may apply ``new_values`` to ``template``.

    Call after the visibility check. Administrators may change anything.
    """
    if _is_system_session(session):
        return
    user = request_user(session)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if user.role == "Administrator":
        return
    if user.role != "Supervisor":
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    denied = HTTPException(
        status_code=403,
        detail="Supervisors may only change the numeric thresholds of a shared rule",
    )
    for field, new in new_values.items():
        if field in SUPERVISOR_EDITABLE_FIELDS - {"parameters"}:
            continue
        old = getattr(template, field, None)
        if field == "parameters":
            old_params = {k: v for k, v in (old or {}).items() if k not in SUPERVISOR_EDITABLE_PARAMETERS}
            new_params = {k: v for k, v in (new or {}).items() if k not in SUPERVISOR_EDITABLE_PARAMETERS}
            if old_params != new_params:
                raise denied
        elif values_differ(old, new):
            raise denied
    if new_labels is not None and sorted(template.labels) != sorted(new_labels):
        raise denied


_TRACKED_FIELDS = (
    "name", "description", "rule_type", "required_variable_types", "variable_key",
    "operator", "threshold", "parameters", "severity", "is_enabled",
    "evaluation_interval_seconds", "stale_after_seconds", "collection_id",
)


def _json_safe(value):
    from decimal import Decimal

    if isinstance(value, Decimal):
        return format(value.normalize(), "f")
    return value


def record_template_changes(
    session: Session,
    template: MonitoringRuleTemplate,
    new_values: dict,
    new_labels: list[str] | None = None,
) -> list[RuleTemplateChange]:
    """Log each changed field of a shared rule (call before applying the new values).

    The editor comes from the authenticated session, never from the request body.
    """
    editor = request_user(session)
    rows: list[RuleTemplateChange] = []

    for field in _TRACKED_FIELDS:
        if field not in new_values:
            continue
        old, new = getattr(template, field), new_values[field]
        if values_differ(old, new):
            rows.append(RuleTemplateChange(
                template_id=template.id,
                changed_by_id=editor.id if editor else None,
                field=field,
                previous_value=_json_safe(old),
                new_value=_json_safe(new),
            ))
    if new_labels is not None and sorted(template.labels) != sorted(new_labels):
        rows.append(RuleTemplateChange(
            template_id=template.id,
            changed_by_id=editor.id if editor else None,
            field="labels",
            previous_value=sorted(template.labels),
            new_value=sorted(new_labels),
        ))
    session.add_all(rows)
    return rows
