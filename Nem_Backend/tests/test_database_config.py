import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.db.session import create_database_engine
from app.models import (
    Alert,
    MaintenanceRecord,
    MonitoringEvent,
    MonitoringRule,
    Reading,
    RuleState,
)

POSTGRES_URL = "postgresql+psycopg://localhost/nem_test"


def test_settings_accept_sync_psycopg_postgresql_url():
    settings = Settings(_env_file=None, database_url=POSTGRES_URL)
    assert settings.database_url == POSTGRES_URL


def test_settings_require_database_url(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(ValidationError, match="database_url"):
        Settings(_env_file=None)


@pytest.mark.parametrize(
    "database_url",
    [
        "sqlite:///./machine_monitor.db",
        "mysql+pymysql://localhost/nem_test",
        "postgresql+asyncpg://localhost/nem_test",
    ],
)
def test_settings_reject_non_sync_postgresql_database_urls(database_url):
    with pytest.raises(ValidationError, match="postgresql\\+psycopg"):
        Settings(_env_file=None, database_url=database_url)


def test_engine_factory_rejects_non_postgresql_urls():
    with pytest.raises(ValueError, match="postgresql\\+psycopg"):
        create_database_engine("sqlite:///./machine_monitor.db")


def test_test_database_must_be_distinct_from_application_database():
    with pytest.raises(ValidationError, match="must not point"):
        Settings(
            _env_file=None,
            database_url="postgresql+psycopg://localhost/plc_monitoring",
            test_database_url="postgresql+psycopg://localhost/plc_monitoring",
        )


def test_test_database_must_not_be_a_postgresql_system_database():
    with pytest.raises(ValidationError, match="dedicated, non-system"):
        Settings(
            _env_file=None,
            database_url="postgresql+psycopg://localhost/plc_monitoring",
            test_database_url="postgresql+psycopg://localhost/postgres",
        )


def test_nem_models_use_separate_tables_and_foreign_keys():
    assert Reading.__tablename__ == "nem_readings"
    assert MonitoringRule.__tablename__ == "nem_monitoring_rules"
    assert RuleState.__tablename__ == "nem_rule_states"
    assert Alert.__tablename__ == "nem_alerts"
    assert MonitoringEvent.__tablename__ == "nem_monitoring_events"
    assert MaintenanceRecord.__tablename__ == "nem_maintenance_records"

    assert next(iter(RuleState.__table__.c.rule_id.foreign_keys)).target_fullname == (
        "nem_monitoring_rules.id"
    )
    assert next(iter(Alert.__table__.c.rule_id.foreign_keys)).target_fullname == (
        "nem_monitoring_rules.id"
    )
    assert next(iter(MonitoringEvent.__table__.c.alert_id.foreign_keys)).target_fullname == (
        "nem_alerts.id"
    )
    assert next(
        iter(MaintenanceRecord.__table__.c.alert_id.foreign_keys)
    ).target_fullname == "nem_alerts.id"
