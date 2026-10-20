from sqlalchemy import inspect, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
import app.models
from app.db.base import Base
from app.models import MonitoringRule, MonitoringRuleTemplate, Variable

#creates tables defined in SQLAlchemy models if they do not exist
def initialize_database(engine: Engine) -> None:
    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "variables" in table_names:
        variable_columns = {column["name"] for column in inspector.get_columns("variables")
        }
        if "opcua_node_id" not in variable_columns:
            with engine.begin() as connection:
                connection.execute(
                    text("ALTER TABLE variables "
                        "ADD COLUMN opcua_node_id VARCHAR(512)"
                    )
                )
    if "nem_monitoring_rules" in table_names:
        rule_columns = {
            column["name"]
            for column in inspector.get_columns("nem_monitoring_rules")
        }
        with engine.begin() as connection:
            if "is_archived" not in rule_columns:
                if engine.dialect.name == "postgresql":
                    connection.execute(
                        text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN IF NOT EXISTS is_archived "
                            "BOOLEAN NOT NULL DEFAULT FALSE"
                        )
                    )
                else:
                    connection.execute(
                        text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN is_archived "
                            "BOOLEAN NOT NULL DEFAULT FALSE"
                        )
                    )
            if "source_template_id" not in rule_columns:
                if engine.dialect.name == "postgresql":
                    connection.execute(
                        text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN IF NOT EXISTS source_template_id INTEGER "
                            "REFERENCES nem_monitoring_rule_templates(id) "
                            "ON DELETE RESTRICT"
                        )
                    )
                else:
                    connection.execute(
                        text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN source_template_id INTEGER "
                            "REFERENCES nem_monitoring_rule_templates(id) "
                            "ON DELETE RESTRICT"
                        )
                    )
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS "
                    "ix_nem_monitoring_rules_source_template_id "
                    "ON nem_monitoring_rules (source_template_id)"
                )
            )

    _migrate_legacy_rule_templates(engine)

    if "nem_maintenance_schedules" in table_names:
        schedule_columns = {
            column["name"]
            for column in inspect(engine).get_columns(
                "nem_maintenance_schedules"
            )
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
                        "SET current_period_start_date = schedule_start_date "
                        "WHERE current_period_start_date IS NULL"
                    )
                )
                if engine.dialect.name == "postgresql":
                    connection.execute(
                        text(
                            "ALTER TABLE nem_maintenance_schedules "
                            "ALTER COLUMN current_period_start_date SET NOT NULL"
                        )
                    )
    if "nem_maintenance_records" in table_names:
        record_columns = {
            column["name"]
            for column in inspect(engine).get_columns(
                "nem_maintenance_records"
            )
        }
        record_column_definitions = {
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
            "schedule_id": (
                "INTEGER REFERENCES nem_maintenance_schedules(id) "
                "ON DELETE RESTRICT"
            ),
            "planned_due_date": "DATE",
            "archived_at": "TIMESTAMP",
        }
        with engine.begin() as connection:
            for name, definition in record_column_definitions.items():
                if name not in record_columns:
                    connection.execute(
                        text(
                            "ALTER TABLE nem_maintenance_records "
                            f"ADD COLUMN {name} {definition}"
                        )
                    )
            connection.execute(
                text(
                    "UPDATE nem_maintenance_records "
                    "SET actual_completed_at = performed_at "
                    "WHERE status = 'completed' AND actual_completed_at IS NULL"
                )
            )

#converts qualifying older rules into resuable templates
def _migrate_legacy_rule_templates(engine: Engine) -> None:
    supported_types = {
        "parameter_threshold",
        "runtime_duration",
        "duration",
        "boolean_count_threshold",
    }
    type_map = {
        "number": ["number"],
        "integer": ["integer"],
        "boolean": ["boolean"],
        "string": ["string"],
    }
    with Session(engine) as session:
        legacy_rules = session.scalars(
            select(MonitoringRule).where(
                MonitoringRule.target_asset_id.is_(None),
                MonitoringRule.is_archived.is_(False),
                MonitoringRule.rule_type.in_(supported_types),
            )
        ).all()
        for rule in legacy_rules:
            if session.scalar(
                select(MonitoringRuleTemplate.id).where(
                    MonitoringRuleTemplate.legacy_rule_id == rule.id
                )
            ):
                continue
            variable = (
                session.get(Variable, rule.variable_id)
                if rule.variable_id is not None
                else None
            )
            required_types = (
                type_map.get(variable.data_type) if variable is not None else None
            )
            if rule.rule_type == "parameter_threshold" and required_types is None:
                required_types = ["number", "integer"]
            elif rule.rule_type == "boolean_count_threshold":
                required_types = ["boolean"]
            elif rule.rule_type == "duration" and required_types is None:
                required_types = ["number", "integer"]

            session.add(
                MonitoringRuleTemplate(
                    name=rule.name,
                    description=rule.description,
                    rule_type=rule.rule_type,
                    required_variable_types=required_types,
                    variable_key=variable.key if variable else None,
                    operator=rule.operator,
                    threshold=rule.threshold,
                    parameters=rule.parameters,
                    severity=rule.severity,
                    is_enabled=rule.is_enabled,
                    evaluation_interval_seconds=rule.evaluation_interval_seconds,
                    stale_after_seconds=rule.stale_after_seconds,
                    legacy_rule_id=rule.id,
                )
            )
            rule.is_enabled = False
            rule.is_archived = True
        session.commit()
