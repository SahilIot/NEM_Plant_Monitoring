// Pure logic for the multi-parameter rule wizard (Parameter Threshold and Interval Based).
// Mirrors the backend rules in app/schemas/rule_parameters.py and app/services/rule_parameters.py;
// the backend remains the authority, this only gives immediate feedback and builds the payload.
import { INTERVAL_PARAMETERS, parameterById, validateLimits } from "./intervalConfig.js";

export const MAX_PARAMETERS = 20;

export const PERIOD_UNITS = [
  { id: "seconds", label: "seconds", seconds: 1 },
  { id: "minutes", label: "minutes", seconds: 60 },
  { id: "hours", label: "hours", seconds: 3600 },
  { id: "days", label: "days", seconds: 86400 },
];
export const PERIOD_PRESETS = [
  { label: "1 minute", amount: "1", unit: "minutes" },
  { label: "1 hour", amount: "1", unit: "hours" },
  { label: "1 day", amount: "1", unit: "days" },
];

export const THRESHOLD_AGGREGATIONS = [
  { id: "none", label: "None", help: "Uses the latest value of the variable as it is." },
  { id: "counter", label: "Counter", help: "Counts OFF-to-ON transitions of a Boolean variable during the calculation period." },
  { id: "last", label: "Last", help: "Uses the last value received inside the calculation period." },
  { id: "timer", label: "Timer", help: "Adds up the seconds a Boolean variable was ON during the calculation period." },
];

export const NUMBER_LIMITS = [
  { key: "lower_alert", label: "Lower Alert Limit", zone: "Lower Alert", meaning: "At or below this value the parameter is in Alert." },
  { key: "lower_warning", label: "Lower Warning Limit", zone: "Lower Warning", meaning: "At or below this value the parameter is in Warning." },
  { key: "upper_warning", label: "Upper Warning Limit", zone: "Upper Warning", meaning: "At or above this value the parameter is in Warning." },
  { key: "upper_alert", label: "Upper Alert Limit", zone: "Upper Alert", meaning: "At or above this value the parameter is in Alert." },
];

export const newKey = () =>
  (globalThis.crypto?.randomUUID?.() || `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

export function newParameter(category, index = 1) {
  const base = { uid: newKey(), name: "", variableId: "", aggregation: "none" };
  if (category === "interval_based") {
    return {
  ...base,
  kind: "interval",
  intervalParameter: "usage",
  aggregation: "timer",
  due: "",
  overdue: "",
  activationAt: "",
  timeMode: "elapsed",
  timeUnit: "days",
  startDate: "",
  name: `Interval ${index}`,
};
  }
  return { ...base, kind: "number", name: `Parameter ${index}`, limits: { lower_alert: "", lower_warning: "", upper_warning: "", upper_alert: "" }, unit: "", expected: true, severity: "alert" };
}

/** Aggregation options a parameter may use, with the reason for any that are unavailable. */
export function aggregationOptions(parameter, category) {
  if (category === "interval_based") {
    const counter = parameter.intervalParameter === "counter";
    const calendar = parameter.intervalParameter === "time" && !parameter.variableId && parameter.aggregation === "none";
    return [
      { id: "none", label: "None", disabled: !(parameter.intervalParameter === "time"), reason: "None is only for a calendar-based Time interval that has no variable." },
      { id: "timer", label: "Timer", disabled: counter, reason: "Counter intervals count cycles, not time." },
      { id: "counter", label: "Counter", disabled: parameter.intervalParameter !== "counter", reason: "Counter aggregation is used by Counter intervals." },
    ].map((item) => ({ ...item, selected: item.id === parameter.aggregation || (calendar && item.id === "none") }));
  }
  const boolean = parameter.kind === "boolean";
  return THRESHOLD_AGGREGATIONS.map((item) => ({
    ...item,
    disabled: boolean && (item.id === "counter" || item.id === "timer"),
    reason: boolean
      ? "A Boolean parameter checks a state, so Counter and Timer (which produce numbers) are not available."
      : "",
  }));
}

/** Which variable data types a parameter can use with its aggregation. */
export function variableCompatibility(parameter, variable) {
  const numeric = variable.data_type === "number" || variable.data_type === "integer";
  const boolean = variable.data_type === "boolean";
  if (parameter.kind === "interval") return boolean ? "" : "Interval parameters need a Boolean variable.";
  if (parameter.kind === "boolean") return boolean ? "" : "Boolean parameters need a Boolean variable.";
  if (parameter.aggregation === "counter" || parameter.aggregation === "timer") {
    return boolean ? "" : `${parameter.aggregation === "timer" ? "Timer" : "Counter"} aggregation needs a Boolean variable.`;
  }
  return numeric ? "" : "Number parameters with None or Last aggregation need a numeric variable.";
}

const num = (text) => (String(text ?? "").trim() === "" ? null : Number(text));

/** Unit of the value a Number parameter compares with its limits. */
export function numberUnit(parameter, variable) {
  if (parameter.aggregation === "timer") return "s";
  if (parameter.aggregation === "counter") return "cycles";
  return parameter.unit || variable?.unit || "";
}

/** Validation errors for one parameter's own configuration (not the variable connection). */
export function validateNumberLimits(limits) {
  const errors = [];
  const values = Object.fromEntries(NUMBER_LIMITS.map(({ key }) => [key, num(limits[key])]));
  for (const { key, label } of NUMBER_LIMITS) {
    if (values[key] !== null && !Number.isFinite(values[key])) errors.push(`${label} must be a number.`);
  }
  if (errors.length) return errors;
  const { lower_alert: la, lower_warning: lw, upper_warning: uw, upper_alert: ua } = values;
  if (Object.values(values).every((v) => v === null)) return ["Configure at least one limit."];
  if (la !== null && lw !== null && !(la < lw)) errors.push("Lower Alert must be lower than Lower Warning.");
  if (uw !== null && ua !== null && !(uw < ua)) errors.push("Upper Warning must be lower than Upper Alert.");
  const lowers = [la, lw].filter((v) => v !== null);
  const uppers = [uw, ua].filter((v) => v !== null);
  if (lowers.length && uppers.length && !(Math.max(...lowers) < Math.min(...uppers))) {
    errors.push("Lower limits must be below the upper limits.");
  }
  return errors;
}

/** Zone of a value; boundaries are inclusive, as in the backend (>= for upper, <= for lower). */
export function numberZone(value, limits) {
  const v = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(v)) return "unavailable";
  const n = (key) => num(limits[key]);
  if (n("upper_alert") !== null && v >= n("upper_alert")) return "upper_alert";
  if (n("lower_alert") !== null && v <= n("lower_alert")) return "lower_alert";
  if (n("upper_warning") !== null && v >= n("upper_warning")) return "upper_warning";
  if (n("lower_warning") !== null && v <= n("lower_warning")) return "lower_warning";
  return "normal";
}

export const ZONE_LABEL = {
  normal: "Normal", lower_alert: "Lower Alert", lower_warning: "Lower Warning",
  upper_warning: "Upper Warning", upper_alert: "Upper Alert", unavailable: "Unavailable",
};

/** Nearest configured limit to a value and the distance to it. */
export function nearestLimit(value, limits) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  let best = null;
  for (const { key, label } of NUMBER_LIMITS) {
    const limit = num(limits[key]);
    if (limit === null || !Number.isFinite(limit)) continue;
    const distance = Math.abs(limit - v);
    if (!best || distance < best.distance) best = { key, label, limit, distance };
  }
  return best;
}

export function calculationPeriodSeconds(amount, unitId) {
  const unit = PERIOD_UNITS.find((item) => item.id === unitId);
  const value = Number(amount);
  if (!unit || !Number.isFinite(value) || value <= 0) return null;
  const seconds = value * unit.seconds;
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 31_536_000 ? seconds : null;
}

/** All problems for the whole form, keyed by parameter uid ("rule" for rule-level ones). */
export function validateForm(values, category, variables, templateMode = false) {
  const problems = { rule: [] };
  if (!values.name.trim()) problems.rule.push("Enter a rule name.");
  if (category === "parameter_threshold" && calculationPeriodSeconds(values.periodAmount, values.periodUnit) === null) {
    problems.rule.push("Enter a calculation period of at least 1 second (whole seconds, up to 365 days).");
  }
  if (values.link.trim() && !/^https?:\/\/\S+$/i.test(values.link.trim())) {
    problems.rule.push("The reference link must start with http:// or https://.");
  }
  if (!values.parameters.length) problems.rule.push("Add at least one parameter.");
  const names = new Set();
  const used = new Map();
  for (const parameter of values.parameters) {
    const list = (problems[parameter.uid] = []);
    const name = parameter.name.trim();
    if (!name) list.push("Enter a parameter name.");
    else if (names.has(name.toLowerCase())) list.push("Parameter names must be unique within a rule.");
    names.add(name.toLowerCase());

    const variable = variables.find((item) => String(item.id) === String(parameter.variableId));
    const calendar = parameter.kind === "interval" && parameter.intervalParameter === "time" && parameter.aggregation === "none";
    if (!calendar && !templateMode) {
      if (!variable) list.push("Connect a variable.");
      else {
        const reason = variableCompatibility(parameter, variable);
        if (reason) list.push(reason);
        const pair = `${variable.id}:${parameter.aggregation}`;
        if (used.has(pair)) list.push(`The same variable and aggregation are already used by "${used.get(pair)}".`);
        used.set(pair, name || "another parameter");
      }
    }
    if (parameter.kind === "number") list.push(...validateNumberLimits(parameter.limits));
    if (parameter.kind === "interval") {
      const { errors } = validateLimits(parameter.intervalParameter, parameter.due, parameter.overdue);
      if (errors.due) list.push(errors.due);
      if (errors.overdue) list.push(errors.overdue);
      if (parameter.intervalParameter === "time" && !calendar && !parameter.activationAt && !templateMode) list.push("Choose when counting should start.");
    }
    if (parameter.intervalParameter === "time" && parameter.timeMode === "calendar") {
  if (!["days", "weeks", "months", "years"].includes(parameter.timeUnit)) {
    list.push("Choose a valid calendar time unit.");
  }

  if (!parameter.startDate) {
    list.push("Choose a calendar start date.");
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(parameter.startDate)) {
    list.push("Start date must use YYYY-MM-DD format.");
  }

  if (
    parameter.due.trim() !== "" &&
    !Number.isInteger(Number(parameter.due))
  ) {
    list.push("Calendar Due must be a whole number.");
  }

  if (
    parameter.overdue.trim() !== "" &&
    !Number.isInteger(Number(parameter.overdue))
  ) {
    list.push("Calendar Overdue must be a whole number.");
  }
}
  }
  return problems;
}

export const hasProblems = (problems) => Object.values(problems).some((list) => list.length);

/** Request body for POST /assets/{id}/multi-parameter-rules. */
export function buildMultiParameterPayload(values, category) {
  const toNumber = (text) => (String(text ?? "").trim() === "" ? null : Number(text));
  return {
    name: values.name.trim(),
    description: values.comment.trim() || null,
    labels: values.labels || [],
    category,
    calculation_period_seconds: category === "parameter_threshold" ? calculationPeriodSeconds(values.periodAmount, values.periodUnit) : null,
    reference_link: values.link.trim() || null,
    instructions: values.instructions.trim() || null,
    document_ids: values.documentIds.map(Number),
    is_enabled: true,
    parameters: values.parameters.map((parameter) => {
      const base = {
        name: parameter.name.trim(),
        kind: parameter.kind,
        variable_id: parameter.variableId ? Number(parameter.variableId) : null,
        aggregation: parameter.aggregation,
      };
      if (parameter.kind === "number") {
        return { ...base, config: { ...Object.fromEntries(Object.keys(parameter.limits).map((k) => [k, toNumber(parameter.limits[k])])), unit: parameter.unit || "" } };
      }
      if (parameter.kind === "boolean") {
        return { ...base, config: { expected: parameter.expected, severity: parameter.severity } };
      }
      const info = parameterById(parameter.intervalParameter);
      const calendarTime =
        parameter.intervalParameter === "time" &&
        parameter.timeMode === "calendar";

      return {
        ...base,
        aggregation: info.aggregation === "counter" ? "counter" : parameter.variableId ? "timer" : "none",
        config: {
          interval_parameter: parameter.intervalParameter,
          due: Number(parameter.due),
          overdue: Number(parameter.overdue),
          ...(calendarTime
            ? {
                time_mode: "calendar",
                time_unit: parameter.timeUnit,
                start_date: parameter.startDate,
              }
            : {}),
          ...(!calendarTime && parameter.intervalParameter === "time" && parameter.activationAt
            ? { activation_at: new Date(parameter.activationAt).toISOString() }
            : {}),
        },
      };
    }),
  };
}

/**
 * Reusable-rule (template) body for the parameter wizard: the parameter DEFINITIONS, with no variable ids.
 * A variable is chosen per parameter when the template is assigned to an asset; `variable_key` is only a hint.
 * Mirrors normalize_template_parameters() in the backend, which remains the authority.
 */
export function buildTemplateParameters(values, category) {
  const toNumber = (text) => (String(text ?? "").trim() === "" ? null : Number(text));
  return {
    category,
    calculation_period_seconds: category === "parameter_threshold" ? calculationPeriodSeconds(values.periodAmount, values.periodUnit) : null,
    ...(values.link.trim() ? { reference_link: values.link.trim() } : {}),
    ...(values.instructions.trim() ? { maintenance_instructions: values.instructions.trim() } : {}),
    parameter_defs: values.parameters.map((parameter) => {
      const base = {
        ...(parameter.key ? { key: parameter.key } : {}),
        name: parameter.name.trim(),
        kind: parameter.kind,
        aggregation: parameter.aggregation,
        uses_variable: true,
        variable_key: (parameter.variableKey || "").trim() || null,
      };
      if (parameter.kind === "number") {
        return { ...base, config: { ...Object.fromEntries(Object.keys(parameter.limits).map((k) => [k, toNumber(parameter.limits[k])])), unit: parameter.unit || "" } };
      }
      if (parameter.kind === "boolean") return { ...base, config: { expected: parameter.expected, severity: parameter.severity } };
      // Builds the interval parameter payload, handling calendar-based intervals
      // separately from PLC-variable-based intervals.
      const calendarTime =
        parameter.intervalParameter === "time" &&
        parameter.timeMode === "calendar";

      const calendarWithoutVariable =
        parameter.intervalParameter === "time" &&
        parameter.aggregation === "none";

      return {
        ...base,
        aggregation: parameter.intervalParameter === "counter"
          ? "counter"
          : calendarWithoutVariable ? "none" : "timer",
        uses_variable: !calendarWithoutVariable,
        config: {
          interval_parameter: parameter.intervalParameter,
          due: Number(parameter.due),
          overdue: Number(parameter.overdue),
          ...(calendarTime
            ? {
                time_mode: "calendar",
                time_unit: parameter.timeUnit,
                start_date: parameter.startDate,
              }
            : {}),
        },
      };
    }),
  };
}

/** Wizard values for an existing multi-parameter template (keys are kept so an edit updates the same parameters). */
export function valuesFromTemplate(template) {
  const meta = template.parameters || {};
  const text = (value) => (value === null || value === undefined ? "" : String(value));
  const period = meta.calculation_period_seconds;
  const unit = [...PERIOD_UNITS].reverse().find((item) => period && period % item.seconds === 0) || PERIOD_UNITS[2];
  return {
    name: template.name || "",
    periodAmount: period ? String(period / unit.seconds) : "1",
    periodUnit: unit.id,
    comment: template.description || "",
    instructions: meta.maintenance_instructions || "",
    link: meta.reference_link || "",
    documentIds: [],
    labels: template.labels || [],
    parameters: (meta.parameter_defs || []).map((def) => {
      const base = { uid: def.key, key: def.key, name: def.name, variableId: "", variableKey: def.variable_key || "", aggregation: def.aggregation };
      const config = def.config || {};
      if (def.kind === "interval") {
        // Restores saved interval settings, including calendar mode, time unit, and start date.
        return {
          ...base,
          kind: "interval",
          intervalParameter: config.interval_parameter,
          due: text(config.due),
          overdue: text(config.overdue),
          activationAt: "",
          timeMode: config.time_mode === "calendar" ? "calendar" : "elapsed",
          timeUnit: config.time_unit || "days",
          startDate: config.start_date || "",
        };
      }
      if (def.kind === "boolean") return { ...base, kind: "boolean", limits: { lower_alert: "", lower_warning: "", upper_warning: "", upper_alert: "" }, unit: "", expected: config.expected !== false, severity: config.severity || "alert" };
      return { ...base, kind: "number", limits: Object.fromEntries(NUMBER_LIMITS.map(({ key }) => [key, text(config[key])])), unit: config.unit || "", expected: true, severity: "alert" };
    }),
  };
}

export { INTERVAL_PARAMETERS };
