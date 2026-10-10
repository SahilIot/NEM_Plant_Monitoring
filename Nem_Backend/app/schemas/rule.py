from datetime import datetime
from decimal import Decimal
import math
from typing import Any, Literal

from pydantic import Field, field_validator, model_validator

from app.schemas.common import ORMModel


class RuleCreate(ORMModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    rule_type: Literal["parameter_threshold", "runtime_duration", "duration", "generic"]
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
                raise ValueError(
                    "Parameter threshold rules require a variable, operator, and threshold"
                )
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
                        raise ValueError(
                            "Threshold duration rules require a supported operator and numeric threshold"
                        )
                    threshold = self.parameters["threshold"]
                    if isinstance(threshold, bool) or (
                        isinstance(threshold, float) and not math.isfinite(threshold)
                    ):
                        raise ValueError("parameters.threshold must be finite and numeric")
                elif condition == "equals":
                    expected_value = self.parameters.get("expected_value")
                    if not isinstance(expected_value, (str, bool, int, float)):
                        raise ValueError(
                            "Equals duration rules require a scalar parameters.expected_value"
                        )
                    if isinstance(expected_value, float) and not math.isfinite(expected_value):
                        raise ValueError("parameters.expected_value must be finite")
                else:
                    raise ValueError("Duration condition must be 'equals' or 'threshold'")
        return self


class RuleUpdate(ORMModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    rule_type: Literal["parameter_threshold", "runtime_duration", "duration", "generic"] | None = None
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


class RuleRead(ORMModel):
    id: int
    name: str
    description: str | None
    rule_type: str
    target_asset_id: int | None
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
