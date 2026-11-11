# Verify runtime/usage maintenance completion:
# alert resolution, progress reset, signal baseline reset, occurrence clearing,
# preservation of active/paused status, and completion event recording.

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.api.routes import maintenance as maintenance_routes
from app.models import Alert, MaintenanceRecord, MaintenanceSchedule
from app.schemas.maintenance import MaintenanceCompletion


class FakeSession:
    def __init__(self, record, schedule, alert):
        self.record = record
        self.schedule = schedule
        self.alert = alert
        self.committed = False
        self.refreshed = False

    def get(self, model, record_id):
        if model is MaintenanceRecord and record_id == self.record.id:
            return self.record
        return None

    def scalar(self, statement):
        model = statement.column_descriptions[0]["entity"]

        if model is MaintenanceSchedule:
            return self.schedule

        if model is MaintenanceRecord:
            return self.record

        if model is Alert:
            return self.alert

        return None

    def commit(self):
        self.committed = True

    def refresh(self, record):
        self.refreshed = True

    def rollback(self):
        pass


@pytest.mark.parametrize(
    ("schedule_mode", "initial_status", "expected_status", "registration"),
    [
        ("runtime", "active", "active", None),
        ("usage", "active", "active", None),
        ("runtime", "paused", "paused", None),
        ("usage", "active", "active", "registration"),
    ],
)
def test_runtime_usage_completion_resets_maintenance_progress(
    monkeypatch,
    schedule_mode,
    initial_status,
    expected_status,
    registration,
):
    completed_at = datetime(2026, 11, 7, 14, 0, tzinfo=timezone.utc)

    record = SimpleNamespace(
        id=44,
        asset_id=1,
        schedule_id=7,
        alert_id=99,
        planned_due_date=None,
        status="in_progress",
        actual_started_at=completed_at - timedelta(minutes=30),
        actual_completed_at=None,
        performed_at=None,
        summary="Routine maintenance",
        maintenance_type="preventive",
        priority="medium",
        assigned_technician=None,
        performed_by="Technician",
        notes=None,
        completion_notes="Maintenance completed",
        parts_used=[],
        checklist=[],
        planned_start_at=None,
        planned_end_at=None,
        next_due_at=None,
    )

    schedule = SimpleNamespace(
        id=7,
        asset_id=1,
        schedule_mode=schedule_mode,
        title="Machine maintenance",
        current_occurrence_id=record.id,
        current_due_date=None,
        current_progress=12.5,
        last_signal_value=True,
        last_signal_at=completed_at - timedelta(minutes=10),
        due_alerted_for=date(2026, 11, 7),
        approval_status="not_required",
        proposed_due_date=None,
        last_completed_at=None,
        status=initial_status,
        recurrence_enabled=False,
    )

    alert = SimpleNamespace(
        id=99,
        maintenance_schedule_id=7,
        status="active",
        resolved_at=None,
        last_updated_at=None,
    )

    session = FakeSession(record, schedule, alert)

    monkeypatch.setattr(
        maintenance_routes,
        "access_scope",
        lambda session: SimpleNamespace(allows=lambda asset_id: True),
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

    schedule_events = []
    maintenance_events = []

    monkeypatch.setattr(
        maintenance_routes,
        "_emit_schedule_event",
        lambda session, schedule, **kwargs: schedule_events.append(kwargs),
    )

    monkeypatch.setattr(
        maintenance_routes,
        "_emit_maintenance_event",
        lambda session, record, **kwargs: maintenance_events.append(kwargs),
    )

    user = SimpleNamespace(role="Administrator")

    result = maintenance_routes.complete_maintenance_record(
        record.id,
        session,
        user,
        MaintenanceCompletion(
            actual_completed_at=completed_at,
            performed_by="Registered technician",
            notes="Replaced the worn seal.",
            completion_notes="Tested and returned to service.",
            parts_used="Seal kit",
            checklist=[{"item": "Leak check", "completed": True}],
        )
        if registration
        else None,
    )

    # Maintenance record must be completed.
    assert result.status == "completed"
    assert result.actual_completed_at == completed_at
    assert result.performed_at == completed_at
    if registration:
        assert result.performed_by == "Registered technician"
        assert result.notes == "Replaced the worn seal."
        assert result.completion_notes == "Tested and returned to service."
        assert result.parts_used == "Seal kit"
        assert result.checklist == [{"item": "Leak check", "completed": True}]

    # Associated alert must be resolved.
    assert alert.status == "resolved"
    assert alert.resolved_at == completed_at
    assert alert.last_updated_at == completed_at

    # Maintenance-owned progress and signal baseline must be reset.
    assert schedule.current_progress == 0.0
    assert schedule.last_signal_value is None
    assert schedule.last_signal_at is None

    # Current occurrence must be cleared.
    assert schedule.current_occurrence_id is None
    assert schedule.current_due_date is None
    assert schedule.due_alerted_for is None

    # Approval state and proposed date must be cleared.
    assert schedule.approval_status == "not_required"
    assert schedule.proposed_due_date is None

    # Schedule remains active, or remains paused if it was paused.
    assert schedule.status == expected_status

    # Completion timestamp must be recorded.
    assert schedule.last_completed_at == completed_at

    # Both completion events must be emitted.
    assert any(
        event["event_type"] == "maintenance_schedule_progress_reset"
        for event in schedule_events
    )

    assert any(
        event["event_type"] == "maintenance_completed"
        for event in maintenance_events
    )

    assert session.committed is True
    assert session.refreshed is True


def test_completion_registration_schema_preserves_empty_legacy_request():
    # Existing completion clients send an empty JSON object and remain supported.
    assert not MaintenanceCompletion.model_validate({}).model_fields_set


def test_completion_registration_schema_requires_all_core_details():
    with pytest.raises(ValueError, match="Registration requires"):
        MaintenanceCompletion.model_validate({"performed_by": "Technician"})