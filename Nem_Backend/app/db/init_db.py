#Initializes the db for backend ,create db tables that are missing and check whether an existing monitoring rule table needs a small schema update
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

import app.models  # noqa: F401 #without this model definitions being imported,create_all() might not know about all the tables you expect it to create
from app.db.base import Base

#This defines a function that accepts a SQLAlchemy db engine
def initialize_database(engine: Engine) -> None:
    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    if "nem_monitoring_rules" in inspector.get_table_names() and (
        "is_archived"
        not in {
            column["name"]
            for column in inspector.get_columns("nem_monitoring_rules")
        }
    ):
        with engine.begin() as connection:
            if engine.dialect.name == "postgresql":
                add_column = (
                    "ALTER TABLE nem_monitoring_rules "
                    "ADD COLUMN IF NOT EXISTS is_archived "
                    "BOOLEAN NOT NULL DEFAULT FALSE"
                )
            else:
                add_column = (
                    "ALTER TABLE nem_monitoring_rules "
                    "ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT FALSE"
                )
            connection.execute(text(add_column))

#Create missing tables
#Inspect the database
#Add the missing column if necessay