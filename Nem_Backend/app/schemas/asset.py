#pydantic schemas for creating,updating,reading,and displaying assets in a tree structure
from datetime import datetime
from pydantic import Field, field_validator
from app.schemas.common import ORMModel
# defines what data an API accepts,validates and returns

# defines the data the API expects when someone creates an asset
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

# similar to assetCreate but it allows optional feilds so a client can update only the information it wants to change
class AssetUpdate(ORMModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    asset_type: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    parent_asset_id: int | None = Field(default=None, gt=0)
    is_active: bool | None = None
#this validator handles optional strings
    @field_validator("name", "asset_type")
    @classmethod
    def nonempty_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty")
        return value

# Returning asset information
# this schema defines the shape of asset data returned by the API
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

#Representing parent and child assets
#This schema inherits all the feilds from AssetRead and adds a children list
class AssetTree(AssetRead):
    children: list["AssetTree"] = Field(default_factory=list) #creates new empty list for each AssetTree instance when children is not provided.

#Defines how asset data is validated and returned