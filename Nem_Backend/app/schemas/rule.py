#Pydantic schemas for creating,updating and reading monitoring rules 
from datetime import datetime
from decimal import Decimal
import math
from typing import Any, Literal
from pydantic import Field, field_validator, model_validator
from app.schemas.common import ORMModel
#This schems defines what information a user must supply when creating a rule
class RuleCreate(ORMModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    rule_type: Literal[
        "parameter_threshold",
        "runtime_duration",
        "duration",
        "generic",
        "boolean_count_threshold",
    ]
    target_asset_id: int | None = Field(default=None, gt=0)
    variable_id: int | None = Field(default=None, gt=0)
    operator: Literal["<", "<=", "==", "!=", ">=", ">", "lt", "lte", "eq", "ne", "gte", "gt"] | None = None
    threshold: Decimal | None = None
    parameters: dict[str, Any] | None = None
    severity: Literal["warning", "alert"]
    is_enabled: bool = True
    evaluation_interval_seconds: int | None = Field(default=None, ge=1, le=31_536_000)
    stale_after_seconds: int | None = Field(default=None, ge=1, le=31_536_000)

    @field_validator("threshold")
    @classmethod
    def finite_threshold(cls, value: Decimal | None) -> Decimal | None:
        if value is not None and not value.is_finite():
            raise ValueError("Threshold must be finite")
        return value

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Rule name cannot be empty")
        return value

    @model_validator(mode="after")
    def validate_rule_definition(self):
        if self.target_asset_id is None and self.variable_id is None:
            raise ValueError("A rule must target an asset, a variable, or both")
        if self.rule_type == "parameter_threshold":
            if self.variable_id is None or self.operator is None or self.threshold is None:
                raise ValueError("Parameter threshold rules require a variable, operator, and threshold")
        if self.rule_type in {"runtime_duration", "duration"}:
            duration = self.parameters.get("duration_seconds") if self.parameters else None
            if not isinstance(duration, int) or isinstance(duration, bool) or duration <= 0:
                raise ValueError("Duration rules require a positive parameters.duration_seconds")
            if self.rule_type == "duration":
                if self.variable_id is None:
                    raise ValueError("Duration rules require a target variable")
                condition = self.parameters.get("condition", "equals")
                if condition == "threshold":
                    if self.parameters.get("operator") not in {
                        "<", "<=", "==", "!=", ">=", ">", "lt", "lte", "eq", "ne", "gte", "gt"
                    } or not isinstance(self.parameters.get("threshold"), (int, float)):
                        raise ValueError("Threshold duration rules require a supported operator and numeric threshold")
                    threshold = self.parameters["threshold"]
                    if isinstance(threshold, bool) or (isinstance(threshold, float) and not math.isfinite(threshold)):
                        raise ValueError("parameters.threshold must be finite and numeric")
                elif condition == "equals":
                    expected_value = self.parameters.get("expected_value")
                    if not isinstance(expected_value, (str, bool, int, float)):
                        raise ValueError("Equals duration rules require a scalar parameters.expected_value")
                    if isinstance(expected_value, float) and not math.isfinite(expected_value):
                        raise ValueError("parameters.expected_value must be finite")
                else:
                    raise ValueError("Duration condition must be 'equals' or 'threshold'")
        if self.rule_type == "boolean_count_threshold":
            if self.variable_id is None:
                raise ValueError("Boolean count threshold rules require a variable_id")
            parameters = self.parameters or {}
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
            ):
                raise ValueError("warning_thresholds must contain two increasing positive integers")

            if (
                not isinstance(alert_threshold, int)
                or isinstance(alert_threshold, bool)
                or alert_threshold <= warning_thresholds[1]
            ):
                raise ValueError("alert_threshold must be a positive integer greater than both warnings")
        return self


class RuleTemplateCreate(ORMModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    rule_type: Literal[
        "parameter_threshold",
        "runtime_duration",
        "duration",
        "boolean_count_threshold",
    ]
    required_variable_types: list[
        Literal["number", "integer", "boolean", "string"]
    ] | None = None
    variable_key: str | None = Field(default=None, max_length=100)
    operator: Literal["<", "<=", "==", "!=", ">=", ">", "lt", "lte", "eq", "ne", "gte", "gt"] | None = None
    threshold: Decimal | None = None
    parameters: dict[str, Any] | None = None
    severity: Literal["warning", "alert"]
    is_enabled: bool = True
    evaluation_interval_seconds: int | None = Field(default=None, ge=1, le=31_536_000)
    stale_after_seconds: int | None = Field(default=None, ge=1, le=31_536_000)

    @field_validator("name")
    @classmethod
    def strip_template_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Template name cannot be empty")
        return value

    @field_validator("required_variable_types")
    @classmethod
    def unique_variable_types(
        cls, value: list[str] | None
    ) -> list[str] | None:
        if value is not None and len(value) != len(set(value)):
            raise ValueError("Required variable types must be unique")
        return value

    @model_validator(mode="after")
    def validate_template_definition(self):
        required_types = self.required_variable_types
        if self.rule_type == "parameter_threshold":
            if required_types is None:
                self.required_variable_types = ["number", "integer"]
            elif not required_types or any(
                item not in {"number", "integer"} for item in required_types
            ):
                raise ValueError(
                    "Parameter threshold templates require number or integer variables"
                )
        elif self.rule_type == "boolean_count_threshold":
            if required_types is not None and required_types != ["boolean"]:
                raise ValueError(
                    "Boolean count templates require boolean variables"
                )
            self.required_variable_types = ["boolean"]
        elif self.rule_type == "duration":
            if required_types is None:
                condition = (self.parameters or {}).get("condition", "equals")
                expected = (self.parameters or {}).get("expected_value")
                if condition == "threshold":
                    self.required_variable_types = ["number", "integer"]
                elif isinstance(expected, bool):
                    self.required_variable_types = ["boolean"]
                elif isinstance(expected, str):
                    self.required_variable_types = ["string"]
                else:
                    self.required_variable_types = ["number", "integer"]
        elif required_types:
            raise ValueError(
                "This rule type does not support a required variable type"
            )

        needs_variable = self.rule_type in {
            "parameter_threshold",
            "duration",
            "boolean_count_threshold",
        }
        RuleCreate.model_validate(
            {
                "name": self.name,
                "description": self.description,
                "rule_type": self.rule_type,
                "target_asset_id": 1,
                "variable_id": 1 if needs_variable else None,
                "operator": self.operator,
                "threshold": self.threshold,
                "parameters": self.parameters,
                "severity": self.severity,
                "is_enabled": self.is_enabled,
                "evaluation_interval_seconds": self.evaluation_interval_seconds,
                "stale_after_seconds": self.stale_after_seconds,
            }
        )
        return self


class RuleTemplateRead(RuleTemplateCreate):
    id: int
    legacy_rule_id: int | None = None
    created_at: datetime
    updated_at: datetime


class RuleTemplateAssetAssignment(ORMModel):
    asset_ids: list[int] = Field(min_length=1, max_length=100)
    variable_mappings: dict[int, int] = Field(default_factory=dict)

    @field_validator("asset_ids")
    @classmethod
    def unique_asset_ids(cls, value: list[int]) -> list[int]:
        if any(asset_id <= 0 for asset_id in value):
            raise ValueError("Asset IDs must be positive")
        if len(value) != len(set(value)):
            raise ValueError("Asset IDs must be unique")
        return value

    @field_validator("variable_mappings")
    @classmethod
    def positive_variable_mappings(cls, value: dict[int, int]) -> dict[int, int]:
        if any(asset_id <= 0 or variable_id <= 0 for asset_id, variable_id in value.items()):
            raise ValueError("Asset and variable IDs must be positive")
        return value

    @model_validator(mode="after")
    def mappings_must_match_selected_assets(self):
        if set(self.variable_mappings) - set(self.asset_ids):
            raise ValueError("Variable mappings may only reference selected assets")
        return self


#Modifying an existing rule
class RuleUpdate(ORMModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    rule_type: Literal[
        "parameter_threshold",
        "runtime_duration",
        "duration",
        "generic",
        "boolean_count_threshold",
    ] | None = None
    target_asset_id: int | None = Field(default=None, gt=0)
    variable_id: int | None = Field(default=None, gt=0)
    operator: Literal["<", "<=", "==", "!=", ">=", ">", "lt", "lte", "eq", "ne", "gte", "gt"] | None = None
    threshold: Decimal | None = None
    parameters: dict[str, Any] | None = None
    severity: Literal["warning", "alert"] | None = None
    is_enabled: bool | None = None
    evaluation_interval_seconds: int | None = Field(default=None, ge=1, le=31_536_000)
    stale_after_seconds: int | None = Field(default=None, ge=1, le=31_536_000)

    @field_validator("threshold")
    @classmethod
    def finite_threshold(cls, value: Decimal | None) -> Decimal | None:
        if value is not None and not value.is_finite():
            raise ValueError("Threshold must be finite")
        return value

    @field_validator("parameters")
    @classmethod
    def validate_duration_parameters(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None and "duration_seconds" in value:
            duration = value["duration_seconds"]
            if not isinstance(duration, int) or isinstance(duration, bool) or duration <= 0:
                raise ValueError("parameters.duration_seconds must be a positive integer")
            expected_state = value.get("expected_value")
            if expected_state is not None and (
                not isinstance(expected_state, (str, bool, int, float))
            ):
                raise ValueError("parameters.expected_value must be a scalar")
            threshold = value.get("threshold")
            if threshold is not None and (
                isinstance(threshold, bool)
                or not isinstance(threshold, (int, float))
            ):
                raise ValueError("parameters.threshold must be numeric")
            if isinstance(threshold, float) and not math.isfinite(threshold):
                raise ValueError("parameters.threshold must be finite")
            if isinstance(expected_state, float) and not math.isfinite(expected_state):
                raise ValueError("parameters.expected_value must be finite")
        return value

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("Rule name cannot be empty")
        return value

# returning a rule to the frontend
class RuleRead(ORMModel):
    id: int
    name: str
    description: str | None
    rule_type: str
    target_asset_id: int | None
    source_template_id: int | None = None
    variable_id: int | None
    operator: str | None
    threshold: Decimal | None
    parameters: dict[str, Any] | None
    severity: str
    is_enabled: bool
    evaluation_interval_seconds: int | None
    stale_after_seconds: int | None
    created_at: datetime
    updated_at: datetime


class FrontendRuleCreate(ORMModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    severity: Literal["warning", "alert"]

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Rule name cannot be empty")
        return value


class UsageRuleCreate(FrontendRuleCreate):
    variable_id: int = Field(gt=0)
    usage_limit: float = Field(gt=0)

    @field_validator("usage_limit")
    @classmethod
    def finite_usage_limit(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("Usage limit must be finite")
        return value


class RuleSelection(ORMModel):
    rule_ids: list[int] = Field(min_length=1, max_length=100)
    variable_mappings: dict[int, int] = Field(default_factory=dict)

    @field_validator("rule_ids")
    @classmethod
    def unique_rule_ids(cls, value: list[int]) -> list[int]:
        if any(rule_id <= 0 for rule_id in value):
            raise ValueError("Rule IDs must be positive")
        if len(value) != len(set(value)):
            raise ValueError("Rule IDs must be unique")
        return value

    @field_validator("variable_mappings")
    @classmethod
    def positive_variable_mappings(cls, value: dict[int, int]) -> dict[int, int]:
        if any(template_id <= 0 or variable_id <= 0 for template_id, variable_id in value.items()):
            raise ValueError("Template and variable IDs must be positive")
        return value

    @model_validator(mode="after")
    def mappings_must_match_selected_templates(self):
        if set(self.variable_mappings) - set(self.rule_ids):
            raise ValueError("Variable mappings may only reference selected templates")
        return self


class RuleCopyRequest(RuleSelection):
    source_asset_id: int = Field(gt=0)
    include_disabled: bool = True
