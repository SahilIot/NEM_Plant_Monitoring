export const ruleFields = (
  variables,
  cycleVariableIds,
  runtimeVariableIds,
  mappingBypassEnabled,
) => [
  {
    key: "name",
    label: "Rule name",
    required: true,
    placeholder: "e.g. Motor temperature limit",
  },
  {
    key: "description",
    label: "Description",
    type: "textarea",
    placeholder: "What should this rule watch?",
  },
  {
    key: "rule_type",
    label: "Rule type",
    type: "select",
    default: "parameter_threshold",
    options: [
      ["parameter_threshold", "Numeric value threshold (e.g. temperature)"],
      ["boolean_count_threshold", "Cycle Clock (Boolean ON/OFF count)"],
      ["runtime_duration", "Motor Running Time"],
    ],
    hint: mappingBypassEnabled
      ? "Choose a Boolean variable marked for the signal's actual purpose."
      : "Cycle counts come from this asset's configured PLC cycle signal.",
  },
  {
    key: "variable_id",
    label: "Numeric variable",
    type: "select",
    required: true,
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    options: variables
      .filter((v) => v.data_type === "number" || v.data_type === "integer")
      .map((v) => [v.id, `${v.name}${v.unit ? ` (${v.unit})` : ""}`]),
  },
  {
    key: "cycle_variable_id",
    label: mappingBypassEnabled
      ? "Boolean cycle signal"
      : "Configured Boolean cycle signal",
    type: "select",
    required: true,
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    options: variables
      .filter((v) => cycleVariableIds.includes(v.id))
      .map((v) => [v.id, `${v.name} (#${v.id})`]),
    hint: cycleVariableIds.length
      ? mappingBypassEnabled
        ? "Only variables marked as Cycle signal are available."
        : "Only Boolean variables configured as this asset's OPC UA cycle signal are available."
      : mappingBypassEnabled
        ? "Edit a Boolean variable in the asset's Variables panel and set its purpose to Cycle signal."
        : "No OPC UA cycle signal is configured for this asset. Configure it in backend OPCUA_MACHINE_MAPPINGS first.",
  },
  {
    key: "runtime_variable_id",
    label: "OPC UA Boolean running signal",
    type: "select",
    required: true,
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    options: variables
      .filter(
        (variable) =>
          variable.data_type === "boolean" &&
          runtimeVariableIds.includes(variable.id),
      )
      .map((variable) => [variable.id, variable.name]),
    hint: mappingBypassEnabled
      ? runtimeVariableIds.length
        ? "Only variables marked as Machine running state are available."
        : "Edit a Boolean variable in the asset's Variables panel and set its purpose to Machine running state."
      : "Select a mapped Boolean OPC UA variable that is true while the machine runs.",
  },
  {
    key: "operator",
    label: "Trigger when value is",
    type: "select",
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    requiredWhen: { key: "rule_type", equals: "parameter_threshold" },
    default: ">=",
    options: [
      [">=", "Greater than or equal to"],
      [">", "Greater than"],
      ["<=", "Less than or equal to"],
      ["<", "Less than"],
      ["==", "Equal to"],
      ["!=", "Not equal to"],
    ],
  },
  {
    key: "threshold",
    label: "Threshold",
    type: "number",
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    requiredWhen: { key: "rule_type", equals: "parameter_threshold" },
    placeholder: "e.g. 900",
  },
  {
    key: "warning_threshold_1",
    label: "Warning at cycle count",
    type: "number",
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    requiredWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    placeholder: "e.g. 9000",
  },
  {
    key: "warning_threshold_2",
    label: "Higher warning at cycle count",
    type: "number",
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    requiredWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    placeholder: "e.g. 9500",
  },
  {
    key: "alert_threshold",
    label: "Alert at cycle count",
    type: "number",
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    requiredWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    placeholder: "e.g. 10000",
  },
  {
    key: "runtime_warning_hours",
    label: "Warning threshold (hours)",
    type: "number",
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    requiredWhen: { key: "rule_type", equals: "runtime_duration" },
    placeholder: "e.g. 8",
  },
  {
    key: "runtime_warning_2_hours",
    label: "Higher warning threshold (hours)",
    type: "number",
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    requiredWhen: { key: "rule_type", equals: "runtime_duration" },
    placeholder: "e.g. 9",
  },
  {
    key: "runtime_alert_hours",
    label: "Alert threshold (hours)",
    type: "number",
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    requiredWhen: { key: "rule_type", equals: "runtime_duration" },
    placeholder: "e.g. 10",
  },
  {
    key: "severity",
    label: "Severity",
    type: "select",
    default: "warning",
    options: [
      ["warning", "Warning"],
      ["alert", "Alert"],
    ],
  },
  {
    key: "evaluation_interval_seconds",
    label: "Evaluation interval (seconds)",
    type: "number",
    placeholder: "Leave blank to keep the current interval",
  },
];
