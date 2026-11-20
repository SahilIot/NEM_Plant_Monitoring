# Validation of the variables chosen for rule parameters, shared by the rule routes and the template services.
# Failures are raised as HTTPException (404 / 422) exactly as the route helper this was moved from did.
from __future__ import annotations

from typing import Any

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
