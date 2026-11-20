// Pure logic for the Interval Based rule wizard. No React, no network.
//
// The wizard asks for exactly two limits (Due and Overdue). The backend stores interval rules with
// three increasing levels (two warnings plus one alert) and evaluates them with ">=":
//   value >= alert      -> alert   (Overdue)
//   value >= warning_2  -> warning (higher warning)
//   value >= warning_1  -> warning (first warning)
// Due is stored as the first warning and Overdue as the alert. The unused middle level is stored one
// smallest unit (1 second / 1 cycle) below Overdue, so the rule is "Due" for the whole range between
// the two limits and the existing engine, payload and validation are used unchanged.

export const INTERVAL_PARAMETERS = [
  {
    id: "usage",
    label: "Usage",
    unit: "hours",
    unitLabel: "h",
    aggregation: "timer",
    ruleType: "runtime_duration",
    signalRole: "running_signal",
    summary: "Accumulated running hours while the machine's running signal is ON.",
    help: "Counts the hours the machine has actually run. Use it for wear-based service such as oil changes or bearing checks.",
  },
  {
    id: "time",
    label: "Time",
    unit: "hours",
    unitLabel: "h",
    aggregation: "timer",
    ruleType: "runtime_duration",
    signalRole: "running_signal",
    scheduled: true,
    summary: "Running hours counted from a chosen start date and time.",
    help: "Same running-hour counting as Usage, but nothing is counted before the start date and time you choose.",
  },
  {
    id: "counter",
    label: "Counter",
    unit: "cycles",
    unitLabel: "cycles",
    aggregation: "counter",
    ruleType: "boolean_count_threshold",
    signalRole: "cycle_signal",
    summary: "Number of complete OFF-to-ON cycles of the machine's cycle signal.",
    help: "Counts how many times the machine has cycled. Use it for service that depends on repetitions, such as strokes or starts.",
  },
];

// Route kinds used by the existing asset and library URLs.
const KIND_TO_PARAMETER = {
  interval: "usage",
  "motor-running": "usage",
  time: "time",
  usage: "counter", // the existing asset route "usage" is the cycle-count workflow
  "cycle-clock": "counter",
};

export const parameterById = (id) => INTERVAL_PARAMETERS.find((item) => item.id === id) || INTERVAL_PARAMETERS[0];
export const parameterForKind = (kind) => KIND_TO_PARAMETER[kind] || "usage";

export const SAMPLE_VALUES = {
  hours: { current: 65, due: 100, overdue: 120 },
  cycles: { current: 650, due: 1000, overdue: 1200 },
};

const SECONDS_PER_HOUR = 3600;
export const toSeconds = (hours) => Math.round(Number(hours) * SECONDS_PER_HOUR);

function positive(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Validates the Due and Overdue entries. Returns { due, overdue, errors } where due/overdue are numbers
 * (or null when they cannot be used yet) and errors maps "due"/"overdue" to a message.
 * Overdue only has to be greater than Due, like the backend. `legacy` is for rules created before the parameter
 * system: they keep an intermediate warning level between Due and Overdue, which needs two units of room.
 */
export function validateLimits(parameterId, dueText, overdueText, { legacy = false } = {}) {
  const parameter = parameterById(parameterId);
  const counter = parameter.aggregation === "counter";
  const errors = {};
  const entered = (text) => String(text ?? "").trim() !== "";
  let due = positive(dueText);
  let overdue = positive(overdueText);

  if (!entered(dueText)) errors.due = "Enter the Due limit.";
  else if (due === null) errors.due = `Due must be a number greater than 0 (${parameter.unit}).`;
  else if (counter && !Number.isSafeInteger(due)) errors.due = "Due must be a whole number of cycles.";

  if (!entered(overdueText)) errors.overdue = "Enter the Overdue limit.";
  else if (overdue === null) errors.overdue = `Overdue must be a number greater than 0 (${parameter.unit}).`;
  else if (counter && !Number.isSafeInteger(overdue)) errors.overdue = "Overdue must be a whole number of cycles.";

  if (!errors.due && !errors.overdue) {
    if (overdue <= due) {
      errors.overdue = "Overdue must be greater than Due.";
    } else if (legacy && counter && overdue - due < 2) {
      errors.overdue = "Overdue must be at least 2 cycles above Due.";
    } else if (legacy && !counter && toSeconds(overdue) - toSeconds(due) < 2) {
      errors.overdue = "Overdue must be at least 2 seconds above Due.";
    }
  }
  if (errors.due) due = null;
  if (errors.overdue) overdue = null;
  return { due, overdue, errors };
}

/** Status for a value against the two limits, with the backend's inclusive ">=" boundaries. */
export function intervalStatus(value, due, overdue) {
  const number = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(number) || number < 0) {
    return "unavailable";
  }
  if (number >= overdue) return "overdue";
  if (number >= due) return "due";
  return "normal";
}

export const STATUS_LABEL = { normal: "Normal", due: "Due", overdue: "Overdue", unavailable: "Unavailable" };

export function formatAmount(value, parameterId) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const counter = parameterById(parameterId).aggregation === "counter";
  if (counter) return `${Math.round(number).toLocaleString()} cycles`;
  const text = Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
  return `${text} ${Math.abs(number) === 1 ? "hour" : "hours"}`;
}

/**
 * Geometry for the progress bar. The scale always reaches past Overdue and past the current value, so a
 * value above Overdue stays on the bar instead of breaking it.
 */
export function demoScale(value, due, overdue) {
  const current = Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const max = Math.max(overdue * 1.2, current * 1.08);
  const pct = (amount) => Math.min(100, Math.max(0, (amount / max) * 100));
  return { max, duePct: pct(due), overduePct: pct(overdue), valuePct: pct(current) };
}
