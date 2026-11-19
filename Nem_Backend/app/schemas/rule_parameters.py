# Request/response schemas and pure validation for 'multi_parameter' rules.
#
# One rule holds several independently configured parameters. Parameters are validated here without
# touching the database; the route adds the checks that need it (variables, assets, signal mappings).
from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Literal

from pydantic import Field, ValidationInfo, field_validator, model_validator

from app.core.labels import normalize_label_names
from app.schemas.common import ORMModel

CATEGORIES = ("parameter_threshold", "interval_based")
MAX_PARAMETERS = 20
NUMBER_LIMIT_KEYS = ("lower_alert", "lower_warning", "upper_warning", "upper_alert")
INTERVAL_PARAMETERS = ("usage", "time", "counter")


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("limits must be numbers")
    if not math.isfinite(float(value)):
        raise ValueError("limits must be finite numbers")
    return float(value)


class RuleParameterIn(ORMModel):
    # Stable identity. Omit it for a new parameter; send it back unchanged to edit one in place.
    key: str | None = Field(default=None, min_length=8, max_length=36)
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["number", "boolean", "interval"]
    variable_id: int | None = Field(default=None, gt=0)
    aggregation: Literal["none", "counter", "last", "timer"] = "none"
    config: dict[str, Any] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Parameter name cannot be empty")
        return value

    @model_validator(mode="after")
    def validate_definition(self, info: ValidationInfo):
        # context {"stored": True} re-checks an already stored parameter (activation, resume, evaluation): the same
        # limit / expected-state / Due-Overdue rules apply, but variable wiring is not re-judged here.
        stored = bool(info.context and info.context.get("stored"))
        label = f"Parameter '{self.name}'"
        config = dict(self.config or {})
        if self.kind == "number":
            limits = {key: _number(config.get(key)) for key in NUMBER_LIMIT_KEYS}
            if all(value is None for value in limits.values()):
                raise ValueError(f"{label}: configure at least one limit")
            if self.variable_id is None and not stored:
                raise ValueError(f"{label}: connect a variable")
            lower_alert, lower_warning = limits["lower_alert"], limits["lower_warning"]
            upper_warning, upper_alert = limits["upper_warning"], limits["upper_alert"]
            if lower_alert is not None and lower_warning is not None and not lower_alert < lower_warning:
                raise ValueError(f"{label}: Lower Alert must be lower than Lower Warning")
            if upper_warning is not None and upper_alert is not None and not upper_warning < upper_alert:
                raise ValueError(f"{label}: Upper Warning must be lower than Upper Alert")
            # Lower and upper limits must form a valid range: every lower limit below every upper limit.
            lowers = [v for v in (lower_alert, lower_warning) if v is not None]
            uppers = [v for v in (upper_warning, upper_alert) if v is not None]
            if lowers and uppers and not max(lowers) < min(uppers):
                raise ValueError(f"{label}: lower limits must be below the upper limits")
            self.config = {**{k: v for k, v in limits.items()}, "unit": str(config.get("unit") or "")[:20]}
        elif self.kind == "boolean":
            expected = config.get("expected")
            if not isinstance(expected, bool):
                raise ValueError(f"{label}: choose the expected state (TRUE or FALSE)")
            severity = config.get("severity", "alert")
            if severity not in {"warning", "alert"}:
                raise ValueError(f"{label}: severity must be warning or alert")
            if self.variable_id is None and not stored:
                raise ValueError(f"{label}: connect a variable")
            self.config = {"expected": expected, "severity": severity}
        else:
            parameter = config.get("interval_parameter")
            if parameter not in INTERVAL_PARAMETERS:
                raise ValueError(f"{label}: interval parameter must be Usage, Time or Counter")
            due, overdue = _number(config.get("due")), _number(config.get("overdue"))
            if due is None or overdue is None or due <= 0 or overdue <= 0:
                raise ValueError(f"{label}: Due and Overdue must be positive numbers")
            if overdue <= due:
                raise ValueError(f"{label}: Overdue must be greater than Due")
            if parameter == "counter":
                if not float(due).is_integer() or not float(overdue).is_integer():
                    raise ValueError(f"{label}: Due and Overdue must be whole numbers of cycles")
                due, overdue = int(due), int(overdue)
            activation_at = config.get("activation_at")
            if parameter == "time" and activation_at is not None and not isinstance(activation_at, str):
                raise ValueError(f"{label}: start time must be an ISO-8601 timestamp")
            if parameter == "time" and activation_at:
                try:
                    datetime.fromisoformat(activation_at.replace("Z", "+00:00"))
                except ValueError:
                    raise ValueError(f"{label}: start time must be an ISO-8601 timestamp") from None
            self.config = {
                "interval_parameter": parameter,
                "due": due,
                "overdue": overdue,
                **({"activation_at": activation_at} if parameter == "time" and activation_at else {}),
            }
            if stored:
                return self
            if parameter == "counter":
                if self.aggregation != "counter" or self.variable_id is None:
                    raise ValueError(f"{label}: Counter intervals need a variable with Counter aggregation")
            elif self.variable_id is None:
                # Calendar-based Time interval: no PLC variable; elapsed hours since the start time.
                if parameter != "time" or self.aggregation != "none":
                    raise ValueError(f"{label}: Usage intervals need a variable with Timer aggregation")
            elif self.aggregation != "timer":
                raise ValueError(f"{label}: Usage and Time intervals with a variable need Timer aggregation")
        return self


class MultiParameterRuleCreate(ORMModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    labels: list[str] = Field(default_factory=list, max_length=10)
    category: Literal["parameter_threshold", "interval_based"]
    # How long the aggregated value is calculated over (seconds). Required for Parameter Threshold.
    calculation_period_seconds: int | None = Field(default=None, ge=1, le=31_536_000)
    parameters: list[RuleParameterIn] = Field(min_length=1, max_length=MAX_PARAMETERS)
    reference_link: str | None = Field(default=None, max_length=2000)
    instructions: str | None = None
    # Existing documents from the document library (uploaded through the existing upload flow).
    document_ids: list[int] = Field(default_factory=list, max_length=20)
    is_enabled: bool = True
    stale_after_seconds: int | None = Field(default=None, ge=1, le=31_536_000)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Rule name cannot be empty")
        return value

    @field_validator("labels")
    @classmethod
    def clean_labels(cls, value: list[str]) -> list[str]:
        return normalize_label_names(value)

    @field_validator("reference_link")
    @classmethod
    def check_link(cls, value: str | None) -> str | None:
        value = (value or "").strip()
        if not value:
            return None
        if not (value.lower().startswith("http://") or value.lower().startswith("https://")):
            raise ValueError("Reference link must start with http:// or https://")
        return value

    @model_validator(mode="after")
    def validate_rule(self):
        if self.category == "parameter_threshold":
            if self.calculation_period_seconds is None:
                raise ValueError("Parameter Threshold rules need a calculation period")
            if any(item.kind == "interval" for item in self.parameters):
                raise ValueError("Parameter Threshold rules cannot contain interval parameters")
        else:
            if any(item.kind != "interval" for item in self.parameters):
                raise ValueError("Interval Based rules can only contain interval parameters")
        names = [item.name.casefold() for item in self.parameters]
        if len(set(names)) != len(names):
            raise ValueError("Parameter names must be unique within a rule")
        keys = [item.key for item in self.parameters if item.key]
        if len(set(keys)) != len(keys):
            raise ValueError("Parameter keys must be unique within a rule")
        return self


class ParameterLifecycleAction(ORMModel):
    """Suspend / resume / deactivate / activate one parameter of a multi-parameter rule."""

    action: Literal["suspend", "resume", "deactivate", "activate"]


class RuleParametersReplace(ORMModel):
    """Edit a rule's parameters in one transaction. Matching is by key, never by position."""

    calculation_period_seconds: int | None = Field(default=None, ge=1, le=31_536_000)
    parameters: list[RuleParameterIn] = Field(min_length=1, max_length=MAX_PARAMETERS)


def normalize_template_parameters(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Validate and normalise the `parameters` JSON of a multi-parameter rule TEMPLATE.

    A template keeps the parameter DEFINITIONS (name, type, aggregation, limits) in `parameter_defs`, each with a
    stable `key`. It holds no variable ids: a variable is chosen per parameter when the template is assigned to an
    asset (`variable_key` is only a hint for matching). Every definition is validated by the same rules as a real
    parameter, so a template can never hold something an asset rule would reject.
    """
    import uuid

    raw = dict(raw or {})
    category = raw.get("category")
    if category not in CATEGORIES:
        raise ValueError("A multi-parameter template needs a category (parameter_threshold or interval_based)")
    period = raw.get("calculation_period_seconds")
    if period is not None:
        if isinstance(period, bool) or not isinstance(period, int) or not 1 <= period <= 31_536_000:
            raise ValueError("calculation_period_seconds must be a whole number of seconds")
    if category == "parameter_threshold" and period is None:
        raise ValueError("Parameter Threshold rules need a calculation period")
    defs = raw.get("parameter_defs")
    if not isinstance(defs, list) or not 1 <= len(defs) <= MAX_PARAMETERS:
        raise ValueError(f"A multi-parameter template needs between 1 and {MAX_PARAMETERS} parameters")
    normalised: list[dict[str, Any]] = []
    for definition in defs:
        if not isinstance(definition, dict):
            raise ValueError("Each template parameter must be an object")
        uses_variable = definition.get("uses_variable", True)
        if not isinstance(uses_variable, bool):
            raise ValueError("uses_variable must be true or false")
        item = RuleParameterIn(
            key=definition.get("key"), name=definition.get("name") or "", kind=definition.get("kind"),
            variable_id=1 if uses_variable else None,
            aggregation=definition.get("aggregation") or "none", config=definition.get("config") or {})
        hint = str(definition.get("variable_key") or "").strip()[:200]
        normalised.append({
            "key": item.key or str(uuid.uuid4()), "name": item.name, "kind": item.kind,
            "aggregation": item.aggregation, "config": item.config, "uses_variable": uses_variable,
            "variable_key": hint or None,
        })
    if category == "parameter_threshold" and any(item["kind"] == "interval" for item in normalised):
        raise ValueError("Parameter Threshold rules cannot contain interval parameters")
    if category == "interval_based" and any(item["kind"] != "interval" for item in normalised):
        raise ValueError("Interval Based rules can only contain interval parameters")
    names = [item["name"].casefold() for item in normalised]
    if len(set(names)) != len(names):
        raise ValueError("Parameter names must be unique within a rule")
    if len({item["key"] for item in normalised}) != len(normalised):
        raise ValueError("Parameter keys must be unique within a rule")
    link = str(raw.get("reference_link") or "").strip()
    if link and not link.lower().startswith(("http://", "https://")):
        raise ValueError("Reference link must start with http:// or https://")
    instructions = str(raw.get("maintenance_instructions") or "").strip()
    return {
        "category": category, "calculation_period_seconds": period, "combine": "worst",
        **({"reference_link": link} if link else {}),
        **({"maintenance_instructions": instructions} if instructions else {}),
        "parameter_defs": normalised,
    }
