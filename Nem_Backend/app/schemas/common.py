#BaseModel - The base class Pydantic uses for data validation and serialization
# ConfigDict- Lets you configure how a pydantic model behaves
from pydantic import BaseModel, ConfigDict

#Common parent class for your API schemas
class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True) #requiring a dictionary