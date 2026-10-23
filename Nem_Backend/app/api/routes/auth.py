"""Local login, session management, and administrator account controls."""
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Asset, AuthSession, User, UserAssetAssignment
from app.services.auth_security import (
    hash_password,
    hash_session_token,
    new_session_token,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["authentication"])
SESSION_HOURS = 8
ROLES = ("Admin", "Operator", "Viewer")
_DUMMY_PASSWORD_HASH = ("pbkdf2_sha256$600000$00000000000000000000000000000000$"
    "0000000000000000000000000000000000000000000000000000000000000000"
)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=1024)


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_at: datetime
    user: dict


class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=12, max_length=1024)
    role: Literal["Admin", "Operator", "Viewer"] = "Viewer"
    asset_ids: list[int] = Field(default_factory=list, max_length=1000)

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        value = value.strip().casefold()
        if not value:
            raise ValueError("Username cannot be empty")
        return value

    @field_validator("asset_ids")
    @classmethod
    def unique_asset_ids(cls, value: list[int]) -> list[int]:
        if len(value) != len(set(value)):
            raise ValueError("Asset assignments must be unique")
        return value


class UserUpdate(BaseModel):
    role: Literal["Admin", "Operator", "Viewer"] | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=12, max_length=1024)


class AssetAssignments(BaseModel):
    asset_ids: list[int] = Field(max_length=1000)

    @field_validator("asset_ids")
    @classmethod
    def unique_asset_ids(cls, value: list[int]) -> list[int]:
        if len(value) != len(set(value)):
            raise ValueError("Asset assignments must be unique")
        return value


Db = Annotated[Session, Depends(get_db)]


def _user_read(user: User, asset_ids: list[int] | None = None) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "is_active": user.is_active,
        "asset_ids": asset_ids if asset_ids is not None else [],
    }


async def get_current_user(request: Request, db: Db) -> User:
    user_id = getattr(request.state, "auth_user_id", None)
    if user_id is None:
        raise HTTPException(
            status_code=401,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Session is invalid or expired")
    return user


def require_roles(*roles: str):
    async def check_role(user: Annotated[User, Depends(get_current_user)]) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user

    return check_role


def _assignment_ids(db: Session, user_id: int) -> list[int]:
    return list(
        db.scalars(
            select(UserAssetAssignment.asset_id)
            .where(UserAssetAssignment.user_id == user_id)
            .order_by(UserAssetAssignment.asset_id)
        ).all()
    )


def _validate_assets(db: Session, asset_ids: list[int]) -> None:
    if not asset_ids:
        return
    existing = set(db.scalars(select(Asset.id).where(Asset.id.in_(asset_ids))).all())
    missing = sorted(set(asset_ids) - existing)
    if missing:
        raise HTTPException(status_code=422, detail=f"Unknown asset assignment(s): {missing}")

@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, db: Db) -> LoginResponse:
    username = payload.username.strip().casefold()
    user = db.scalar(select(User).where(User.username == username))
    password_hash = user.password_hash if user is not None else _DUMMY_PASSWORD_HASH
    password_is_valid = verify_password(payload.password, password_hash)
    if (
        user is None
        or not user.is_active
        or not password_is_valid
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,detail="Invalid username or password",headers={"WWW-Authenticate": "Bearer"},)

    token = new_session_token()
    expires = datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=hash_session_token(token),
            expires_at=expires,
        )
    )
    db.commit()
    return LoginResponse(
        access_token=token,
        expires_at=expires,
        user=_user_read(user, _assignment_ids(db, user.id)),
    )


@router.get("/me")
async def me(user: Annotated[User, Depends(get_current_user)], db: Db) -> dict:
    return _user_read(user, _assignment_ids(db, user.id))


@router.post("/logout", status_code=204)
def logout(request: Request, db: Db) -> None:
    token = getattr(request.state, "auth_token_hash", None)
    if token:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == token))
        db.commit()


@router.get("/users", dependencies=[Depends(require_roles("Admin"))])
def list_users(db: Db) -> list[dict]:
    users = db.scalars(select(User).order_by(User.username)).all()
    return [_user_read(user, _assignment_ids(db, user.id)) for user in users]


@router.post("/users", status_code=201, dependencies=[Depends(require_roles("Admin"))])
def create_user(payload: UserCreate, db: Db) -> dict:
    _validate_assets(db, payload.asset_ids)
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role=payload.role,
        is_active=True,
    )
    db.add(user)
    try:
        db.flush()
        db.add_all(
            UserAssetAssignment(user_id=user.id, asset_id=asset_id)
            for asset_id in payload.asset_ids
        )
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="Username already exists") from error
    db.refresh(user)
    return _user_read(user, payload.asset_ids)


@router.patch(
    "/users/{user_id}", dependencies=[Depends(require_roles("Admin"))]
)
def update_user(user_id: int, payload: UserUpdate, db: Db) -> dict:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User was not found")
    values = payload.model_dump(exclude_unset=True)
    if not values:
        return _user_read(user, _assignment_ids(db, user.id))
    if any(value is None for value in values.values()):
        raise HTTPException(status_code=422, detail="User update values cannot be null")
    removing_admin = user.role == "Admin" and (
        values.get("role", user.role) != "Admin"
        or values.get("is_active", user.is_active) is False
    )
    if removing_admin:
        active_admin_count = db.scalar(
            select(User.id).where(
                User.role == "Admin", User.is_active.is_(True), User.id != user.id
            ).limit(1)
        )
        if active_admin_count is None:
            raise HTTPException(
                status_code=409, detail="The last active administrator cannot be removed"
            )
    role_or_password_changed = "role" in values or "password" in values
    if "password" in values:
        values["password_hash"] = hash_password(values.pop("password"))
    for field, value in values.items():
        setattr(user, field, value)
    if role_or_password_changed or user.is_active is False:
        db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    db.commit()
    db.refresh(user)
    return _user_read(user, _assignment_ids(db, user.id))


@router.put(
    "/users/{user_id}/assets",
    dependencies=[Depends(require_roles("Admin"))],
)
def replace_user_assets(user_id: int, payload: AssetAssignments, db: Db) -> dict:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User was not found")
    _validate_assets(db, payload.asset_ids)
    db.execute(
        delete(UserAssetAssignment).where(UserAssetAssignment.user_id == user.id)
    )
    db.add_all(
        UserAssetAssignment(user_id=user.id, asset_id=asset_id)
        for asset_id in payload.asset_ids
    )
    db.commit()
    return _user_read(user, _assignment_ids(db, user.id))
