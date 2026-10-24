"""Local users, revocable login sessions, and per-asset assignments."""
from datetime import datetime, timezone
from sqlalchemy import Boolean, CheckConstraint, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base
from app.db.session import UTCDateTime

#Stores user accounts 
class User(Base):
    __tablename__ = "auth_users"
    __table_args__ = (
        CheckConstraint("role IN ('Administrator', 'Supervisor', 'Operator')",name="ck_auth_users_role",),)

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(120), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="Supervisor", index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=lambda: datetime.now(timezone.utc))
    sessions: Mapped[list["AuthSession"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    asset_assignments: Mapped[list["UserAssetAssignment"]] = relationship(back_populates="user", cascade="all, delete-orphan")

#Manages login sessions
class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("auth_users.id", ondelete="CASCADE"), index=True, nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column( UTCDateTime(), nullable=False, default=lambda: datetime.now(timezone.utc))
    user: Mapped[User] = relationship(back_populates="sessions")

#Controls machine-level access 
class UserAssetAssignment(Base):
    __tablename__ = "auth_user_asset_assignments"
    __table_args__ = ( UniqueConstraint("user_id", "asset_id", name="uq_auth_user_asset"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("auth_users.id", ondelete="CASCADE"), index=True, nullable=False)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="CASCADE"), index=True, nullable=False)
    user: Mapped[User] = relationship(back_populates="asset_assignments")
