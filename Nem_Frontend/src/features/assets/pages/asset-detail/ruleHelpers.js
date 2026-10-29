import { formatValue } from "../../../../utils/format.js";

export function thresholdMetrics(rule) {
  const expectedBoolean = rule.parameters?.expected_value;
  if (
    rule.rule_type === "parameter_threshold" &&
    typeof expectedBoolean === "boolean"
  ) {
    return [
      {
        label: "Condition",
        value: `${rule.operator === "!=" || rule.operator === "ne" ? "is not" : "is"} ${expectedBoolean ? "ON" : "OFF"}`,
      },
    ];
  }
  if (rule.rule_type === "runtime_duration") {
    const warnings = rule.parameters?.warning_thresholds_seconds;
    const alert = rule.parameters?.alert_threshold_seconds;
    if (Array.isArray(warnings) && warnings.length === 2 && alert != null) {
      return [
        {
          label: "Warning",
          value: `${(Number(warnings[0]) / 3600).toFixed(2)} h`,
        },
        {
          label: "Higher warning",
          value: `${(Number(warnings[1]) / 3600).toFixed(2)} h`,
        },
        { label: "Alert", value: `${(Number(alert) / 3600).toFixed(2)} h` },
      ];
    }
  }
  if (rule.rule_type === "boolean_count_threshold") {
    const warnings = rule.parameters?.warning_thresholds;
    const alert = rule.parameters?.alert_threshold;
    if (Array.isArray(warnings) && warnings.length === 2 && alert != null) {
      return [
        { label: "Warning", value: Number(warnings[0]).toLocaleString() },
        {
          label: "Higher warning",
          value: Number(warnings[1]).toLocaleString(),
        },
        { label: "Alert", value: Number(alert).toLocaleString() },
      ];
    }
  }
  if (rule.threshold !== null && rule.threshold !== undefined) {
    return [
      {
        label: "Threshold",
        value: `${rule.operator || ""} ${formatValue(rule.threshold)}`.trim(),
      },
    ];
  }
  return [];
}

export function thresholdSequence(rule) {
  const parameters = rule.parameters || {};
  if (
    rule.rule_type === "runtime_duration" &&
    Array.isArray(parameters.warning_thresholds_seconds) &&
    parameters.warning_thresholds_seconds.length === 2 &&
    parameters.alert_threshold_seconds != null
  ) {
    return [
      {
        label: "Warning",
        value: Number(parameters.warning_thresholds_seconds[0]),
      },
      {
        label: "Higher warning",
        value: Number(parameters.warning_thresholds_seconds[1]),
      },
      { label: "Alert", value: Number(parameters.alert_threshold_seconds) },
    ];
  }
  if (
    rule.rule_type === "boolean_count_threshold" &&
    Array.isArray(parameters.warning_thresholds) &&
    parameters.warning_thresholds.length === 2 &&
    parameters.alert_threshold != null
  ) {
    return [
      { label: "Warning", value: Number(parameters.warning_thresholds[0]) },
      {
        label: "Higher warning",
        value: Number(parameters.warning_thresholds[1]),
      },
      { label: "Alert", value: Number(parameters.alert_threshold) },
    ];
  }
  return [];
}

export function compactRuleDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "duration not set";
  if (value % 86400 === 0) return `${value / 86400}d`;
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

export function ruleConditionSummary(rule) {
  const parameters = rule.parameters || {};
  if (rule.rule_type === "duration") {
    const duration = compactRuleDuration(parameters.duration_seconds);
    if (parameters.condition === "threshold") {
      if (rule.variable_data_type === "boolean") {
        return `Invalid condition: Boolean signal cannot be compared with ${parameters.operator || ""} ${parameters.threshold}; expected ON/OFF for ${duration}.`;
      }
      return `Value ${parameters.operator || ""} ${parameters.threshold} for ${duration}`.trim();
    }
    if (typeof parameters.expected_value === "boolean") {
      return `Signal ${parameters.expected_value ? "ON" : "OFF"} continuously for ${duration}`;
    }
  }
  if (rule.rule_type === "runtime_duration") {
    const warnings = parameters.warning_thresholds_seconds;
    const alert = parameters.alert_threshold_seconds;
    if (Array.isArray(warnings) && warnings.length === 2 && alert != null) {
      return `Running time · warnings at ${compactRuleDuration(warnings[0])} / ${compactRuleDuration(warnings[1])}, alert at ${compactRuleDuration(alert)}`;
    }
  }
  if (rule.rule_type === "boolean_count_threshold") {
    const warnings = parameters.warning_thresholds;
    if (
      Array.isArray(warnings) &&
      warnings.length === 2 &&
      parameters.alert_threshold != null
    ) {
      return `Cycle count · warnings at ${warnings[0]} / ${warnings[1]}, alert at ${parameters.alert_threshold}`;
    }
  }
  if (
    rule.rule_type === "parameter_threshold" &&
    typeof parameters.expected_value === "boolean"
  ) {
    return `Signal ${rule.operator === "!=" || rule.operator === "ne" ? "is not" : "is"} ${parameters.expected_value ? "ON" : "OFF"}`;
  }
  if (rule.rule_type === "parameter_threshold" && rule.threshold != null) {
    return `Value ${rule.operator || ""} ${rule.threshold}`.trim();
  }
  return null;
}

export function formatTimeUntilStart(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0)
    return "Starting now";
  let remaining = Math.ceil(milliseconds / 1000);
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

export const isBlank = (value) =>
  value === undefined || value === null || String(value).trim() === "";

export const sameNumber = (a, b) =>
  !isBlank(a) && !isBlank(b) && Number(a) === Number(b);

// Builds the rule-specific threshold/interval part of a PATCH payload from
// the edit form. Only values the user actually changed are included.
export function buildRuleThresholdChanges(ruleType, values, initial) {
  const changes = {};

  if (ruleType === "runtime_duration") {
    const keys = [
      "runtime_warning_hours",
      "runtime_warning_2_hours",
      "runtime_alert_hours",
    ];
    if (!keys.every((key) => sameNumber(values[key], initial[key]))) {
      const [warning1, warning2, alert] = keys.map((key) =>
        Number(values[key]),
      );
      if (
        keys.some((key) => isBlank(values[key])) ||
        ![warning1, warning2, alert].every(
          (value) => Number.isFinite(value) && value > 0,
        ) ||
        warning1 >= warning2 ||
        warning2 >= alert
      ) {
        throw new Error(
          "Running-time thresholds must be positive and strictly increasing.",
        );
      }
      changes.parameters = {
        warning_thresholds_seconds: [
          Math.round(warning1 * 3600),
          Math.round(warning2 * 3600),
        ],
        alert_threshold_seconds: Math.round(alert * 3600),
      };
    }
  } else if (ruleType === "boolean_count_threshold") {
    const keys = [
      "warning_threshold_1",
      "warning_threshold_2",
      "alert_threshold",
    ];
    if (!keys.every((key) => sameNumber(values[key], initial[key]))) {
      const [warning1, warning2, alert] = keys.map((key) =>
        Number(values[key]),
      );
      if (
        keys.some((key) => isBlank(values[key])) ||
        ![warning1, warning2, alert].every(
          (value) => Number.isSafeInteger(value) && value > 0,
        ) ||
        warning1 >= warning2 ||
        warning2 >= alert
      ) {
        throw new Error(
          "Cycle thresholds must be positive whole numbers in increasing order.",
        );
      }
      changes.parameters = {
        warning_thresholds: [warning1, warning2],
        alert_threshold: alert,
      };
    }
  } else if (
    ruleType === "parameter_threshold" &&
    !sameNumber(values.threshold, initial.threshold) &&
    !isBlank(values.threshold)
  ) {
    const threshold = Number(values.threshold);
    if (!Number.isFinite(threshold)) {
      throw new Error("Enter a valid numeric threshold.");
    }
    changes.threshold = threshold;
  }

  if (
    !isBlank(values.evaluation_interval_seconds) &&
    !sameNumber(
      values.evaluation_interval_seconds,
      initial.evaluation_interval_seconds,
    )
  ) {
    const interval = Number(values.evaluation_interval_seconds);
    if (!Number.isInteger(interval) || interval < 1) {
      throw new Error(
        "Evaluation interval must be a whole number of seconds (1 or more).",
      );
    }
    changes.evaluation_interval_seconds = interval;
  }

  return changes;
}
