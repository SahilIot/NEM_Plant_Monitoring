from typing import Any

from pydantic import Field, field_validator

from app.schemas.common import ORMModel
from app.schemas.reading import ReadingRead


class OpcUaReadRequest(ORMModel):
    node_id: str = Field(min_length=1, max_length=512)
    asset_id: int = Field(gt=0)
    variable_id: int = Field(gt=0)
    source_id: str | None = Field(default=None, max_length=200)

    @field_validator("node_id")
    @classmethod
    def nonempty_node_id(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("NodeId cannot be empty")
        return value


class OpcUaReadResponse(ORMModel):
    node_id: str
    value: Any
    reading: ReadingRead
