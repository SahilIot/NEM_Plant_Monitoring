#Generic - allows a class to work with different data types
# TypeVar- Creates a placeholder for a dtype
#BaseModel - The base class Pydantic uses for data validation and serialization
# ConfigDict- Lets you configure how a pydantic model behaves
from typing import Generic, TypeVar
from pydantic import BaseModel, ConfigDict

T = TypeVar("T") #Placeholder for a type of data(“I don't know what type of item I'll need yet. The code using this class will decide.”)
#Paginated API reponse 
class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int
#Common parent class for your API schemas
class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True) #requiring a dictionary