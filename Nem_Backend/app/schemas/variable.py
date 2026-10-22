from datetime import datetime
from typing import Literal
from pydantic import Field, field_validator, model_validator
from app.schemas.common import ORMModel

VariableDataType = Literal["number", "integer", "string", "boolean"]
VariableSignalRole = Literal["running", "cycle"]

class VariableCreate(ORMModel):
    name: str = Field(min_length=1, max_length=150)
    key: str = Field(min_length=1, max_length=100)
    data_type: VariableDataType
    signal_role: VariableSignalRole | None = None
    unit: str | None = Field(default=None, max_length=50)
    description: str | None = None
    is_active: bool = True
    # OPC UA node discovered on the PLC; optional for manually created variables.
    opcua_node_id: str | None = Field(default=None, max_length=512)

    @model_validator(mode="after")
    def validate_signal_role(self) -> "VariableCreate":
        if self.signal_role is not None and self.data_type != "boolean":
            raise ValueError("A signal purpose can only be set for Boolean variables")
        return self

    @field_validator("name", "key")
    @classmethod
    def nonempty_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty")
        return value

    @field_validator("opcua_node_id")
    @classmethod
    def clean_opcua_node_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            return None
        return value

class VariableUpdate(ORMModel):
    name: str | None = Field(default=None, min_length=1, max_length=150)
    key: str | None = Field(default=None, min_length=1, max_length=100)
    data_type: VariableDataType | None = None
    signal_role: VariableSignalRole | None = None
    unit: str | None = Field(default=None, max_length=50)
    description: str | None = None
    is_active: bool | None = None
    opcua_node_id: str | None = Field(default=None, max_length=512)

    @model_validator(mode="after")
    def validate_signal_role(self) -> "VariableUpdate":
        if (
            self.signal_role is not None
            and self.data_type is not None
            and self.data_type != "boolean"
        ):
            raise ValueError("A signal purpose can only be set for Boolean variables")
        return self

    @field_validator("name", "key")
    @classmethod
    def nonempty_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty")
        return value

    @field_validator("opcua_node_id")
    @classmethod
    def clean_opcua_node_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            return None
        return value

class VariableRead(ORMModel):
    id: int
    asset_id: int
    name: str
    key: str
    data_type: str
    signal_role: str | None = None
    unit: str | None
    description: str | None
    is_active: bool
    opcua_node_id: str | None = None
    created_at: datetime
    updated_at: datetime