// Shared rule summaries keep reusable-rule cards consistent across assignment workflows.
export function formatRuleDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value % 86400 === 0) return `${value / 86400}d`;
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

// Show the configured threshold or condition using the same wording in both assignment modals.
export function ruleConditionSummary(rule) {
  const parameters = rule.parameters || {};
  if (rule.rule_type === "runtime_duration") {
    const warningThresholds = parameters.warning_thresholds_seconds || [];
    const alertThreshold = parameters.alert_threshold_seconds;
    if (warningThresholds.length === 2 && alertThreshold != null) {
      return `Running time · warning at ${formatRuleDuration(warningThresholds[0])} / ${formatRuleDuration(warningThresholds[1])}, alert at ${formatRuleDuration(alertThreshold)}`;
    }
  }
  if (rule.rule_type === "boolean_count_threshold") {
    const warningThresholds = parameters.warning_thresholds || [];
    if (warningThresholds.length === 2 && parameters.alert_threshold != null) {
      return `Cycle count · warning at ${warningThresholds[0]} / ${warningThresholds[1]}, alert at ${parameters.alert_threshold}`;
    }
  }
  if (
    rule.rule_type === "runtime_duration" &&
    Array.isArray(parameters.warning_thresholds_seconds) &&
    parameters.warning_thresholds_seconds.length === 2 &&
    parameters.alert_threshold_seconds != null
  ) {
    return `Running time · warnings at ${formatRuleDuration(parameters.warning_thresholds_seconds[0])} / ${formatRuleDuration(parameters.warning_thresholds_seconds[1])} · alert at ${formatRuleDuration(parameters.alert_threshold_seconds)}`;
  }
  if (rule.rule_type === "parameter_threshold" && parameters.temperature_rule === true) {
    const unit = parameters.unit || "°C";
    return `Temperature · warning at ${parameters.warning_threshold ?? "—"} ${unit} / alert at ${parameters.alert_threshold ?? "—"} ${unit}`;
  }
  if (
    rule.rule_type === "parameter_threshold" &&
    typeof parameters.expected_value === "boolean"
  ) {
    return `Boolean signal ${rule.operator === "!=" || rule.operator === "ne" ? "is not" : "is"} ${parameters.expected_value ? "ON" : "OFF"}`;
  }
  if (rule.rule_type === "duration") {
    if (parameters.condition === "interval_elapsed") {
      return `Every ${formatRuleDuration(parameters.interval_seconds)}`;
    }
    const duration = formatRuleDuration(parameters.duration_seconds);
    if (parameters.condition === "threshold") {
      if ((rule.required_variable_types || []).includes("boolean")) {
        return `Invalid definition: Boolean signals cannot be compared with ${parameters.operator || ""} ${parameters.threshold}; the signal should stay ON for ${duration || "the configured duration"}`;
      }
      return `Value ${parameters.operator || ""} ${parameters.threshold} for ${duration || "configured duration"}`;
    }
    if (typeof parameters.expected_value === "boolean") {
      return `Signal ${parameters.expected_value ? "ON" : "OFF"} continuously for ${duration || "configured duration"}`;
    }
  }
  if (rule.rule_type === "parameter_threshold" && rule.threshold != null) {
    return `Value ${rule.operator || ""} ${rule.threshold}`.trim();
  }
  return rule.description || "Asset-level monitoring rule";
}

// Keep severity and multi-label filtering identical in both reusable-rule assignment dialogs.
export function matchesRuleFilters(rule, severity, labelIds) {
  const matchesSeverity =
    severity === "all" ||
    (rule.severity || "warning").toLowerCase() === severity;
  const ruleLabelIds = (rule.labels || []).map((label) =>
    Number(typeof label === "object" ? label.id : label)
  );
  const matchesLabels =
    labelIds.length === 0 ||
    labelIds.every((id) => ruleLabelIds.includes(Number(id)));
  return matchesSeverity && matchesLabels;
}

// Derive collection status from its member-level assignment availability.
export function collectionAssignmentStatus(memberCount, assignedCount, availableCount) {
  if (memberCount > 0 && assignedCount === memberCount) return "Assigned";
  if (assignedCount > 0) return "Partially Assigned";
  return availableCount > 0 ? "Available" : "Unavailable";
}
