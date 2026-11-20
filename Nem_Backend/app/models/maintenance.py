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
            "schedule_mode IN ('calendar', 'runtime', 'usage', 'rule')",
            name="ck_maintenance_schedule_mode",
        ),

        # Start eligibility of a schedule created from a monitoring rule: it waits at not_due until the rule
        # reaches its Due limit, then becomes ready. Other schedules have no eligibility.
        CheckConstraint(
            "eligibility IS NULL OR eligibility IN ('not_due', 'ready')",
            name="ck_maintenance_schedule_eligibility",
        ),

        # One open schedule per rule parameter: saving or evaluating a rule again can never add a second.
        Index(
            "uq_maintenance_schedule_open_rule_parameter",
            "source_parameter_id",
            unique=True,
            postgresql_where=text("source_parameter_id IS NOT NULL AND status = 'active'"),
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
    source_rule_id: Mapped[int | None] = mapped_column(ForeignKey("nem_monitoring_rules.id", ondelete="SET NULL"), index=True)
    source_parameter_id: Mapped[int | None] = mapped_column(ForeignKey("nem_rule_parameters.id", ondelete="SET NULL"), index=True)
    source_parameter_key: Mapped[str | None] = mapped_column(String(36))
    source_rule_name: Mapped[str | None] = mapped_column(String(200))
    source_parameter_name: Mapped[str | None] = mapped_column(String(200))
    source_rule_type: Mapped[str | None] = mapped_column(String(30))
    # 'not_due' until the rule reaches its Due limit, then 'ready' (Start is allowed). NULL for other schedules.
    eligibility: Mapped[str | None] = mapped_column(String(20))
    due_threshold: Mapped[float | None] = mapped_column(Float)
    overdue_threshold: Mapped[float | None] = mapped_column(Float)
    threshold_unit: Mapped[str | None] = mapped_column(String(20))
    became_due_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    due_value: Mapped[float | None] = mapped_column(Float)
    progress_reset: Mapped[str | None] = mapped_column(String(20))
    progress_reset_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    cancelled_by_id: Mapped[int | None] = mapped_column(ForeignKey("auth_users.id", ondelete="SET NULL"))
    cancelled_by_name: Mapped[str | None] = mapped_column(String(200))
    cancellation_reason: Mapped[str | None] = mapped_column(Text)
    cancellation_kind: Mapped[str | None] = mapped_column(String(30))
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
    actual_values: Mapped[list[dict[str, object]] | None] = mapped_column(JSON)
    schedule_id: Mapped[int | None] = mapped_column(ForeignKey("nem_maintenance_schedules.id", ondelete="RESTRICT"), index=True)
    planned_due_date: Mapped[date | None] = mapped_column(Date)
    start_eligibility: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Rule, parameter, Due threshold and the value at the moment it became Due, kept with the job permanently.
    rule_context: Mapped[dict | None] = mapped_column(JSON)
    started_by_id: Mapped[int | None] = mapped_column(Integer)
    started_by_name: Mapped[str | None] = mapped_column(String(200))
    completed_by_id: Mapped[int | None] = mapped_column(Integer)
    completed_by_name: Mapped[str | None] = mapped_column(String(200))
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
