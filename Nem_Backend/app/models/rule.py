# Reusable monitoring rule templates, separate from asset-specific rules.
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Index,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.session import UTCDateTime
from app.models.audit_mixin import AuditNamesMixin
from app.models.labels import (
    Label,
    rule_labels,
    rule_template_labels,
    rule_template_request_labels,
)


class MonitoringRuleTemplate(AuditNamesMixin, Base):
    __tablename__ = "nem_monitoring_rule_templates"
    __table_args__ = (
        CheckConstraint("visibility_type IN ('admin_only', 'specific_supervisors')",
            name="ck_nem_monitoring_rule_templates_visibility",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    rule_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    required_variable_types: Mapped[list[str] | None] = mapped_column(JSON)
    variable_key: Mapped[str | None] = mapped_column(String(200))
    operator: Mapped[str | None] = mapped_column(String(10))
    threshold: Mapped[Decimal | None] = mapped_column(Numeric(20, 6))
    parameters: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    evaluation_interval_seconds: Mapped[int | None] = mapped_column()
    stale_after_seconds: Mapped[int | None] = mapped_column()

    collection_id: Mapped[int | None] = mapped_column(
        ForeignKey("rule_collections.id", ondelete="SET NULL"),
        index=True,
    )
    legacy_rule_id: Mapped[int | None] = mapped_column(unique=True)

    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    # Who may see and manage this shared rule in the global Monitoring Rules section.
    visibility_type: Mapped[str] = mapped_column(
        String(30),
        default="admin_only",
        server_default="admin_only",
        nullable=False,
    )
    visibility_supervisors: Mapped[list["User"]] = relationship( "User", secondary="nem_rule_template_supervisors", lazy="selectin") # type: ignore
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("auth_users.id", ondelete="SET NULL"), index=True)
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("auth_users.id", ondelete="SET NULL"), index=True)
    created_by_user: Mapped["User | None"] = relationship( "User", foreign_keys=[created_by_id], lazy="selectin") # type: ignore
    updated_by_user: Mapped["User | None"] = relationship( "User", foreign_keys=[updated_by_id], lazy="selectin") # type: ignore
    label_records: Mapped[list[Label]] = relationship(secondary=rule_template_labels,lazy="selectin",)

    @property
    def visibility_supervisor_ids(self) -> list[int]:
        return sorted(user.id for user in self.visibility_supervisors)

    @property
    def labels(self) -> list[str]:
        return [label.name for label in self.label_records]


class MonitoringRuleTemplateRequest(Base):
    # Supervisor-submitted reusable rule awaiting Admin review.

    __tablename__ = "nem_monitoring_rule_template_requests"

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'approved', 'declined')",
            name="ck_nem_rule_template_requests_status",
        ),
        Index(
            "ix_nem_rule_template_requests_status_created",
            "status",
            "created_at",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)

    suggestion_type: Mapped[str] = mapped_column(
        String(30),
        default="monitoring_rule",
        server_default="monitoring_rule",
        nullable=False,
    )
    maintenance_details: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    # Proposed reusable rule configuration.
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    rule_type: Mapped[str] = mapped_column(String(40), nullable=False)
    required_variable_types: Mapped[list[str] | None] = mapped_column(JSON)
    variable_key: Mapped[str | None] = mapped_column(String(200))
    operator: Mapped[str | None] = mapped_column(String(10))
    threshold: Mapped[Decimal | None] = mapped_column(Numeric(20, 6))
    parameters: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    evaluation_interval_seconds: Mapped[int | None] = mapped_column()
    stale_after_seconds: Mapped[int | None] = mapped_column()

    # Optional collection selected for the proposed template.
    collection_id: Mapped[int | None] = mapped_column(
        ForeignKey("rule_collections.id", ondelete="SET NULL"),
        index=True,
    )

    # Requester and reviewer reference existing users.
    requested_by: Mapped[int] = mapped_column(
        ForeignKey("auth_users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(20),
        default="pending",
        server_default="pending",
        nullable=False,
        index=True,
    )
    reviewed_by: Mapped[int | None] = mapped_column(ForeignKey("auth_users.id", ondelete="RESTRICT"),)
    reviewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    review_comment: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    # Labels attached to a Supervisor's reusable rule suggestion.
    label_records: Mapped[list[Label]] = relationship(
        secondary=rule_template_request_labels,
        lazy="selectin",
    )

    @property
    def labels(self) -> list[str]:
        return [label.name for label in self.label_records]
    
class MonitoringRule(AuditNamesMixin, Base):
    """Asset-specific monitoring rule."""

    __tablename__ = "nem_monitoring_rules"

    __table_args__ = (
        CheckConstraint(
            "severity IN ('warning', 'alert')",
            name="ck_nem_monitoring_rules_severity",
        ),
        CheckConstraint(
            "lifecycle_status IN "
            "('in_progress', 'suspended', 'deactivated', 'completed')",
            name="ck_nem_monitoring_rules_lifecycle_status",
        ),
        CheckConstraint(
            "rule_type IN "
            "('parameter_threshold', 'runtime_duration', 'duration', "
            "'generic', 'boolean_condition', 'boolean_count_threshold', "
            "'multi_parameter')",
            name="ck_nem_monitoring_rules_type",
        ),
        Index(
            "ix_nem_monitoring_rules_target_enabled",
            "target_asset_id",
            "is_enabled",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    rule_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)

    target_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"),index=True,)
    source_template_id: Mapped[int | None] = mapped_column(ForeignKey( "nem_monitoring_rule_templates.id",ondelete="RESTRICT",),index=True,)
    variable_id: Mapped[int | None] = mapped_column(ForeignKey("variables.id", ondelete="RESTRICT"),index=True,)

    operator: Mapped[str | None] = mapped_column(String(10))
    threshold: Mapped[Decimal | None] = mapped_column(Numeric(20, 6))
    parameters: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)

    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True)
    lifecycle_status: Mapped[str] = mapped_column(
        String(20),
        default="in_progress",
        server_default="in_progress",
        nullable=False,
    )
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    evaluation_interval_seconds: Mapped[int | None] = mapped_column()
    stale_after_seconds: Mapped[int | None] = mapped_column()

    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
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
    label_records: Mapped[list[Label]] = relationship(secondary=rule_labels, lazy="selectin",)
    # Only 'multi_parameter' rules have parameter rows; every other rule type leaves this empty.
    parameter_items: Mapped[list["RuleParameter"]] = relationship(
        "RuleParameter",
        order_by="RuleParameter.position",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    @property
    def shared_rule(self) -> bool:
        # True when this rule is an asset use of a shared rule (edits change every asset using it).
        return self.source_template_id is not None

    @property
    def labels(self) -> list[str]:
        return [label.name for label in self.label_records]


# Stores the current result of a monitoring rule.
class RuleState(Base):
    __tablename__ = "nem_rule_states"

    __table_args__ = (
        CheckConstraint(
            "status IN ('normal', 'warning', 'alert', 'unknown')",
            name="ck_nem_rule_states_status",
        ),
        Index("ix_nem_rule_states_status", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[int] = mapped_column(
        ForeignKey("nem_monitoring_rules.id", ondelete="RESTRICT"),nullable=False,unique=True,)
    target_asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"),nullable=False,index=True,)
    target_variable_id: Mapped[int | None] = mapped_column(ForeignKey("variables.id", ondelete="RESTRICT"),index=True,)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    latest_value: Mapped[Any | None] = mapped_column(JSON)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    last_evaluated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    condition_started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    last_transition_at: Mapped[datetime] = mapped_column( UTCDateTime(), nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text)


# Stores problems that need attention.
class Alert(Base):
    __tablename__ = "nem_alerts"

    __table_args__ = (
        CheckConstraint(
            "severity IN ('warning', 'alert')",
            name="ck_nem_alerts_severity",
        ),
        CheckConstraint(
            "status IN ('active', 'resolved')",
            name="ck_nem_alerts_status",
        ),
        Index(
            "ix_nem_alerts_active_asset_severity",
            "status",
            "target_asset_id",
            "severity",
        ),
        Index(
            "ix_nem_alerts_rule_status",
            "rule_id",
            "status",
        ),
        Index(
            "uq_nem_alerts_active_rule_asset",
            "rule_id",
            "target_asset_id",
            unique=True,
            postgresql_where=text("status = 'active' AND parameter_id IS NULL"),
        ),
        # Multi-parameter rules raise one alert per parameter, so one parameter's alert can never
        # be resolved, replaced or hidden by another's.
        Index(
            "uq_nem_alerts_active_rule_asset_parameter",
            "rule_id",
            "target_asset_id",
            "parameter_id",
            unique=True,
            postgresql_where=text("status = 'active' AND parameter_id IS NOT NULL"),
        ),
        Index(
            "uq_nem_alerts_active_maintenance_due",
            "maintenance_schedule_id",
            "maintenance_due_date",
            unique=True,
            postgresql_where=text(
                "status = 'active' AND maintenance_schedule_id IS NOT NULL"
            ),
        ),
        CheckConstraint(
            "(rule_id IS NOT NULL AND maintenance_schedule_id IS NULL) OR "
            "(rule_id IS NULL AND maintenance_schedule_id IS NOT NULL "
            "AND maintenance_due_date IS NOT NULL)",
            name="ck_nem_alerts_source",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)

    rule_id: Mapped[int | None] = mapped_column(
        ForeignKey("nem_monitoring_rules.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    maintenance_schedule_id: Mapped[int | None] = mapped_column(
        ForeignKey("nem_maintenance_schedules.id", ondelete="RESTRICT"),
        index=True,
    )
    maintenance_due_date: Mapped[date | None] = mapped_column(Date)
    # Set only for alerts raised by one parameter of a multi-parameter rule. The name is kept as a
    # snapshot so history stays readable after the parameter is edited or removed.
    parameter_id: Mapped[int | None] = mapped_column(
        ForeignKey("nem_rule_parameters.id", ondelete="SET NULL"), nullable=True, index=True
    )
    parameter_name: Mapped[str | None] = mapped_column(String(200))

    target_asset_id: Mapped[int] = mapped_column(
        ForeignKey("assets.id", ondelete="RESTRICT"),
        nullable=False,index=True,)
    target_variable_id: Mapped[int | None] = mapped_column(ForeignKey("variables.id", ondelete="RESTRICT"),
        index=True,)

    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(250), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    trigger_value: Mapped[Any | None] = mapped_column(JSON)
    threshold: Mapped[Decimal | None] = mapped_column(Numeric(20, 6))

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    last_updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    acknowledged_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    acknowledged_by: Mapped[str | None] = mapped_column(String(200))


# Stores monitoring event history.
class MonitoringEvent(Base):
    __tablename__ = "nem_monitoring_events"

    __table_args__ = (
        Index(
            "ix_nem_monitoring_events_asset_timestamp",
            "asset_id",
            "occurred_at",
        ),
        Index(
            "ix_nem_monitoring_events_type_timestamp",
            "event_type",
            "occurred_at",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    event_type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    severity: Mapped[str | None] = mapped_column(String(20))

    asset_id: Mapped[int | None] = mapped_column(
        ForeignKey("assets.id", ondelete="RESTRICT"),
        index=True,
    )
    rule_id: Mapped[int | None] = mapped_column(ForeignKey("nem_monitoring_rules.id", ondelete="RESTRICT"),
        index=True,
    )
    alert_id: Mapped[int | None] = mapped_column( ForeignKey("nem_alerts.id", ondelete="RESTRICT"),
        index=True,
    )

    message: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    event_metadata: Mapped[dict[str, Any] | None] = mapped_column("metadata", JSON)


# A lease is a temporary claim to perform scheduled work.
class SchedulerLease(Base):
    __tablename__ = "scheduler_leases"

    name: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), nullable=False)
    lease_until: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column( UTCDateTime(), nullable=False)


class RuleParameter(Base):
    __tablename__ = "nem_rule_parameters"
    __table_args__ = (
        UniqueConstraint("rule_id", "key", name="uq_nem_rule_parameters_rule_key"),
        CheckConstraint("kind IN ('number', 'boolean', 'interval')", name="ck_nem_rule_parameters_kind"),
        CheckConstraint(
            "aggregation IN ('none', 'counter', 'last', 'timer')",
            name="ck_nem_rule_parameters_aggregation",
        ),
        CheckConstraint(
            "lifecycle_status IN ('active', 'suspended', 'deactivated')",
            name="ck_nem_rule_parameters_lifecycle",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[int] = mapped_column(
        ForeignKey("nem_monitoring_rules.id", ondelete="CASCADE"), nullable=False, index=True
    )
    key: Mapped[str] = mapped_column(String(36), nullable=False, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    position: Mapped[int] = mapped_column(nullable=False, default=0)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    variable_id: Mapped[int | None] = mapped_column(
        ForeignKey("variables.id", ondelete="RESTRICT"), index=True
    )
    aggregation: Mapped[str] = mapped_column(String(20), nullable=False, default="none")
    config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    # Independent of the parent rule's lifecycle: only 'active' parameters are evaluated and can alert.
    lifecycle_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="active", server_default="active"
    )
    maintenance_scheduled_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    cycle_baseline_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    state: Mapped["RuleParameterState | None"] = relationship("RuleParameterState", uselist=False, cascade="all, delete-orphan", lazy="selectin")

class RuleParameterState(Base):
    # Latest evaluation of one rule parameter (the rule's own RuleState holds the combined result).
    __tablename__ = "nem_rule_parameter_states"
    __table_args__ = (
        CheckConstraint(
            "status IN ('normal', 'warning', 'alert', 'unknown')",
            name="ck_nem_rule_parameter_states_status",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    parameter_id: Mapped[int] = mapped_column(
        ForeignKey("nem_rule_parameters.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    # Evaluated (aggregated) value and the raw latest PLC value, kept apart so the UI can tell them apart.
    latest_value: Mapped[Any | None] = mapped_column(JSON)
    raw_value: Mapped[Any | None] = mapped_column(JSON)
    message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    error_message: Mapped[str | None] = mapped_column(Text)
    last_evaluated_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    # Incremental checkpoint for cumulative (interval) aggregation; never shown to users.
    aggregate_state: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    # Timestamp of the latest reading seen (even when stale) and the last reading that was valid and fresh.
    reading_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    last_valid_value: Mapped[Any | None] = mapped_column(JSON)
    last_valid_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    # Set when this parameter's alert was completed while its condition still holds, so the same
    # continuing condition does not immediately raise a new alert. Cleared when it returns to Normal.
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())