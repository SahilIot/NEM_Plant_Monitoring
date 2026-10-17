import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from app.models import MachineMonitoringState, MonitoringEvent, Reading
from app.schemas.opcua import OpcUaMachineMapping
from app.services.opcua_collector import (
    OpcUaCollector,
    OpcUaNotification,
    _SubscriptionHandler,
    load_machine_mappings,
)
from tests.test_api import create_asset, create_variable


def configure_collector(
    client,
    asset_id,
    cycle_variable_id=None,
    running_variable_id=None,
    readings=None,
):
    mapping = {"asset_id": asset_id}
    if cycle_variable_id is not None:
        mapping["cycle_signal"] = {
            "node_id": "ns=2;s=Machine.Cycle",
            "variable_id": cycle_variable_id,
        }
        mapping["cycle_limit"] = 500
    if running_variable_id is not None:
        mapping["runtime_limit_seconds"] = 36_000
    if running_variable_id is not None:
        mapping["running_signal"] = {
            "node_id": "ns=2;s=Machine.Running",
            "variable_id": running_variable_id,
        }
    if readings is not None:
        mapping["readings"] = readings
    settings = client.app.state.settings.model_copy(
        update={"opcua_machine_mappings": json.dumps([mapping])}
    )
    collector = OpcUaCollector(settings, client.app.state.session_factory)
    client.app.state.opcua_collector = collector
    return collector


def notification(node_id, value, at):
    return OpcUaNotification(node_id=node_id, value=value, recorded_at=at)


def test_cycle_counts_only_false_to_true_transitions_and_persists(client):
    asset_id = create_asset(client)
    cycle_variable_id = create_variable(
        client, asset_id, key="cycle_signal", data_type="boolean"
    )
    collector = configure_collector(client, asset_id, cycle_variable_id)
    start = datetime.now(timezone.utc)

    for offset, value in enumerate((False, True, True, False, True)):
        collector._process_notification(
            notification(
                "ns=2;s=Machine.Cycle",
                value,
                start + timedelta(seconds=offset),
            )
        )

    with client.app.state.session_factory() as session:
        state = session.get(MachineMonitoringState, asset_id)
        assert state is not None
        assert state.cycle_count == 2
        assert state.cycle_signal is True
        assert session.query(Reading).filter_by(variable_id=cycle_variable_id).count() == 5
        assert (
            session.query(MonitoringEvent)
            .filter_by(event_type="machine_cycle_counted", asset_id=asset_id)
            .count()
            == 0
        )

    restarted = OpcUaCollector(
        collector.settings,
        client.app.state.session_factory,
    )
    with client.app.state.session_factory() as session:
        persisted = session.get(MachineMonitoringState, asset_id)
        assert persisted.cycle_count == 2
        assert persisted.last_cycle_at == start + timedelta(seconds=4)
    assert restarted.mappings[0].asset_id == asset_id


def test_invalid_values_do_not_create_readings_or_advance_state(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="cycle_signal", data_type="boolean")
    collector = configure_collector(client, asset_id, variable_id)

    collector._process_notification(
        notification("ns=2;s=Machine.Cycle", 1, datetime.now(timezone.utc))
    )

    with client.app.state.session_factory() as session:
        assert session.get(MachineMonitoringState, asset_id) is None
        assert session.query(Reading).filter_by(variable_id=variable_id).count() == 0


def test_additional_plc_readings_use_nem_ingestion_and_rule_alerts(client):
    asset_id = create_asset(client)
    cycle_variable_id = create_variable(
        client, asset_id, key="cycle_signal", data_type="boolean"
    )
    temperature_variable_id = create_variable(
        client, asset_id, key="temperature", data_type="number"
    )
    rule = client.post(
        "/api/v1/rules",
        json={
            "name": "PLC temperature high",
            "rule_type": "parameter_threshold",
            "target_asset_id": asset_id,
            "variable_id": temperature_variable_id,
            "operator": ">",
            "threshold": 80,
            "severity": "alert",
        },
    )
    assert rule.status_code == 201, rule.text
    collector = configure_collector(
        client,
        asset_id,
        cycle_variable_id,
        readings=[
            {"node_id": "ns=2;s=Machine.Temperature", "variable_id": temperature_variable_id}
        ],
    )

    collector._process_notification(
        notification(
            "ns=2;s=Machine.Temperature",
            91.5,
            datetime.now(timezone.utc),
        )
    )

    reading = client.get(
        f"/api/v1/readings/variables/{temperature_variable_id}/latest"
    )
    assert reading.status_code == 200
    assert reading.json()["value"] == 91.5
    alerts = client.get(f"/api/v1/alerts/active?asset_id={asset_id}").json()
    assert alerts["total"] == 1
    assert alerts["items"][0]["title"] == "PLC temperature high"


def test_first_true_cycle_observation_is_only_a_baseline(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="cycle_signal", data_type="boolean")
    collector = configure_collector(client, asset_id, variable_id)
    start = datetime.now(timezone.utc)

    for offset, value in enumerate((True, True, False, True)):
        collector._process_notification(
            notification(
                "ns=2;s=Machine.Cycle",
                value,
                start + timedelta(seconds=offset),
            )
        )

    with client.app.state.session_factory() as session:
        state = session.get(MachineMonitoringState, asset_id)
        assert state.cycle_count == 1


def test_running_time_is_checkpointed_and_resumes_from_persisted_total(client):
    asset_id = create_asset(client)
    cycle_variable_id = create_variable(
        client, asset_id, key="cycle_signal", data_type="boolean"
    )
    running_variable_id = create_variable(
        client, asset_id, key="running_signal", data_type="boolean"
    )
    collector = configure_collector(
        client, asset_id, cycle_variable_id, running_variable_id
    )
    start = datetime.now(timezone.utc)

    collector._process_notification(
        notification("ns=2;s=Machine.Cycle", False, start)
    )
    collector._process_notification(
        notification("ns=2;s=Machine.Running", True, start)
    )
    collector._checkpoint_runtime(start + timedelta(seconds=10))
    collector._process_notification(
        notification(
            "ns=2;s=Machine.Running",
            False,
            start + timedelta(seconds=15),
        )
    )

    with client.app.state.session_factory() as session:
        state = session.get(MachineMonitoringState, asset_id)
        assert float(state.accumulated_running_seconds) == pytest.approx(15)
        assert state.is_running is False
        assert state.last_cycle_signal_at == start
        assert (
            session.query(MonitoringEvent)
            .filter_by(event_type="machine_stopped", asset_id=asset_id)
            .count()
            == 1
        )

    collector._process_notification(
        notification(
            "ns=2;s=Machine.Running",
            True,
            start + timedelta(seconds=20),
        )
    )
    collector._checkpoint_runtime(start + timedelta(seconds=27))
    with client.app.state.session_factory() as session:
        persisted = session.get(MachineMonitoringState, asset_id)
        assert float(persisted.accumulated_running_seconds) == pytest.approx(22)
        assert persisted.is_running is True
        assert persisted.last_cycle_signal_at == start


def test_postgresql_utc_timestamp_round_trips_with_non_utc_session_timezone(client):
    asset_id = create_asset(client)
    timestamp = datetime(2026, 10, 16, 9, 12, 17, 106412, tzinfo=timezone.utc)

    with client.app.state.session_factory() as session:
        session.execute(text("SET LOCAL TIME ZONE 'Asia/Calcutta'"))
        session.add(
            MachineMonitoringState(
                asset_id=asset_id,
                last_cycle_signal_at=timestamp,
                updated_at=timestamp,
            )
        )
        session.commit()

    with client.app.state.session_factory() as session:
        session.execute(text("SET LOCAL TIME ZONE 'Asia/Calcutta'"))
        state = session.get(MachineMonitoringState, asset_id)
        stored_timestamp = session.scalar(
            text(
                "SELECT last_cycle_signal_at FROM machine_monitoring_states "
                "WHERE asset_id = :asset_id"
            ),
            {"asset_id": asset_id},
        )

    assert state is not None
    assert state.last_cycle_signal_at == timestamp
    assert state.last_cycle_signal_at.tzinfo == timezone.utc
    assert stored_timestamp == timestamp.replace(tzinfo=None)


def test_naive_notification_timestamp_is_interpreted_as_utc(client, caplog):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="cycle_signal", data_type="boolean")
    collector = configure_collector(client, asset_id, variable_id)
    timestamp = datetime.now(timezone.utc).replace(tzinfo=None)

    with caplog.at_level(logging.WARNING, logger="nem_backend.opcua.collector"):
        collector._process_notification(
            notification("ns=2;s=Machine.Cycle", False, timestamp)
        )

    with client.app.state.session_factory() as session:
        state = session.get(MachineMonitoringState, asset_id)
        assert state is not None
        assert state.last_cycle_signal_at == timestamp.replace(tzinfo=timezone.utc)
    assert "interpreting it as UTC" in caplog.text


def test_corrected_legacy_timestamp_allows_new_cycle_notification(client, caplog):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="cycle_signal", data_type="boolean")
    collector = configure_collector(client, asset_id, variable_id)
    source_timestamp = datetime.now(timezone.utc) - timedelta(seconds=5)
    incorrectly_stored_timestamp = source_timestamp.astimezone(
        ZoneInfo("Asia/Calcutta")
    ).replace(tzinfo=None)

    with client.app.state.session_factory() as session:
        session.add(
            MachineMonitoringState(
                asset_id=asset_id,
                cycle_count=0,
                last_cycle_signal_at=source_timestamp,
                updated_at=source_timestamp,
            )
        )
        session.commit()
        session.execute(
            text(
                "UPDATE machine_monitoring_states "
                "SET last_cycle_signal_at = :timestamp WHERE asset_id = :asset_id"
            ),
            {"timestamp": incorrectly_stored_timestamp, "asset_id": asset_id},
        )
        session.commit()

    with caplog.at_level(logging.WARNING, logger="nem_backend.opcua.collector"):
        collector._process_notification(
            notification("ns=2;s=Machine.Cycle", True, source_timestamp)
        )

    with client.app.state.session_factory() as session:
        assert session.query(Reading).filter_by(variable_id=variable_id).count() == 0
        session.execute(
            text(
                "UPDATE machine_monitoring_states "
                "SET last_cycle_signal_at = "
                "(last_cycle_signal_at AT TIME ZONE 'Asia/Calcutta') "
                "AT TIME ZONE 'UTC' WHERE asset_id = :asset_id"
            ),
            {"asset_id": asset_id},
        )
        session.commit()

    accepted_timestamp = source_timestamp + timedelta(seconds=1)
    collector._process_notification(
        notification("ns=2;s=Machine.Cycle", True, accepted_timestamp)
    )

    with client.app.state.session_factory() as session:
        state = session.get(MachineMonitoringState, asset_id)
        assert state is not None
        assert state.last_cycle_signal_at == accepted_timestamp
        assert session.query(Reading).filter_by(variable_id=variable_id).count() == 1
    assert "Out-of-order OPC UA notification" in caplog.text


def test_startup_pauses_runtime_without_counting_backend_downtime(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="cycle_signal", data_type="boolean")
    collector = configure_collector(client, asset_id, variable_id)
    stale_checkpoint = datetime.now(timezone.utc) - timedelta(hours=2)

    with client.app.state.session_factory() as session:
        session.add(
            MachineMonitoringState(
                asset_id=asset_id,
                cycle_count=23,
                accumulated_running_seconds=Decimal("900.000"),
                is_running=True,
                runtime_checkpoint_at=stale_checkpoint,
                updated_at=stale_checkpoint,
            )
        )
        session.commit()

    collector.prepare_startup()
    with client.app.state.session_factory() as session:
        state = session.get(MachineMonitoringState, asset_id)
        assert state.accumulated_running_seconds == Decimal("900.000")
        assert state.runtime_checkpoint_at is None

    connected_at = datetime.now(timezone.utc)
    collector._connect_runtime(connected_at)
    collector._checkpoint_runtime(connected_at + timedelta(seconds=7))
    with client.app.state.session_factory() as session:
        state = session.get(MachineMonitoringState, asset_id)
        assert float(state.accumulated_running_seconds) == pytest.approx(907)


def test_first_running_observation_sets_baseline_without_counting_runtime(client):
    asset_id = create_asset(client)
    cycle_variable_id = create_variable(
        client, asset_id, key="cycle_signal", data_type="boolean"
    )
    running_variable_id = create_variable(
        client, asset_id, key="running_signal", data_type="boolean"
    )
    collector = configure_collector(
        client, asset_id, cycle_variable_id, running_variable_id
    )
    at = datetime.now(timezone.utc)

    collector._process_notification(
        notification("ns=2;s=Machine.Running", True, at)
    )

    with client.app.state.session_factory() as session:
        state = session.get(MachineMonitoringState, asset_id)
        assert state.is_running is True
        assert state.accumulated_running_seconds == 0
        assert state.runtime_checkpoint_at == at


def test_bad_quality_notifications_are_ignored():
    async def exercise():
        queue = asyncio.Queue()
        handler = _SubscriptionHandler(asyncio.get_running_loop(), queue, 10)
        node = SimpleNamespace(nodeid=SimpleNamespace(to_string=lambda: "ns=2;s=Test"))

        class BadStatus:
            def is_good(self):
                return False

        bad_data = SimpleNamespace(
            monitored_item=SimpleNamespace(
                Value=SimpleNamespace(StatusCode=BadStatus())
            )
        )
        handler.datachange_notification(node, True, bad_data)
        await asyncio.sleep(0)
        assert queue.empty()

        class GoodStatus:
            def is_good(self):
                return True

        good_data = SimpleNamespace(
            monitored_item=SimpleNamespace(
                Value=SimpleNamespace(
                    StatusCode=GoodStatus(),
                    SourceTimestamp=None,
                    ServerTimestamp=None,
                )
            )
        )
        handler.datachange_notification(node, True, good_data)
        await asyncio.sleep(0)
        item = queue.get_nowait()
        assert item.node_id == "ns=2;s=Test"
        assert item.value is True

    asyncio.run(exercise())


def test_mapping_configuration_rejects_duplicate_node_ids():
    with pytest.raises(Exception, match="must not map one NodeId more than once"):
        load_machine_mappings(
            json.dumps(
                [
                    {
                        "asset_id": 1,
                        "cycle_signal": {"node_id": "ns=2;s=Cycle", "variable_id": 1},
                    },
                    {
                        "asset_id": 2,
                        "running_signal": {"node_id": "ns=2;s=Cycle", "variable_id": 2},
                    },
                ]
            )
        )


def test_plc_status_api_exposes_connection_machine_metrics_and_alerts(client):
    asset_id = create_asset(client, "Press")
    cycle_variable_id = create_variable(
        client, asset_id, key="cycle_signal", data_type="boolean"
    )
    running_variable_id = create_variable(
        client, asset_id, key="running_signal", data_type="boolean"
    )
    alert_variable_id = create_variable(
        client, asset_id, key="temperature", data_type="number"
    )
    rule = client.post(
        "/api/v1/rules",
        json={
            "name": "High temperature",
            "rule_type": "parameter_threshold",
            "target_asset_id": asset_id,
            "variable_id": alert_variable_id,
            "operator": ">",
            "threshold": 80,
            "severity": "alert",
        },
    )
    assert rule.status_code == 201, rule.text
    cycle_rule = client.post(
        "/api/v1/rules",
        json={
            "name": "Cycle signal active",
            "rule_type": "duration",
            "target_asset_id": asset_id,
            "variable_id": cycle_variable_id,
            "parameters": {
                "condition": "equals",
                "expected_value": True,
                "duration_seconds": 1,
            },
            "severity": "warning",
        },
    )
    assert cycle_rule.status_code == 201, cycle_rule.text
    reading = client.post(
        "/api/v1/readings",
        json={
            "asset_id": asset_id,
            "variable_id": alert_variable_id,
            "value": 90,
        },
    )
    assert reading.status_code == 201, reading.text
    collector = configure_collector(
        client, asset_id, cycle_variable_id, running_variable_id
    )
    collector.status.update(
        state="connected",
        connected=True,
        last_notification_at=datetime.now(timezone.utc),
    )
    at = datetime.now(timezone.utc)
    collector._process_notification(
        notification("ns=2;s=Machine.Cycle", False, at)
    )
    collector._process_notification(
        notification("ns=2;s=Machine.Cycle", True, at)
    )
    collector._process_notification(
        notification("ns=2;s=Machine.Running", True, at)
    )
    time.sleep(1.05)
    evaluated = client.post(f"/api/v1/monitoring/evaluate?asset_id={asset_id}")
    assert evaluated.status_code == 200, evaluated.text
    state_response = client.get(f"/api/v1/rules/{cycle_rule.json()['id']}/status")
    assert state_response.json()["status"] == "warning", state_response.json()

    response = client.get("/api/v1/plc/status")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["connection"]["state"] == "connected"
    assert result["connection"]["stale"] is False
    assert result["machines"][0]["asset_name"] == "Press"
    assert result["machines"][0]["status"] == "running"
    assert result["machines"][0]["cycle_count"] == 1
    assert result["machines"][0]["cycle_limit"] == 500
    assert {
        alert["title"] for alert in result["machines"][0]["alerts"]
    } == {"High temperature", "Cycle signal active"}


def test_subscription_uses_only_data_change_subscribe_and_releases_resources(
    client, monkeypatch
):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="cycle_signal", data_type="boolean")
    collector = configure_collector(client, asset_id, variable_id)
    collector.settings = collector.settings.model_copy(
        update={"opcua_runtime_checkpoint_seconds": 1}
    )
    operations = []

    class FakeSubscription:
        async def subscribe_data_change(self, nodes):
            operations.append(("subscribe_data_change", [node.node_id for node in nodes]))

        async def delete(self):
            operations.append(("delete", None))

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            operations.append(("disconnect", None))

        async def create_subscription(self, _period, _handler):
            operations.append(("create_subscription", None))
            return FakeSubscription()

        def get_node(self, node_id):
            return SimpleNamespace(node_id=node_id)

        async def check_connection(self):
            raise ConnectionError("simulated drop")

    async def fake_create_client(_settings):
        return FakeClient()

    monkeypatch.setattr(
        "app.services.opcua_collector.create_configured_opcua_client",
        fake_create_client,
    )

    with pytest.raises(ConnectionError, match="simulated drop"):
        asyncio.run(collector._run_connection())

    assert ("subscribe_data_change", ["ns=2;s=Machine.Cycle"]) in operations
    assert ("delete", None) in operations
    assert ("disconnect", None) in operations
    assert all("write" not in operation[0] for operation in operations)


def test_database_lease_prevents_duplicate_collectors(client, monkeypatch):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="cycle_signal", data_type="boolean")
    first = configure_collector(client, asset_id, variable_id)
    second = OpcUaCollector(first.settings, client.app.state.session_factory)
    checkpoint = datetime.now(timezone.utc)
    with client.app.state.session_factory() as session:
        session.add(
            MachineMonitoringState(
                asset_id=asset_id,
                is_running=True,
                runtime_checkpoint_at=checkpoint,
                updated_at=checkpoint,
            )
        )
        session.commit()

    assert first._acquire_lease() is True
    assert second._acquire_lease() is False

    async def stop_standby_collector():
        second._stop_event.set()

    monkeypatch.setattr(second, "_wait_before_retry", stop_standby_collector)
    asyncio.run(second._run())
    with client.app.state.session_factory() as session:
        state = session.get(MachineMonitoringState, asset_id)
        assert state is not None
        assert state.runtime_checkpoint_at == checkpoint

    first._release_lease()
    assert second._acquire_lease() is True
    second._release_lease()


def test_collector_start_is_idempotent_and_stops_gracefully(client, monkeypatch):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="cycle_signal", data_type="boolean")
    collector = configure_collector(client, asset_id, variable_id)
    monkeypatch.setattr(collector, "_acquire_lease", lambda: True)
    monkeypatch.setattr(collector, "_release_lease", lambda: None)

    async def wait_for_stop():
        await collector._stop_event.wait()

    monkeypatch.setattr(collector, "_run_connection", wait_for_stop)

    async def exercise():
        collector.start()
        running_task = collector._task
        collector.start()
        assert collector._task is running_task
        await collector.stop()
        assert collector._task is None

    asyncio.run(exercise())


def test_collector_retries_after_connection_failure(client, monkeypatch):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id, key="cycle_signal", data_type="boolean")
    collector = configure_collector(client, asset_id, variable_id)
    collector.settings = collector.settings.model_copy(
        update={"opcua_reconnect_delay_seconds": 1}
    )
    attempts = 0

    async def fake_connection():
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            collector._stop_event.set()
            return
        raise ConnectionError("temporary outage")

    monkeypatch.setattr(collector, "_acquire_lease", lambda: True)
    monkeypatch.setattr(collector, "_release_lease", lambda: None)
    monkeypatch.setattr(collector, "_run_connection", fake_connection)
    asyncio.run(collector._run())

    assert attempts == 2
    assert collector.status["state"] == "disconnected"


def test_machine_mapping_requires_at_least_one_signal():
    with pytest.raises(ValueError, match="At least one"):
        OpcUaMachineMapping.model_validate({"asset_id": 1})
