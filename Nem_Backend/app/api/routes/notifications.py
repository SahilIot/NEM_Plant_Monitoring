# Administrator-managed asset supervisor assignments and notification status
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.routes.auth import require_roles
from app.db.session import get_db
from app.models import Asset, AssetSupervisor, EmailNotification, User
from app.services.email_notifications import (
    supervisor_assignments_for_asset,
)

router = APIRouter(tags=["notifications"], dependencies=[Depends(require_roles("Administrator"))])
Db = Annotated[Session, Depends(get_db)]

#Accepts list of supervisor used IDs,with a maximum of 50 entries
class SupervisorAssignment(BaseModel):
    user_ids: list[int] = Field(default_factory=list, max_length=50)

#Retrives the users currently assigned to an asset.
# An assignment grants a Supervisor or Operator access to the asset and its child
# assets; Supervisor assignments also select the email recipients (see
# services/email_notifications.py). Operators never receive alert emails.
def _assignment(session: Session, asset_id: int) -> dict:
    users = session.scalars(
        select(User).join(AssetSupervisor, AssetSupervisor.user_id == User.id)
        .where(AssetSupervisor.asset_id == asset_id).order_by(User.username)
    ).all()
    return {
        "asset_id": asset_id,
        "supervisors": [
            {"id": u.id, "username": u.username, "email_address": u.email_address}
            for u in users if u.role == "Supervisor"
        ],
        "operators": [
            {"id": u.id, "username": u.username, "email_address": u.email_address}
            for u in users if u.role == "Operator"
        ],
    }

# Returns an asset`s supervisor assignments.
@router.get("/assets/{asset_id}/supervisors")
def get_asset_supervisors(asset_id: int, session: Db) -> dict:
    asset = session.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    assignments = _assignment(session, asset_id)
    # Only top-level assets can be assigned; child assets inherit from their parent.
    assignments["assignable"] = asset.parent_asset_id is None
    inherited: dict[int, dict] = {}
    for source_asset_id, source_asset_name, user in supervisor_assignments_for_asset(session, asset):
        if source_asset_id == asset.id:
            continue
        supervisor = inherited.setdefault(user.id, {
            "id": user.id,
            "username": user.username,
            "email_address": user.email_address,
            "inherited_from": [],
        })
        supervisor["inherited_from"].append({
            "asset_id": source_asset_id,
            "asset_name": source_asset_name,
        })
    assignments["inherited_supervisors"] = list(inherited.values())
    return assignments

# Replaces an asset`s supervisor assignments after validating the selected users.
@router.put("/assets/{asset_id}/supervisors")
def set_asset_supervisors(asset_id: int, payload: SupervisorAssignment, session: Db) -> dict:
    asset = session.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    user_ids = sorted(set(payload.user_ids))
    if user_ids and asset.parent_asset_id is not None:
        # Clearing is still allowed so stale rows on a child can be removed.
        raise HTTPException(
            status_code=422,
            detail="Users can only be assigned to a top-level (parent) asset; child assets inherit access from their parent.",
        )
    if user_ids:
        valid = set(session.scalars(
            select(User.id).where(
                User.id.in_(user_ids),
                User.role.in_(("Supervisor", "Operator")),
                User.is_active.is_(True),
            )
        ).all())
        invalid = [i for i in user_ids if i not in valid]
        if invalid:
            raise HTTPException(status_code=422, detail=f"Not active Supervisor or Operator accounts: {invalid}")
    session.execute(delete(AssetSupervisor).where(AssetSupervisor.asset_id == asset_id))
    session.add_all(AssetSupervisor(asset_id=asset_id, user_id=i) for i in user_ids)
    session.commit()
    return _assignment(session, asset_id)

#Counts notifications by status and returns up to five recent errors
@router.get("/notifications/email/summary")
def email_notification_summary(session: Db) -> dict:
    rows = session.execute(
        select(EmailNotification.status, func.count()).group_by(EmailNotification.status)
    ).all()
    recent_errors = session.scalars(
        select(EmailNotification.last_error)
        .where(EmailNotification.last_error.is_not(None))
        .order_by(EmailNotification.id.desc()).limit(5)
    ).all()
    return {"counts": {status: count for status, count in rows}, "recent_errors": recent_errors}