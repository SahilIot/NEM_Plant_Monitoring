from datetime import datetime, timezone

from pydantic import Field, field_validator, model_validator

from app.schemas.common import ORMModel


class MaintenanceCreate(ORMModel):
    asset_id: int = Field(gt=0)
    alert_id: int | None = Field(default=None, gt=0)
    summary: str = Field(min_length=1, max_length=200)
    notes: str | None = Field(default=None, max_length=10_000)
    performed_by: str = Field(min_length=1, max_length=200)
    performed_at: datetime | None = None
    next_due_at: datetime | None = None

    @field_validator("summary", "performed_by")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("This field cannot be empty")
        return stripped

    @field_validator("performed_at", "next_due_at")
    @classmethod
    def normalize_timestamp(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    @model_validator(mode="after")
    def validate_dates(self):
        if (
            self.performed_at is not None
            and self.next_due_at is not None
            and self.next_due_at <= self.performed_at
        ):
            raise ValueError("next_due_at must be later than performed_at")
        return self


class MaintenanceRead(ORMModel):
    id: int
    asset_id: int
    alert_id: int | None
    summary: str
    notes: str | None
    performed_by: str
    performed_at: datetime
    next_due_at: datetime | None
    created_at: datetime
