import asyncio
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.routes.frontend_compat import (
    frontend_create_asset_rule,
    frontend_hard_delete_rule,
)
from app.api.routes.assets import delete_asset
from app.api.routes.maintenance import create_maintenance_schedule
from app.api.routes.rules import validate_targets
from app.api.routes.variables import create_variable, delete_variable
from app.db.base import Base
from app.db.init_db import initialize_database
from app.models import (
    Alert,
    Asset,
    MonitoringEvent,
    MonitoringRule,
    RuleCounterState,
    RuleState,
    Variable,
)
from app.schemas.rule import RuleCreate
from app.schemas.maintenance import MaintenanceScheduleCreate
from app.schemas.opcua import OpcUaMachineMapping
from app.schemas.variable import VariableCreate
from app.core.config import Settings
from app.services.opcua_collector import (
    OpcUaCollector,
    OpcUaNotification,
    load_machine_mappings,
)
from app.services.monitoring_engine import (
    evaluate_rule,
    update_rule_signal_states,
)

UTC = timezone.utc
START = datetime(2026, 1, 1, tzinfo=UTC)


@pytest.fixture
def engine():
    database = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(database)
    yield database
    database.dispose()


@pytest.fixture
def session(engine):
    with Session(engine, expire_on_commit=False) as db:
        yield db


def add_asset_variable(
    session: Session, name: str, *, node_id: str | None = None
) -> tuple[Asset, Variable]:
    asset = Asset(name=name, asset_type="machine")
    session.add(asset)
    session.flush()
    variable = Variable(
        asset_id=asset.id,
        name="Running / cycle signal",
        key="run_signal",
        data_type="boolean",
        opcua_node_id=node_id,
        is_active=True,
    )
    session.add(variable)
    session.flush()
    return asset, variable


def test_running_time_rule_schema_accepts_ordered_thresholds():
    rule = RuleCreate.model_validate(
        {
            "name": "Shift runtime",
            "rule_type": "runtime_duration",
            "target_asset_id": 1,
            "variable_id": 2,
            "severity": "warning",
            "parameters": {
                "warning_thresholds_seconds": [8 * 3600, 9 * 3600],
                "alert_threshold_seconds": 10 * 3600,
            },
        }
    )

    assert rule.parameters["warning_thresholds_seconds"] == [28800, 32400]


def test_opcua_configuration_allows_a_node_to_be_shared_across_assets():
    mappings = load_machine_mappings(
        json.dumps(
            [
                {
                    "asset_id": 1,
                    "cycle_signal": {
                        "node_id": "ns=2;s=shared-cycle",
                        "variable_id": 11,
                    },
                },
                {
                    "asset_id": 2,
                    "cycle_signal": {
                        "node_id": "ns=2;s=shared-cycle",
                        "variable_id": 22,
                    },
                },
            ]
        )
    )

    assert len(mappings) == 2


def test_mapping_bypass_discovers_declared_variables_and_deduplicates_nodes(
    session: Session,
):
    first_asset, first_variable = add_asset_variable(
        session, "Mixer A", node_id="ns=2;s=shared-running"
    )
    second_asset, second_variable = add_asset_variable(
        session, "Mixer B", node_id="ns=2;s=shared-running"
    )
    invalid_asset, invalid_variable = add_asset_variable(
        session, "Invalid node", node_id="bad node id"
    )
    session.commit()
    settings = Settings(
        database_url="postgresql+psycopg://localhost/nem",
        opcua_machine_mappings="",
        opc_ua_mapping_bypass_enabled=True,
    )
    collector = OpcUaCollector(
        settings,
        sessionmaker(bind=session.get_bind(), expire_on_commit=False),
    )

    collector._validate_mappings()

    assert list(collector._node_mappings) == ["ns=2;s=shared-running"]
    assert len(collector._node_mappings["ns=2;s=shared-running"]) == 2
    rows = collector.configured_mapping_rows(session)
    assert {
        (row["asset_id"], row["variable_id"], row["role"])
        for row in rows
    } == {
        (first_asset.id, first_variable.id, "declared_variable"),
        (second_asset.id, second_variable.id, "declared_variable"),
    }
    assert invalid_asset.id not in {row["asset_id"] for row in rows}
    assert invalid_variable.id not in {
        variable_id
        for mapped_signals in collector._node_mappings.values()
        for _, _, variable_id in mapped_signals
    }
    assert collector.status["declared_variable_count"] == 2


def test_unmapped_declared_variable_is_not_subscribed_when_bypass_is_disabled(
    session: Session,
):
    _, variable = add_asset_variable(
        session, "Mixer", node_id="ns=2;s=unmapped-running"
    )
    session.commit()
    settings = Settings(
        database_url="postgresql+psycopg://localhost/nem",
        opcua_machine_mappings="",
        opc_ua_mapping_bypass_enabled=False,
    )
    collector = OpcUaCollector(
        settings,
        sessionmaker(bind=session.get_bind(), expire_on_commit=False),
    )

    collector._validate_mappings()

    assert collector._node_mappings == {}
    assert collector.configured_mapping_rows(session) == []
    assert variable.opcua_node_id == "ns=2;s=unmapped-running"


def test_collector_detects_declared_variables_added_while_connected(
    session: Session,
):
    asset, _ = add_asset_variable(
        session, "Mixer", node_id="ns=2;s=existing-running"
    )
    session.commit()
    collector = OpcUaCollector(
        Settings(
            database_url="postgresql+psycopg://localhost/nem",
            opcua_machine_mappings="",
            opc_ua_mapping_bypass_enabled=True,
        ),
        sessionmaker(bind=session.get_bind(), expire_on_commit=False),
    )

    collector._validate_mappings()
    assert not collector._declared_variable_configuration_changed()

    session.add(
        Variable(
            asset_id=asset.id,
            name="New running signal",
            key="new_running_signal",
            data_type="boolean",
            opcua_node_id="ns=2;s=new-running",
            is_active=True,
        )
    )
    session.commit()

    assert collector._declared_variable_configuration_changed()


def test_database_migration_removes_legacy_global_node_id_uniqueness(engine):
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX uq_variables_opcua_node_id "
            "ON variables (opcua_node_id)"
        )

    initialize_database(engine)

    indexes = {
        index["name"]: index
        for index in inspect(engine).get_indexes("variables")
    }
    assert "uq_variables_opcua_node_id" not in indexes
    assert not indexes["ix_variables_opcua_node_id"]["unique"]

    with Session(engine, expire_on_commit=False) as db:
        first_asset = Asset(name="Asset with registered node", asset_type="machine")
        second_asset = Asset(name="Asset sharing node", asset_type="machine")
        db.add_all([first_asset, second_asset])
        db.flush()
        first = create_variable(
            first_asset.id,
            VariableCreate(
                name="Signal A",
                key="signal_a",
                data_type="boolean",
                opcua_node_id="ns=2;s=shared-node",
            ),
            db,
        )
        second = create_variable(
            second_asset.id,
            VariableCreate(
                name="Signal B",
                key="signal_b",
                data_type="boolean",
                opcua_node_id="ns=2;s=shared-node",
            ),
            db,
        )

        assert first.opcua_node_id == second.opcua_node_id
        assert first.asset_id != second.asset_id


def test_duplicate_variable_key_reports_key_conflict_only(session: Session):
    asset, _ = add_asset_variable(session, "Key conflict")
    payload = VariableCreate(
        name="Another signal",
        key="run_signal",
        data_type="boolean",
    )

    with pytest.raises(HTTPException) as error:
        create_variable(asset.id, payload, session)

    assert error.value.status_code == 409
    assert error.value.detail == "Variable key already exists for this asset"


def test_mapping_bypass_rule_validation_is_boolean_and_asset_scoped(
    session: Session,
):
    asset, variable = add_asset_variable(
        session, "Mixer", node_id="ns=2;s=mixer-running"
    )
    runtime_parameters = {
        "warning_thresholds_seconds": [10, 20],
        "alert_threshold_seconds": 30,
    }

    validate_targets(
        session,
        asset.id,
        variable.id,
        "runtime_duration",
        None,
        None,
        runtime_parameters,
        None,
        mapping_bypass_enabled=True,
    )
    validate_targets(
        session,
        asset.id,
        variable.id,
        "boolean_count_threshold",
        None,
        None,
        {"warning_thresholds": [10, 20], "alert_threshold": 30},
        None,
        mapping_bypass_enabled=True,
    )
    with pytest.raises(HTTPException):
        validate_targets(
            session,
            asset.id,
            variable.id,
            "runtime_duration",
            None,
            None,
            runtime_parameters,
            None,
        )

    variable.data_type = "number"
    with pytest.raises(HTTPException):
        validate_targets(
            session,
            asset.id,
            variable.id,
            "runtime_duration",
            None,
            None,
            runtime_parameters,
            None,
            mapping_bypass_enabled=True,
        )

    variable.data_type = "boolean"
    variable.opcua_node_id = "bad node id"
    with pytest.raises(HTTPException) as error:
        validate_targets(
            session,
            asset.id,
            variable.id,
            "runtime_duration",
            None,
            None,
            runtime_parameters,
            None,
            mapping_bypass_enabled=True,
        )
    assert error.value.status_code == 422

    other_asset, _ = add_asset_variable(session, "Other mixer")
    with pytest.raises(HTTPException) as error:
        validate_targets(
            session,
            other_asset.id,
            variable.id,
            "runtime_duration",
            None,
            None,
            runtime_parameters,
            None,
            mapping_bypass_enabled=True,
        )
    assert error.value.status_code == 422


def test_running_signal_refresh_uses_good_quality_boolean_reads():
    settings = Settings(
        database_url="postgresql+psycopg://user:password@localhost/nem",
        opcua_machine_mappings=json.dumps(
            [
                {
                    "asset_id": 1,
                    "running_signal": {
                        "node_id": "ns=2;s=machine-running",
                        "variable_id": 11,
                    },
                }
            ]
        ),
    )
    collector = OpcUaCollector(settings, None)
    processed = []
    collector._process_mapped_notification = (
        lambda notification, mapping, role, variable_id: processed.append(
            (notification, mapping, role, variable_id)
        )
    )

    class GoodStatus:
        @staticmethod
        def is_good():
            return True

    class BadStatus:
        @staticmethod
        def is_good():
            return False

    class FakeNode:
        def __init__(self, status):
            self.status = status

        async def read_data_value(self, *, raise_on_bad_status=True):
            assert raise_on_bad_status is False
            return SimpleNamespace(
                StatusCode=self.status,
                Value=SimpleNamespace(Value=True),
            )

    class FakeClient:
        def get_node(self, node_id):
            assert node_id == "ns=2;s=machine-running"
            return FakeNode(GoodStatus())

    class BadQualityClient:
        def get_node(self, node_id):
            return FakeNode(BadStatus())

    asyncio.run(
        collector._refresh_running_signals(FakeClient(), sampled_at=START)
    )
    asyncio.run(
        collector._refresh_running_signals(
            BadQualityClient(),
            sampled_at=START + timedelta(seconds=10),
        )
    )

    assert len(processed) == 1
    notification, mapping, role, variable_id = processed[0]
    assert notification.value is True
    assert notification.recorded_at == START
    assert mapping.asset_id == 1
    assert role == "running"
    assert variable_id == 11


def test_declared_cycle_signal_refresh_initializes_rule_counter(engine):
    settings = Settings(
        database_url="postgresql+psycopg://localhost/nem",
        opcua_machine_mappings="",
        opc_ua_mapping_bypass_enabled=True,
    )
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    with Session(engine, expire_on_commit=False) as session:
        asset, variable = add_asset_variable(
            session,
            "Declared cycle machine",
            node_id="ns=2;s=declared-cycle",
        )
        rule = MonitoringRule(
            name="Declared cycle count",
            rule_type="boolean_count_threshold",
            target_asset_id=asset.id,
            variable_id=variable.id,
            parameters={
                "warning_thresholds": [10, 20],
                "alert_threshold": 30,
            },
            severity="warning",
            is_enabled=True,
        )
        session.add(rule)
        session.commit()
        variable_id = variable.id
        asset_id = asset.id

    collector = OpcUaCollector(settings, session_factory)
    collector._validate_mappings()
    processed = []
    collector._process_mapped_notification = (
        lambda notification, mapping, role, variable_id: processed.append(
            (notification, mapping, role, variable_id)
        )
    )

    class GoodStatus:
        @staticmethod
        def is_good():
            return True

    class FakeNode:
        async def read_data_value(self, *, raise_on_bad_status=True):
            return SimpleNamespace(
                StatusCode=GoodStatus(),
                Value=SimpleNamespace(Value=True),
            )

    class FakeClient:
        def get_node(self, node_id):
            assert node_id == "ns=2;s=declared-cycle"
            return FakeNode()

    asyncio.run(collector._refresh_running_signals(FakeClient(), sampled_at=START))

    assert len(processed) == 1
    notification, mapping, role, processed_variable_id = processed[0]
    assert notification.value is True
    assert mapping.asset_id == asset_id
    assert role == "reading"
    assert processed_variable_id == variable_id
def test_asset_scoped_running_time_rule_creation_persists_selected_asset(
    session: Session,
):
    asset, variable = add_asset_variable(session, "Mixer")
    mapping = OpcUaMachineMapping.model_validate(
        {
            "asset_id": asset.id,
            "running_signal": {
                "node_id": "ns=2;s=mixer-running",
                "variable_id": variable.id,
            },
        }
    )
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                opcua_collector=SimpleNamespace(mappings=[mapping])
            )
        )
    )
    payload = RuleCreate.model_validate(
        {
            "name": "Mixer runtime",
            "rule_type": "runtime_duration",
            "target_asset_id": asset.id,
            "variable_id": variable.id,
            "severity": "warning",
            "parameters": {
                "warning_thresholds_seconds": [28800, 32400],
                "alert_threshold_seconds": 36000,
            },
        }
    )

    result = frontend_create_asset_rule(asset.id, payload, request, session)

    assert result["asset_id"] == asset.id
    assert result["variable_id"] == variable.id
    assert session.get(MonitoringRule, result["id"]).parameters == payload.parameters


def test_declared_running_signal_can_create_rule_when_bypass_is_enabled(
    session: Session,
):
    asset, variable = add_asset_variable(
        session, "Mixer", node_id="ns=2;s=mixer-running"
    )
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                settings=SimpleNamespace(opc_ua_mapping_bypass_enabled=True),
                opcua_collector=SimpleNamespace(mappings=[]),
            )
        )
    )
    payload = RuleCreate.model_validate(
        {
            "name": "Declared runtime",
            "rule_type": "runtime_duration",
            "target_asset_id": asset.id,
            "variable_id": variable.id,
            "severity": "warning",
            "parameters": {
                "warning_thresholds_seconds": [10, 20],
                "alert_threshold_seconds": 30,
            },
        }
    )

    result = frontend_create_asset_rule(asset.id, payload, request, session)

    assert result["asset_id"] == asset.id
    assert result["variable_id"] == variable.id


def test_asset_scoped_rule_creation_rejects_another_assets_target(
    session: Session,
):
    first_asset, first_variable = add_asset_variable(session, "Mixer A")
    second_asset, _ = add_asset_variable(session, "Mixer B")
    payload = RuleCreate.model_validate(
        {
            "name": "Wrong asset",
            "rule_type": "runtime_duration",
            "target_asset_id": second_asset.id,
            "variable_id": first_variable.id,
            "severity": "warning",
            "parameters": {
                "warning_thresholds_seconds": [10, 20],
                "alert_threshold_seconds": 30,
            },
        }
    )
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                opcua_collector=SimpleNamespace(mappings=[])
            )
        )
    )

    with pytest.raises(HTTPException) as error:
        frontend_create_asset_rule(first_asset.id, payload, request, session)

    assert error.value.status_code == 422


def test_motor_rotation_creation_uses_asset_cycle_signal_and_starts_at_zero(
    session: Session,
):
    asset, variable = add_asset_variable(session, "Press")
    mapping = OpcUaMachineMapping.model_validate(
        {
            "asset_id": asset.id,
            "cycle_signal": {
                "node_id": "ns=2;s=press-cycle",
                "variable_id": variable.id,
            },
        }
    )
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                opcua_collector=SimpleNamespace(mappings=[mapping])
            )
        )
    )
    payload = RuleCreate.model_validate(
        {
            "name": "Motor Rotation",
            "rule_type": "boolean_count_threshold",
            "target_asset_id": asset.id,
            "variable_id": variable.id,
            "severity": "warning",
            "parameters": {
                "warning_thresholds": [9000, 9500],
                "alert_threshold": 10000,
            },
        }
    )

    result = frontend_create_asset_rule(asset.id, payload, request, session)
    rule = session.get(MonitoringRule, result["id"])

    assert result["asset_id"] == asset.id
    assert rule.target_asset_id == asset.id
    assert session.scalar(
        select(RuleCounterState).where(RuleCounterState.rule_id == rule.id)
    ) is None
    update_rule_signal_states(
        session,
        asset_id=asset.id,
        variable_id=variable.id,
        value=False,
        at=START,
        stale_after_seconds=60,
    )
    counter = counter_for(session, rule)
    assert counter.cycle_count == 0
    update_rule_signal_states(
        session,
        asset_id=asset.id,
        variable_id=variable.id,
        value=True,
        at=START + timedelta(seconds=1),
        stale_after_seconds=60,
    )
    assert counter.cycle_count == 1


def test_recurring_maintenance_schedule_creation_remains_available(
    session: Session,
):
    asset, _ = add_asset_variable(session, "Mixer")
    payload = MaintenanceScheduleCreate.model_validate(
        {
            "asset_id": asset.id,
            "title": "Monthly service",
            "maintenance_type": "preventive",
            "schedule_start_date": "2026-10-20",
            "first_due_date": "2026-11-20",
            "recurrence_enabled": True,
            "recurrence_interval": 1,
            "recurrence_unit": "months",
        }
    )

    schedule = create_maintenance_schedule(payload, session)

    assert schedule.asset_id == asset.id
    assert schedule.first_due_date.isoformat() == "2026-11-20"


def test_unused_variable_can_be_deleted(session: Session):
    asset, variable = add_asset_variable(session, "Mixer")
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                opcua_collector=SimpleNamespace(mappings=[])
            )
        )
    )

    response = delete_variable(variable.id, request, session)

    assert response.status_code == 204
    assert session.get(Variable, variable.id) is None


def test_variable_delete_is_rejected_if_opcua_mapping_still_uses_it(
    session: Session,
):
    asset, variable = add_asset_variable(session, "Mixer")
    mapping = OpcUaMachineMapping.model_validate(
        {
            "asset_id": asset.id,
            "cycle_signal": {
                "node_id": "ns=2;s=mixer-cycle",
                "variable_id": variable.id,
            },
        }
    )
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                opcua_collector=SimpleNamespace(mappings=[mapping])
            )
        )
    )

    with pytest.raises(HTTPException) as error:
        delete_variable(variable.id, request, session)

    assert error.value.status_code == 409


def test_asset_delete_is_rejected_when_it_has_variables(session: Session):
    asset, _ = add_asset_variable(session, "Mixer")

    with pytest.raises(HTTPException) as error:
        delete_asset(asset.id, session)

    assert error.value.status_code == 409


def test_empty_asset_can_be_deleted(session: Session):
    asset = Asset(name="Unused machine", asset_type="machine")
    session.add(asset)
    session.flush()

    response = delete_asset(asset.id, session)

    assert response.status_code == 204
    assert session.get(Asset, asset.id) is None


def test_asset_delete_removes_asset_scoped_audit_events(session: Session):
    asset = Asset(name="Unused machine", asset_type="machine")
    session.add(asset)
    session.flush()
    event = MonitoringEvent(
        event_type="rule_permanently_deleted",
        asset_id=asset.id,
        message="Monitoring rule permanently deleted.",
        occurred_at=START,
    )
    session.add(event)
    session.flush()
    asset_id, event_id = asset.id, event.id

    response = delete_asset(asset_id, session)

    assert response.status_code == 204
    assert session.get(Asset, asset_id) is None
    assert session.get(MonitoringEvent, event_id) is None


def add_rule(
    session: Session,
    asset: Asset,
    variable: Variable,
    *,
    rule_type: str = "runtime_duration",
    name: str = "Runtime",
    parameters: dict | None = None,
) -> MonitoringRule:
    if parameters is None:
        parameters = {
            "warning_thresholds_seconds": [100, 200],
            "alert_threshold_seconds": 300,
        }
    rule = MonitoringRule(
        name=name,
        rule_type=rule_type,
        target_asset_id=asset.id,
        variable_id=variable.id,
        parameters=parameters,
        severity="warning",
        is_enabled=True,
    )
    session.add(rule)
    session.flush()
    return rule


def signal(
    session: Session,
    rule: MonitoringRule,
    asset: Asset,
    variable: Variable,
    value: bool,
    at: datetime,
    *,
    stale_after_seconds: int = 60,
):
    update_rule_signal_states(
        session,
        asset_id=asset.id,
        variable_id=variable.id,
        value=value,
        at=at,
        stale_after_seconds=stale_after_seconds,
    )
    return evaluate_rule(
        session,
        rule,
        evaluated_at=at,
        stale_after_seconds=stale_after_seconds,
    )


def counter_for(session: Session, rule: MonitoringRule) -> RuleCounterState:
    return session.scalar(
        select(RuleCounterState).where(RuleCounterState.rule_id == rule.id)
    )


def test_running_time_increases_while_signal_is_true(session: Session):
    asset, variable = add_asset_variable(session, "Mixer")
    rule = add_rule(session, asset, variable)
    signal(session, rule, asset, variable, True, START)

    state = evaluate_rule(
        session, rule, evaluated_at=START + timedelta(seconds=20),
        stale_after_seconds=60,
    )

    assert state.latest_value == pytest.approx(20)
    assert counter_for(session, rule).accumulated_running_seconds == Decimal(0)


def test_running_time_pauses_while_signal_is_false(session: Session):
    asset, variable = add_asset_variable(session, "Mixer")
    rule = add_rule(session, asset, variable)
    signal(session, rule, asset, variable, True, START)
    signal(session, rule, asset, variable, False, START + timedelta(seconds=10))

    state = evaluate_rule(
        session, rule, evaluated_at=START + timedelta(seconds=40),
        stale_after_seconds=60,
    )

    assert state.latest_value == pytest.approx(10)
    assert state.status == "normal"
    assert counter_for(session, rule).accumulated_running_seconds == Decimal(10)


def test_running_time_resumes_after_a_stopped_period(session: Session):
    asset, variable = add_asset_variable(session, "Mixer")
    rule = add_rule(session, asset, variable)
    signal(session, rule, asset, variable, True, START)
    signal(session, rule, asset, variable, False, START + timedelta(seconds=10))
    signal(session, rule, asset, variable, True, START + timedelta(seconds=30))

    state = evaluate_rule(
        session, rule, evaluated_at=START + timedelta(seconds=35),
        stale_after_seconds=60,
    )

    assert state.latest_value == pytest.approx(15)


def test_running_time_is_recomputed_from_persisted_signal_after_restart(engine):
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as session:
        asset, variable = add_asset_variable(session, "Mixer")
        rule = add_rule(session, asset, variable)
        signal(session, rule, asset, variable, True, START)
        rule_id = rule.id
        asset_id = asset.id
        variable_id = variable.id
        session.commit()

    with Session(engine, expire_on_commit=False) as restarted:
        rule = restarted.get(MonitoringRule, rule_id)
        asset = restarted.get(Asset, asset_id)
        variable = restarted.get(Variable, variable_id)
        state = evaluate_rule(
            restarted, rule, evaluated_at=START + timedelta(seconds=20),
            stale_after_seconds=60,
        )
        assert state.latest_value == pytest.approx(20)
        state = evaluate_rule(
            restarted, rule, evaluated_at=START + timedelta(seconds=20),
            stale_after_seconds=60,
        )
        assert state.latest_value == pytest.approx(20)


def test_stale_signal_pauses_runtime_and_reports_unknown(session: Session):
    asset, variable = add_asset_variable(session, "Mixer")
    rule = add_rule(session, asset, variable)
    signal(session, rule, asset, variable, True, START, stale_after_seconds=5)

    state = evaluate_rule(
        session, rule, evaluated_at=START + timedelta(seconds=20),
        stale_after_seconds=5,
    )

    assert state.status == "unknown"
    assert state.latest_value == pytest.approx(5)


def test_runtime_thresholds_trigger_warning_higher_warning_and_alert(session: Session):
    asset, variable = add_asset_variable(session, "Mixer")
    rule = add_rule(
        session,
        asset,
        variable,
        parameters={
            "warning_thresholds_seconds": [10, 20],
            "alert_threshold_seconds": 30,
        },
    )
    signal(session, rule, asset, variable, True, START)

    warning = evaluate_rule(
        session, rule, evaluated_at=START + timedelta(seconds=10),
        stale_after_seconds=60,
    )
    warning_status, warning_message = warning.status, warning.message
    higher_warning = evaluate_rule(
        session, rule, evaluated_at=START + timedelta(seconds=20),
        stale_after_seconds=60,
    )
    higher_warning_status, higher_warning_message = (
        higher_warning.status,
        higher_warning.message,
    )
    alert = evaluate_rule(
        session, rule, evaluated_at=START + timedelta(seconds=30),
        stale_after_seconds=60,
    )

    assert warning_status == "warning"
    assert "warning threshold" in warning_message
    assert higher_warning_status == "warning"
    assert "higher warning threshold" in higher_warning_message
    assert alert.status == "alert"


def test_declared_running_signal_pauses_and_triggers_runtime_thresholds(
    session: Session,
):
    asset, variable = add_asset_variable(
        session, "Mixer", node_id="ns=4;i=14"
    )
    rule = add_rule(
        session,
        asset,
        variable,
        parameters={
            "warning_thresholds_seconds": [10, 20],
            "alert_threshold_seconds": 30,
        },
    )
    session.commit()
    collector = OpcUaCollector(
        Settings(
            database_url="postgresql+psycopg://localhost/nem",
            opcua_machine_mappings="",
            opc_ua_mapping_bypass_enabled=True,
            monitoring_default_stale_after_seconds=60,
        ),
        sessionmaker(bind=session.get_bind(), expire_on_commit=False),
    )
    collector._validate_mappings()

    for value, elapsed_seconds in (
        (True, 0),
        (False, 10),
        (True, 20),
        (False, 30),
        (True, 40),
        (False, 50),
    ):
        collector._process_notification(
            OpcUaNotification(
                node_id=variable.opcua_node_id,
                value=value,
                recorded_at=START + timedelta(seconds=elapsed_seconds),
            )
        )
        session.expire_all()
        state = session.scalar(
            select(RuleState).where(RuleState.rule_id == rule.id)
        )
        if elapsed_seconds == 10:
            assert state.status == "warning"
        elif elapsed_seconds == 30:
            assert state.status == "warning"
            assert "higher warning threshold" in state.message
        elif elapsed_seconds == 50:
            assert state.status == "alert"
            assert state.latest_value == pytest.approx(30)

    counter = counter_for(session, rule)
    assert counter.accumulated_running_seconds == Decimal(30)


def test_deleted_and_recreated_cycle_rule_starts_at_zero(session: Session):
    asset, variable = add_asset_variable(session, "Press")
    old_rule = add_rule(
        session, asset, variable, rule_type="boolean_count_threshold",
        name="Motor Rotation",
        parameters={
            "warning_thresholds": [10, 20],
            "alert_threshold": 30,
        },
    )
    signal(session, old_rule, asset, variable, False, START)
    signal(session, old_rule, asset, variable, True, START + timedelta(seconds=1))
    assert counter_for(session, old_rule).cycle_count == 1

    add_rule(
        session,
        asset,
        variable,
        rule_type="boolean_count_threshold",
        name="Independent rotation",
        parameters={
            "warning_thresholds": [10, 20],
            "alert_threshold": 30,
        },
    )
    old_rule.is_enabled = False
    old_rule_id = old_rule.id
    frontend_hard_delete_rule(old_rule_id, session)
    new_rule = add_rule(
        session, asset, variable, rule_type="boolean_count_threshold",
        name="Motor Rotation",
        parameters={
            "warning_thresholds": [10, 20],
            "alert_threshold": 30,
        },
    )
    signal(session, new_rule, asset, variable, False, START + timedelta(seconds=2))

    assert new_rule.id != old_rule_id
    assert counter_for(session, new_rule).cycle_count == 0


def test_same_opc_node_on_two_assets_has_independent_cycle_counters(session: Session):
    asset_a, variable_a = add_asset_variable(session, "Press A", node_id="ns=2;s=cycle")
    asset_b, variable_b = add_asset_variable(session, "Press B", node_id="ns=2;s=cycle")
    rule_a = add_rule(
        session, asset_a, variable_a, rule_type="boolean_count_threshold",
        name="Rotation A",
        parameters={"warning_thresholds": [10, 20], "alert_threshold": 30},
    )
    rule_b = add_rule(
        session, asset_b, variable_b, rule_type="boolean_count_threshold",
        name="Rotation B",
        parameters={"warning_thresholds": [10, 20], "alert_threshold": 30},
    )
    signal(session, rule_a, asset_a, variable_a, False, START)
    signal(session, rule_b, asset_b, variable_b, False, START)
    signal(session, rule_a, asset_a, variable_a, True, START + timedelta(seconds=1))
    signal(session, rule_a, asset_a, variable_a, False, START + timedelta(seconds=2))
    signal(session, rule_a, asset_a, variable_a, True, START + timedelta(seconds=3))
    signal(session, rule_b, asset_b, variable_b, True, START + timedelta(seconds=3))

    assert counter_for(session, rule_a).cycle_count == 2
    assert counter_for(session, rule_b).cycle_count == 1


def test_repeated_boolean_notifications_do_not_duplicate_cycle_count(session: Session):
    asset, variable = add_asset_variable(session, "Press")
    rule = add_rule(
        session, asset, variable, rule_type="boolean_count_threshold",
        name="Rotation",
        parameters={"warning_thresholds": [10, 20], "alert_threshold": 30},
    )
    signal(session, rule, asset, variable, False, START)
    signal(session, rule, asset, variable, True, START + timedelta(seconds=1))
    signal(session, rule, asset, variable, True, START + timedelta(seconds=2))
    signal(session, rule, asset, variable, True, START + timedelta(seconds=3))

    assert counter_for(session, rule).cycle_count == 1


def test_stale_cycle_signal_gap_does_not_count_an_unobserved_transition(
    session: Session,
):
    asset, variable = add_asset_variable(session, "Press")
    rule = add_rule(
        session,
        asset,
        variable,
        rule_type="boolean_count_threshold",
        name="Rotation",
        parameters={"warning_thresholds": [10, 20], "alert_threshold": 30},
    )
    signal(session, rule, asset, variable, False, START, stale_after_seconds=5)
    signal(
        session,
        rule,
        asset,
        variable,
        True,
        START + timedelta(seconds=10),
        stale_after_seconds=5,
    )

    assert counter_for(session, rule).cycle_count == 0


def test_deleting_one_rule_does_not_change_another_rule_counter(session: Session):
    asset, variable = add_asset_variable(session, "Press")
    first = add_rule(
        session, asset, variable, rule_type="boolean_count_threshold",
        name="Rotation one",
        parameters={"warning_thresholds": [10, 20], "alert_threshold": 30},
    )
    second = add_rule(
        session, asset, variable, rule_type="boolean_count_threshold",
        name="Rotation two",
        parameters={"warning_thresholds": [10, 20], "alert_threshold": 30},
    )
    signal(session, first, asset, variable, False, START)
    signal(session, second, asset, variable, False, START)
    signal(session, first, asset, variable, True, START + timedelta(seconds=1))
    signal(session, second, asset, variable, True, START + timedelta(seconds=1))
    first_id, second_id = first.id, second.id

    first.is_enabled = False
    frontend_hard_delete_rule(first_id, session)

    assert session.get(RuleCounterState, counter_for(session, second).id).cycle_count == 1
    assert session.get(MonitoringRule, second_id) is not None
    assert session.get(MonitoringRule, first_id) is None


def test_repeated_runtime_evaluation_keeps_one_active_alert(session: Session):
    asset, variable = add_asset_variable(session, "Mixer")
    rule = add_rule(
        session,
        asset,
        variable,
        parameters={
            "warning_thresholds_seconds": [5, 10],
            "alert_threshold_seconds": 15,
        },
    )
    signal(session, rule, asset, variable, True, START)
    for _ in range(3):
        evaluate_rule(
            session, rule, evaluated_at=START + timedelta(seconds=20),
            stale_after_seconds=60,
        )
    active_alerts = session.scalars(
        select(Alert).where(
            Alert.rule_id == rule.id,
            Alert.status == "active",
        )
    ).all()

    assert len(active_alerts) == 1
    assert active_alerts[0].severity == "alert"
