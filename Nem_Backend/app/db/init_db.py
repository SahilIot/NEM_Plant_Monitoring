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

    tables = set(inspect(engine).get_table_names())
    if "nem_maintenance_schedules" in tables:
        schedule_columns = {
            column["name"]
            for column in inspect(engine).get_columns("nem_maintenance_schedules")
        }
        if "current_period_start_date" not in schedule_columns:
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "ALTER TABLE nem_maintenance_schedules "
                        "ADD COLUMN current_period_start_date DATE"
                    )
                )
                connection.execute(
                    text(
                        "UPDATE nem_maintenance_schedules "
                        "SET current_period_start_date = schedule_start_date"
                    )
                )
                if engine.dialect.name == "postgresql":
                    connection.execute(
                        text(
                            "ALTER TABLE nem_maintenance_schedules "
                            "ALTER COLUMN current_period_start_date SET NOT NULL"
                        )
                    )
    if "nem_maintenance_records" in tables:
        existing_columns = {
            column["name"]
            for column in inspect(engine).get_columns("nem_maintenance_records")
        }
        column_definitions = {
            "maintenance_type": "VARCHAR(30) NOT NULL DEFAULT 'inspection'",
            "status": "VARCHAR(20) NOT NULL DEFAULT 'completed'",
            "planned_start_at": "TIMESTAMP",
            "planned_end_at": "TIMESTAMP",
            "actual_started_at": "TIMESTAMP",
            "actual_completed_at": "TIMESTAMP",
            "priority": "VARCHAR(20) NOT NULL DEFAULT 'medium'",
            "assigned_technician": "VARCHAR(200)",
            "completion_notes": "TEXT",
            "parts_used": "TEXT",
            "checklist": "JSON",
            "schedule_id": "INTEGER REFERENCES nem_maintenance_schedules(id)",
            "planned_due_date": "DATE",
            "archived_at": "TIMESTAMP",
        }
        with engine.begin() as connection:
            for name, definition in column_definitions.items():
                if name in existing_columns:
                    continue
                connection.execute(
                    text(
                        f"ALTER TABLE nem_maintenance_records "
                        f"ADD COLUMN {name} {definition}"
                    )
                )
            connection.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS "
                    "uq_maintenance_occurrence_schedule_due "
                    "ON nem_maintenance_records (schedule_id, planned_due_date)"
                )
            )
            connection.execute(
                text(
                    "UPDATE nem_maintenance_records "
                    "SET actual_completed_at = performed_at "
                    "WHERE status = 'completed' AND actual_completed_at IS NULL"
                )
            )

    if "nem_alerts" in tables:
        alert_columns = {
            column["name"] for column in inspect(engine).get_columns("nem_alerts")
        }
        check_names = {
            constraint["name"]
            for constraint in inspect(engine).get_check_constraints("nem_alerts")
        }
        with engine.begin() as connection:
            if "maintenance_schedule_id" not in alert_columns:
                connection.execute(
                    text(
                        "ALTER TABLE nem_alerts ADD COLUMN "
                        "maintenance_schedule_id INTEGER "
                        "REFERENCES nem_maintenance_schedules(id)"
                    )
                )
            if "maintenance_due_date" not in alert_columns:
                connection.execute(
                    text("ALTER TABLE nem_alerts ADD COLUMN maintenance_due_date DATE")
                )
            if engine.dialect.name == "postgresql":
                connection.execute(
                    text("ALTER TABLE nem_alerts ALTER COLUMN rule_id DROP NOT NULL")
                )
                if "ck_nem_alerts_source" not in check_names:
                    connection.execute(
                        text(
                            "ALTER TABLE nem_alerts ADD CONSTRAINT "
                            "ck_nem_alerts_source CHECK ("
                            "(rule_id IS NOT NULL AND maintenance_schedule_id IS NULL) OR "
                            "(rule_id IS NULL AND maintenance_schedule_id IS NOT NULL "
                            "AND maintenance_due_date IS NOT NULL))"
                        )
                    )
            connection.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS "
                    "uq_nem_alerts_active_maintenance_due "
                    "ON nem_alerts (maintenance_schedule_id, maintenance_due_date) "
                    "WHERE status = 'active' AND maintenance_schedule_id IS NOT NULL"
                )
            )

#Create missing tables
#Inspect the database
#Add the missing column if necessay