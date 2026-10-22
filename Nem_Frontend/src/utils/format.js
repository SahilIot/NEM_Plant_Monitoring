
export function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(value, now = Date.now()) {
  if (!value) return "never";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return String(value);
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return "0h 0m 0s";
  const wholeSeconds = Math.floor(total);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${wholeSeconds % 60}s`;
}

export function formatValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? String(value)
      : value.toLocaleString([], { maximumFractionDigits: 2 });
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

const OPERATOR_SYMBOL = {
  lt: "<", lte: "≤", eq: "=", ne: "≠", gte: "≥", gt: ">",
  "<": "<", "<=": "≤", "==": "=", "!=": "≠", ">=": "≥", ">": ">",
};

export function conditionText(rule, variableName) {
  if (rule.rule_type === "runtime_duration") {
    const warnings = rule.parameters?.warning_thresholds_seconds;
    const alert = rule.parameters?.alert_threshold_seconds;
    if (Array.isArray(warnings) && warnings.length === 2 && alert != null) {
      return `Running time · warning at ${(Number(warnings[0]) / 3600).toFixed(2)} h / ${(Number(warnings[1]) / 3600).toFixed(2)} h, alert at ${(Number(alert) / 3600).toFixed(2)} h`;
    }
  }
  if (rule.rule_type === "boolean_count_threshold") {
    const warnings = rule.parameters?.warning_thresholds;
    const alert = rule.parameters?.alert_threshold;
    if (
      !Array.isArray(warnings) ||
      warnings.length !== 2 ||
      alert == null
    ) {
      return "Cycle-count thresholds";
    }
    const formatCount = (value) =>
      Number(value).toLocaleString([], { maximumFractionDigits: 0 });
    return `Cycles: warning at ${formatCount(warnings[0])} / ${formatCount(warnings[1])}, alert at ${formatCount(alert)}`;
  }
  const expectedBoolean = rule.parameters?.expected_value;
  if (rule.rule_type === "parameter_threshold" && typeof expectedBoolean === "boolean") {
    const condition = rule.operator === "!=" || rule.operator === "ne" ? "is not" : "is";
    return `${variableName || "Signal"} ${condition} ${expectedBoolean ? "ON" : "OFF"}`;
  }
  if (rule.rule_type !== "parameter_threshold" || rule.threshold == null) return "";
  const symbol = OPERATOR_SYMBOL[rule.operator] || rule.operator || "";
  return `${variableName || "Value"} ${symbol} ${rule.threshold}`;
}
