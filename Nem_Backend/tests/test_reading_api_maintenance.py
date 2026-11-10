# Perform end-to-end API integration testing of runtime- and usage-based maintenance tracking,
# including Administrator and Supervisor authentication and authorization, single and batch PLC reading submission,
# automatic maintenance progress calculation, threshold detection, alert and maintenance record creation, duplicate occurrence prevention, and safe PostgreSQL test database transaction rollback without affecting production data.

from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.db.session import create_database_engine
from app.models.asset import Asset
from app.models.auth import User
from app.models.maintenance import MaintenanceRecord, MaintenanceSchedule
from app.models.rule import Alert
from app.models.variable import Variable
from app.services.auth_security import hash_password

import app.main as main_module
import app.services.maintenance_progress as progress_service


EXPECTED_TEST_DATABASE = "plc_monitoring_runtime_test"
TEST_PASSWORD = "test-password-123"


@pytest.fixture
def api(monkeypatch):
    """
    Run API tests against the dedicated PostgreSQL test database.

    All database changes, including API commits and login sessions,
    remain inside an outer transaction and are rolled back afterward.
    """

    settings = get_settings()

    if not settings.test_database_url:
        raise RuntimeError(
            "TEST_DATABASE_URL is not configured. "
            "Refusing to run API integration tests."
        )

    test_url = make_url(settings.test_database_url)
    production_url = make_url(settings.database_url)

    if test_url.database != EXPECTED_TEST_DATABASE:
        raise RuntimeError(
            f"Unsafe test database: {test_url.database!r}. "
            f"Expected {EXPECTED_TEST_DATABASE!r}."
        )

    if test_url.database == production_url.database:
        raise RuntimeError(
            "Test database and production database must be different."
        )

    engine = create_database_engine(settings.test_database_url)
    connection = engine.connect()
    transaction = connection.begin()

    app_engine = None
    client = None

    try:
        actual_database = connection.execute(
            text("SELECT current_database()")
        ).scalar_one()

        if actual_database != EXPECTED_TEST_DATABASE:
            raise RuntimeError(
                f"Connected to unexpected database: {actual_database!r}"
            )

        test_session_factory = sessionmaker(
            bind=connection,
            autoflush=False,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )

        # The app engine is separate from the transaction-bound
        # test connection. The app's middleware and routes use
        # test_session_factory instead.
        app_engine = create_database_engine(settings.test_database_url)

        monkeypatch.setattr(
            main_module,
            "create_database_engine",
            lambda database_url: app_engine,
        )

        monkeypatch.setattr(
            main_module,
            "create_session_factory",
            lambda engine, info=None: test_session_factory,
        )

        # The test database schema has already been initialized.
        # Do not run schema initialization during API tests.
        monkeypatch.setattr(
            main_module,
            "initialize_database",
            lambda engine: None,
        )

        # Prevent external OPC UA activity.
        monkeypatch.setattr(
            main_module.OpcUaCollector,
            "start",
            lambda self: None,
        )

        async def stop_collector(self):
            return None

        monkeypatch.setattr(
            main_module.OpcUaCollector,
            "stop",
            stop_collector,
        )

        # Prevent external notification/event side effects.
        monkeypatch.setattr(
            progress_service,
            "enqueue_alert_notifications",
            lambda *args, **kwargs: None,
        )

        monkeypatch.setattr(
            progress_service,
            "emit_event",
            lambda *args, **kwargs: None,
        )

        test_settings = settings.model_copy(
            update={
                "database_url": settings.test_database_url,
                "monitoring_scheduler_enabled": False,
                "maintenance_due_alerts_enabled": False,
                "email_notifications_enabled": False,
            }
        )

        application = main_module.create_app(test_settings)

        with TestClient(application) as test_client:
            client = test_client

            # Create test users inside the outer transaction.
            with test_session_factory() as session:
                admin = User(
                    username=f"api_admin_{uuid4().hex[:10]}",
                    password_hash=hash_password(TEST_PASSWORD),
                    role="Administrator",
                    is_active=True,
                )

                supervisor = User(
                    username=f"api_supervisor_{uuid4().hex[:10]}",
                    password_hash=hash_password(TEST_PASSWORD),
                    role="Supervisor",
                    is_active=True,
                )

                session.add_all([admin, supervisor])
                session.flush()

                admin_username = admin.username
                supervisor_username = supervisor.username

                session.commit()

            # Obtain real application login tokens.
            admin_response = client.post(
                "/api/v1/auth/login",
                json={
                    "username": admin_username,
                    "password": TEST_PASSWORD,
                },
            )

            assert admin_response.status_code == 200, admin_response.text

            supervisor_response = client.post(
                "/api/v1/auth/login",
                json={
                    "username": supervisor_username,
                    "password": TEST_PASSWORD,
                },
            )

            assert supervisor_response.status_code == 200, (
                supervisor_response.text
            )

            admin_token = admin_response.json()["access_token"]
            supervisor_token = supervisor_response.json()["access_token"]

            yield {
                "client": client,
                "session_factory": test_session_factory,
                "admin_token": admin_token,
                "supervisor_token": supervisor_token,
            }

    finally:
        if transaction.is_active:
            transaction.rollback()

        connection.close()

        if app_engine is not None:
            app_engine.dispose()

        engine.dispose()


def create_asset_and_variable(
    session: Session,
    *,
    signal_role: str,
):
    unique_id = uuid4().hex[:10]

    asset = Asset(
        name=f"API Test Asset {unique_id}",
        asset_type="machine",
        is_active=True,
    )

    session.add(asset)
    session.flush()

    variable = Variable(
        asset_id=asset.id,
        name=f"API Test {signal_role} signal",
        key=f"api_test_{signal_role}_{unique_id}",
        data_type="boolean",
        signal_role=signal_role,
        is_active=True,
    )

    session.add(variable)
    session.flush()

    return asset, variable


def create_schedule(
    session: Session,
    *,
    asset: Asset,
    variable: Variable,
    mode: str,
    threshold: float,
):
    today = date.today()

    schedule = MaintenanceSchedule(
        asset_id=asset.id,
        title=f"API Integration {mode} maintenance",
        maintenance_type="inspection",
        priority="medium",
        schedule_mode=mode,
        signal_variable_id=variable.id,
        runtime_interval_hours=(
            threshold if mode == "runtime" else None
        ),
        usage_interval_count=(
            int(threshold) if mode == "usage" else None
        ),
        current_progress=0.0,
        last_signal_value=None,
        last_signal_at=None,
        schedule_start_date=today,
        current_period_start_date=today,
        first_due_date=today,
        current_due_date=None,
        proposed_due_date=None,
        current_occurrence_id=None,
        recurrence_enabled=False,
        status="active",
        approval_status="not_required",
    )

    session.add(schedule)
    session.flush()

    return schedule


def admin_headers(api):
    return {
        "Authorization": f"Bearer {api['admin_token']}",
    }


def supervisor_headers(api):
    return {
        "Authorization": f"Bearer {api['supervisor_token']}",
    }


def test_reading_api_rejects_missing_token(api):
    response = api["client"].post(
        "/api/v1/readings",
        json={
            "asset_id": 1,
            "variable_id": 1,
            "value": True,
        },
    )

    assert response.status_code == 401


def test_supervisor_cannot_post_readings(api):
    response = api["client"].post(
        "/api/v1/readings",
        headers=supervisor_headers(api),
        json={
            "asset_id": 1,
            "variable_id": 1,
            "value": True,
        },
    )

    assert response.status_code == 403


def test_single_reading_api_triggers_runtime_maintenance(api):
    session_factory = api["session_factory"]

    with session_factory() as session:
        asset, variable = create_asset_and_variable(
            session,
            signal_role="running",
        )

        # 0.002 hours = 7.2 seconds.
        schedule = create_schedule(
            session,
            asset=asset,
            variable=variable,
            mode="runtime",
            threshold=0.002,
        )

        asset_id = asset.id
        variable_id = variable.id
        schedule_id = schedule.id

        session.commit()

    start = datetime.now(timezone.utc) - timedelta(seconds=60)

    first_response = api["client"].post(
        "/api/v1/readings",
        headers=admin_headers(api),
        json={
            "asset_id": asset_id,
            "variable_id": variable_id,
            "value": True,
            "recorded_at": start.isoformat(),
        },
    )

    assert first_response.status_code == 201, first_response.text

    second_response = api["client"].post(
        "/api/v1/readings",
        headers=admin_headers(api),
        json={
            "asset_id": asset_id,
            "variable_id": variable_id,
            "value": True,
            "recorded_at": (
                start + timedelta(seconds=10)
            ).isoformat(),
        },
    )

    assert second_response.status_code == 201, second_response.text

    with session_factory() as session:
        schedule = session.get(MaintenanceSchedule, schedule_id)

        alerts = session.scalars(
            select(Alert).where(
                Alert.maintenance_schedule_id == schedule_id,
                Alert.status == "active",
            )
        ).all()

        records = session.scalars(
            select(MaintenanceRecord).where(
                MaintenanceRecord.schedule_id == schedule_id,
                MaintenanceRecord.status == "planned",
            )
        ).all()

        assert schedule.current_progress >= 0.002
        assert schedule.current_occurrence_id is not None

        assert len(alerts) == 1
        assert len(records) == 1
        assert records[0].alert_id == alerts[0].id
        assert records[0].planned_due_date is None
        assert schedule.current_occurrence_id == records[0].id


def test_batch_reading_api_triggers_usage_maintenance(api):
    session_factory = api["session_factory"]

    with session_factory() as session:
        asset, variable = create_asset_and_variable(
            session,
            signal_role="cycle",
        )

        schedule = create_schedule(
            session,
            asset=asset,
            variable=variable,
            mode="usage",
            threshold=2,
        )

        asset_id = asset.id
        variable_id = variable.id
        schedule_id = schedule.id

        session.commit()

    start = datetime.now(timezone.utc) - timedelta(seconds=60)

    readings = [
        {
            "asset_id": asset_id,
            "variable_id": variable_id,
            "value": False,
            "recorded_at": start.isoformat(),
        },
        {
            "asset_id": asset_id,
            "variable_id": variable_id,
            "value": True,
            "recorded_at": (
                start + timedelta(seconds=10)
            ).isoformat(),
        },
        {
            "asset_id": asset_id,
            "variable_id": variable_id,
            "value": False,
            "recorded_at": (
                start + timedelta(seconds=20)
            ).isoformat(),
        },
        {
            "asset_id": asset_id,
            "variable_id": variable_id,
            "value": True,
            "recorded_at": (
                start + timedelta(seconds=30)
            ).isoformat(),
        },
    ]

    response = api["client"].post(
        "/api/v1/readings/batch",
        headers=admin_headers(api),
        json={
            "readings": readings,
        },
    )

    assert response.status_code == 201, response.text

    with session_factory() as session:
        schedule = session.get(MaintenanceSchedule, schedule_id)

        alerts = session.scalars(
            select(Alert).where(
                Alert.maintenance_schedule_id == schedule_id,
                Alert.status == "active",
            )
        ).all()

        records = session.scalars(
            select(MaintenanceRecord).where(
                MaintenanceRecord.schedule_id == schedule_id,
                MaintenanceRecord.status == "planned",
            )
        ).all()

        assert schedule.current_progress == pytest.approx(2.0)
        assert schedule.current_occurrence_id is not None

        assert len(alerts) == 1
        assert len(records) == 1
        assert records[0].alert_id == alerts[0].id
        assert schedule.current_occurrence_id == records[0].id

        record_count = session.scalar(
            select(func.count()).select_from(MaintenanceRecord).where(
                MaintenanceRecord.schedule_id == schedule_id
            )
        )

        assert record_count == 1
