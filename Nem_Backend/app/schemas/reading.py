# controls what data your api accepts,validate plc reading before they stored
# PLC -> OPC UA Client -> ReadingCreate -> validation -> reading_ingestion.py -> database -> dashboard
from datetime import datetime, timezone
import math
# any -> allows metadata or returned values to contain different data types
# Union -> means a value can belong to one of several allowed types
from typing import Any, Union

from pydantic import AliasChoices, Field, StrictBool, StrictFloat, StrictInt, StrictStr, field_validator
 # 
from app.schemas.common import ORMModel
 # what values can a plc reading contains
ReadingValue = Union[StrictStr, StrictBool, StrictInt, StrictFloat]

# Validate incoming readings
class ReadingCreate(ORMModel):
    asset_id: int = Field(gt=0)
    variable_id: int = Field(gt=0)
    value: ReadingValue
    recorded_at: datetime | None = None
    source_id: str | None = Field(default=None, max_length=200)
    metadata: dict[str, Any] | None = None

    @field_validator("recorded_at")
    @classmethod
    def utc_timestamp(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

# prevents invalid floating-point measurements from being accepted
    @field_validator("value")
    @classmethod
    def finite_numeric_value(cls, value: ReadingValue) -> ReadingValue:
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("Reading value must be finite")
        return value

# Accept multiple readings together
class ReadingBatch(ORMModel):
    readings: list[ReadingCreate] = Field(min_length=1, max_length=100)

# Format readings returned by the api
class ReadingRead(ORMModel):
    id: int
    asset_id: int
    variable_id: int
    value: Any
    recorded_at: datetime
    source_id: str | None
    metadata: dict[str, Any] | None = Field(
        default=None, validation_alias=AliasChoices("metadata_json", "metadata")
    )
