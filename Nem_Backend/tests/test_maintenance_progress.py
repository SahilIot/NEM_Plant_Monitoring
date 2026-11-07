from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.services.maintenance_progress import update_maintenance_progress


class FakeResult:
    def __init__(self, items):
        self.items = items

    def all(self):
        return self.items


class FakeSession:
    def __init__(self, schedule, variable):
        self.schedule = schedule
        self.variable = variable

    def scalars(self, statement):
        return FakeResult([self.schedule])

    def get(self, model, object_id):
        return self.variable


def make_schedule(mode):
    return SimpleNamespace(
        id=1,
        asset_id=10,
        signal_variable_id=20,
        schedule_mode=mode,
        status="active",
        current_occurrence_id=None,
        current_progress=0.0,
        last_signal_value=None,
        last_signal_at=None,
        runtime_interval_hours=100.0 if mode == "runtime" else None,
        usage_interval_count=100 if mode == "usage" else None,
    )


def make_variable(role):
    return SimpleNamespace(
        id=20,
        is_active=True,
        data_type="boolean",
        signal_role=role,
    )


def make_reading(value, timestamp, reading_id):
    return SimpleNamespace(
        id=reading_id,
        asset_id=10,
        variable_id=20,
        value=value,
        recorded_at=timestamp,
    )


def test_runtime_accumulates_only_while_running():
    schedule = make_schedule("runtime")
    session = FakeSession(schedule, make_variable("running"))

    start = datetime(2026, 11, 7, 10, 0, tzinfo=timezone.utc)

    readings = [
        make_reading(True, start, 1),
        make_reading(True, start + timedelta(minutes=30), 2),
        make_reading(False, start + timedelta(hours=1), 3),
        make_reading(False, start + timedelta(hours=1, minutes=30), 4),
    ]

    result = update_maintenance_progress(
        session, readings, stale_after_seconds=3600
    )

    assert result == 0
    assert abs(schedule.current_progress - 1.0) < 0.000001


def test_usage_counts_false_to_true_edges_only():
    schedule = make_schedule("usage")
    session = FakeSession(schedule, make_variable("cycle"))

    start = datetime(2026, 11, 7, 10, 0, tzinfo=timezone.utc)

    readings = [
        make_reading(False, start, 1),
        make_reading(True, start + timedelta(seconds=1), 2),
        make_reading(True, start + timedelta(seconds=2), 3),
        make_reading(False, start + timedelta(seconds=3), 4),
        make_reading(True, start + timedelta(seconds=4), 5),
        make_reading(False, start + timedelta(seconds=5), 6),
    ]

    result = update_maintenance_progress(
        session, readings, stale_after_seconds=60
    )

    assert result == 0
    assert schedule.current_progress == 2.0


def test_stale_runtime_gap_is_not_counted():
    schedule = make_schedule("runtime")
    session = FakeSession(schedule, make_variable("running"))

    start = datetime(2026, 11, 7, 10, 0, tzinfo=timezone.utc)

    readings = [
        make_reading(True, start, 1),
        make_reading(True, start + timedelta(minutes=10), 2),
        make_reading(True, start + timedelta(minutes=10, seconds=30), 3),
    ]

    result = update_maintenance_progress(
        session, readings, stale_after_seconds=60
    )

    assert result == 0
    assert abs(schedule.current_progress - (30 / 3600)) < 0.000001


def test_runtime_threshold_creates_one_alert_and_occurrence(monkeypatch):
    import app.services.maintenance_progress as progress_module
    from app.models.maintenance import MaintenanceRecord, MaintenanceSchedule
    from app.models.rule import Alert

    schedule = make_schedule("runtime")
    schedule.runtime_interval_hours = 0.5
    schedule.title = "Runtime service"
    schedule.description = "Runtime maintenance test"
    schedule.maintenance_type = "preventive"
    schedule.assigned_technician = None
    schedule.priority = "medium"

    variable = make_variable("running")

    class ThresholdSession(FakeSession):
        def __init__(self):
            super().__init__(schedule, variable)
            self.added = []
            self.next_id = 100

        def scalars(self, statement):
            entity = statement.column_descriptions[0]["entity"]

            if entity is MaintenanceSchedule:
                return FakeResult([schedule])
            if entity is Alert:
                return FakeResult([])
            if entity is MaintenanceRecord:
                return FakeResult([])

            return FakeResult([])

        def add(self, item):
            self.added.append(item)

        def flush(self):
            for item in self.added:
                if getattr(item, "id", None) is None:
                    item.id = self.next_id
                    self.next_id += 1

        def get(self, model, object_id):
            if model.__name__ == "Variable":
                return variable
            return None

    session = ThresholdSession()
    events = []
    monkeypatch.setattr(
        progress_module,
        "emit_event",
        lambda *args, **kwargs: events.append(kwargs),
    )

    start = datetime(2026, 11, 7, 10, 0, tzinfo=timezone.utc)

    readings = [
        make_reading(True, start, 1),
        make_reading(True, start + timedelta(minutes=30), 2),
    ]

    result = update_maintenance_progress(
        session, readings, stale_after_seconds=3600
    )

    duplicate_result = update_maintenance_progress(
        session,
        [
            make_reading(
                True,
                start + timedelta(minutes=45),
                3,
            )
        ],
        stale_after_seconds=3600,
    )

    assert duplicate_result == 0

    alerts = [item for item in session.added if isinstance(item, Alert)]
    records = [
        item for item in session.added
        if isinstance(item, MaintenanceRecord)
    ]

    assert result == 1
    assert len(alerts) == 1
    assert len(records) == 1
    assert records[0].alert_id == alerts[0].id
    assert schedule.current_occurrence_id == records[0].id
    assert len(events) == 1


def test_usage_threshold_creates_one_alert_and_occurrence(monkeypatch):
    import app.services.maintenance_progress as progress_module
    from app.models.maintenance import MaintenanceRecord, MaintenanceSchedule
    from app.models.rule import Alert

    schedule = make_schedule("usage")
    schedule.usage_interval_count = 2
    schedule.title = "Cycle service"
    schedule.description = "Usage maintenance test"
    schedule.maintenance_type = "preventive"
    schedule.assigned_technician = None
    schedule.priority = "medium"

    variable = make_variable("cycle")

    class ThresholdSession(FakeSession):
        def __init__(self):
            super().__init__(schedule, variable)
            self.added = []
            self.next_id = 200

        def scalars(self, statement):
            entity = statement.column_descriptions[0]["entity"]

            if entity is MaintenanceSchedule:
                return FakeResult([schedule])
            if entity is Alert:
                return FakeResult([])
            if entity is MaintenanceRecord:
                return FakeResult([])

            return FakeResult([])

        def add(self, item):
            self.added.append(item)

        def flush(self):
            for item in self.added:
                if getattr(item, "id", None) is None:
                    item.id = self.next_id
                    self.next_id += 1

        def get(self, model, object_id):
            if model.__name__ == "Variable":
                return variable
            return None

    session = ThresholdSession()
    events = []
    monkeypatch.setattr(
        progress_module,
        "emit_event",
        lambda *args, **kwargs: events.append(kwargs),
    )

    start = datetime(2026, 11, 7, 10, 0, tzinfo=timezone.utc)

    readings = [
        make_reading(False, start, 1),
        make_reading(True, start + timedelta(seconds=1), 2),
        make_reading(False, start + timedelta(seconds=2), 3),
        make_reading(True, start + timedelta(seconds=3), 4),
    ]

    result = update_maintenance_progress(
        session, readings, stale_after_seconds=60
    )

    duplicate_result = update_maintenance_progress(
        session,
        [
            make_reading(False, start + timedelta(seconds=4), 5),
            make_reading(True, start + timedelta(seconds=5), 6),
        ],
        stale_after_seconds=60,
    )

    assert duplicate_result == 0

    alerts = [item for item in session.added if isinstance(item, Alert)]
    records = [
        item for item in session.added
        if isinstance(item, MaintenanceRecord)
    ]

    assert result == 1
    assert len(alerts) == 1
    assert len(records) == 1
    assert records[0].alert_id == alerts[0].id
    assert schedule.current_occurrence_id == records[0].id
    assert len(events) == 1

def test_paused_schedule_does_not_accumulate_and_resume_uses_fresh_baseline():
    schedule = make_schedule("runtime")
    variable = make_variable("running")

    class PauseAwareSession(FakeSession):
        def scalars(self, statement):
            if self.schedule.status != "active":
                return FakeResult([])
            return FakeResult([self.schedule])

    session = PauseAwareSession(schedule, variable)

    start = datetime(2026, 11, 7, 10, 0, tzinfo=timezone.utc)

    # First reading establishes the initial running baseline.
    update_maintenance_progress(
        session,
        [make_reading(True, start, 1)],
        stale_after_seconds=3600,
    )

    assert schedule.current_progress == 0.0

    # Simulate pausing the schedule.
    schedule.status = "paused"
    schedule.last_signal_value = None
    schedule.last_signal_at = None

    paused_reading = make_reading(
        True,
        start + timedelta(hours=2),
        2,
    )

    result = update_maintenance_progress(
        session,
        [paused_reading],
        stale_after_seconds=3600,
    )

    assert result == 0
    assert schedule.current_progress == 0.0

    # Resume: first reading establishes a fresh baseline.
    schedule.status = "active"

    resume_time = start + timedelta(hours=3)

    result = update_maintenance_progress(
        session,
        [make_reading(True, resume_time, 3)],
        stale_after_seconds=3600,
    )

    assert result == 0
    assert schedule.current_progress == 0.0

    # Only time after the fresh baseline should be counted.
    result = update_maintenance_progress(
        session,
        [
            make_reading(
                True,
                resume_time + timedelta(minutes=10),
                4,
            )
        ],
        stale_after_seconds=3600,
    )

    assert result == 0
    assert abs(schedule.current_progress - (10 / 60)) < 0.000001