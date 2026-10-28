"""Administrator-managed asset supervisor assignments and notification status."""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.routes.auth import require_roles
from app.db.session import get_db
from app.models import Asset, AssetSupervisor, EmailNotification, User

router = APIRouter(tags=["notifications"], dependencies=[Depends(require_roles("Administrator"))])
Db = Annotated[Session, Depends(get_db)]


class SupervisorAssignment(BaseModel):
    user_ids: list[int] = Field(default_factory=list, max_length=50)


def _assignment(session: Session, asset_id: int) -> dict:
    users = session.scalars(
        select(User).join(AssetSupervisor, AssetSupervisor.user_id == User.id)
        .where(AssetSupervisor.asset_id == asset_id).order_by(User.username)
    ).all()
    return {
        "asset_id": asset_id,
        "supervisors": [
            {"id": u.id, "username": u.username, "email_address": u.email_address} for u in users
        ],
    }


@router.get("/assets/{asset_id}/supervisors")
def get_asset_supervisors(asset_id: int, session: Db) -> dict:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    return _assignment(session, asset_id)


@router.put("/assets/{asset_id}/supervisors")
def set_asset_supervisors(asset_id: int, payload: SupervisorAssignment, session: Db) -> dict:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    user_ids = sorted(set(payload.user_ids))
    if user_ids:
        valid = set(session.scalars(
            select(User.id).where(User.id.in_(user_ids), User.role == "Supervisor", User.is_active.is_(True))
        ).all())
        invalid = [i for i in user_ids if i not in valid]
        if invalid:
            raise HTTPException(status_code=422, detail=f"Not active Supervisor accounts: {invalid}")
    session.execute(delete(AssetSupervisor).where(AssetSupervisor.asset_id == asset_id))
    session.add_all(AssetSupervisor(asset_id=asset_id, user_id=i) for i in user_ids)
    session.commit()
    return _assignment(session, asset_id)


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
