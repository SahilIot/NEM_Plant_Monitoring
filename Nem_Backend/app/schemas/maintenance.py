#Pydantic schemas for maintenance records and recurring maintenance schedules

from datetime import date, datetime, timezone
from typing import Any, Literal #restrict a field to specific permitted values
from pydantic import ConfigDict, Field, field_validator, model_validator
from app.schemas.common import ORMModel

#Creates an individual maintenance record
class MaintenanceCreate(ORMModel):
    asset_id: int = Field(gt=0)
    alert_id: int | None = Field(default=None, gt=0)
    summary: str | None = Field(default=None, min_length=1, max_length=200)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    notes: str | None = Field(default=None, max_length=10_000)
    performed_by: str | None = Field(default=None, min_length=1, max_length=200)
    performed_at: datetime | None = None
    next_due_at: datetime | None = None
    due_date: date | None = None
    maintenance_type: Literal["preventive", "corrective", "inspection", "unplanned"] = "inspection"
    status: Literal["planned", "in_progress", "completed", "cancelled"] = "planned"
    planned_start_at: datetime | None = None
    planned_end_at: datetime | None = None
    actual_started_at: datetime | None = None
    actual_completed_at: datetime | None = None
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    assigned_technician: str | None = Field(default=None, max_length=200)
    completion_notes: str | None = Field(default=None, max_length=10_000)
    parts_used: str | None = Field(default=None, max_length=10_000)
    checklist: list[dict[str, object]] | None = None

    @field_validator("summary", "title", "performed_by", "assigned_technician")
    @classmethod
    def strip_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            return None
        return stripped

    @field_validator(
        "performed_at",
        "next_due_at",
        "planned_start_at",
        "planned_end_at",
        "actual_started_at",
        "actual_completed_at",
    )
    @classmethod
    def normalize_timestamp(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

#Schema checks that the planned end is not earlier than the planned start
    @model_validator(mode="after")
    def validate_dates(self):
        if self.title is not None:
            if self.planned_start_at is None or self.planned_end_at is None:
                raise ValueError("planned_start_at and planned_end_at are required")
            if self.planned_end_at < self.planned_start_at:
                raise ValueError("planned_end_at must not precede planned_start_at")
            if self.notes is None or not self.notes.strip():
                raise ValueError("notes are required for a maintenance job")
        elif self.summary is None or self.performed_by is None:
            raise ValueError("Provide a title or a legacy summary and performed_by")

        if (
            self.actual_started_at is not None
            and self.actual_completed_at is not None
            and self.actual_completed_at < self.actual_started_at
        ):
            raise ValueError("actual_completed_at must not precede actual_started_at")
        if (
            self.performed_at is not None
            and self.next_due_at is not None
            and self.next_due_at <= self.performed_at
        ):
            raise ValueError("next_due_at must be later than performed_at")
        return self

# Defines the data returned for a maintenance record
#Data that backend returns to the frontend when a maintenance record is requested
class MaintenanceRead(ORMModel):
    id: int
    asset_id: int
    alert_id: int | None
    summary: str
    title: str
    notes: str | None
    performed_by: str
    performed_at: datetime
    next_due_at: datetime | None
    maintenance_type: str
    status: str
    planned_start_at: datetime | None
    planned_end_at: datetime | None
    actual_started_at: datetime | None
    actual_completed_at: datetime | None
    priority: str
    assigned_technician: str | None
    completion_notes: str | None
    parts_used: str | None
    checklist: list[dict[str, object]] | None
    schedule_id: int | None = None
    planned_due_date: date | None = None
    created_at: datetime
    updated_at: datetime | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    updated_by_id: int | None = None
    updated_by: str | None = None

#Defines which maintenance record fields can be updated,editing a job
class MaintenanceUpdate(ORMModel):
    model_config = ConfigDict(extra="forbid")

    alert_id: int | None = Field(default=None, gt=0)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    maintenance_type: Literal["preventive", "corrective", "inspection", "unplanned"] | None = None
    planned_start_at: datetime | None = None
    planned_end_at: datetime | None = None
    actual_started_at: datetime | None = None
    actual_completed_at: datetime | None = None
    priority: Literal["low", "medium", "high", "critical"] | None = None
    assigned_technician: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=10_000)
    completion_notes: str | None = Field(default=None, max_length=10_000)
    parts_used: str | None = Field(default=None, max_length=10_000)
    checklist: list[dict[str, object]] | None = None
    next_due_at: datetime | None = None

    @field_validator("title", "assigned_technician")
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("Text fields cannot be empty")
        return value

    @field_validator(
        "planned_start_at",
        "planned_end_at",
        "actual_started_at",
        "actual_completed_at",
        "next_due_at",
    )
    @classmethod
    def normalize_timestamp(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

#Create a maintenance schedule,including recurrence settings
#The core of recurring maintenance
class MaintenanceScheduleCreate(ORMModel):
    asset_id: int = Field(gt=0)
    title: str = Field(min_length=1, max_length=200)
    maintenance_type: Literal["preventive", "corrective", "inspection", "unplanned"]
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    assigned_technician: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=10_000)
        # Select the maintenance scheduling mode.
    schedule_mode: Literal["calendar", "runtime", "usage"] = "calendar"

    # Runtime and usage schedules require a Boolean signal variable.
    signal_variable_id: int | None = Field(default=None, gt=0)

    # Maintenance interval based on machine running hours.
    runtime_interval_hours: float | None = Field(default=None, gt=0)

    # Maintenance interval based on completed machine cycles.
    usage_interval_count: int | None = Field(default=None, gt=0)
    # Schedule start date is optional; it can be provided later.
    schedule_start_date: date | None = None

    # First due date is optional; it can be calculated or provided later.
    first_due_date: date | None = None
    recurrence_enabled: bool = False
    recurrence_interval: int | None = Field(default=None, ge=1, le=3650)
    recurrence_unit: Literal["days", "weeks", "months", "years"] | None = None
    instruction_document_ids: list[int] = Field(default_factory=list, max_length=100)

    @field_validator("title", "assigned_technician")
    @classmethod
    def clean_schedule_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Text fields cannot be empty")
        return cleaned
    
    # Validate fields according to the selected maintenance schedule mode.
    # Calendar schedules require start and first due dates.
    # Runtime schedules require a running signal and runtime interval.
    # Usage schedules require a cycle signal and usage interval.
    # Prevents mixing incompatible settings between different schedule modes.
    # Ensures recurrence settings are used only for calendar-based schedules.
    @model_validator(mode="after")
    def validate_schedule(self):
        if self.schedule_mode == "calendar":
            if self.schedule_start_date is None or self.first_due_date is None:
                raise ValueError(
                    "schedule_start_date and first_due_date are required for calendar schedules"
                )

            if self.first_due_date < self.schedule_start_date:
                raise ValueError("first_due_date must not precede schedule_start_date")

            if self.signal_variable_id is not None:
                raise ValueError(
                    "signal_variable_id is only used for runtime or usage schedules"
                )

            if self.runtime_interval_hours is not None or self.usage_interval_count is not None:
                raise ValueError(
                    "Runtime and usage intervals are not valid for calendar schedules"
                )

            if self.recurrence_enabled and (
                self.recurrence_interval is None or self.recurrence_unit is None
            ):
                raise ValueError(
                    "recurrence_interval and recurrence_unit are required for recurring calendar schedules"
                )

            if not self.recurrence_enabled and (
                self.recurrence_interval is not None or self.recurrence_unit is not None
            ):
                raise ValueError("recurrence settings require recurrence_enabled=true")
        
        elif self.schedule_mode == "runtime":
            if self.signal_variable_id is None:
                raise ValueError(
                    "A running signal variable is required for runtime schedules"
                )

            if self.runtime_interval_hours is None:
                raise ValueError(
                    "runtime_interval_hours is required for runtime schedules"
                )

            if self.usage_interval_count is not None:
                raise ValueError(
                    "usage_interval_count is not valid for runtime schedules"
                )

            if (
                self.recurrence_enabled
                or self.recurrence_interval is not None
                or self.recurrence_unit is not None
            ):
                raise ValueError(
                    "Calendar recurrence settings are not valid for runtime schedules"
                )

        elif self.schedule_mode == "usage":
            if self.signal_variable_id is None:
                raise ValueError(
                    "A cycle signal variable is required for usage schedules"
                )

            if self.usage_interval_count is None:
                raise ValueError(
                    "usage_interval_count is required for usage schedules"
                )

            if self.runtime_interval_hours is not None:
                raise ValueError(
                    "runtime_interval_hours is not valid for usage schedules"
                )

            if (
                self.recurrence_enabled
                or self.recurrence_interval is not None
                or self.recurrence_unit is not None
            ):
                raise ValueError(
                    "Calendar recurrence settings are not valid for usage schedules"
                )

        return self

#Updates an existing schedule, modifying an existing schedule.
class MaintenanceScheduleUpdate(ORMModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=200)
    maintenance_type: Literal["preventive", "corrective", "inspection", "unplanned"] | None = None
    priority: Literal["low", "medium", "high", "critical"] | None = None
    assigned_technician: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=10_000)

    schedule_start_date: date | None = None
    first_due_date: date | None = None

    # Supports calendar, runtime-based, and usage/cycle-based maintenance schedules.
    schedule_mode: Literal["calendar", "runtime", "usage"] | None = None

    # Identifies the asset variable used for runtime or usage-based scheduling.
    signal_variable_id: int | None = Field(default=None, gt=0)

    # Defines the maintenance interval in operating hours.
    runtime_interval_hours: float | None = Field(default=None, gt=0)

    # Defines the maintenance interval based on machine usage or cycles.
    usage_interval_count: int | None = Field(default=None, gt=0)

    recurrence_enabled: bool | None = None
    recurrence_interval: int | None = Field(default=None, ge=1, le=3650)
    recurrence_unit: Literal["days", "weeks", "months", "years"] | None = None

    instruction_document_ids: list[int] | None = Field(default=None, max_length=100)

    status: Literal["active", "paused", "cancelled", "awaiting_approval", "completed"] | None = None
    @field_validator("title", "assigned_technician")
    @classmethod
    def clean_optional_schedule_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Text fields cannot be empty")
        return cleaned

    @model_validator(mode="after")
    def validate_schedule_update(self):
        if self.schedule_start_date and self.first_due_date:
            if self.first_due_date < self.schedule_start_date:
                raise ValueError("first_due_date must not precede schedule_start_date")
        return self

#Returns schedule information , including due status and approval status, displaying the schedule
class MaintenanceScheduleRead(ORMModel):
    id: int
    asset_id: int
    title: str
    maintenance_type: str
    priority: str
    assigned_technician: str | None
    description: str | None
    instruction_document_ids: list[int]
    instruction_documents: list[dict[str, Any]]

    schedule_start_date: date

    # Identifies the maintenance scheduling method: calendar, runtime, or usage.
    schedule_mode: str

    # Stores the asset variable used for runtime or usage-based scheduling.
    signal_variable_id: int | None

    # Maintenance interval based on machine operating hours.
    runtime_interval_hours: float | None

    # Maintenance interval based on machine usage or cycles.
    usage_interval_count: int | None

    # Shows the current progress toward the next maintenance due point.
    current_progress: float

    # Defines the unit of progress, such as hours or cycles.
    progress_unit: str
    current_period_start_date: date
    first_due_date: date
    current_due_date: date | None
    proposed_due_date: date | None
    current_occurrence_id: int | None
    recurrence_enabled: bool
    recurrence_interval: int | None
    recurrence_unit: str | None
    status: str
    approval_status: str
    last_completed_at: datetime | None
    due_status: str
    current_day_count: int
    total_days: int
    created_at: datetime
    updated_at: datetime
    created_by_id: int | None = None
    created_by: str | None = None
    updated_by_id: int | None = None
    updated_by: str | None = None

#Accepts a due date when confirming the next schedule - user approval
class MaintenanceScheduleConfirm(ORMModel):
    due_date: date

#Create Schedule -> Monitor the due data -> Complete maintenance -> Propose next due date -> Save approved next occurrence