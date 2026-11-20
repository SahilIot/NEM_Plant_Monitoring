# Validation of a rule's targets and of the variables chosen for rule parameters, shared by the rule routes and the services.
# Failures are raised as HTTPException (404 / 422) exactly as the route helper this was moved from did.
from __future__ import annotations

from typing import Any

from asyncua import ua
from asyncua.ua.uaerrors import UaStringParsingError
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.constants import (
    AGGREGATION_LAST,
    AGGREGATION_NONE,
    BOOLEAN,
    COUNTER,
    CYCLE,
    INTERVAL_PARAMETER,
    NUMBER,
    RUNNING,
    TIMER,
    RULE_BOOLEAN_COUNT_THRESHOLD,
    RULE_DURATION,
    RULE_PARAMETER_THRESHOLD,
    RULE_RUNTIME_DURATION,
)
from app.models import Asset, Variable
from app.schemas.rule_parameters import RuleParameterIn
from app.services.access_scope import access_scope
from app.services.signal_mappings import (
    configured_cycle_signal_mapping,
    configured_runtime_signal_mapping,
    is_mapping_bypass_enabled,
)

NUMERIC_TYPES = {NUMBER, "integer"}
# Config keys that only change how the value is judged. Editing them re-evaluates on the next cycle but
# never discards accumulated progress; every other key (interval type, start time) changes what is measured.
LIMIT_CONFIG_KEYS = {"lower_alert", "lower_warning", "upper_warning", "upper_alert", "unit", "due", "overdue", "expected", "severity"}

# It creates a representation of the measurement configuration
def measured_source(variable_id: int | None, aggregation: str, config: dict[str, Any]) -> tuple:
    return (variable_id, aggregation, {key: value for key, value in (config or {}).items() if key not in LIMIT_CONFIG_KEYS})

# Imp -> Its responsibility is to ensure that every param references a valid var and that the var is suitable for the param config.
def check_parameters(session: Session, app_state: Any, asset: Asset,items: list[RuleParameterIn],category: str,
                      current: dict[str, int | None] | None = None) -> None:
    bypass = is_mapping_bypass_enabled(app_state)
    seen: dict[tuple[int, str], str] = {}
    for item in items:
        label = f"Parameter '{item.name}'"
        if item.variable_id is None:
            continue
        variable = session.get(Variable, item.variable_id)
        if variable is None or not access_scope(session).allows(variable.asset_id):
            raise HTTPException(status_code=404, detail=f"{label}: variable {item.variable_id} was not found")
        if variable.asset_id != asset.id:
            raise HTTPException(status_code=422, detail=f"{label}: the variable does not belong to this asset")
        if not variable.is_active and not (item.key and (current or {}).get(item.key) == variable.id):
            raise HTTPException(status_code=422, detail=f"{label}: the variable is inactive")

        boolean = variable.data_type == BOOLEAN
        if item.kind == NUMBER:
            if item.aggregation in {AGGREGATION_NONE, AGGREGATION_LAST} and variable.data_type not in NUMERIC_TYPES:
                raise HTTPException(status_code=422, detail=f"{label}: Number parameters with {item.aggregation.capitalize()} aggregation need a numeric variable")
            if item.aggregation in {COUNTER, TIMER} and not boolean:
                raise HTTPException(status_code=422, detail=f"{label}: {item.aggregation.capitalize()} aggregation needs a Boolean variable")
        elif item.kind == BOOLEAN:
            if not boolean:
                raise HTTPException(status_code=422, detail=f"{label}: Boolean parameters need a Boolean variable")
            if item.aggregation not in {AGGREGATION_NONE, AGGREGATION_LAST}:
                raise HTTPException(status_code=422, detail=f"{label}: Boolean parameters support None or Last aggregation only")
        else:
            if not boolean:
                raise HTTPException(status_code=422, detail=f"{label}: interval parameters need a Boolean variable")
            counter = item.config.get(INTERVAL_PARAMETER) == COUNTER
            mapping = (configured_cycle_signal_mapping if counter else configured_runtime_signal_mapping)(app_state, variable.id)
            bypass_ok = bypass and variable.opcua_node_id is not None and variable.signal_role in {None, CYCLE if counter else RUNNING}
            if mapping != (asset.id, variable.id) and not bypass_ok:
                raise HTTPException(status_code=422, detail=(f"{label}: the variable must be this asset's configured "
                    f"{CYCLE if counter else RUNNING} signal"))

        pair = (variable.id, item.aggregation)
        if pair in seen:
            raise HTTPException(status_code=422, detail=f"{label}: the same variable and aggregation are already used by '{seen[pair]}'")
        seen[pair] = item.name

# make sure a rule refers to valid machine assets and variables, and its configuration makes sense
def validate_targets(
    session: Session,
    target_asset_id: int | None,
    variable_id: int | None,
    rule_type: str,
    operator: str | None,
    threshold,
    parameters: dict | None,
    cycle_signal_mapping: tuple[int, int] | None,
    runtime_signal_mapping: tuple[int, int] | None = None,
    mapping_bypass_enabled: bool = False,
) -> None:
    #Check that asset exits
    scope = access_scope(session)
    asset = session.get(Asset, target_asset_id) if target_asset_id is not None else None
    if target_asset_id is not None and (asset is None or not scope.allows(asset.id)):
        raise HTTPException(status_code=404, detail=f"Asset {target_asset_id} was not found")
    #Varibale exists
    variable = session.get(Variable, variable_id) if variable_id is not None else None
    if variable_id is not None and (variable is None or not scope.allows(variable.asset_id)):
        raise HTTPException(status_code=404, detail=f"Variable {variable_id} was not found")
    if variable is not None and target_asset_id is not None:
        if variable.asset_id != target_asset_id:
            raise HTTPException(status_code=422, detail="Target variable does not belong to target asset")
    if rule_type == RULE_PARAMETER_THRESHOLD:
        expected_value = (parameters or {}).get("expected_value")
        if isinstance(expected_value, bool):
            if (
                variable is None
                or not variable.is_active
                or variable.data_type != BOOLEAN
                or operator not in {"==", "!=", "eq", "ne"}
                or threshold is not None
            ):
                raise HTTPException(status_code=422,detail=("Boolean parameter thresholds require an active Boolean "
                        "variable, an equality operator, and a Boolean expected_value"),)
        else:
            if variable is None or variable.data_type not in {NUMBER, "integer"}:
                raise HTTPException(status_code=422,detail="Parameter threshold rules require a numeric variable",)
            if operator is None or threshold is None:
                raise HTTPException(status_code=422, detail="Parameter threshold rules require an operator and threshold",)
    if rule_type in {RULE_RUNTIME_DURATION, RULE_DURATION}:
        interval_elapsed = (
            rule_type == RULE_DURATION
            and parameters is not None
            and parameters.get("condition") == "interval_elapsed"
        )
        if interval_elapsed:
            interval_seconds = parameters.get("interval_seconds")
            if (
                asset is None
                or not isinstance(interval_seconds, int)
                or isinstance(interval_seconds, bool)
                or interval_seconds <= 0
                or variable_id is not None
            ):
                raise HTTPException(status_code=422,detail=("Interval-based rules require an asset target, a positive "
                        "interval_seconds value, and no variable target"),)
            return
        duration = parameters.get("duration_seconds") if parameters else None
        if rule_type == RULE_RUNTIME_DURATION and parameters and ("warning_thresholds_seconds" in parameters):
            if (
                asset is None
                or not asset.is_active
                or variable is None
                or not variable.is_active
                or variable.data_type != BOOLEAN
            ):
                raise HTTPException(status_code=422,detail="Running-time rules require an active Boolean variable on an active asset",)
            bypass_signal_is_valid = (
                mapping_bypass_enabled
                and variable is not None
                and variable.opcua_node_id is not None
                and variable.signal_role in {None, RUNNING}
            )
            if bypass_signal_is_valid:
                try:
                    ua.NodeId.from_string(variable.opcua_node_id)
                except (TypeError, ValueError, UaStringParsingError) as error:
                    raise HTTPException(status_code=422,detail="Running-time rules require a valid OPC UA NodeId",) from error
            if (
                runtime_signal_mapping != (target_asset_id, variable_id)
                and not bypass_signal_is_valid
            ):
                raise HTTPException(status_code=422,detail=("Running-time rules must target this asset's configured "
                        "OPC UA running signal or an asset-owned declared Boolean "
                        "running signal while mapping bypass is enabled"),)
        else:
            if (
                not isinstance(duration, int)
                or isinstance(duration, bool)
                or duration <= 0
            ):
                raise HTTPException(status_code=422,detail="Runtime rules require a positive parameters.duration_seconds",)
            if rule_type == RULE_DURATION:
                condition = (parameters or {}).get("condition", "equals")
                expected = (parameters or {}).get("expected_value")
                if condition == "threshold":
                    if variable is None or variable.data_type not in {NUMBER, "integer"}:
                        raise HTTPException(status_code=422, detail="Threshold duration rules require a numeric variable.",)
                elif isinstance(expected, bool):
                    if (
                        asset is None
                        or not asset.is_active
                        or variable is None
                        or not variable.is_active
                        or variable.data_type != BOOLEAN
                    ):
                        raise HTTPException( status_code=422, detail="Boolean duration rules require an active Boolean variable on an active asset.",)
                    bypass_signal_is_valid = (
                        mapping_bypass_enabled
                        and variable.opcua_node_id is not None
                        and variable.signal_role == RUNNING
                    )
                    if bypass_signal_is_valid:
                        try:
                            ua.NodeId.from_string(variable.opcua_node_id)
                        except (TypeError, ValueError, UaStringParsingError) as error:
                            raise HTTPException(status_code=422,detail="Boolean duration rules require a valid OPC UA NodeId.",) from error
                    if (
                        runtime_signal_mapping != (target_asset_id, variable_id)
                        and not bypass_signal_is_valid
                    ):
                        raise HTTPException(status_code=422,detail=("Boolean duration rules must target this asset's "
                                "configured running signal or a declared variable "
                                "marked as Machine running state."),)
    if rule_type == RULE_BOOLEAN_COUNT_THRESHOLD:
        if (
            asset is None
            or not asset.is_active
            or variable is None
            or not variable.is_active
            or variable.data_type != BOOLEAN
        ):
            raise HTTPException(status_code=422,detail=("Boolean count threshold rules require an active Boolean variable"),)
        bypass_signal_is_valid = (
            mapping_bypass_enabled
            and variable is not None
            and variable.opcua_node_id is not None
            and variable.signal_role in {None, CYCLE}
        )
        if bypass_signal_is_valid:
            try:
                ua.NodeId.from_string(variable.opcua_node_id)
            except (TypeError, ValueError, UaStringParsingError) as error:
                raise HTTPException(status_code=422,detail="Boolean count threshold rules require a valid OPC UA NodeId",) from error
        if (
            cycle_signal_mapping != (target_asset_id, variable_id)
            and not bypass_signal_is_valid
        ):
            raise HTTPException(status_code=422,detail=("Boolean count threshold rules must target the active Boolean "
                    "variable configured as this asset's OPC UA cycle signal, or "
                    "an asset-owned declared Boolean variable while mapping bypass is enabled." ),)
        parameters = parameters or {}
        warning_thresholds = parameters.get("warning_thresholds")
        alert_threshold = parameters.get("alert_threshold")

        if (
            not isinstance(warning_thresholds, list)
            or len(warning_thresholds) != 2
            or any(
                not isinstance(value, int)
                or isinstance(value, bool)
                or value <= 0
                for value in warning_thresholds
            )
            or warning_thresholds[0] >= warning_thresholds[1]
            or not isinstance(alert_threshold, int)
            or isinstance(alert_threshold, bool)
            or alert_threshold <= warning_thresholds[1]
        ):
            raise HTTPException(status_code=422,detail=("Configure two increasing positive warning thresholds and a larger positive alert threshold"),)
