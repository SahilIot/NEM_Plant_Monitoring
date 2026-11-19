
from __future__ import annotations
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterable

from fastapi import HTTPException
from sqlalchemy import and_, false, or_, select, true
from sqlalchemy.orm import Session

from app.models import Asset, AssetSupervisor, InstructionDocument, MaintenanceSchedule, MonitoringRule, User, Variable
from app.core.constants import ROLE_ADMINISTRATOR, ROLE_OPERATOR, ROLE_SUPERVISOR

SCOPED_ROLES = frozenset({ROLE_SUPERVISOR, ROLE_OPERATOR})
REQUEST_SESSION_KEY = "access_scope_required"
_CACHE_KEY = "_access_scope"

# The central permission object.
@dataclass(frozen=True)
class AccessScope:
    unrestricted: bool
    asset_ids: frozenset[int] = frozenset()
# Checks whether the user can access a particular asset.
    def allows(self, asset_id: int | None) -> bool:
        if self.unrestricted:
            return True
        return asset_id is not None and asset_id in self.asset_ids
# This generates SQL condition for filtering db queries.
    def clause(self, column):
        # SQL condition limiting column (an asset id column) to the scope
        if self.unrestricted:
            return true()
        if not self.asset_ids:
            return false()
        return column.in_(sorted(self.asset_ids))
# Takes a collection of asset ids and removes everything outside the user`s permission scope.
    def restrict(self, asset_ids: Iterable[int]) -> set[int]:
        if self.unrestricted:
            return set(asset_ids)
        return {item for item in asset_ids if item in self.asset_ids}


UNRESTRICTED = AccessScope(unrestricted=True)
NO_ACCESS = AccessScope(unrestricted=False)


def _descendants_of(session: Session, roots: set[int]) -> frozenset[int]:
    if not roots:
        return frozenset()
    visible: set[int] = set(session.scalars(select(Asset.id).where(Asset.id.in_(sorted(roots)))).all())
    frontier = set(visible)
    while frontier:
        children = set(session.scalars(
                select(Asset.id).where(Asset.parent_asset_id.in_(sorted(frontier)))
            ).all()
        )
        frontier = children - visible
        visible |= frontier
    return frozenset(visible)

# Calculating the user permissions.-> access scope from the db.
def scope_for_user(session: Session, user: User | None) -> AccessScope:
    # Compute the scope of user from the database.
    if user is None or not user.is_active:
        return NO_ACCESS
    if user.role == ROLE_ADMINISTRATOR:
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

# Request-level scope and caching.This func determines whether the current sqlalchemy session belongs to: An authenticated API request or a background system.
def access_scope(session: Session) -> AccessScope:
    # Scope of the user that owns session (cached for the request).
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

# Controlled internal access -> purpose to allow a specific internal operation to bypass the caller`s asset restrictions.`
@contextmanager
def internal_propagation_scope(session: Session):

    previous = session.info.get(_CACHE_KEY)
    session.info[_CACHE_KEY] = UNRESTRICTED
    try:
        yield
    finally:
        if previous is None:
            session.info.pop(_CACHE_KEY, None)
        else:
            session.info[_CACHE_KEY] = previous

# Protecting individual assets -> check whether the current user can access an asset
def require_asset_access(
    session: Session,
    asset_id: int | None,
    detail: str | None = None,
) -> None:
    # Raise 404 unless the request user may reach asset_id.
    if not access_scope(session).allows(asset_id):
        raise HTTPException(status_code=404,detail=detail or f"Asset {asset_id} was not found",)

# These functions extend asset access restrictions to monitoring rules.
def rule_asset_id(session: Session, rule) -> int | None:
    # Asset that owns a monitoring rule (target asset, else variable asset).
    if rule.target_asset_id is not None:
        return rule.target_asset_id
    if rule.variable_id is not None:
        variable = session.get(Variable, rule.variable_id)
        return variable.asset_id if variable is not None else None
    return None

# Builds a SQL filter to retrieve only rule associated with permitted assets.
def rule_clause(scope: AccessScope):
    # SQL condition matching rules owned by an asset inside scope.
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

# Check an individual rule`s asset ownership.
def require_rule_access(session: Session, rule, detail: str | None = None) -> None:
    if not access_scope(session).allows(rule_asset_id(session, rule)):
        raise HTTPException(status_code=404, detail=detail or f"Rule {rule.id} was not found")

# This function applies asset scope to INstruction & Document.
def hidden_document_ids(session: Session) -> set[int]:

    scope = access_scope(session)
    if scope.unrestricted:
        return set()
    attached: set[int] = set()
    visible: set[int] = set()
    for asset_id, document_ids in session.execute(select(MaintenanceSchedule.asset_id, MaintenanceSchedule.instruction_document_ids)):
        for document_id in document_ids or []:
            if isinstance(document_id, bool) or not isinstance(document_id, int):
                continue
            attached.add(document_id)
            if scope.allows(asset_id):
                visible.add(document_id)
    linked_out_of_scope = {
        document_id
        for document_id, asset_id in session.execute(
            select(InstructionDocument.id, InstructionDocument.asset_id).where(InstructionDocument.asset_id.is_not(None))
        )
        if document_id not in visible and not scope.allows(asset_id)
    }
    return (attached - visible) | linked_out_of_scope
