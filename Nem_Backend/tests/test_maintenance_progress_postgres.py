# Verify PostgreSQL integration of runtime and usage maintenance tracking,
# including progress calculation from machine signals, threshold detection,
# automatic creation of maintenance records and alerts, prevention of duplicate occurrences, and protection against accidental production database access.

from datetime import date, datetime, timedelta, timezone
from uuid import uuid4
from types import SimpleNamespace

from app.api.routes import maintenance as maintenance_routes
import pytest

from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import create_database_engine
from app.models.asset import Asset
from app.models.maintenance import MaintenanceRecord, MaintenanceSchedule
from app.models.reading import Reading
from app.models.rule import Alert
from app.models.variable import Variable
import app.services.maintenance_progress as progress_service


EXPECTED_TEST_DATABASE = "plc_monitoring_runtime_test"


@pytest.fixture
def db_session():
    """
    Use only the dedicated PostgreSQL test database.

    Each test runs inside an outer transaction which is rolled back
    after the test. Production database access is explicitly rejected.
    """
    settings = get_settings()

    if not settings.test_database_url:
        raise RuntimeError(
            "TEST_DATABASE_URL is not configured. "
            "Refusing to run PostgreSQL integration tests."
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

    session = None

    try:
        actual_database = connection.execute(
            text("SELECT current_database()")
        ).scalar_one()

        if actual_database != EXPECTED_TEST_DATABASE:
            raise RuntimeError(
                f"Connected to unexpected database: {actual_database!r}"
            )

        session = Session(
            bind=connection,
            autoflush=False,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )

        yield session

    finally:
        if session is not None:
            session.close()

        if transaction.is_active:
            transaction.rollback()

        connection.close()
        engine.dispose()


def create_test_asset_and_variable(
    session: Session,
    *,
    signal_role: str,
):
    unique_id = uuid4().hex[:10]

    asset = Asset(
        name=f"Integration Test Asset {unique_id}",
        asset_type="machine",
        is_active=True,
    )
    session.add(asset)
    session.flush()

    variable = Variable(
        asset_id=asset.id,
        name=f"Test {signal_role} signal",
        key=f"test_{signal_role}_{unique_id}",
        data_type="boolean",
        signal_role=signal_role,
        is_active=True,
    )
    session.add(variable)
    session.flush()

    return asset, variable


def create_test_schedule(
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
        title=f"Integration {mode} maintenance",
        maintenance_type="inspection",
        priority="medium",
        schedule_mode=mode,
        signal_variable_id=variable.id,
        runtime_interval_hours=threshold if mode == "runtime" else None,
        usage_interval_count=int(threshold) if mode == "usage" else None,
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


def make_reading(
    *,
    asset_id: int,
    variable_id: int,
    value: bool,
    recorded_at: datetime,
    reading_id: int,
):
    return Reading(
        id=reading_id,
        asset_id=asset_id,
        variable_id=variable_id,
        value=value,
        recorded_at=recorded_at,
    )


def disable_external_side_effects(monkeypatch):
    """Do not send notifications or create external monitoring events."""
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


def test_postgres_runtime_threshold_creates_one_occurrence(
    db_session,
    monkeypatch,
):
    disable_external_side_effects(monkeypatch)

    asset, variable = create_test_asset_and_variable(
        db_session,
        signal_role="running",
    )

    schedule = create_test_schedule(
        db_session,
        asset=asset,
        variable=variable,
        mode="runtime",
        threshold=0.5,
    )

    start = datetime(2026, 11, 7, 10, 0, tzinfo=timezone.utc)

    readings = [
        make_reading(
            asset_id=asset.id,
            variable_id=variable.id,
            value=True,
            recorded_at=start,
            reading_id=1,
        ),
        make_reading(
            asset_id=asset.id,
            variable_id=variable.id,
            value=True,
            recorded_at=start + timedelta(minutes=30),
            reading_id=2,
        ),
    ]

    created = progress_service.update_maintenance_progress(
        db_session,
        readings,
        stale_after_seconds=3600,
    )

    db_session.flush()
    db_session.refresh(schedule)

    assert created == 1
    assert schedule.current_progress == pytest.approx(0.5)
    assert schedule.current_occurrence_id is not None

    alerts = db_session.scalars(
        select(Alert).where(
            Alert.maintenance_schedule_id == schedule.id,
            Alert.status == "active",
        )
    ).all()

    records = db_session.scalars(
        select(MaintenanceRecord).where(
            MaintenanceRecord.schedule_id == schedule.id,
            MaintenanceRecord.status == "planned",
        )
    ).all()

    assert len(alerts) == 1
    assert len(records) == 1
    assert records[0].alert_id == alerts[0].id
    assert records[0].planned_due_date is None
    assert schedule.current_occurrence_id == records[0].id

    # Further readings must not create another occurrence
    # while the current occurrence is still active.
    later_reading = make_reading(
        asset_id=asset.id,
        variable_id=variable.id,
        value=True,
        recorded_at=start + timedelta(hours=1),
        reading_id=3,
    )

    duplicate_created = progress_service.update_maintenance_progress(
        db_session,
        [later_reading],
        stale_after_seconds=3600,
    )

    db_session.flush()

    assert duplicate_created == 0

    alert_count = db_session.scalar(
        select(func.count()).select_from(Alert).where(
            Alert.maintenance_schedule_id == schedule.id
        )
    )

    record_count = db_session.scalar(
        select(func.count()).select_from(MaintenanceRecord).where(
            MaintenanceRecord.schedule_id == schedule.id
        )
    )

    assert alert_count == 1
    assert record_count == 1


def test_postgres_usage_counts_boolean_rising_edges(
    db_session,
    monkeypatch,
):
    disable_external_side_effects(monkeypatch)

    asset, variable = create_test_asset_and_variable(
        db_session,
        signal_role="cycle",
    )

    schedule = create_test_schedule(
        db_session,
        asset=asset,
        variable=variable,
        mode="usage",
        threshold=2,
    )

    start = datetime(2026, 11, 7, 11, 0, tzinfo=timezone.utc)

    readings = [
        make_reading(
            asset_id=asset.id,
            variable_id=variable.id,
            value=False,
            recorded_at=start,
            reading_id=11,
        ),
        make_reading(
            asset_id=asset.id,
            variable_id=variable.id,
            value=True,
            recorded_at=start + timedelta(seconds=10),
            reading_id=12,
        ),
        make_reading(
            asset_id=asset.id,
            variable_id=variable.id,
            value=False,
            recorded_at=start + timedelta(seconds=20),
            reading_id=13,
        ),
        make_reading(
            asset_id=asset.id,
            variable_id=variable.id,
            value=True,
            recorded_at=start + timedelta(seconds=30),
            reading_id=14,
        ),
    ]

    created = progress_service.update_maintenance_progress(
        db_session,
        readings,
        stale_after_seconds=60,
    )

    db_session.flush()
    db_session.refresh(schedule)

    assert created == 1
    assert schedule.current_progress == pytest.approx(2.0)
    assert schedule.current_occurrence_id is not None

    alerts = db_session.scalars(
        select(Alert).where(
            Alert.maintenance_schedule_id == schedule.id
        )
    ).all()

    records = db_session.scalars(
        select(MaintenanceRecord).where(
            MaintenanceRecord.schedule_id == schedule.id
        )
    ).all()

    assert len(alerts) == 1
    assert len(records) == 1
    assert alerts[0].status == "active"
    assert records[0].status == "planned"
    assert records[0].alert_id == alerts[0].id
    assert schedule.current_occurrence_id == records[0].id

@pytest.mark.parametrize(
    ("mode", "threshold", "initial_readings", "next_readings"),
    [
        (
            "runtime",
            0.5,
            [
                (True, 0),
                (True, 30),
            ],
            [
                (True, 32),
                (True, 62),
            ],
        ),
        (
            "usage",
            2,
            [
                (False, 0),
                (True, 10),
                (False, 20),
                (True, 30),
            ],
            [
                (False, 32),
                (True, 33),
                (False, 34),
                (True, 35),
            ],
        ),
    ],
)
def test_postgres_completion_starts_next_maintenance_cycle(
    db_session,
    monkeypatch,
    mode,
    threshold,
    initial_readings,
    next_readings,
):
    disable_external_side_effects(monkeypatch)

    asset, variable = create_test_asset_and_variable(
        db_session,
        signal_role="running" if mode == "runtime" else "cycle",
    )

    schedule = create_test_schedule(
        db_session,
        asset=asset,
        variable=variable,
        mode=mode,
        threshold=threshold,
    )

    start = datetime(2026, 11, 7, 10, 0, tzinfo=timezone.utc)

    first_batch = [
        make_reading(
            asset_id=asset.id,
            variable_id=variable.id,
            value=value,
            recorded_at=start + timedelta(minutes=minutes),
            reading_id=100 + index,
        )
        for index, (value, minutes) in enumerate(initial_readings)
    ]

    first_created = progress_service.update_maintenance_progress(
        db_session,
        first_batch,
        stale_after_seconds=3600,
    )

    db_session.flush()
    db_session.refresh(schedule)

    assert first_created == 1
    assert schedule.current_occurrence_id is not None

    first_record = db_session.scalar(
        select(MaintenanceRecord).where(
            MaintenanceRecord.id == schedule.current_occurrence_id
        )
    )

    assert first_record is not None
    assert first_record.status == "planned"

    first_alert = db_session.scalar(
        select(Alert).where(Alert.id == first_record.alert_id)
    )

    assert first_alert is not None
    assert first_alert.status == "active"

    # Complete the first occurrence using the real completion function.
    completed_at = start + timedelta(minutes=31)

    monkeypatch.setattr(
        maintenance_routes,
        "access_scope",
        lambda session: SimpleNamespace(
            allows=lambda asset_id: True
        ),
    )
    monkeypatch.setattr(
        maintenance_routes,
        "utc_now",
        lambda: completed_at,
    )
    monkeypatch.setattr(
        maintenance_routes,
        "_validate_record_dates",
        lambda record: None,
    )
    monkeypatch.setattr(
        maintenance_routes,
        "_emit_schedule_event",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        maintenance_routes,
        "_emit_maintenance_event",
        lambda *args, **kwargs: None,
    )

    user = SimpleNamespace(role="Administrator")

    completed_record = maintenance_routes.complete_maintenance_record(
        first_record.id,
        db_session,
        user,
    )

    db_session.refresh(schedule)
    db_session.refresh(first_alert)

    assert completed_record.status == "completed"
    assert first_alert.status == "resolved"

    # Completion must reset the maintenance-owned progress and baseline.
    assert schedule.current_progress == pytest.approx(0.0)
    assert schedule.last_signal_value is None
    assert schedule.last_signal_at is None
    assert schedule.current_occurrence_id is None
    assert schedule.current_due_date is None
    assert schedule.due_alerted_for is None
    assert schedule.status == "active"

    # Fresh readings must start a new interval, not reuse the old baseline.
    second_batch = [
        make_reading(
            asset_id=asset.id,
            variable_id=variable.id,
            value=value,
            recorded_at=start + timedelta(minutes=minutes),
            reading_id=200 + index,
        )
        for index, (value, minutes) in enumerate(next_readings)
    ]

    second_created = progress_service.update_maintenance_progress(
        db_session,
        second_batch,
        stale_after_seconds=3600,
    )

    db_session.flush()
    db_session.refresh(schedule)

    assert second_created == 1
    assert schedule.current_occurrence_id is not None
    assert schedule.current_occurrence_id != first_record.id

    second_record = db_session.scalar(
        select(MaintenanceRecord).where(
            MaintenanceRecord.id == schedule.current_occurrence_id
        )
    )

    assert second_record is not None

    second_alert = db_session.scalar(
        select(Alert).where(Alert.id == second_record.alert_id)
    )

    assert second_alert is not None
    assert second_record.status == "planned"
    assert second_alert is not None
    assert second_alert.status == "active"

    # Both occurrences must exist, with only the new alert active.
    all_records = db_session.scalars(
        select(MaintenanceRecord).where(
            MaintenanceRecord.schedule_id == schedule.id
        )
    ).all()

    all_alerts = db_session.scalars(
        select(Alert).where(
            Alert.maintenance_schedule_id == schedule.id
        )
    ).all()

    assert len(all_records) == 2
    assert len(all_alerts) == 2
    assert sum(alert.status == "active" for alert in all_alerts) == 1
    assert sum(alert.status == "resolved" for alert in all_alerts) == 1
