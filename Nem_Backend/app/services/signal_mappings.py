# Lookups of the OPC UA collector's configured machine signals, used when rules and templates choose variables.
# They take the application state (request.app.state) so no HTTP request object is needed here.
from typing import Any


# Check whether the OPC UA mapping bypass feature is enabled in application settings.
def is_mapping_bypass_enabled(app_state: Any) -> bool:
    settings = getattr(app_state, "settings", None)
    return bool(getattr(settings, "opc_ua_mapping_bypass_enabled", False))


# (asset_id, variable_id) of the machine cycle signal when the variable is configured as one, otherwise None.
def configured_cycle_signal_mapping(app_state: Any, variable_id: int | None) -> tuple[int, int] | None:
    collector = app_state.opcua_collector
    return next(
        (
            (mapping.asset_id, mapping.cycle_signal.variable_id)
            for mapping in collector.mappings
            if mapping.cycle_signal is not None
            and mapping.cycle_signal.variable_id == variable_id
        ),
        None,
    )


# Rules need to know whether a selected variable is already configured as the machine's cycle or running signal.
def configured_runtime_signal_mapping(app_state: Any, variable_id: int | None) -> tuple[int, int] | None:
    collector = app_state.opcua_collector
    return next(
        (
            (mapping.asset_id, mapping.running_signal.variable_id)
            for mapping in collector.mappings
            if mapping.running_signal is not None
            and mapping.running_signal.variable_id == variable_id
        ),
        None,
    )
