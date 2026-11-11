# PostgreSQL integration tests for calendar, runtime and usage maintenance
# schedule creation and lifecycle management.
#
# These tests verify that maintenance schedules are created correctly,
# validated against their signal variables, and safely cancelled or updated.
#
# All tests use a dedicated PostgreSQL test database. Production database
# access is explicitly blocked.

from datetime import date, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.api.routes import maintenance as maintenance_routes
from app.core.config import get_settings
from app.db.session import create_database_engine
from app.models.asset import Asset
from app.models.maintenance import MaintenanceRecord, MaintenanceSchedule
from app.models.variable import Variable
from app.models.rule import Alert
from app.schemas.maintenance import (
    MaintenanceScheduleCreate,
    MaintenanceScheduleUpdate,
)


EXPECTED_TEST_DATABASE = "plc_monitoring_runtime_test"


@pytest.fixture
def db_session():
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


@pytest.fixture
def schedule_route_mocks(monkeypatch):
    emitted_events = []

    monkeypatch.setattr(
        maintenance_routes,
        "access_scope",
        lambda session: SimpleNamespace(
            allows=lambda asset_id: True
        ),
    )

    def capture_event(session, schedule, **kwargs):
        emitted_events.append(
            {
                "schedule_id": schedule.id,
                **kwargs,
            }
        )

    monkeypatch.setattr(
        maintenance_routes,
        "_emit_schedule_event",
        capture_event,
    )

    return emitted_events


def create_asset(session: Session):
    unique_id = uuid4().hex[:10]

    asset = Asset(
        name=f"Schedule Test Asset {unique_id}",
        asset_type="machine",
        is_active=True,
    )

    session.add(asset)
    session.flush()

    return asset


def create_signal_variable(
    session: Session,
    *,
    asset_id: int,
    signal_role: str,
):
    unique_id = uuid4().hex[:10]

    variable = Variable(
        asset_id=asset_id,
        name=f"Test {signal_role} signal {unique_id}",
        key=f"schedule_{signal_role}_{unique_id}",
        data_type="boolean",
        signal_role=signal_role,
        is_active=True,
    )

    session.add(variable)
    session.flush()

    return variable


def schedule_count(session: Session) -> int:
    return session.scalar(
        select(func.count()).select_from(MaintenanceSchedule)
    )


def record_count(session: Session, schedule_id: int) -> int:
    return session.scalar(
        select(func.count())
        .select_from(MaintenanceRecord)
        .where(MaintenanceRecord.schedule_id == schedule_id)
    )

# CALENDAR SCHEDULE CREATION
def test_calendar_schedule_creates_initial_occurrence(
    db_session,
    schedule_route_mocks,
):
    today = date.today()
    first_due = today + timedelta(days=14)

    asset = create_asset(db_session)

    payload = MaintenanceScheduleCreate(
        asset_id=asset.id,
        title="Calendar integration test",
        maintenance_type="inspection",
        schedule_mode="calendar",
        schedule_start_date=today,
        first_due_date=first_due,
        recurrence_enabled=True,
        recurrence_interval=1,
        recurrence_unit="months",
    )

    schedule = maintenance_routes._create_maintenance_schedule(
        db_session,
        payload,
    )

    db_session.flush()

    assert schedule.schedule_mode == "calendar"
    assert schedule.schedule_start_date == today
    assert schedule.first_due_date == first_due
    assert schedule.current_due_date == first_due
    assert schedule.recurrence_enabled is True
    assert schedule.recurrence_interval == 1
    assert schedule.recurrence_unit == "months"

    assert schedule.current_occurrence_id is not None
    assert record_count(db_session, schedule.id) == 1

    occurrence = db_session.get(
        MaintenanceRecord,
        schedule.current_occurrence_id,
    )

    assert occurrence is not None
    assert occurrence.schedule_id == schedule.id
    assert occurrence.planned_due_date == first_due
    assert occurrence.status == "planned"

    assert len(schedule_route_mocks) == 1
    assert schedule_route_mocks[0]["schedule_id"] == schedule.id
    assert schedule_route_mocks[0]["event_type"] == (
        "maintenance_schedule_created"
    )
    assert schedule_route_mocks[0]["due_date"] == first_due


def test_schedule_deletion_preserves_linked_occurrence_history(
    db_session,
    schedule_route_mocks,
    monkeypatch,
):
    today = date.today()
    asset = create_asset(db_session)
    schedule = maintenance_routes._create_maintenance_schedule(
        db_session,
        MaintenanceScheduleCreate(
            asset_id=asset.id,
            title="Schedule with history",
            maintenance_type="inspection",
            schedule_mode="calendar",
            schedule_start_date=today,
            first_due_date=today + timedelta(days=1),
        ),
    )
    db_session.flush()
    linked_record_id = schedule.current_occurrence_id
    monkeypatch.setattr(
        maintenance_routes,
        "access_scope",
        lambda session: SimpleNamespace(allows=lambda asset_id: True),
    )

    # Refusing deletion must leave both the schedule and its occurrence intact.
    with pytest.raises(HTTPException) as exc_info:
        maintenance_routes.permanently_delete_maintenance_schedule(
            schedule.id,
            db_session,
            SimpleNamespace(id=1, role="Administrator"),
        )

    assert exc_info.value.status_code == 409
    assert db_session.get(MaintenanceSchedule, schedule.id) is not None
    assert db_session.get(MaintenanceRecord, linked_record_id) is not None


@pytest.mark.parametrize("role", ["Supervisor", "Operator"])
def test_schedule_deletion_role_guard_rejects_non_administrators(role):
    # Exercise direct DELETE requests through the same authentication dependency as production.
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.routes.auth import get_current_user

    test_app = FastAPI()
    test_app.include_router(maintenance_routes.router)
    test_app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(role=role)
    test_app.dependency_overrides[maintenance_routes.get_db] = lambda: None

    response = TestClient(test_app).delete("/maintenance/schedules/1/permanent")

    assert response.status_code == 403


def test_administrator_can_delete_schedule_without_occurrences(
    db_session,
    schedule_route_mocks,
    monkeypatch,
):
    asset = create_asset(db_session)
    variable = create_signal_variable(
        db_session,
        asset_id=asset.id,
        signal_role="running",
    )
    schedule = maintenance_routes._create_maintenance_schedule(
        db_session,
        MaintenanceScheduleCreate(
            asset_id=asset.id,
            title="Schedule without occurrences",
            maintenance_type="preventive",
            schedule_mode="runtime",
            signal_variable_id=variable.id,
            runtime_interval_hours=100,
        ),
    )
    db_session.flush()
    monkeypatch.setattr(
        maintenance_routes,
        "access_scope",
        lambda session: SimpleNamespace(allows=lambda asset_id: True),
    )
    monkeypatch.setattr(maintenance_routes, "emit_event", lambda *args, **kwargs: None)

    # An occurrence-free schedule can use the existing permanent-delete workflow.
    maintenance_routes.permanently_delete_maintenance_schedule(
        schedule.id,
        db_session,
        SimpleNamespace(id=1, role="Administrator"),
    )

    assert db_session.get(MaintenanceSchedule, schedule.id) is None


# RUNTIME SCHEDULE CREATION
def test_runtime_schedule_is_created_without_initial_occurrence(
    db_session,
    schedule_route_mocks,
):
    asset = create_asset(db_session)

    variable = create_signal_variable(
        db_session,
        asset_id=asset.id,
        signal_role="running",
    )

    payload = MaintenanceScheduleCreate(
        asset_id=asset.id,
        title="Runtime integration test",
        maintenance_type="preventive",
        schedule_mode="runtime",
        signal_variable_id=variable.id,
        runtime_interval_hours=100,
    )

    schedule = maintenance_routes._create_maintenance_schedule(
        db_session,
        payload,
    )

    db_session.flush()

    assert schedule.schedule_mode == "runtime"
    assert schedule.signal_variable_id == variable.id
    assert schedule.runtime_interval_hours == 100
    assert schedule.usage_interval_count is None

    assert schedule.schedule_start_date == date.today()
    assert schedule.first_due_date == date.today()
    assert schedule.current_due_date is None

    assert schedule.current_progress == 0
    assert schedule.current_occurrence_id is None
    assert record_count(db_session, schedule.id) == 0

    assert len(schedule_route_mocks) == 1
    assert schedule_route_mocks[0]["schedule_id"] == schedule.id
    assert schedule_route_mocks[0]["event_type"] == (
        "maintenance_schedule_created"
    )
    assert schedule_route_mocks[0]["due_date"] is None



# USAGE SCHEDULE CREATION
def test_usage_schedule_is_created_without_initial_occurrence(
    db_session,
    schedule_route_mocks,
):
    asset = create_asset(db_session)

    variable = create_signal_variable(
        db_session,
        asset_id=asset.id,
        signal_role="cycle",
    )

    payload = MaintenanceScheduleCreate(
        asset_id=asset.id,
        title="Usage integration test",
        maintenance_type="inspection",
        schedule_mode="usage",
        signal_variable_id=variable.id,
        usage_interval_count=500,
    )

    schedule = maintenance_routes._create_maintenance_schedule(
        db_session,
        payload,
    )

    db_session.flush()

    assert schedule.schedule_mode == "usage"
    assert schedule.signal_variable_id == variable.id
    assert schedule.usage_interval_count == 500
    assert schedule.runtime_interval_hours is None

    assert schedule.schedule_start_date == date.today()
    assert schedule.first_due_date == date.today()
    assert schedule.current_due_date is None

    assert schedule.current_progress == 0
    assert schedule.current_occurrence_id is None
    assert record_count(db_session, schedule.id) == 0

    assert len(schedule_route_mocks) == 1
    assert schedule_route_mocks[0]["schedule_id"] == schedule.id
    assert schedule_route_mocks[0]["event_type"] == (
        "maintenance_schedule_created"
    )
    assert schedule_route_mocks[0]["due_date"] is None



# SIGNAL ROLE VALIDATION
@pytest.mark.parametrize(
    ("schedule_mode", "signal_role"),
    [
        ("runtime", "cycle"),
        ("usage", "running"),
    ],
)
def test_schedule_rejects_wrong_signal_role(
    db_session,
    schedule_route_mocks,
    schedule_mode,
    signal_role,
):
    asset = create_asset(db_session)

    variable = create_signal_variable(
        db_session,
        asset_id=asset.id,
        signal_role=signal_role,
    )

    payload_data = {
        "asset_id": asset.id,
        "title": "Invalid signal test",
        "maintenance_type": "inspection",
        "schedule_mode": schedule_mode,
        "signal_variable_id": variable.id,
    }

    if schedule_mode == "runtime":
        payload_data["runtime_interval_hours"] = 100
    else:
        payload_data["usage_interval_count"] = 500

    payload = MaintenanceScheduleCreate(**payload_data)

    initial_count = schedule_count(db_session)

    with pytest.raises(HTTPException) as exc_info:
        maintenance_routes._create_maintenance_schedule(
            db_session,
            payload,
        )

    assert exc_info.value.status_code == 422
    assert schedule_count(db_session) == initial_count
    assert schedule_route_mocks == []


def test_schedule_rejects_signal_variable_from_another_asset(
    db_session,
    schedule_route_mocks,
):
    asset = create_asset(db_session)
    another_asset = create_asset(db_session)

    variable = create_signal_variable(
        db_session,
        asset_id=another_asset.id,
        signal_role="running",
    )

    payload = MaintenanceScheduleCreate(
        asset_id=asset.id,
        title="Foreign signal test",
        maintenance_type="inspection",
        schedule_mode="runtime",
        signal_variable_id=variable.id,
        runtime_interval_hours=100,
    )

    initial_count = schedule_count(db_session)

    with pytest.raises(HTTPException) as exc_info:
        maintenance_routes._create_maintenance_schedule(
            db_session,
            payload,
        )

    assert exc_info.value.status_code == 422
    assert schedule_count(db_session) == initial_count
    assert schedule_route_mocks == []



# TEST DATA HELPERS

def create_pending_calendar_schedule(
    session: Session,
    schedule_route_mocks,
):
    today = date.today()
    first_due = today + timedelta(days=14)

    asset = create_asset(session)

    payload = MaintenanceScheduleCreate(
        asset_id=asset.id,
        title="Pending recurrence test",
        maintenance_type="inspection",
        schedule_mode="calendar",
        schedule_start_date=today,
        first_due_date=first_due,
        recurrence_enabled=True,
        recurrence_interval=1,
        recurrence_unit="months",
    )

    schedule = maintenance_routes._create_maintenance_schedule(
        session,
        payload,
    )

    schedule.approval_status = "pending"
    schedule.proposed_due_date = maintenance_routes.next_due_date(
        schedule.first_due_date,
        interval=1,
        unit="months",
        after=schedule.current_due_date,
    )

    session.flush()

    return schedule


def create_runtime_or_usage_schedule_with_occurrence(
    session: Session,
    schedule_route_mocks,
    *,
    schedule_mode: str,
):
    asset = create_asset(session)

    signal_role = "running" if schedule_mode == "runtime" else "cycle"

    variable = create_signal_variable(
        session,
        asset_id=asset.id,
        signal_role=signal_role,
    )

    payload_data = {
        "asset_id": asset.id,
        "title": f"{schedule_mode.title()} cancellation test",
        "maintenance_type": "inspection",
        "schedule_mode": schedule_mode,
        "signal_variable_id": variable.id,
    }

    if schedule_mode == "runtime":
        payload_data["runtime_interval_hours"] = 100
    else:
        payload_data["usage_interval_count"] = 500

    schedule = maintenance_routes._create_maintenance_schedule(
        session,
        MaintenanceScheduleCreate(**payload_data),
    )

    occurrence = MaintenanceRecord(
        asset_id=asset.id,
        summary=f"{schedule_mode.title()} maintenance occurrence",
        performed_by="Cancellation Test",
        maintenance_type="inspection",
        status="planned",
        schedule_id=schedule.id,
        planned_due_date=None,
    )

    session.add(occurrence)
    session.flush()

    schedule.current_occurrence_id = occurrence.id

    now = maintenance_routes.utc_now()

    alert = Alert(
        rule_id=None,
        maintenance_schedule_id=schedule.id,
        maintenance_due_date=date.today(),
        target_asset_id=asset.id,
        target_variable_id=variable.id,
        severity="warning",
        title=f"{schedule_mode.title()} maintenance due",
        message="Maintenance threshold reached.",
        status="active",
        started_at=now,
        last_updated_at=now,
    )

    session.add(alert)
    session.flush()

    return schedule, occurrence, alert



# PENDING RECURRENCE PROPOSAL TESTS

def test_pending_proposal_recalculates_when_interval_changes(
    db_session,
    schedule_route_mocks,
):
    schedule = create_pending_calendar_schedule(
        db_session,
        schedule_route_mocks,
    )

    previous_due = schedule.current_due_date
    old_proposal = schedule.proposed_due_date

    payload = MaintenanceScheduleUpdate(
        recurrence_interval=2,
    )

    maintenance_routes.update_maintenance_schedule(
        schedule.id,
        payload,
        db_session,
        SimpleNamespace(role="Administrator"),
    )

    expected_proposal = maintenance_routes.next_due_date(
        schedule.first_due_date,
        interval=2,
        unit="months",
        after=previous_due,
    )

    assert schedule.recurrence_interval == 2
    assert schedule.current_due_date == previous_due
    assert schedule.proposed_due_date == expected_proposal
    assert schedule.proposed_due_date != old_proposal
    assert schedule.approval_status == "pending"


def test_pending_proposal_recalculates_when_recurrence_unit_changes(
    db_session,
    schedule_route_mocks,
):
    schedule = create_pending_calendar_schedule(
        db_session,
        schedule_route_mocks,
    )

    previous_due = schedule.current_due_date

    payload = MaintenanceScheduleUpdate(
        recurrence_unit="weeks",
    )

    maintenance_routes.update_maintenance_schedule(
        schedule.id,
        payload,
        db_session,
        SimpleNamespace(role="Administrator"),
    )

    expected_proposal = maintenance_routes.next_due_date(
        schedule.first_due_date,
        interval=schedule.recurrence_interval,
        unit="weeks",
        after=previous_due,
    )

    assert schedule.recurrence_unit == "weeks"
    assert schedule.current_due_date == previous_due
    assert schedule.proposed_due_date == expected_proposal
    assert schedule.approval_status == "pending"


def test_pending_proposal_recalculates_when_first_due_date_changes(
    db_session,
    schedule_route_mocks,
):
    schedule = create_pending_calendar_schedule(
        db_session,
        schedule_route_mocks,
    )

    previous_due = schedule.current_due_date
    new_first_due = schedule.first_due_date + timedelta(days=7)

    payload = MaintenanceScheduleUpdate(
        first_due_date=new_first_due,
    )

    maintenance_routes.update_maintenance_schedule(
        schedule.id,
        payload,
        db_session,
        SimpleNamespace(role="Administrator"),
    )

    expected_proposal = maintenance_routes.next_due_date(
        new_first_due,
        interval=schedule.recurrence_interval,
        unit=schedule.recurrence_unit,
        after=previous_due,
    )

    assert schedule.first_due_date == new_first_due
    assert schedule.current_due_date == previous_due
    assert schedule.proposed_due_date == expected_proposal
    assert schedule.approval_status == "pending"



# MAINTENANCE CANCELLATION TESTS

@pytest.mark.parametrize("schedule_mode", ["runtime", "usage"])
def test_cancelling_runtime_or_usage_record_clears_schedule_pointer(
    db_session,
    schedule_route_mocks,
    monkeypatch,
    schedule_mode,
):


    schedule, occurrence, alert = (
        create_runtime_or_usage_schedule_with_occurrence(
            db_session,
            schedule_route_mocks,
            schedule_mode=schedule_mode,
        )
    )

    monkeypatch.setattr(
        maintenance_routes,
        "_emit_maintenance_event",
        lambda *args, **kwargs: None,
    )

    result = maintenance_routes.cancel_maintenance_record(
        occurrence.id,
        db_session,
    )

    db_session.flush()

    assert result.status == "cancelled"
    assert schedule.status == "cancelled"
    assert schedule.current_occurrence_id is None

    # Historical occurrence must remain in the database.
    assert db_session.get(MaintenanceRecord, occurrence.id) is not None

    assert alert.status == "resolved"
    assert alert.resolved_at is not None
    assert alert.last_updated_at is not None


def test_cancelling_schedule_cancels_planned_occurrence_and_resolves_alert(
    db_session,
    schedule_route_mocks,
    monkeypatch,
):

    schedule, occurrence, alert = (
        create_runtime_or_usage_schedule_with_occurrence(
            db_session,
            schedule_route_mocks,
            schedule_mode="runtime",
        )
    )

    monkeypatch.setattr(
        maintenance_routes,
        "_emit_maintenance_event",
        lambda *args, **kwargs: None,
    )

    payload = MaintenanceScheduleUpdate(status="cancelled")

    result = maintenance_routes.update_maintenance_schedule(
        schedule.id,
        payload,
        db_session,
        SimpleNamespace(role="Administrator"),
    )

    db_session.flush()

    assert result.status == "cancelled"

    # The planned occurrence must be cancelled with its schedule.
    assert occurrence.status == "cancelled"

    # The schedule must not retain a pointer to the cancelled occurrence.
    assert schedule.current_occurrence_id is None

    # Cancellation must preserve historical maintenance records.
    assert db_session.get(MaintenanceRecord, occurrence.id) is not None

    # The associated active due alert must be resolved.
    assert alert.status == "resolved"
    assert alert.resolved_at is not None


# TERMINAL SCHEDULE STATE TESTS
@pytest.mark.parametrize("previous_status", ["cancelled"])
@pytest.mark.parametrize("requested_status", ["active", "paused"])
def test_cancelled_schedule_cannot_be_reactivated(
    db_session,
    schedule_route_mocks,
    previous_status,
    requested_status,
):
    asset = create_asset(db_session)

    variable = create_signal_variable(
        db_session,
        asset_id=asset.id,
        signal_role="running",
    )

    payload = MaintenanceScheduleCreate(
        asset_id=asset.id,
        title="Terminal schedule test",
        maintenance_type="inspection",
        schedule_mode="runtime",
        signal_variable_id=variable.id,
        runtime_interval_hours=100,
    )

    schedule = maintenance_routes._create_maintenance_schedule(
        db_session,
        payload,
    )

    schedule.status = previous_status
    db_session.flush()

    with pytest.raises(HTTPException) as exc_info:
        maintenance_routes.update_maintenance_schedule(
            schedule.id,
            MaintenanceScheduleUpdate(status=requested_status),
            db_session,
            SimpleNamespace(role="Administrator"),
        )

    assert exc_info.value.status_code == 409
    assert schedule.status == "cancelled"
