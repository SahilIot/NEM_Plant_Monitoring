"""Visibility of shared (reusable) monitoring rules and Supervisor visibility requests."""

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Column,
    ForeignKey,
    Index,
    String,
    Table,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.session import UTCDateTime

VISIBILITY_TYPES = ("admin_only", "specific_supervisors", "all_supervisors")

# Supervisors a shared rule is visible to when its visibility is "specific_supervisors".
rule_template_visibility_supervisors = Table(
    "nem_rule_template_supervisors",
    Base.metadata,
    Column(
        "template_id",
        ForeignKey("nem_monitoring_rule_templates.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "user_id",
        ForeignKey("auth_users.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    ),
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RuleVisibilityRequest(Base):
    """A Supervisor's request to widen the visibility of a shared rule (Admin approves)."""

    __tablename__ = "nem_rule_visibility_requests"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected')",
            name="ck_nem_rule_visibility_requests_status",
        ),
        CheckConstraint(
            "requested_visibility IN ('admin_only', 'specific_supervisors', 'all_supervisors')",
            name="ck_nem_rule_visibility_requests_requested",
        ),
        Index("ix_nem_rule_visibility_requests_status_created", "status", "created_at"),
        # One pending request per rule and requested configuration.
        Index(
            "uq_nem_rule_visibility_requests_pending",
            "template_id",
            "requested_visibility",
            "requested_key",
            unique=True,
            postgresql_where=text("status = 'pending'"),
            sqlite_where=text("status = 'pending'"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    template_id: Mapped[int] = mapped_column(
        ForeignKey("nem_monitoring_rule_templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Rule name at the time of the request, kept even if the rule is later renamed or removed.
    rule_name: Mapped[str] = mapped_column(String(200), nullable=False)
    requested_by: Mapped[int] = mapped_column(
        ForeignKey("auth_users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    current_visibility: Mapped[str] = mapped_column(String(30), nullable=False)
    requested_visibility: Mapped[str] = mapped_column(String(30), nullable=False)
    requested_user_ids: Mapped[list[int]] = mapped_column(
        JSON, nullable=False, default=list, server_default=text("'[]'")
    )
    # Canonical form of requested_user_ids ("3,7"), used by the pending-uniqueness index.
    requested_key: Mapped[str] = mapped_column(
        String(500), nullable=False, default="", server_default=""
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", server_default="pending", index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=_utcnow, nullable=False
    )
    reviewed_by: Mapped[int | None] = mapped_column(
        ForeignKey("auth_users.id", ondelete="RESTRICT"), index=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    rejection_reason: Mapped[str | None] = mapped_column(Text)

    requester: Mapped["User"] = relationship("User", foreign_keys=[requested_by], lazy="selectin")
    reviewer: Mapped["User | None"] = relationship("User", foreign_keys=[reviewed_by], lazy="selectin")


class RuleVisibilityChange(Base):
    """Append-only record of every visibility change of a shared rule."""

    __tablename__ = "nem_rule_visibility_changes"

    id: Mapped[int] = mapped_column(primary_key=True)
    template_id: Mapped[int] = mapped_column(
        ForeignKey("nem_monitoring_rule_templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    changed_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("auth_users.id", ondelete="SET NULL"), index=True
    )
    request_id: Mapped[int | None] = mapped_column(
        ForeignKey("nem_rule_visibility_requests.id", ondelete="SET NULL")
    )
    source: Mapped[str] = mapped_column(String(20), nullable=False)  # "admin" | "request"
    previous_visibility: Mapped[str] = mapped_column(String(30), nullable=False)
    new_visibility: Mapped[str] = mapped_column(String(30), nullable=False)
    previous_user_ids: Mapped[list[int]] = mapped_column(JSON, nullable=False, default=list)
    new_user_ids: Mapped[list[int]] = mapped_column(JSON, nullable=False, default=list)
    changed_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=_utcnow, nullable=False
    )

    changed_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[changed_by_id], lazy="selectin"
    )
