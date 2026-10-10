from datetime import datetime
from typing import Any, Literal
from pydantic import AliasChoices, Field
from app.schemas.common import ORMModel

class RuleStateRead(ORMModel):
    id: int | None = None
    rule_id: int
    target_asset_id: int | None = None
    target_variable_id: int | None = None
    status: Literal["normal", "warning", "alert", "unknown"]
    latest_value: Any = None
    message: str
    last_evaluated_at: datetime | None = None
    condition_started_at: datetime | None = None
    last_transition_at: datetime | None = None
    error_message: str | None = None

class EvaluationResult(ORMModel):
    evaluated: int
    unknown: int
    normal: int
    warning: int
    alert: int

class AcknowledgeRequest(ORMModel):
    acknowledged_by: str | None = Field(default=None, max_length=200)

class AlertRead(ORMModel):
    id: int
    rule_id: int
    target_asset_id: int
    target_variable_id: int | None
    severity: Literal["warning", "alert"]
    title: str
    message: str
    trigger_value: Any
    threshold: float | None
    status: Literal["active", "resolved"]
    started_at: datetime
    last_updated_at: datetime
    resolved_at: datetime | None
    acknowledged_at: datetime | None
    acknowledged_by: str | None

class EventRead(ORMModel):
    id: int
    event_type: str
    severity: str | None
    asset_id: int | None
    rule_id: int | None
    alert_id: int | None
    message: str
    occurred_at: datetime
    metadata: dict[str, Any] | None = Field(
        default=None, validation_alias=AliasChoices("event_metadata", "metadata")
    )