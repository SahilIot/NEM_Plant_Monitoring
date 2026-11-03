"""Asset-assignment access scope shared by the REST routes and live updates.

Rules
-----
* Administrators are unrestricted.
* Assignment is parent-only: access is granted by assigning a top-level (root)
  asset, which gives the user that asset and every descendant beneath it. A row in
  ``nem_asset_supervisors`` that points at a child asset (one that has a parent) is
  not valid, grants nothing and is ignored: there is no independent child access and
  no fallback. Access never flows upward or sideways.
* An active non-administrator with no assignments reaches nothing.
* Sessions that were not opened for an authenticated API request (background
  workers, the OPC UA collector, the email worker) are system sessions and are
  not restricted. Request sessions are marked by ``get_db``; a request session
  without a resolvable active user is denied everything (fail closed).

Callers answer "not found" (404) for an asset outside the scope so that the
response is identical to a missing asset and does not reveal that it exists.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterable

from fastapi import HTTPException
from sqlalchemy import and_, false, or_, select, true
from sqlalchemy.orm import Session

from app.models import Asset, AssetSupervisor, MaintenanceSchedule, MonitoringRule, User, Variable

SCOPED_ROLES = frozenset({"Supervisor", "Operator"})
REQUEST_SESSION_KEY = "access_scope_required"
_CACHE_KEY = "_access_scope"


@dataclass(frozen=True)
class AccessScope:
    unrestricted: bool
    asset_ids: frozenset[int] = frozenset()

    def allows(self, asset_id: int | None) -> bool:
        if self.unrestricted:
            return True
        return asset_id is not None and asset_id in self.asset_ids

    def clause(self, column):
        """SQL condition limiting ``column`` (an asset id column) to the scope."""
        if self.unrestricted:
            return true()
        if not self.asset_ids:
            return false()
        return column.in_(sorted(self.asset_ids))

    def restrict(self, asset_ids: Iterable[int]) -> set[int]:
        if self.unrestricted:
            return set(asset_ids)
        return {item for item in asset_ids if item in self.asset_ids}


UNRESTRICTED = AccessScope(unrestricted=True)
NO_ACCESS = AccessScope(unrestricted=False)


def _descendants_of(session: Session, roots: set[int]) -> frozenset[int]:
    """Return the existing ``roots`` plus all of their descendants.

    Starts from the explicitly assigned roots only and expands one level at a time
    (children of the current frontier), so the whole asset table is never scanned and
    an unassigned parent never leads to its children. Stale root ids are dropped.
    Cycle-safe.
    """
    if not roots:
        return frozenset()
    visible: set[int] = set(
        session.scalars(select(Asset.id).where(Asset.id.in_(sorted(roots)))).all()
    )
    frontier = set(visible)
    while frontier:
        children = set(
            session.scalars(
                select(Asset.id).where(Asset.parent_asset_id.in_(sorted(frontier)))
            ).all()
        )
        frontier = children - visible
        visible |= frontier
    return frozenset(visible)


def scope_for_user(session: Session, user: User | None) -> AccessScope:
    """Compute the scope of ``user`` from the database."""
    if user is None or not user.is_active:
        return NO_ACCESS
    if user.role == "Administrator":
        return UNRESTRICTED
    if user.role not in SCOPED_ROLES:
        return NO_ACCESS
    # Only assignments on top-level assets count; stale rows on child assets are ignored.
    assigned = set(
        session.scalars(
            select(AssetSupervisor.asset_id)
            .join(Asset, Asset.id == AssetSupervisor.asset_id)
            .where(AssetSupervisor.user_id == user.id, Asset.parent_asset_id.is_(None))
        ).all()
    )
    return AccessScope(unrestricted=False, asset_ids=_descendants_of(session, assigned))


def access_scope(session: Session) -> AccessScope:
    """Scope of the user that owns ``session`` (cached for the request)."""
    cached = session.info.get(_CACHE_KEY)
    if cached is not None:
        return cached
    if not session.info.get(REQUEST_SESSION_KEY):
        scope = UNRESTRICTED  # system session (background work)
    else:
        user_id = session.info.get("auth_user_id")
        user = session.get(User, user_id) if user_id is not None else None
        scope = scope_for_user(session, user)
    session.info[_CACHE_KEY] = scope
    return scope


@contextmanager
def internal_propagation_scope(session: Session):
    """Run internal propagation of a shared-rule edit without the caller's asset filter.
    Editing a shared rule updates every asset rule created from it, including assets
    the editing Supervisor cannot reach. The affected rows are selected by the rule's
    own assignments (``source_template_id``), never by the caller's scope, and
    nothing about those assets is returned to the caller. Use only around that
    internal loop; request-level asset checks stay in force everywhere else.
    """
    previous = session.info.get(_CACHE_KEY)
    session.info[_CACHE_KEY] = UNRESTRICTED
    try:
        yield
    finally:
        if previous is None:
            session.info.pop(_CACHE_KEY, None)
        else:
            session.info[_CACHE_KEY] = previous


def require_asset_access(
    session: Session,
    asset_id: int | None,
    detail: str | None = None,
) -> None:
    """Raise 404 unless the request user may reach ``asset_id``."""
    if not access_scope(session).allows(asset_id):
        raise HTTPException(
            status_code=404,
            detail=detail or f"Asset {asset_id} was not found",
        )


def require_assets_access(
    session: Session,
    asset_ids: Iterable[int],
    detail_template: str = "Asset {asset_id} was not found",
) -> None:
    scope = access_scope(session)
    for asset_id in asset_ids:
        if not scope.allows(asset_id):
            raise HTTPException(
                status_code=404, detail=detail_template.format(asset_id=asset_id)
            )


def rule_asset_id(session: Session, rule) -> int | None:
    """Asset that owns a monitoring rule (target asset, else variable asset)."""
    if rule.target_asset_id is not None:
        return rule.target_asset_id
    if rule.variable_id is not None:
        variable = session.get(Variable, rule.variable_id)
        return variable.asset_id if variable is not None else None
    return None


def rule_clause(scope: AccessScope):
    """SQL condition matching rules owned by an asset inside ``scope``."""
    if scope.unrestricted:
        return true()
    return or_(
        scope.clause(MonitoringRule.target_asset_id),
        and_(
            MonitoringRule.target_asset_id.is_(None),
            MonitoringRule.variable_id.in_(
                select(Variable.id).where(scope.clause(Variable.asset_id))
            ),
        ),
    )


def require_rule_access(session: Session, rule, detail: str | None = None) -> None:
    if not access_scope(session).allows(rule_asset_id(session, rule)):
        raise HTTPException(
            status_code=404, detail=detail or f"Rule {rule.id} was not found"
        )


def visible_parent_id(scope: AccessScope, parent_asset_id: int | None) -> int | None:
    """Parent id to expose: hidden parents are reported as no parent."""
    return parent_asset_id if scope.allows(parent_asset_id) else None


def hidden_document_ids(session: Session) -> set[int]:
    """Instruction documents a restricted caller must not see.

    Documents have no asset of their own; they are attached to maintenance
    schedules. A document attached to schedules is visible only when at least one
    of those schedules is on an asset inside the scope. Documents attached to no
    schedule form a shared library and stay visible to every signed-in user.
    """
    scope = access_scope(session)
    if scope.unrestricted:
        return set()
    attached: set[int] = set()
    visible: set[int] = set()
    for asset_id, document_ids in session.execute(
        select(MaintenanceSchedule.asset_id, MaintenanceSchedule.instruction_document_ids)
    ):
        for document_id in document_ids or []:
            if isinstance(document_id, bool) or not isinstance(document_id, int):
                continue
            attached.add(document_id)
            if scope.allows(asset_id):
                visible.add(document_id)
    return attached - visible
