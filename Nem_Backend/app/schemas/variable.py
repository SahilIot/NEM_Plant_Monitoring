from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from app.schemas.common import ORMModel


class VariableCreate(ORMModel):
    name: str = Field(min_length=1, max_length=150)
    key: str = Field(min_length=1, max_length=100)
    data_type: Literal["number", "integer", "string", "boolean"]
    unit: str | None = Field(default=None, max_length=50)
    description: str | None = None
    is_active: bool = True

    @field_validator("name", "key")
    @classmethod
    def nonempty_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty")
        return value


class VariableUpdate(ORMModel):
    name: str | None = Field(default=None, min_length=1, max_length=150)
    key: str | None = Field(default=None, min_length=1, max_length=100)
    data_type: Literal["number", "integer", "string", "boolean"] | None = None
    unit: str | None = Field(default=None, max_length=50)
    description: str | None = None
    is_active: bool | None = None

    @field_validator("name", "key")
    @classmethod
    def nonempty_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty")
        return value


class VariableRead(ORMModel):
    id: int
    asset_id: int
    name: str
    key: str
    data_type: str
    unit: str | None
    description: str | None
    is_active: bool
    created_at: datetime
    updated_at: datetime
