import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../services/api.js";
import { useLiveRefresh } from "../../../services/useLiveRefresh.js";
import LabelsField from "../../../components/common/LabelsField.jsx";
import { useConfirmation } from "../../../components/common/UI.jsx";
import { RuleField, UnitInput } from "./RuleFormParts.jsx";
import IntervalDemo from "./IntervalDemo.jsx";
import { BooleanDemo, NumberThresholdDemo } from "./ParameterDemos.jsx";
import VariableSelector, { describeReading } from "./VariableSelector.jsx";
import { INTERVAL_PARAMETERS, formatAmount, parameterById, validateLimits } from "./intervalConfig.js";
import {
  MAX_PARAMETERS,
  NUMBER_LIMITS,
  PERIOD_PRESETS,
  PERIOD_UNITS,
  aggregationOptions,
  calculationPeriodSeconds,
  hasProblems,
  isCalendarTime,
  newParameter,
  numberUnit,
  timeModePatch,
  validateForm,
  variableCompatibility,
} from "./parameterRules.js";
import "./IntervalRuleWizard.css";
import "./ParameterRuleWizard.css";
import { BackButton, ForwardButton } from "../../../components/common/NavButtons.jsx";
import CalendarStartFields from "./CalendarStartFields.jsx";

const STEPS = {
  parameter_threshold: ["General", "Parameters", "Instructions", "Review"],
  interval_based: ["General", "Variables", "Limits", "Instructions", "Review"],
};
const FRESH_SECONDS = 300;

const truthy = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "1", "on"].includes(text)) return true;
    if (["false", "0", "off"].includes(text)) return false;
  }
  return null;
};

/** What the preview may show for one parameter. Raw PLC values and evaluated values are kept apart. */
export function actualFor(parameter, variable, reading) {
  if (!variable) return null;
  if (!reading) return { state: "unavailable", detail: "No reading has been received for this variable yet." };
  const at = new Date(reading.recorded_at);
  if (Number.isNaN(at.getTime())) return { state: "unavailable", detail: "The reading has no valid time." };
  if ((Date.now() - at.getTime()) / 1000 > FRESH_SECONDS) {
    return { state: "unavailable", detail: `The last reading is stale (${describeReading(reading).text}).` };
  }
  const where = `${variable.name} (${describeReading(reading).text})`;
  if (parameter.kind === "boolean") {
    const value = truthy(reading.value);
    return value === null
      ? { state: "invalid", detail: `The latest value (${String(reading.value)}) is not a Boolean.` }
      : { state: "ok", value, detail: where };
  }
  if (parameter.kind === "interval") {
    return truthy(reading.value) === null
      ? { state: "invalid", detail: `The latest value (${String(reading.value)}) is not a Boolean.` }
      : { state: "ok", value: 0, detail: `${where}. A new rule starts at 0 and counts from the moment it is created.` };
  }
  if (parameter.aggregation === "counter" || parameter.aggregation === "timer") {
    return { state: "unavailable", detail: `The ${parameter.aggregation} value is calculated by the backend after the rule exists; ${where} is the raw signal.` };
  }
  const number = typeof reading.value === "number" && Number.isFinite(reading.value) ? reading.value : null;
  return number === null
    ? { state: "invalid", detail: `The latest value (${String(reading.value)}) is not a number.` }
    : { state: "ok", value: number, detail: `Raw value from ${where}.` };
}

export default function ParameterRuleWizard({
  category,
  assetId,
  assetName,
  variables,
  eligible = { running_signal: [], cycle_signal: [] },
  initialValues,
  canEdit = true,
  onSubmit,
  onCancel,
  topNotice = null,
  // Reusable-rule (template) mode: no asset, so a variable is chosen per parameter when the rule is assigned.
  templateMode = false,
  submitLabel = "Create rule",
  savingLabel = "Creating…",
  reviewExtra = null,
  extraProblem = "",
  // One fixed parameter (a reusable rule created before the parameter system): no add, remove, reorder or type change.
  singleParameter = false,
  // A new rule starts with no parameters; these fields are applied to the first one the user adds.
  firstParameterDefaults = null,
  // A Supervisor editing a rule: every field is shown but locked except the Due and Overdue values.
  limitsOnly = false,
}) {
  const confirm = useConfirmation();
  const steps = STEPS[category];
  const interval = category === "interval_based";
  const [values, setValues] = useState(initialValues);
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [readings, setReadings] = useState({});
  const [documents, setDocuments] = useState([]);
  const submitting = useRef(false);
  const headingRef = useRef(null);
  const stepName = steps[step];

  // Live values for every variable of the asset: one read when the wizard opens, then a re-read
  // whenever the shared live connection reports new readings for this asset (no timer polling).
  const readLatest = useCallback(async () => {
    try {
      const rows = await api.get(`/readings/assets/${assetId}/latest`);
      setReadings(Object.fromEntries((Array.isArray(rows) ? rows : []).map((row) => [row.variable_id, row])));
    } catch {
      setReadings({});
    }
  }, [assetId]);
  useLiveRefresh(readLatest, { tables: ["readings", "nem_readings", "variables"], delay: 1000, assetId, enabled: !templateMode });
  useEffect(() => {
    if (templateMode) return undefined;
    readLatest();
    return undefined;
  }, [assetId]);

  useEffect(() => {
    if (templateMode) return;
    api.getAll("/documents").then((rows) => setDocuments((rows || []).filter((d) => d.asset_id == null || Number(d.asset_id) === Number(assetId)))).catch(() => setDocuments([]));
  }, [assetId]);

  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [step]);

  const set = useCallback((patch) => { setValues((c) => ({ ...c, ...patch })); setError(""); }, []);
  const field = (e) => set({ [e.target.name]: e.target.value });
  const update = (uid, patch) => {
    setValues((c) => ({ ...c, parameters: c.parameters.map((p) => (p.uid === uid ? { ...p, ...patch } : p)) }));
    setError("");
  };
  const problems = useMemo(() => validateForm(values, category, variables, templateMode), [values, category, variables, templateMode]);
  const variableOf = (p) => variables.find((v) => String(v.id) === String(p.variableId)) || null;

  const addParameter = () => {
    if (values.parameters.length >= MAX_PARAMETERS) return;
    const added = newParameter(category, values.parameters.length + 1);
    if (values.parameters.length === 0 && firstParameterDefaults) Object.assign(added, firstParameterDefaults);
    set({ parameters: [...values.parameters, added] });
  };
  const removeParameter = async (p) => {
    const configured = p.variableId || (p.limits && Object.values(p.limits).some((v) => v !== "")) || p.due || p.overdue;
    if (configured && !(await confirm(`Remove "${p.name || "this parameter"}" and its configuration? Other parameters are not affected.`, { title: "Remove parameter?", confirmLabel: "Remove", cancelLabel: "Keep", destructive: true }))) return;
    set({ parameters: values.parameters.filter((x) => x.uid !== p.uid) });
  };
  const move = (index, delta) => {
    const next = [...values.parameters];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    set({ parameters: next });
  };

  // Changing the type or aggregation drops a variable that no longer fits instead of keeping a bad pairing.
  const patchCompat = (p, patch) => {
    const merged = { ...p, ...patch };
    const variable = variableOf(merged);
    if (variable && variableCompatibility(merged, variable)) patch = { ...patch, variableId: "" };
    update(p.uid, patch);
  };
  const setKind = (p, kind) => patchCompat(p, kind === "number"
    ? { kind, aggregation: "none", limits: p.limits || { lower_alert: "", lower_warning: "", upper_warning: "", upper_alert: "" } }
    : { kind, aggregation: "none", expected: p.expected ?? true, severity: p.severity || "alert" });
  const setInterval = (p, id) => {
    const info = parameterById(id);
    const stayingOnTime = id === "time" && p.intervalParameter === "time";
    // Time Mode follows the interval type: Time keeps its mode, entering Time starts Elapsed (Timer), leaving Time clears it.
    const patch = { intervalParameter: id, timeMode: stayingOnTime ? p.timeMode || "elapsed" : "elapsed", aggregation: info.aggregation === "counter" ? "counter" : stayingOnTime ? (isCalendarTime(p) ? "none" : p.aggregation) : "timer", due: p.intervalParameter === id ? p.due : "", overdue: p.intervalParameter === id ? p.overdue : "" };
    if (info.unit !== parameterById(p.intervalParameter).unit) { patch.due = ""; patch.overdue = ""; }
    if (parameterById(p.intervalParameter).signalRole !== info.signalRole) patch.variableId = "";
    update(p.uid, patch);
  };
  const setIntervalAggregation = (p, id) => {
    if (id === "counter") setInterval({ ...p, aggregation: "counter" }, "counter");
    else if (id === "none") update(p.uid, { intervalParameter: "time", timeMode: p.intervalParameter === "time" ? p.timeMode || "elapsed" : "elapsed", aggregation: "none", variableId: "", due: p.intervalParameter === "time" ? p.due : "", overdue: p.intervalParameter === "time" ? p.overdue : "" });
    else update(p.uid, { aggregation: "timer", ...(isCalendarTime(p) ? { timeMode: "elapsed" } : {}), intervalParameter: p.intervalParameter === "counter" ? "usage" : p.intervalParameter, variableId: p.intervalParameter === "counter" ? "" : p.variableId, ...(p.intervalParameter === "counter" ? { due: "", overdue: "" } : {}) });
  };

  const reasonFor = (p) => (variable) => {
    const base = variableCompatibility(p, variable);
    if (base) return base;
    if (p.kind === "interval") {
      const role = parameterById(p.intervalParameter).signalRole;
      if (!(eligible[role] || []).includes(Number(variable.id))) return role === "running_signal" ? "Not mapped as the machine running state." : "Not mapped as a cycle signal.";
    }
    const clash = values.parameters.find((o) => o.uid !== p.uid && String(o.variableId) === String(variable.id) && o.aggregation === p.aggregation);
    return clash ? `Already used by "${clash.name}" with the same aggregation.` : "";
  };

  const stepProblem = (name) => {
    const rule = problems.rule;
    const pairs = values.parameters.flatMap((p) => (problems[p.uid] || []).map((m) => ({ p, m })));
    const find = (re) => {
      const hit = pairs.find(({ m }) => re.test(m));
      return hit ? `${hit.p.name || "Parameter"}: ${hit.m}` : "";
    };
    const needsParameter = rule.find((m) => /at least one parameter/i.test(m)) || "";
    if (name === "General") return rule.find((m) => /name|period/i.test(m)) || (interval ? needsParameter : "") || find(/name|unique|start/i);
    if (name === "Variables") return find(/variable|aggregation|Timer|Counter|mapped/i);
    if (name === "Limits") return find(/Due|Overdue/);
    if (name === "Parameters") return needsParameter || find(/./);
    if (name === "Instructions") return rule.find((m) => /link/i.test(m)) || "";
    return "";
  };

  const goTo = (index) => {
    for (let check = step; check < index; check += 1) {
      const message = stepProblem(steps[check]);
      if (message) { setError(message); setShowErrors(true); setStep(check); return; }
    }
    setError("");
    setStep(index);
    setReached((c) => Math.max(c, index));
  };

  const create = async () => {
    if (submitting.current || !canEdit) return;
    if (extraProblem) { setError(extraProblem); return; }
    if (hasProblems(problems)) {
      setShowErrors(true);
      const first = steps.findIndex((name) => stepProblem(name));
      setStep(first < 0 ? steps.length - 1 : first);
      setError(stepProblem(steps[first]) || "Fix the highlighted problems before creating the rule.");
      return;
    }
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      await onSubmit(values);
    } catch (requestError) {
      setError(requestError?.message || "Could not create the rule.");
      submitting.current = false;
      setSaving(false);
    }
  };

  const disabled = saving || !canEdit;
  const locked = disabled || limitsOnly; // for every field a Supervisor may not change
  const title = (text) => <h2 className="rule-section-title pw-title"><span ref={headingRef} tabIndex={-1}>{text}</span></h2>;

  const cardHead = (p, index) => (
    <div className="pw-card-head">
      <span className="pw-index" aria-hidden="true">{index + 1}</span>
      <input aria-label={`Parameter ${index + 1} name`} className="pw-name" value={p.name} maxLength={200}
        onChange={(e) => update(p.uid, { name: e.target.value })} disabled={locked} placeholder="Enter parameter name" required aria-required="true" />
      {!singleParameter && <div className="pw-card-actions">
        <button type="button" className="btn-outline" aria-label={`Move ${p.name || "parameter"} up`} disabled={locked || index === 0} onClick={() => move(index, -1)}>↑</button>
        <button type="button" className="btn-outline" aria-label={`Move ${p.name || "parameter"} down`} disabled={locked || index === values.parameters.length - 1} onClick={() => move(index, 1)}>↓</button>
        <button type="button" className="btn-outline pw-remove" disabled={locked} onClick={() => removeParameter(p)}>Remove</button>
      </div>}
    </div>
  );
  const cardProblems = (p) => showErrors && (problems[p.uid] || []).length > 0 && (
    <ul className="pw-problems" aria-label={`Problems with ${p.name || "parameter"}`}>{problems[p.uid].map((m) => <li key={m}>{m}</li>)}</ul>
  );

  const aggregationSelect = (p) => {
    const options = aggregationOptions(p, category);
    const current = interval ? (p.aggregation === "none" || isCalendarTime(p) ? "none" : p.intervalParameter === "counter" ? "counter" : "timer") : p.aggregation;
    const info = options.find((o) => o.id === current);
    return (
      <RuleField id={`agg-${p.uid}`} label="Aggregation *" hint={info?.help || (current === "timer" ? "Timer adds up the time the signal is ON." : current === "counter" ? "Counter counts each OFF-to-ON cycle." : current === "none" ? "No variable: elapsed calendar time since the start time." : "")}>
        <select id={`agg-${p.uid}`} value={current} disabled={locked || singleParameter}
          onChange={(e) => (interval ? setIntervalAggregation(p, e.target.value) : patchCompat(p, { aggregation: e.target.value }))}>
          {options.map((o) => <option key={o.id} value={o.id} disabled={o.disabled}>{o.label}{o.disabled ? " (unavailable)" : ""}</option>)}
        </select>
        {options.some((o) => o.disabled) && <small className="iw-help">{options.filter((o) => o.disabled).map((o) => `${o.label}: ${o.reason}`).join(" ")}</small>}
      </RuleField>
    );
  };

  const connect = (p, hint) => templateMode ? (
    <RuleField id={`vkey-${p.uid}`} label="Preferred variable key" optional wide
      hint="Chosen per asset when the rule is assigned. A key here only suggests the match on assets that have a variable with that key.">
      <input id={`vkey-${p.uid}`} value={p.variableKey || ""} maxLength={200} disabled={locked} autoComplete="off"
        onChange={(e) => update(p.uid, { variableKey: e.target.value })} />
    </RuleField>
  ) : (
    <VariableSelector variables={variables} readings={readings} value={p.variableId} reasonFor={reasonFor(p)}
      assetName={assetName} disabled={locked} idPrefix={`var-${p.uid}`} hint={hint}
      onChange={(id) => update(p.uid, { variableId: id })} />
  );

  const limitInputs = (p) => (
    <div className="pw-limits">
      {NUMBER_LIMITS.map(({ key, label }) => (
        <RuleField key={key} id={`${key}-${p.uid}`} label={label}>
          <UnitInput unit={numberUnit(p, variableOf(p)) || ""}>
            <input id={`${key}-${p.uid}`} type="number" inputMode="decimal" step="any" value={p.limits[key]}
              onChange={(e) => update(p.uid, { limits: { ...p.limits, [key]: e.target.value } })} disabled={locked} />
          </UnitInput>
        </RuleField>
      ))}
      <small style={{ gridColumn: "1 / -1" }}>At least one threshold is required. Configure only the limits you want to monitor.</small>
    </div>
  );

  const thresholdCard = (p, index) => {
    const variable = variableOf(p);
    const actual = actualFor(p, variable, readings[variable?.id]);
    return (
      <section key={p.uid} className="pw-card" aria-label={`Parameter ${index + 1}`}>
        {cardHead(p, index)}
        <div className="pw-type" role="radiogroup" aria-label="Parameter type">
          {["number", "boolean"].map((kind) => (
            <button key={kind} type="button" role="radio" aria-checked={p.kind === kind}
              className={`iw-parameter-option${p.kind === kind ? " is-active" : ""}`} disabled={locked} onClick={() => p.kind !== kind && setKind(p, kind)}>
              <strong>{kind === "number" ? "Number" : "Boolean"}</strong>
              <span>{kind === "number" ? "Compare a numeric value with lower and upper limits." : "Check that the signal is TRUE or FALSE as expected."}</span>
            </button>
          ))}
        </div>
        {connect(p)}
        {aggregationSelect(p)}
        {p.kind === "number" ? (
          <>
            {limitInputs(p)}
            <NumberThresholdDemo limits={p.limits} unit={numberUnit(p, variable)} actual={actual && actual.state === "ok" ? { ...actual, aggregated: false } : actual} />
          </>
        ) : (
          <>
            <div className="pw-bool-config">
              <RuleField id={`exp-${p.uid}`} label="Expected state (normal) *">
                <select id={`exp-${p.uid}`} value={String(p.expected)} onChange={(e) => update(p.uid, { expected: e.target.value === "true" })} disabled={locked}>
                  <option value="true">TRUE</option><option value="false">FALSE</option>
                </select>
              </RuleField>
              <RuleField id={`sev-${p.uid}`} label="When not matching, raise *">
                <select id={`sev-${p.uid}`} value={p.severity} onChange={(e) => update(p.uid, { severity: e.target.value })} disabled={locked}>
                  <option value="alert">Alert</option><option value="warning">Warning</option>
                </select>
              </RuleField>
            </div>
            <BooleanDemo expected={p.expected} severity={p.severity} actual={actual} />
          </>
        )}
        {cardProblems(p)}
      </section>
    );
  };

  // Handles calendar-based intervals separately from variable-based intervals,
  // validates whole-number limits, and displays the appropriate interval demo.
  const intervalUnit = (p) =>
  p.intervalParameter === "time" && p.timeMode === "calendar"
    ? p.timeUnit || "days"
    : parameterById(p.intervalParameter).unit;

  const intervalLimits = (p) => {
  const result = validateLimits(p.intervalParameter, p.due, p.overdue);

  if (p.intervalParameter === "time" && p.timeMode === "calendar") {
    if (result.due !== null && !Number.isSafeInteger(result.due)) {
      result.errors.due = "Due must be a whole number.";
      result.due = null;
    }

    if (result.overdue !== null && !Number.isSafeInteger(result.overdue)) {
      result.errors.overdue = "Overdue must be a whole number.";
      result.overdue = null;
    }
  }

  return result;
};
  const intervalDemo = (p) => {
  const l = intervalLimits(p);

  if (p.intervalParameter === "time" && p.timeMode === "calendar") {
    return (
      <IntervalDemo
        parameterId="time"
        due={l.due}
        overdue={l.overdue}
        calendarUnit={p.timeUnit || "days"}
      />
    );
  }

  const variable = variableOf(p);

  return (
    <IntervalDemo
      parameterId={p.intervalParameter}
      due={l.due}
      overdue={l.overdue}
      actual={actualFor(p, variable, readings[variable?.id])}
    />
  );
};

  const intervalGeneralCard = (p, index) => (
    <section key={p.uid} className="pw-card" aria-label={`Parameter ${index + 1}`}>
      {cardHead(p, index)}
      <div className="iw-parameter-options" role="radiogroup" aria-label="Interval parameter">
        {INTERVAL_PARAMETERS.map((item) => (
          <button key={item.id} type="button" role="radio" aria-checked={item.id === p.intervalParameter}
            className={`iw-parameter-option${item.id === p.intervalParameter ? " is-active" : ""}`} disabled={locked || singleParameter} onClick={() => setInterval(p, item.id)}>
            <strong>{item.label}</strong><span>{item.summary}</span>
          </button>
        ))}
      </div>
      {/* Allows selecting elapsed-time or calendar-based intervals.
    Calendar mode uses a unit and start date; elapsed mode uses an activation date. */}
      {p.intervalParameter === "time" && (
        <>
        <RuleField
        id={`time-mode-${p.uid}`}
        label="Time Mode *"
        hint="Choose elapsed time or a fixed calendar-based schedule."
        >
          <select
          id={`time-mode-${p.uid}`}
          value={p.timeMode || "elapsed"}
          onChange={(e) => {
            const mode = e.target.value;
            if (mode !== (p.timeMode || "elapsed")) update(p.uid, timeModePatch(mode));
          }}
          disabled={locked}
          >
            <option value="elapsed">Elapsed Time</option>
            <option value="calendar">Calendar Time</option>
          </select>
        </RuleField>
        {p.timeMode === "calendar" ? (
          <>
          <RuleField
          id={`time-unit-${p.uid}`}
          label="Calendar Unit *"
          >
            <select
            id={`time-unit-${p.uid}`}
            value={p.timeUnit || "days"}
            onChange={(e) => update(p.uid, { timeUnit: e.target.value })}
            disabled={locked}
            >
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
              <option value="years">Years</option>
            </select>
          </RuleField>
        <CalendarStartFields
          idPrefix={`cal-${p.uid}`}
          startDate={p.startDate}
          startTime={p.startTime}
          onChange={(patch) => update(p.uid, patch)}
          disabled={locked}
        />
      </>
    ) : (
      !templateMode && (
        <RuleField
          id={`act-${p.uid}`}
          label="Start counting on *"
          hint="Nothing is counted before this date and time."
        >
          <input
            id={`act-${p.uid}`}
            type="datetime-local"
            value={p.activationAt}
            onChange={(e) => update(p.uid, { activationAt: e.target.value })}
            disabled={locked}
          />
        </RuleField>
      )
    )}
  </>
)}
      {intervalDemo(p)}
    </section>
  );

  const toggleDoc = (id) => set({ documentIds: values.documentIds.includes(id) ? values.documentIds.filter((x) => x !== id) : [...values.documentIds, id] });

  const reviewRow = (p) => {
    const variable = variableOf(p);
    let detail;
    if (p.kind === "number") {
      detail = NUMBER_LIMITS.filter(({ key }) => String(p.limits[key]).trim() !== "").map(({ label, key }) => `${label.replace(" Limit", "")} ${p.limits[key]}${numberUnit(p, variable) ? ` ${numberUnit(p, variable)}` : ""}`).join(" · ");
    } else if (p.kind === "boolean") {
      detail = `Expected ${p.expected ? "TRUE" : "FALSE"}; otherwise ${p.severity}`;
    } else {
  // Formats due and overdue limits using calendar units or the parameter's measurement unit.
  const l = intervalLimits(p);
  const calendarTime =
    p.intervalParameter === "time" && p.timeMode === "calendar";
  const unit = intervalUnit(p);

  const formatLimit = (value) => {
    if (value === null || value === undefined) return "—";
    return calendarTime
      ? `${value} ${unit}`
      : formatAmount(value, p.intervalParameter);
  };

  detail = `Due ${formatLimit(l.due)} · Overdue ${formatLimit(l.overdue)}`;
}
    return (
      <li key={p.uid} className="pw-review-item">
        <strong>{p.name}</strong>
        <span>{p.kind === "interval" ? parameterById(p.intervalParameter).label : p.kind === "number" ? "Number" : "Boolean"}</span>
        <dl className="iw-details">
          <div><dt>Variable</dt><dd>{templateMode ? ((isCalendarTime(p) || (p.intervalParameter === "time" && p.aggregation === "none")) ? "None (calendar-based)" : `Chosen when assigned${p.variableKey ? ` (key ${p.variableKey})` : ""}`) : variable ? variable.name : "None (calendar-based)"}</dd></div>
          <div><dt>Aggregation</dt><dd>{(aggregationOptions(p, category).find((o) => (o.selected ?? o.id === p.aggregation)) || {}).label || p.aggregation}</dd></div>
          <div className="pw-wide"><dt>{p.kind === "boolean" ? "Condition" : p.kind === "interval" ? "Limits" : "Thresholds"}</dt><dd>{detail}</dd></div>
        </dl>
      </li>
    );
  };

  const addButton = singleParameter ? null : (
    <>
      {values.parameters.length === 0 && <p className="iw-help">This rule has no parameters yet. Click “+ Add Parameter” to add one.</p>}
      <button type="button" className="btn-outline pw-add" onClick={addParameter} disabled={locked || values.parameters.length >= MAX_PARAMETERS}>
        + Add Parameter
      </button>
    </>
  );

  return (
    <div className="iw">
      <ol className="iw-steps pw-steps" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label="Rule creation steps">
        {steps.map((name, index) => (
          <li key={name} className={`iw-step${index === step ? " is-current" : ""}${index < step ? " is-done" : ""}`}>
            <button type="button" className="iw-step-button" aria-current={index === step ? "step" : undefined} disabled={saving || index > reached + 1} onClick={() => goTo(index)}>
              <span className="iw-step-number" aria-hidden="true">{index < step ? "✓" : index + 1}</span>
              <span className="iw-step-label">{name}</span>
              <span className="sr-only">{`Step ${index + 1} of ${steps.length}`}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="iw-body">
        {topNotice}
        {error && <p role="alert" className="error-message">{error}</p>}

        {stepName === "General" && (
          <div className="pw-section">
            {title("1 · General configuration")}
            <RuleField id="pw-name" label="Rule name *" wide>
              <input id="pw-name" name="name" value={values.name} onChange={field} maxLength={200} disabled={locked} autoComplete="off"
                placeholder={interval ? "e.g. Gearbox service" : "e.g. Motor health"} />
            </RuleField>
            <RuleField id="pw-labels" label="Labels" optional wide><LabelsField id="pw-labels" value={values.labels} onChange={(labels) => set({ labels })} disabled={locked} /></RuleField>
            {!interval && (
              <fieldset className="pw-period" disabled={locked}>
                <legend>Calculation period *</legend>
                <p className="iw-help">The period over which each parameter's value or aggregation is evaluated. The backend uses it when it evaluates the rule.</p>
                <div className="pw-period-row">
                  <input type="number" min="1" step="any" aria-label="Calculation period amount" value={values.periodAmount} onChange={(e) => set({ periodAmount: e.target.value })} />
                  <select aria-label="Calculation period unit" value={values.periodUnit} onChange={(e) => set({ periodUnit: e.target.value })}>
                    {PERIOD_UNITS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                  </select>
                  {PERIOD_PRESETS.map((preset) => (
                    <button key={preset.label} type="button" className={`btn-outline pw-preset${values.periodAmount === preset.amount && values.periodUnit === preset.unit ? " is-active" : ""}`}
                      onClick={() => set({ periodAmount: preset.amount, periodUnit: preset.unit })}>{preset.label}</button>
                  ))}
                </div>
                {calculationPeriodSeconds(values.periodAmount, values.periodUnit) === null && <small className="rule-field-warning">Enter a whole number of seconds, at least 1 and at most 365 days.</small>}
              </fieldset>
            )}
            {interval && (
              <>
                <p className="iw-help">Each parameter below is checked on its own. Choose what it measures; the preview shows how its limits will behave.</p>
                {values.parameters.map(intervalGeneralCard)}
                {addButton}
              </>
            )}
          </div>
        )}

        {stepName === "Parameters" && (
          <div className="pw-section">
            {title("2 · Parameters")}
            <p className="iw-help">Add one card per signal you want to monitor. Each parameter has its own variable, aggregation and limits, and the rule shows the most severe parameter status.</p>
            {values.parameters.map(thresholdCard)}
            {addButton}
          </div>
        )}

        {stepName === "Variables" && (
          <div className="pw-section">
            {title("2 · Variable mapping")}
            {/* Displays each configured parameter with its unit, aggregation,
            PLC signal connection guidance, and validation messages. */}
            {values.parameters.map((p, index) => {
              const info = parameterById(p.intervalParameter);
              const unit = intervalUnit(p);
              return (
              <section key={p.uid} className="pw-card" aria-label={`Parameter ${index + 1}`}>
                <div className="pw-card-head"><span className="pw-index" aria-hidden="true">{index + 1}</span><strong className="pw-static">{p.name}</strong><span className="iw-chip">{info.label} · {unit}</span></div>
                {aggregationSelect(p)}
                {p.intervalParameter === "time" && (isCalendarTime(p) || p.aggregation === "none") && !p.variableId
                  ? <p className="iw-help">{p.timeMode === "calendar"
                    ? `Calendar Time: no PLC variable is needed. Due and Overdue are measured in ${p.timeUnit || "days"} from the selected calendar start date.`
                    : "Elapsed Time: no PLC variable is needed. Elapsed hours are counted from the start time."}</p>
                    : connect(p, "Choose the signal that drives this interval.")}
                  {cardProblems(p)}
                </section>
              );
            })}
          </div>
        )}

        {stepName === "Limits" && (
          <div className="pw-section">
            {title("3 · Due and Overdue limits")}
            {values.parameters.map((p, index) => {
              const info = parameterById(p.intervalParameter);
              const unit = intervalUnit(p);
              const wholeNumber = info.aggregation === "counter" ||
              (p.intervalParameter === "time" && p.timeMode === "calendar");
              const l = intervalLimits(p);
              return (
                <section key={p.uid} className="pw-card" aria-label={`Parameter ${index + 1}`}>
                  <div className="pw-card-head"><span className="pw-index" aria-hidden="true">{index + 1}</span><strong className="pw-static">{p.name}</strong><span className="iw-chip">{info.label} · {unit}</span></div>
                  <div className="pw-limits">
                    <RuleField id={`due-${p.uid}`} label={`Due limit (${unit}) *`} hint="Maintenance is due at this value.">
                      <UnitInput unit={unit}>
                        <input id={`due-${p.uid}`} type="number" min="0" step={wholeNumber ? "1" : "any"} value={p.due} onChange={(e) => update(p.uid, { due: e.target.value })} disabled={disabled} />
                      </UnitInput>
                      <small className="rule-field-warning">{p.due !== "" ? l.errors.due : ""}</small>
                    </RuleField>
                    <RuleField id={`over-${p.uid}`} label={`Overdue limit (${unit}) *`} hint="Maintenance is overdue once this value is reached.">
                      <UnitInput unit={unit}>
                        <input id={`over-${p.uid}`} type="number" min="0" step={wholeNumber ? "1" : "any"} value={p.overdue} onChange={(e) => update(p.uid, { overdue: e.target.value })} disabled={disabled} />
                      </UnitInput>
                      <small className="rule-field-warning">{p.overdue !== "" ? l.errors.overdue : ""}</small>
                    </RuleField>
                  </div>
                  {intervalDemo(p)}
                </section>
              );
            })}
          </div>
        )}

        {stepName === "Instructions" && (
          <div className="pw-section">
            {title(`${steps.indexOf("Instructions") + 1} · Instructions and documents`)}
            <p className="iw-help">All optional. These apply to the whole rule.</p>
            <RuleField id="pw-comment" label="Comment or description" optional wide><textarea id="pw-comment" name="comment" rows={3} value={values.comment} onChange={field} disabled={locked} /></RuleField>
            <RuleField id="pw-instructions" label="Instructions" optional wide hint="What should be done when this rule is raised."><textarea id="pw-instructions" name="instructions" rows={4} value={values.instructions} onChange={field} disabled={locked} /></RuleField>
            <RuleField id="pw-link" label="External reference link" optional wide hint="For example a manual (https://…)."><input id="pw-link" name="link" type="url" value={values.link} onChange={field} placeholder="https://" disabled={locked} /></RuleField>
            {!templateMode && <fieldset className="pw-docs" disabled={locked}>
              <legend>Supporting documents <span className="optional-label">Optional</span></legend>
              {documents.length ? (
                <ul className="pw-doc-list">
                  {documents.map((d) => (
                    <li key={d.id}><label><input type="checkbox" checked={values.documentIds.includes(d.id)} onChange={() => toggleDoc(d.id)} /> {d.title || d.name || `Document ${d.id}`}</label></li>
                  ))}
                </ul>
              ) : <p className="iw-help">No documents are available for this asset.</p>}
              <small className="iw-help">Documents are uploaded in <a href="/ui/configuration/documents/new" target="_blank" rel="noreferrer">Configuration → Documents</a> (the existing secure upload); pick them here to link them to this rule.</small>
            </fieldset>}
          </div>
        )}

        {stepName === "Review" && (
          <div className="pw-section">
            {title(`${steps.length} · Review and create`)}
            <dl className="iw-review">
              <div><dt>Rule name</dt><dd>{values.name.trim() || "—"}</dd></div>
              <div><dt>Category</dt><dd>{interval ? "Interval Based" : "Parameter Threshold"}</dd></div>
              {!interval && <div><dt>Calculation period</dt><dd>{values.periodAmount} {values.periodUnit}</dd></div>}
              {values.comment.trim() && <div><dt>Comment</dt><dd>{values.comment.trim()}</dd></div>}
              {values.instructions.trim() && <div><dt>Instructions</dt><dd>{values.instructions.trim()}</dd></div>}
              {values.link.trim() && <div><dt>Reference link</dt><dd>{values.link.trim()}</dd></div>}
              {values.documentIds.length > 0 && <div><dt>Documents</dt><dd>{documents.filter((d) => values.documentIds.includes(d.id)).map((d) => d.title || d.name).join(", ")}</dd></div>}
              {(values.labels || []).length > 0 && <div><dt>Labels</dt><dd>{values.labels.join(", ")}</dd></div>}
            </dl>
            <h3 className="pw-subtitle">{values.parameters.length} parameter{values.parameters.length === 1 ? "" : "s"}</h3>
            <ol className="pw-review-list">{values.parameters.map(reviewRow)}</ol>
            {hasProblems(problems) && <p className="rule-field-warning">Some parameters still have problems; go back to fix them.</p>}
            {reviewExtra}
          </div>
        )}
      </div>

      <div className="form-actions rule-form-actions iw-actions">
        <button type="button" className="btn-outline" onClick={onCancel} disabled={saving}>Cancel</button>
        <span className="iw-actions-spacer" />
        {step > 0 && <BackButton inline className="btn-outline" label="Back" onClick={() => goTo(step - 1)} disabled={saving} />}
        {step < steps.length - 1
          ? <ForwardButton inline className="btn-primary" label="Next" onClick={() => goTo(step + 1)} disabled={saving || !canEdit} />
          : <button type="button" className="btn-primary" onClick={create} disabled={saving || !canEdit}>{saving ? savingLabel : submitLabel}</button>}
      </div>
    </div>
  );
}
