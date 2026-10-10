from datetime import datetime

from pydantic import Field, field_validator

from app.schemas.common import ORMModel


class AssetCreate(ORMModel):
    name: str = Field(min_length=1, max_length=200)
    asset_type: str = Field(min_length=1, max_length=100)
    description: str | None = None
    parent_asset_id: int | None = Field(default=None, gt=0)
    is_active: bool = True

    @field_validator("name", "asset_type")
    @classmethod
    def nonempty_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty")
        return value


class AssetUpdate(ORMModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    asset_type: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    parent_asset_id: int | None = Field(default=None, gt=0)
    is_active: bool | None = None

    @field_validator("name", "asset_type")
    @classmethod
    def nonempty_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty")
        return value


class AssetRead(ORMModel):
    id: int
    name: str
    asset_type: str
    description: str | None
    is_demo: bool
    parent_asset_id: int | None
    is_active: bool
    created_at: datetime
    updated_at: datetime


class AssetTree(AssetRead):
    children: list["AssetTree"] = Field(default_factory=list)
