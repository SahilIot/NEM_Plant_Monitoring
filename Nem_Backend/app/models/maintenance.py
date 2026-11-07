from datetime import date, datetime, timezone
from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Float,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base
from app.db.session import UTCDateTime
from app.models.audit_mixin import AuditNamesMixin

#represents the recurring maintenance plan
class MaintenanceSchedule(AuditNamesMixin, Base):
    __tablename__ = "nem_maintenance_schedules"

    __table_args__ = (
        # Ensures recurrence unit contains only valid values.
        CheckConstraint(
            "recurrence_unit IS NULL OR recurrence_unit IN ('days', 'weeks', 'months', 'years')",
            name="ck_maintenance_schedule_recurrence_unit",
        ),

        # Ensures recurrence interval is positive when provided.
        CheckConstraint(
            "recurrence_interval IS NULL OR recurrence_interval > 0",
            name="ck_maintenance_schedule_recurrence_interval",
        ),

        # Restricts maintenance schedules to supported scheduling modes.
        CheckConstraint(
            "schedule_mode IN ('calendar', 'runtime', 'usage')",
            name="ck_maintenance_schedule_mode",
        ),

        # Ensures runtime maintenance interval is positive.
        CheckConstraint(
            "runtime_interval_hours IS NULL OR runtime_interval_hours > 0",
            name="ck_maintenance_schedule_runtime_interval",
        ),

        # Ensures usage-based maintenance interval is positive.
        CheckConstraint(
            "usage_interval_count IS NULL OR usage_interval_count > 0",
            name="ck_maintenance_schedule_usage_interval",
        ),

        # Prevents negative maintenance progress values.
        CheckConstraint(
            "current_progress >= 0",
            name="ck_maintenance_schedule_progress",
        ),

        Index(
            "ix_maintenance_schedule_asset_status_due",
            "asset_id",
            "status",
            "current_due_date",
        ),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    maintenance_type: Mapped[str] = mapped_column(String(30), nullable=False)
    priority: Mapped[str] = mapped_column(String(20), nullable=False)
    assigned_technician: Mapped[str | None] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    instruction_document_ids: Mapped[list[int]] = mapped_column(JSON, nullable=False, default=list, server_default=text("'[]'"))
    # Scheduling mode and signal configuration
    schedule_mode: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="calendar",
        server_default=text("'calendar'"),
    )
    signal_variable_id: Mapped[int | None] = mapped_column(
        ForeignKey("variables.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    runtime_interval_hours: Mapped[float | None] = mapped_column(Float)
    usage_interval_count: Mapped[int | None] = mapped_column(Integer)

    # Independent maintenance progress tracking
    current_progress: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        default=0.0,
        server_default=text("0"),
    )
    last_signal_value: Mapped[bool | None] = mapped_column(Boolean)
    last_signal_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    schedule_start_date: Mapped[date] = mapped_column(Date, nullable=False)
    current_period_start_date: Mapped[date] = mapped_column(Date, nullable=False)
    first_due_date: Mapped[date] = mapped_column(Date, nullable=False)
    current_due_date: Mapped[date | None] = mapped_column(Date)
    proposed_due_date: Mapped[date | None] = mapped_column(Date)
    current_occurrence_id: Mapped[int | None] = mapped_column(Integer)
    recurrence_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("FALSE"))
    recurrence_interval: Mapped[int | None] = mapped_column(Integer)
    recurrence_unit: Mapped[str | None] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active", server_default=text("'active'"))
    approval_status: Mapped[str] = mapped_column(String(20), nullable=False, default="not_required", server_default=text("'not_required'"))
    last_completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    due_alerted_for: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("auth_users.id", ondelete="SET NULL"), index=True)
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("auth_users.id", ondelete="SET NULL"), index=True)
    created_by_user: Mapped["User | None"] = relationship("User", foreign_keys=[created_by_id], lazy="selectin") # type: ignore
    updated_by_user: Mapped["User | None"] = relationship("User", foreign_keys=[updated_by_id], lazy="selectin") # type: ignore

#stores the maintenance work performed on machines 
class MaintenanceRecord(AuditNamesMixin, Base):
    __tablename__ = "nem_maintenance_records"
    __table_args__ = (
        Index("ix_nem_maintenance_records_asset_performed", "asset_id", "performed_at"),
        UniqueConstraint(
            "schedule_id",
            "planned_due_date",
            name="uq_maintenance_occurrence_schedule_due",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"), nullable=False, index=True)
    alert_id: Mapped[int | None] = mapped_column(ForeignKey("nem_alerts.id", ondelete="RESTRICT"), index=True)
    summary: Mapped[str] = mapped_column(String(200), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    performed_by: Mapped[str] = mapped_column(String(200), nullable=False)
    performed_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False)
    next_due_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    maintenance_type: Mapped[str] = mapped_column(String(30), nullable=False, default="inspection", server_default=text("'inspection'"))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="completed", server_default=text("'completed'"))
    planned_start_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    planned_end_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    actual_started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    actual_completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    priority: Mapped[str] = mapped_column(String(20), nullable=False, default="medium", server_default=text("'medium'"))
    assigned_technician: Mapped[str | None] = mapped_column(String(200))
    completion_notes: Mapped[str | None] = mapped_column(Text)
    parts_used: Mapped[str | None] = mapped_column(Text)
    checklist: Mapped[list[dict[str, object]] | None] = mapped_column(JSON)
    schedule_id: Mapped[int | None] = mapped_column(ForeignKey("nem_maintenance_schedules.id", ondelete="RESTRICT"), index=True)
    planned_due_date: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False)
    # Nullable and without onupdate: legacy rows stay NULL; the audit listener stamps it.
    updated_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("auth_users.id", ondelete="SET NULL"), index=True)
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("auth_users.id", ondelete="SET NULL"), index=True)
    created_by_user: Mapped["User | None"] = relationship("User", foreign_keys=[created_by_id], lazy="selectin") # type: ignore
    updated_by_user: Mapped["User | None"] = relationship("User", foreign_keys=[updated_by_id], lazy="selectin") # type: ignore

    @property
    def title(self) -> str:
        return self.summary
