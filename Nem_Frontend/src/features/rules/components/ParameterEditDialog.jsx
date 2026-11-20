import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Pencil, X } from "lucide-react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { RuleField, UnitInput } from "./RuleFormParts.jsx";
import CalendarStartFields from "./CalendarStartFields.jsx";
import VariableSelector from "./VariableSelector.jsx";
import { parameterById, validateLimits } from "./intervalConfig.js";
import {
  NUMBER_LIMITS,
  THRESHOLD_AGGREGATIONS,
  calendarStartConfig,
  calendarStartValues,
  numberUnit,
  validateCalendarStart,
  validateNumberLimits,
  variableCompatibility,
} from "./parameterRules.js";
import "./IntervalRuleWizard.css";
import "./ParameterEditDialog.css";

const text = (value) => (value === null || value === undefined ? "" : String(value));
const toNumber = (value) => (String(value ?? "").trim() === "" ? null : Number(value));
const pad = (n) => String(n).padStart(2, "0");

// ISO timestamp -> value of <input type="datetime-local"> in the browser's time zone.
function toLocalInput(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function periodLabel(seconds) {
  if (!seconds) return "";
  for (const [size, unit] of [[86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]]) {
    if (seconds % size === 0) {
      const count = seconds / size;
      return `${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} seconds`;
}

/** One line describing a saved parameter, built only from its stored configuration. */
export function describeParameter(parameter) {
  const config = parameter.config || {};

  if (parameter.kind === "interval") {
    const info = parameterById(config.interval_parameter);
    const unit =
      config.interval_parameter === "time" && config.time_mode === "calendar"
        ? config.time_unit || "days"
        : info.unitLabel;

    return `${info.label} interval · Due ${config.due} ${unit} · Overdue ${config.overdue} ${unit}`;
  }

  if (parameter.kind === "boolean") {
    return `Boolean · expects ${config.expected ? "TRUE" : "FALSE"}`;
  }

  const limits = NUMBER_LIMITS.filter(
    ({ key }) => config[key] !== null && config[key] !== undefined
  ).length;

  return `Number · ${limits} limit${limits === 1 ? "" : "s"}${config.unit ? ` · ${config.unit}` : ""}`;
}

const typeLabel = (parameter) => {
  if (parameter.kind === "interval") return `Interval · ${parameterById(parameter.config?.interval_parameter).label}`;
  return parameter.kind === "boolean" ? "Boolean" : "Number";
};
const aggregationLabel = (value) => ({ none: "None", last: "Last", timer: "Timer", counter: "Counter" }[value] || value);

function formFrom(parameter) {
  const config = parameter.config || {};
  const base = {
    name: parameter.name,
    variableId: parameter.variable_id ? String(parameter.variable_id) : "",
    aggregation: parameter.aggregation,
  };
  if (parameter.kind === "number") {
    return { ...base, limits: Object.fromEntries(NUMBER_LIMITS.map(({ key }) => [key, text(config[key])])), unit: text(config.unit) };
  }
  if (parameter.kind === "boolean") return { ...base, expected: config.expected !== false, severity: config.severity || "alert" };
  return {
    ...base,
    due: text(config.due),
    overdue: text(config.overdue),
    activationAt: toLocalInput(config.activation_at),
    timeMode: config.time_mode === "calendar" ? "calendar" : "elapsed",
    timeUnit: config.time_unit || "days",
    ...calendarStartValues(config),
  };
}

/** Section of the form: a heading and a two-column grid (one column on narrow screens). */
const Section = ({ title, children }) => (
  <section className="pe-section">
    <h4>{title}</h4>
    <div className="pe-fields">{children}</div>
  </section>
);

/** Read-only value that looks like a field, for settings this dialog does not change. */
const Fixed = ({ label, value, hint, wide = false }) => (
  <div className={`form-group${wide ? " form-group-wide" : ""}`}>
    <label>{label}</label>
    <div className="pe-readonly" aria-readonly="true">{value}</div>
    {hint && <small>{hint}</small>}
  </div>
);

/**
 * "Edit parameter": edit ONE saved parameter of a multi-parameter rule
 * (PATCH /rules/{rule}/parameters/{parameter}). The parent rule and the other parameters are never sent.
 * Opened from a parameter's own menu it goes straight to that parameter; without `parameterId` it first
 * asks which parameter to edit. `alwaysSelect` (the parent rule's Edit) asks even when there is only one.
 */
export default function ParameterEditDialog({ ruleId, parameterId = null, alwaysSelect = false, assetId, assetName, ruleName, ruleInfo = null, onClose, onSaved }) {
  const [loaded, setLoaded] = useState({ status: "loading", error: "", parameters: [], category: "", period: null });
  const [variables, setVariables] = useState([]);
  const [readings, setReadings] = useState({});
  const [eligible, setEligible] = useState(null);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  // A Supervisor may change only Due and Overdue; every other field is shown but locked (the API enforces this too).
  const { user } = useAuth();
  const supervisor = user?.role === "Supervisor";

  const load = useCallback(async () => {
    setLoaded((current) => ({ ...current, status: "loading", error: "" }));
    try {
      const [rule, items, plc, latest] = await Promise.all([
        api.get(`/rules/${ruleId}/parameters`),
        api.getAll(`/assets/${assetId}/variables?is_active=true`).catch(() => []),
        api.get("/plc/status").catch(() => null),
        api.get(`/readings/assets/${assetId}/latest`).catch(() => []),
      ]);
      const mappings = (Array.isArray(plc?.mappings) ? plc.mappings : []).filter(
        (m) => Number(m.asset_id) === Number(assetId) && m.mapping_valid && m.data_type === "boolean");
      const idsFor = (role) => mappings.filter((m) => m.role === role).map((m) => Number(m.variable_id));
      setVariables(Array.isArray(items) ? items : []);
      setReadings(Object.fromEntries((Array.isArray(latest) ? latest : []).map((row) => [row.variable_id, row])));
      setEligible(plc ? { running_signal: idsFor("running_signal"), cycle_signal: idsFor("cycle_signal") } : null);
      setLoaded({
        status: "ready", error: "", parameters: rule.parameters || [], category: rule.category || "",
        period: rule.calculation_period_seconds ?? null,
      });
    } catch (loadError) {
      setLoaded((current) => ({ ...current, status: "error", error: loadError?.message || "Could not load the parameters." }));
    }
  }, [ruleId, assetId]);
  useEffect(() => { load(); }, [load]);

  const choose = (parameter) => {
    setSelected(parameter);
    setForm(formFrom(parameter));
    setError("");
    setShowErrors(false);
  };
  // Opened from one parameter's own menu: go straight to that parameter. A rule with a single parameter
  // has nothing to choose from either.
  useEffect(() => {
    if (loaded.status !== "ready" || selected) return;
    const target = parameterId !== null ? loaded.parameters.find((item) => item.id === parameterId) : null;
    if (target) choose(target);
    else if (loaded.parameters.length === 1 && !alwaysSelect) choose(loaded.parameters[0]);
  }, [loaded, selected, parameterId, alwaysSelect]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape" && !saving) onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const patch = (changes) => { setForm((current) => ({ ...current, ...changes })); setError(""); };
  const shape = selected && form ? { ...selected, ...form } : null; // what variableCompatibility needs
  const interval = selected?.kind === "interval";
  const intervalType = interval ? selected.config?.interval_parameter : null;
  const calendar = interval && intervalType === "time" && selected.aggregation === "none";
  const calendarTime = interval && intervalType === "time" && selected.config?.time_mode === "calendar";

  // The saved variable is always listed, even if it is no longer in the active list.
  const selectableVariables = useMemo(() => {
    if (!selected?.variable_id || variables.some((item) => item.id === selected.variable_id)) return variables;
    return [...variables, { id: selected.variable_id, name: `Variable #${selected.variable_id}`, data_type: "unknown" }];
  }, [variables, selected]);

  const reasonFor = (variable) => {
    if (!shape) return "";
    const base = variableCompatibility(shape, variable);
    if (base) return base;
    if (interval && eligible) {
      const role = parameterById(intervalType).signalRole;
      if (!eligible[role].includes(Number(variable.id))) return role === "running_signal" ? "Not mapped as the machine running state." : "Not mapped as a cycle signal.";
    }
    const clash = loaded.parameters.find((other) => other.id !== selected.id && String(other.variable_id) === String(variable.id) && other.aggregation === form.aggregation);
    return clash ? `Already used by "${clash.name}" with the same aggregation.` : "";
  };

  const problems = useMemo(() => {
    if (!selected || !form) return [];
    const list = [];
    if (!form.name.trim()) list.push("Please enter a parameter name.");
    else if (loaded.parameters.some((other) => other.id !== selected.id && other.name.trim().toLowerCase() === form.name.trim().toLowerCase())) {
      list.push("Another parameter in this rule already has this name.");
    }
    if (!calendar) {
      const variable = variables.find((item) => String(item.id) === form.variableId);
      if (!form.variableId) list.push("Connect a variable.");
      else if (variable) {
        const reason = variableCompatibility(shape, variable);
        if (reason) list.push(reason);
      }
      const clash = loaded.parameters.find((other) => other.id !== selected.id && String(other.variable_id) === form.variableId && other.aggregation === form.aggregation);
      if (clash) list.push(`The same variable and aggregation are already used by "${clash.name}".`);
    }
    if (selected.kind === "number") list.push(...validateNumberLimits(form.limits));
    if (interval) {
      const { errors } = validateLimits(intervalType, form.due, form.overdue, { legacy: String(selected.key || "").startsWith("legacy-") });
      if (errors.due) list.push(errors.due);
      if (errors.overdue) list.push(errors.overdue);
      // A stored Time interval that never had a start time stays editable without inventing one.
      if (intervalType === "time" && !calendar && !form.activationAt && selected.config?.activation_at) list.push("Choose when counting should start.");
            if (calendarTime) {
        if (!["days", "weeks", "months", "years"].includes(form.timeUnit)) {
          list.push("Choose a valid calendar unit.");
        }
        // A rule saved before a start time existed keeps its date without one; any change needs a time.
        const savedConfig = selected.config || {};
        list.push(...validateCalendarStart(form, savedConfig.start_at ? null : { startDate: savedConfig.start_date || "" }));
        if (form.due.trim() !== "" && !Number.isSafeInteger(Number(form.due))) {
          list.push("Due must be a whole number for Calendar Time.");
        }
        if (form.overdue.trim() !== "" && !Number.isSafeInteger(Number(form.overdue))) {
          list.push("Overdue must be a whole number for Calendar Time.");
        }
      }
    }
    return list;
  }, [selected, form, shape, variables, loaded.parameters, calendar, calendarTime, interval, intervalType]);

  const save = async (event) => {
    event.preventDefault();
    if (submitting.current) return;
    if (problems.length) { setShowErrors(true); return; }
    submitting.current = true;
    setSaving(true);
    setError("");
    const config = (() => {
      if (selected.kind === "number") {
        return { ...Object.fromEntries(NUMBER_LIMITS.map(({ key }) => [key, toNumber(form.limits[key])])), unit: form.unit || "" };
      }
      if (selected.kind === "boolean") return { expected: form.expected, severity: form.severity };
      if (calendarTime) {
        return {
          interval_parameter: intervalType,
          due: Number(form.due),
          overdue: Number(form.overdue),
          time_mode: "calendar",
          time_unit: form.timeUnit,
          ...calendarStartConfig(form, selected.config || {}),
        };
      }
      const saved = selected.config || {};
      const untouched = form.activationAt === toLocalInput(saved.activation_at);
      const start = intervalType === "time" && form.activationAt
        ? { activation_at: untouched && saved.activation_at ? saved.activation_at : new Date(form.activationAt).toISOString() }
        : {};
      return { interval_parameter: intervalType, due: Number(form.due), overdue: Number(form.overdue), ...start };
    })();
    try {
      const result = await api.patch(`/rules/${ruleId}/parameters/${selected.id}`, {
        key: selected.key,
        name: form.name.trim(),
        kind: selected.kind,
        variable_id: form.variableId ? Number(form.variableId) : null,
        aggregation: form.aggregation,
        config,
      });
      onSaved?.(result);
    } catch (saveError) {
      setError(saveError?.message || "Could not save the parameter.");
      submitting.current = false;
      setSaving(false);
    }
  };

  const title = "Edit parameter";
  const subtitle = [selected?.name, ruleName || assetName].filter(Boolean).join(" · ");
  const shell = (body, footer) => createPortal(
    <div className="modal-bg" onClick={saving ? undefined : onClose}>
      <div className="modal pe-modal" role="dialog" aria-modal="true" aria-labelledby="pe-title" onClick={(event) => event.stopPropagation()}>
        <header className="pe-head">
          <div className="pe-head-text">
            <h3 id="pe-title">{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-outline" aria-label="Close" onClick={onClose} disabled={saving}><X size={16} aria-hidden="true" /></button>
        </header>
        {body}
        {footer}
      </div>
    </div>,
    document.body,
  );

  // --- loading / error / empty / parameter selector ------------------------------------------------
  if (!selected) {
    const close = <button type="button" className="btn-outline" onClick={onClose}>{loaded.status === "ready" && (loaded.parameters.length > 1 || alwaysSelect) ? "Cancel" : "Close"}</button>;
    return shell(
      <div className="pe-body">
        {loaded.status === "loading" && <p className="pe-note" role="status">Loading parameters…</p>}
        {loaded.status === "error" && <p className="pe-error" role="alert">{loaded.error}</p>}
        {loaded.status === "ready" && loaded.parameters.length === 0 && <p className="pe-note">This rule has no parameters to edit.</p>}
        {loaded.status === "ready" && (loaded.parameters.length > 1 || (alwaysSelect && loaded.parameters.length > 0)) && (
          <>
            <p className="pe-question" id="pe-question">Which parameter would you like to edit?</p>
            <ul className="pe-list" aria-labelledby="pe-question">
              {loaded.parameters.map((parameter) => (
                <li key={parameter.id}>
                  <button type="button" className="pe-item" onClick={() => choose(parameter)}
                    disabled={parameter.editable === false} title={parameter.editable === false ? parameter.not_editable_reason : undefined}>
                    <Pencil size={15} aria-hidden="true" />
                    <span className="pe-item-text">
                      <strong>{parameter.name}</strong>
                      <small>{typeLabel(parameter)} · {variables.find((item) => item.id === parameter.variable_id)?.name || (parameter.variable_id ? `Variable #${parameter.variable_id}` : "No variable")}</small>
                      <small>{parameter.editable === false ? parameter.not_editable_reason : describeParameter(parameter)}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>,
      <footer className="pe-foot">
        {close}
        {loaded.status === "error" && <button type="button" className="btn-primary" onClick={load}>Try again</button>}
      </footer>,
    );
  }

  // single parameter form 
  const variable = variables.find((item) => String(item.id) === form.variableId);
  const aggregations = selected.kind === "boolean" ? THRESHOLD_AGGREGATIONS.filter((a) => a.id === "none" || a.id === "last") : THRESHOLD_AGGREGATIONS;
  const intervalInfo = interval ? parameterById(intervalType) : null;
  const changeAggregation = (value) => {
    const next = { aggregation: value };
    const current = variables.find((item) => String(item.id) === form.variableId);
    if (current && variableCompatibility({ ...selected, aggregation: value }, current)) next.variableId = "";
    patch(next);
  };
  const instructions = (ruleInfo?.maintenance_instructions || "").trim();
  const link = (ruleInfo?.reference_link || "").trim();
  const documents = Array.isArray(ruleInfo?.document_ids) ? ruleInfo.document_ids.length : 0;
  const periodShown = !interval && loaded.period ? periodLabel(loaded.period) : "";

  return shell(
    <form id="pe-form" className="pe-body" onSubmit={save} noValidate>
      {(loaded.parameters.length > 1 || alwaysSelect) && parameterId === null && (
        <button type="button" className="pe-back" onClick={() => setSelected(null)} disabled={saving}>
          <ArrowLeft size={16} aria-hidden="true" /> All parameters
        </button>
      )}

      <Section title="Parameter information">
        <RuleField id="pe-name" label="Parameter name *" wide>
          <input id="pe-name" value={form.name} maxLength={200} placeholder="Enter parameter name" disabled={saving || supervisor} autoComplete="off" onChange={(e) => patch({ name: e.target.value })} />
        </RuleField>
        <div className="form-group form-group-wide">
          <label>{calendar ? "Variable" : "Connected PLC variable *"}</label>
          {calendar ? (
            <div className="pe-readonly" aria-readonly="true">None — counted from the calendar</div>
          ) : (
            <VariableSelector variables={selectableVariables} readings={readings} value={form.variableId} reasonFor={reasonFor}
              assetName={assetName} disabled={saving || supervisor} idPrefix="pe-var" onChange={(id) => patch({ variableId: id })} />
          )}
        </div>
      </Section>

      <Section title="Configuration">
        <Fixed label="Parameter type" value={typeLabel(selected)} />
        {interval ? (
          <Fixed label="Aggregation" value={aggregationLabel(form.aggregation)} />
        ) : (
          <RuleField id="pe-aggregation" label="Aggregation *">
            <select id="pe-aggregation" value={form.aggregation} disabled={saving || supervisor} onChange={(e) => changeAggregation(e.target.value)}>
              {aggregations.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </RuleField>
        )}
        {interval && (
          <Fixed
          label="Calculation"
          value={
            calendarTime
            ? "Fixed calendar recurrence from the selected start date"
            : "Cumulative since the rule was activated"
          }
          wide
          />
        )}
        {periodShown && <Fixed label="Calculation period" value={periodShown} hint="Set for the whole rule." />}
      </Section>

      <Section title="Limits">
        {selected.kind === "number" && (
          <>
            {NUMBER_LIMITS.map(({ key, label }) => (
              <RuleField key={key} id={`pe-${key}`} label={label}>
                <UnitInput unit={numberUnit({ ...selected, ...form }, variable) || ""}>
                  <input id={`pe-${key}`} type="number" inputMode="decimal" step="any" value={form.limits[key]} disabled={saving || supervisor}
                    onChange={(e) => patch({ limits: { ...form.limits, [key]: e.target.value } })} />
                </UnitInput>
              </RuleField>
            ))}
            <small style={{ gridColumn: "1 / -1" }}>At least one threshold is required. Configure only the limits you want to monitor.</small>
            {(form.aggregation === "none" || form.aggregation === "last") && (
              <RuleField id="pe-unit" label="Unit" optional>
                <input id="pe-unit" value={form.unit} maxLength={20} disabled={saving || supervisor} autoComplete="off" onChange={(e) => patch({ unit: e.target.value })} />
              </RuleField>
            )}
          </>
        )}
        {selected.kind === "boolean" && (
          <>
            <RuleField id="pe-expected" label="Expected state (normal) *">
              <select id="pe-expected" value={String(form.expected)} disabled={saving || supervisor} onChange={(e) => patch({ expected: e.target.value === "true" })}>
                <option value="true">TRUE</option><option value="false">FALSE</option>
              </select>
            </RuleField>
            <RuleField id="pe-severity" label="When not matching, raise *">
              <select id="pe-severity" value={form.severity} disabled={saving || supervisor} onChange={(e) => patch({ severity: e.target.value })}>
                <option value="alert">Alert</option><option value="warning">Warning</option>
              </select>
            </RuleField>
          </>
        )}
        {interval && (
          <>
            <RuleField id="pe-due" label="Due *">
              <UnitInput unit={calendarTime ? form.timeUnit : intervalInfo.unitLabel}>
                <input
                id="pe-due"
                type="number"
                inputMode={calendarTime ? "numeric" : "decimal"}
                step={calendarTime ? "1" : "any"}
                min="0"
                value={form.due}
                disabled={saving}
                onChange={(e) => patch({ due: e.target.value })}
                />
              </UnitInput>
            </RuleField>
            <RuleField id="pe-overdue" label="Overdue *">
              <UnitInput unit={calendarTime ? form.timeUnit : intervalInfo.unitLabel}>
                <input
                id="pe-overdue"
                type="number"
                inputMode={calendarTime ? "numeric" : "decimal"}
                step={calendarTime ? "1" : "any"}
                min="0"
                value={form.overdue}
                disabled={saving}
                onChange={(e) => patch({ overdue: e.target.value })}
                />
              </UnitInput>
            </RuleField>
            {calendarTime ? (
              <>
                <RuleField id="pe-time-unit" label="Calendar Unit *">
                  <select
                    id="pe-time-unit"
                    value={form.timeUnit}
                    disabled={saving || supervisor}
                    onChange={(e) => patch({ timeUnit: e.target.value })}
                  >
                    <option value="days">Days</option>
                    <option value="weeks">Weeks</option>
                    <option value="months">Months</option>
                    <option value="years">Years</option>
                  </select>
                </RuleField>

                <CalendarStartFields
                  idPrefix="pe-calendar"
                  startDate={form.startDate}
                  startTime={form.startTime}
                  onChange={patch}
                  disabled={saving || supervisor}
                />
              </>
            ) : intervalType === "time" ? (
              <RuleField
                id="pe-start"
                label="Start"
                optional={calendar}
                hint="Counting starts from this date and time."
                wide
              >
                <input
                  id="pe-start"
                  type="datetime-local"
                  value={form.activationAt}
                  disabled={saving || supervisor}
                  onChange={(e) => patch({ activationAt: e.target.value })}
                />
              </RuleField>
            ) : null}
          </>
        )}
      </Section>

      <Section title="Instructions">
        <div className="form-group form-group-wide">
          <div className="pe-readonly pe-instructions" aria-readonly="true">
            {instructions || link || documents ? (
              <>
                {instructions && <p>{instructions}</p>}
                {link && <p><a href={link} target="_blank" rel="noreferrer">{link}</a></p>}
                {documents > 0 && <p>{documents} linked document{documents === 1 ? "" : "s"}</p>}
              </>
            ) : "No instructions are saved for this rule."}
          </div>
          <small>Instructions and documents belong to the whole rule and are not changed here.</small>
        </div>
      </Section>

      {supervisor && (
        <p className="pe-note" role="status">
          {interval
            ? "As a Supervisor you can change the Due and Overdue values only. Everything else is shown for reference."
            : "As a Supervisor you can change Due and Overdue values of interval parameters only. This parameter has none, so it is shown for reference."}
        </p>
      )}
      <p className="pe-note">
        {calendarTime
        ? "Only this parameter is changed. Changing the calendar unit or start date updates its recurrence. Due and Overdue values apply only to this parameter. Other parameters and alert history are kept."
        : "Only this parameter is changed. Changing the variable, aggregation or start time restarts this parameter's progress; the name and limits keep it. Other parameters and alert history are kept."}
      </p>
      {showErrors && problems.length > 0 && (
        <ul className="pe-problems" role="alert">{problems.map((message) => <li key={message}>{message}</li>)}</ul>
      )}
      {error && <p className="pe-error" role="alert">{error}</p>}
    </form>,
    <footer className="pe-foot">
      <button type="button" className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
      <button type="submit" form="pe-form" className="btn-primary" disabled={saving || (supervisor && !interval)}>{saving ? "Saving…" : "Save changes"}</button>
    </footer>,
  );
}
