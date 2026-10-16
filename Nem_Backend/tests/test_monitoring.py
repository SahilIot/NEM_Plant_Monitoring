from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.models import Alert, MonitoringEvent, MonitoringRule, RuleState
from app.services.monitoring_engine import evaluate_rules
from tests.test_api import create_asset, create_reading, create_variable


def make_threshold_rule(client, asset_id, variable_id, *, name, threshold, severity):
    response = client.post(
        "/api/v1/rules",
        json={
            "name": name,
            "rule_type": "parameter_threshold",
            "target_asset_id": asset_id,
            "variable_id": variable_id,
            "operator": ">=",
            "threshold": threshold,
            "severity": severity,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def latest_state(client, rule_id):
    response = client.get(f"/api/v1/rules/{rule_id}/status")
    assert response.status_code == 200, response.text
    return response.json()


def test_rule_creation_scopes_cycle_threshold_validation_to_count_rules(client):
    asset_id = create_asset(client)
    numeric_variable_id = create_variable(client, asset_id)

    parameter_rule = client.post(
        "/api/v1/rules",
        json={
            "name": "Temperature threshold",
            "rule_type": "parameter_threshold",
            "target_asset_id": asset_id,
            "variable_id": numeric_variable_id,
            "operator": ">",
            "threshold": 80,
            "severity": "warning",
        },
    )
    assert parameter_rule.status_code == 201, parameter_rule.text

    boolean_variable_id = create_variable(
        client, asset_id, key="cycle_signal", data_type="boolean"
    )
    count_rule = client.post(
        "/api/v1/rules",
        json={
            "name": "Cycle count thresholds",
            "rule_type": "boolean_count_threshold",
            "target_asset_id": asset_id,
            "variable_id": boolean_variable_id,
            "parameters": {
                "warning_thresholds": [100, 200],
                "alert_threshold": 300,
            },
            "severity": "warning",
        },
    )
    assert count_rule.status_code == 201, count_rule.text

    invalid_count_rule = client.post(
        "/api/v1/rules",
        json={
            "name": "Missing cycle thresholds",
            "rule_type": "boolean_count_threshold",
            "target_asset_id": asset_id,
            "variable_id": boolean_variable_id,
            "severity": "warning",
        },
    )
    assert invalid_count_rule.status_code == 422


def test_threshold_normal_warning_alert_recovery_and_deduplication(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    warning_rule = make_threshold_rule(
        client, asset_id, variable_id, name="Warm", threshold=80, severity="warning"
    )
    alert_rule = make_threshold_rule(
        client, asset_id, variable_id, name="Overheat", threshold=100, severity="alert"
    )

    create_reading(client, asset_id, variable_id, 70)
    client.post("/api/v1/monitoring/evaluate")
    assert latest_state(client, warning_rule)["status"] == "normal"
    assert latest_state(client, alert_rule)["status"] == "normal"

    create_reading(client, asset_id, variable_id, 85)
    assert latest_state(client, warning_rule)["status"] == "warning"
    assert latest_state(client, alert_rule)["status"] == "normal"
    first_active = client.get("/api/v1/alerts/active").json()
    assert first_active["total"] == 1
    warning_alert_id = first_active["items"][0]["id"]

    create_reading(client, asset_id, variable_id, 110)
    assert latest_state(client, alert_rule)["status"] == "alert"
    # Repeated evaluation of the same condition updates, but does not duplicate, alert episodes.
    client.post("/api/v1/monitoring/evaluate")
    assert client.get("/api/v1/alerts/active").json()["total"] == 2

    create_reading(client, asset_id, variable_id, 70)
    assert latest_state(client, warning_rule)["status"] == "normal"
    assert latest_state(client, alert_rule)["status"] == "normal"
    active = client.get("/api/v1/alerts/active").json()
    assert active["total"] == 0
    history = client.get("/api/v1/alerts?lifecycle_status=resolved").json()
    assert history["total"] == 2
    assert client.get(f"/api/v1/alerts/{warning_alert_id}").json()["status"] == "resolved"
    events = client.get(f"/api/v1/events?asset_id={asset_id}").json()
    event_types = [row["event_type"] for row in events["items"]]
    assert event_types.count("warning_triggered") == 1
    assert event_types.count("alert_triggered") == 1
    assert event_types.count("condition_returned_to_normal") == 2
    assert client.get(f"/api/v1/events?rule_id={warning_rule}&limit=1").json()["total"] >= 3


def test_manual_monitoring_evaluation_uses_application_settings(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    rule_id = make_threshold_rule(
        client, asset_id, variable_id, name="Manual evaluation", threshold=80, severity="warning"
    )
    create_reading(client, asset_id, variable_id, 70)

    response = client.post(f"/api/v1/monitoring/evaluate?rule_id={rule_id}")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "evaluated": 1,
        "unknown": 0,
        "normal": 1,
        "warning": 0,
        "alert": 0,
    }


def test_acknowledgement_does_not_resolve_and_preserves_optional_identity(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    rule_id = make_threshold_rule(
        client, asset_id, variable_id, name="Critical", threshold=90, severity="alert"
    )
    create_reading(client, asset_id, variable_id, 99)
    active = client.get(f"/api/v1/alerts/active?rule_id={rule_id}").json()["items"][0]
    acknowledged = client.post(
        f"/api/v1/alerts/{active['id']}/acknowledge",
        json={"acknowledged_by": "operator-17"},
    )
    assert acknowledged.status_code == 200
    assert acknowledged.json()["status"] == "active"
    assert acknowledged.json()["acknowledged_by"] == "operator-17"
    assert client.get("/api/v1/alerts/active?acknowledged=true").json()["total"] == 1
    # Repeating acknowledgement is idempotent and creates no second acknowledgement event.
    client.post(f"/api/v1/alerts/{active['id']}/acknowledge", json={})
    event_rows = client.get("/api/v1/events?event_type=alert_acknowledged").json()
    assert event_rows["total"] == 1
    create_reading(client, asset_id, variable_id, 20)
    assert client.get(f"/api/v1/alerts/{active['id']}").json()["status"] == "resolved"
    assert client.post(
        f"/api/v1/alerts/{active['id']}/acknowledge", json={}
    ).status_code == 409


def test_rule_severity_change_updates_active_alert_without_duplicate(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    rule_id = make_threshold_rule(
        client, asset_id, variable_id, name="Severity change", threshold=80, severity="warning"
    )
    create_reading(client, asset_id, variable_id, 90)
    alert = client.get(f"/api/v1/alerts/active?rule_id={rule_id}").json()["items"][0]
    changed = client.patch(f"/api/v1/rules/{rule_id}", json={"severity": "alert"})
    assert changed.status_code == 200
    client.post("/api/v1/monitoring/evaluate")
    current = client.get(f"/api/v1/alerts/{alert['id']}").json()
    assert current["severity"] == "alert"
    assert client.get(f"/api/v1/alerts/active?rule_id={rule_id}").json()["total"] == 1
    assert client.get("/api/v1/events?event_type=alert_severity_changed").json()["total"] == 1


def test_disabling_rule_closes_active_alert_and_preserves_history(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    rule_id = make_threshold_rule(
        client, asset_id, variable_id, name="Disable me", threshold=20, severity="warning"
    )
    create_reading(client, asset_id, variable_id, 30)
    alert = client.get(f"/api/v1/alerts/active?rule_id={rule_id}").json()["items"][0]
    assert client.patch(f"/api/v1/rules/{rule_id}", json={"is_enabled": False}).status_code == 200
    create_reading(client, asset_id, variable_id, 50)
    client.post("/api/v1/monitoring/evaluate")
    assert latest_state(client, rule_id)["status"] == "unknown"
    closed_alert = client.get(f"/api/v1/alerts/{alert['id']}").json()
    assert closed_alert["status"] == "resolved"
    assert closed_alert["resolved_at"] is not None
    assert client.get(f"/api/v1/alerts/active?rule_id={rule_id}").json()["total"] == 0
    assert client.get("/api/v1/events?event_type=rule_disabled").json()["total"] == 1
    assert client.patch(f"/api/v1/rules/{rule_id}", json={"is_enabled": True}).status_code == 200
    create_reading(client, asset_id, variable_id, 0)
    assert client.get(f"/api/v1/alerts/{alert['id']}").json()["status"] == "resolved"


def test_disabled_rule_can_be_archived_without_deleting_history(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    rule_id = make_threshold_rule(
        client, asset_id, variable_id, name="Archive me", threshold=20, severity="alert"
    )
    create_reading(client, asset_id, variable_id, 30)
    alert = client.get(f"/api/v1/alerts/active?rule_id={rule_id}").json()["items"][0]

    assert client.delete(f"/api/v1/rules/{rule_id}").status_code == 409
    assert client.patch(
        f"/api/v1/rules/{rule_id}", json={"is_enabled": False}
    ).status_code == 200
    assert client.delete(f"/api/v1/rules/{rule_id}").status_code == 204

    assert client.get(f"/api/v1/assets/{asset_id}/rules").json() == []
    assert client.get(f"/api/v1/rules/{rule_id}").status_code == 404
    assert client.get(f"/api/v1/alerts/{alert['id']}").json()["status"] == "resolved"
    archived_event = client.get(
        f"/api/v1/events?rule_id={rule_id}&event_type=rule_archived"
    )
    assert archived_event.status_code == 200
    assert archived_event.json()["total"] == 1


def test_missing_stale_and_future_data_never_claim_normal(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    rule_response = client.post(
        "/api/v1/rules",
        json={
            "name": "Freshness",
            "rule_type": "parameter_threshold",
            "target_asset_id": asset_id,
            "variable_id": variable_id,
            "operator": ">",
            "threshold": 100,
            "severity": "alert",
            "stale_after_seconds": 5,
        },
    )
    rule_id = rule_response.json()["id"]
    client.post("/api/v1/monitoring/evaluate")
    assert latest_state(client, rule_id)["status"] == "unknown"
    stale_time = datetime.now(timezone.utc) - timedelta(minutes=1)
    create_reading(client, asset_id, variable_id, 10, stale_time)
    assert latest_state(client, rule_id)["status"] == "unknown"
    assert client.get("/api/v1/events?event_type=stale_data_detected").json()["total"] == 1
    assert create_reading(
        client, asset_id, variable_id, 10, datetime.now(timezone.utc) + timedelta(minutes=10)
    ).status_code == 422

    client.post(
        "/api/v1/readings",
        json={
            "asset_id": asset_id,
            "variable_id": variable_id,
            "value": "invalid-for-number",
        },
    )
    assert latest_state(client, rule_id)["status"] == "unknown"


def test_duration_condition_waits_persists_across_evaluation_and_recovers(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="operating_state", data_type="string")
    rule = client.post(
        "/api/v1/rules",
        json={
            "name": "Stopped for five seconds",
            "rule_type": "duration",
            "target_asset_id": asset_id,
            "variable_id": variable_id,
            "parameters": {
                "condition": "equals",
                "expected_value": "stopped",
                "duration_seconds": 5,
            },
            "severity": "warning",
        },
    )
    assert rule.status_code == 201, rule.text
    rule_id = rule.json()["id"]
    t0 = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert create_reading(client, asset_id, variable_id, "stopped", t0).status_code == 201
    state = latest_state(client, rule_id)
    assert state["status"] == "normal"
    assert state["condition_started_at"] is not None

    app = client.app
    with app.state.session_factory() as session:
        result = evaluate_rules(
            session,
            evaluated_at=t0 + timedelta(seconds=4),
            stale_after_seconds=3600,
            rule_id=rule_id,
        )
        session.commit()
        assert result["normal"] == 1
    assert latest_state(client, rule_id)["status"] == "normal"

    with app.state.session_factory() as session:
        result = evaluate_rules(
            session,
            evaluated_at=t0 + timedelta(seconds=6),
            stale_after_seconds=3600,
            rule_id=rule_id,
        )
        session.commit()
        assert result["warning"] == 1
        state = session.scalar(select(RuleState).where(RuleState.rule_id == rule_id))
        assert state.condition_started_at is not None
        assert session.scalar(
            select(func.count()).select_from(Alert).where(Alert.rule_id == rule_id)
        ) == 1
    create_reading(client, asset_id, variable_id, "running")
    assert latest_state(client, rule_id)["status"] == "normal"
    assert client.get(f"/api/v1/alerts?rule_id={rule_id}&lifecycle_status=resolved").json()["total"] == 1


def test_scheduler_respects_per_rule_interval_but_ingestion_evaluates_immediately(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    rule_id = make_threshold_rule(
        client, asset_id, variable_id, name="Interval", threshold=10, severity="alert"
    )
    assert client.patch(
        f"/api/v1/rules/{rule_id}", json={"evaluation_interval_seconds": 60}
    ).status_code == 200
    create_reading(client, asset_id, variable_id, 20)

    app = client.app
    with app.state.session_factory() as session:
        state = session.scalar(select(RuleState).where(RuleState.rule_id == rule_id))
        evaluated_at = state.last_evaluated_at
        result = evaluate_rules(
            session,
            evaluated_at=evaluated_at + timedelta(seconds=10),
            stale_after_seconds=3600,
            rule_id=rule_id,
            respect_rule_intervals=True,
        )
        assert result["evaluated"] == 0
        result = evaluate_rules(
            session,
            evaluated_at=evaluated_at + timedelta(seconds=61),
            stale_after_seconds=3600,
            rule_id=rule_id,
            respect_rule_intervals=True,
        )
        assert result["alert"] == 1
        session.commit()
    assert client.get(f"/api/v1/alerts/active?rule_id={rule_id}").json()["total"] == 1


def test_dashboard_counts_persisted_rules_and_active_alerts_per_asset(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    first_rule = make_threshold_rule(
        client, asset_id, variable_id, name="Warning", threshold=10, severity="warning"
    )
    second_rule = make_threshold_rule(
        client, asset_id, variable_id, name="Alert", threshold=20, severity="alert"
    )
    create_reading(client, asset_id, variable_id, 30)
    client.patch(f"/api/v1/rules/{first_rule}", json={"is_enabled": False})

    summary = client.get("/api/v1/dashboard/summary").json()
    assert summary["assets_in_alert_state"] == 1
    assert summary["assets_in_warning_state"] == 1
    assert summary["total_active_alerts"] == 2
    assert summary["unacknowledged_active_alerts"] == 2
    assert summary["enabled_rules"] == 1
    assert summary["disabled_rules"] == 1
    assert summary["rules_alert"] == 1
    assert summary["rules_unknown"] == 0


def test_alert_and_event_filters_and_stable_pagination(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    make_threshold_rule(
        client, asset_id, variable_id, name="Event filter", threshold=1, severity="alert"
    )
    create_reading(client, asset_id, variable_id, 5)
    page = client.get(f"/api/v1/events?asset_id={asset_id}&limit=1&offset=0").json()
    assert page["total"] >= 1
    assert len(page["items"]) == 1
    assert client.get("/api/v1/events?severity=invalid").status_code == 422
    assert client.get("/api/v1/alerts?lifecycle_status=invalid").status_code == 422


def test_asset_event_log_shows_only_rule_alert_and_machine_stop_events(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    rule_id = make_threshold_rule(
        client, asset_id, variable_id, name="Visible alert", threshold=1, severity="alert"
    )
    create_reading(client, asset_id, variable_id, 5)

    with client.app.state.session_factory() as session:
        occurred_at = datetime.now(timezone.utc)
        session.add_all(
            [
                MonitoringEvent(
                    event_type="machine_cycle_counted",
                    message="Cycle pulse",
                    occurred_at=occurred_at,
                    asset_id=asset_id,
                ),
                MonitoringEvent(
                    event_type="evaluation_failure",
                    message="Evaluation noise",
                    occurred_at=occurred_at,
                    asset_id=asset_id,
                    rule_id=rule_id,
                ),
                MonitoringEvent(
                    event_type="machine_stopped",
                    message="Machine stopped",
                    occurred_at=occurred_at,
                    asset_id=asset_id,
                ),
            ]
        )
        session.commit()

    events = client.get(f"/api/v1/assets/{asset_id}/events").json()
    messages = [event["text"] for event in events]
    assert "Machine stopped" in messages
    assert any("Rule 'Visible alert' created." == message for message in messages)
    assert any("Visible alert" in message for message in messages)
    assert "Cycle pulse" not in messages
    assert "Evaluation noise" not in messages
