// The two rule types users can choose when creating a rule. They are a user-facing
// classification only: each category groups the existing backend rule types, none of
// which is renamed, merged or migrated.
export const RULE_CATEGORIES = [
  {
    id: "interval",
    label: "Interval Based",
    description:
      "Alert as running time, cycle count or scheduled running time reaches its thresholds.",
  },
  {
    id: "parameter",
    label: "Parameter Threshold",
    description:
      "Compare a variable's value with a threshold and alert when it is crossed.",
  },
];

// Backend (and library-template alias) rule types per category.
const INTERVAL_TYPES = new Set([
  "runtime_duration",
  "boolean_count_threshold",
  "duration",
  "interval_based",
]);
const PARAMETER_TYPES = new Set([
  "parameter_threshold",
  "temperature_monitoring",
  "boolean_condition",
]);

// A Boolean parameter_threshold template that is not a state check accumulates running time.
const isRunningTimeTemplate = (rule) =>
  rule.rule_type === "parameter_threshold" &&
  rule.required_variable_types?.includes("boolean") &&
  rule.parameters?.expected_value === true &&
  rule.parameters?.evaluation_mode !== "state";

/** "interval", "parameter", or null for types outside both categories (e.g. generic). */
export function ruleCategoryId(rule) {
  if (!rule?.rule_type) return null;
  // A multi-parameter rule is stored under its own backend type; its category is in its parameters.
  if (rule.rule_type === "multi_parameter") {
    return rule.parameters?.category === "interval_based" ? "interval" : "parameter";
  }
  if (isRunningTimeTemplate(rule)) return "interval";
  if (INTERVAL_TYPES.has(rule.rule_type)) return "interval";
  if (PARAMETER_TYPES.has(rule.rule_type)) return "parameter";
  return null;
}

export function ruleCategoryLabel(rule) {
  const id = ruleCategoryId(rule);
  return RULE_CATEGORIES.find((category) => category.id === id)?.label || null;
}
