
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

import app.models  
from app.db.base import Base


def initialize_database(engine: Engine) -> None:
   
    Base.metadata.create_all(bind=engine)

    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())

   
    if "variables" in table_names:
        variable_columns = {
            column["name"]
            for column in inspector.get_columns("variables")
        }

        if "opcua_node_id" not in variable_columns:
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "ALTER TABLE variables "
                        "ADD COLUMN opcua_node_id VARCHAR(512)"
                    )
                )

   
    if "nem_monitoring_rules" in table_names:
        rule_columns = {
            column["name"]
            for column in inspector.get_columns("nem_monitoring_rules")
        }

        if "is_archived" not in rule_columns:
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
                        "ADD COLUMN is_archived "
                        "BOOLEAN NOT NULL DEFAULT FALSE"
                    )

                connection.execute(text(add_column))
