# Administrator-controlled visibility of shared (reusable) monitoring rules, plus their change history

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Column, ForeignKey, String, Table
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.session import UTCDateTime

VISIBILITY_TYPES = ("admin_only", "specific_supervisors")

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

class RuleVisibilityChange(Base):
    # Append-only record of every visibility change of a shared rule.

    __tablename__ = "nem_rule_visibility_changes"

    id: Mapped[int] = mapped_column(primary_key=True)
    template_id: Mapped[int] = mapped_column(ForeignKey("nem_monitoring_rule_templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    changed_by_id: Mapped[int | None] = mapped_column(ForeignKey("auth_users.id", ondelete="SET NULL"), index=True)
    # "admin" for every new change; "request" can remain on rows written before the request feature was removed.
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    previous_visibility: Mapped[str] = mapped_column(String(30), nullable=False)
    new_visibility: Mapped[str] = mapped_column(String(30), nullable=False)
    previous_user_ids: Mapped[list[int]] = mapped_column(JSON, nullable=False, default=list)
    new_user_ids: Mapped[list[int]] = mapped_column(JSON, nullable=False, default=list)
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=_utcnow, nullable=False )
    changed_by: Mapped["User | None"] = relationship( "User", foreign_keys=[changed_by_id], lazy="selectin") # type: ignore


class RuleTemplateChange(Base):
    # Field-level history of edits to a shared rule (previous value, new value, who, when).

    __tablename__ = "nem_rule_template_changes"

    id: Mapped[int] = mapped_column(primary_key=True)
    template_id: Mapped[int] = mapped_column(
        ForeignKey("nem_monitoring_rule_templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    changed_by_id: Mapped[int | None] = mapped_column(ForeignKey("auth_users.id", ondelete="SET NULL"), index=True)
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=_utcnow, nullable=False)
    field: Mapped[str] = mapped_column(String(60), nullable=False)
    previous_value: Mapped[Any | None] = mapped_column(JSON)
    new_value: Mapped[Any | None] = mapped_column(JSON)
    changed_by: Mapped["User | None"] = relationship( "User", foreign_keys=[changed_by_id], lazy="selectin") # type: ignore
