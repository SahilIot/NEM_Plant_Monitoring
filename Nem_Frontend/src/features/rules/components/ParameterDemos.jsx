import React, { useId, useState } from "react";
import { ZONE_LABEL, NUMBER_LIMITS, nearestLimit, numberZone } from "./parameterRules.js";
import "./IntervalDemo.css";
import "./ParameterDemos.css";

// Tooltip open-state shared by the demos: hover, keyboard focus and tap all open the same tooltip.
function useTips() {
  const [active, setActive] = useState(null);
  const [pinned, setPinned] = useState(null);
  const point = (key, baseId) => ({
    onMouseEnter: () => setActive(key),
    onMouseLeave: () => setActive((c) => (c === key ? null : c)),
    onFocus: () => setActive(key),
    onBlur: () => { setActive((c) => (c === key ? null : c)); setPinned((c) => (c === key ? null : c)); },
    onClick: () => setPinned((c) => (c === key ? null : key)),
    onKeyDown: (e) => { if (e.key === "Escape") { setActive(null); setPinned(null); } },
    "aria-describedby": `${baseId}-tip-${key}`,
  });
  return { open: pinned || active, point };
}

const fmt = (value, unit) => `${Math.round(Number(value) * 1000) / 1000}${unit ? ` ${unit}` : ""}`;
const SAMPLE_LIMITS = { lower_alert: 10, lower_warning: 20, upper_warning: 80, upper_alert: 100 };
const ZONE_CLASS = { normal: "region-normal", lower_warning: "region-due", upper_warning: "region-due", lower_alert: "region-overdue", upper_alert: "region-overdue" };

/**
 * Number parameter preview: five zones, the four limits and the current value.
 * `actual` is null (no variable) or { state: loading|ok|unavailable|invalid, value, detail, aggregated }.
 */
export function NumberThresholdDemo({ limits, unit = "", actual = null }) {
  const baseId = useId();
  const { open, point } = useTips();
  const [tryValue, setTryValue] = useState(null);
  const [mode, setMode] = useState("live");
  const entered = NUMBER_LIMITS.filter(({ key }) => String(limits[key] ?? "").trim() !== "" && Number.isFinite(Number(limits[key])));
  const sample = entered.length === 0;
  const active = sample ? SAMPLE_LIMITS : Object.fromEntries(entered.map(({ key }) => [key, Number(limits[key])]));
  const points = NUMBER_LIMITS.filter(({ key }) => active[key] !== undefined && active[key] !== null).map((item) => ({ ...item, value: Number(active[item.key]) }));
  const values = points.map((p) => p.value);
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || Math.abs(hi) || 10;
  const defaultValue = sample ? 65 : lo + span / 2;
  const showActual = actual?.state === "ok" && mode === "live";
  const current = showActual ? Number(actual.value) : tryValue ?? defaultValue;
  const min = Math.min(lo - span * 0.25, current - span * 0.05);
  const max = Math.max(hi + span * 0.25, current + span * 0.05);
  const pct = (v) => Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
  const edges = [min, ...[...new Set(values)].sort((a, b) => a - b), max];
  const segments = edges.slice(0, -1).map((from, i) => ({ from, to: edges[i + 1], zone: numberZone((from + edges[i + 1]) / 2, active) }));
  const zone = numberZone(current, active);
  const nearest = nearestLimit(current, active);
  const tips = {
    value: {
      title: showActual ? (actual.aggregated ? "Evaluated value (live)" : "Current value (live)") : "Current value (sample)",
      lines: [`Actual value: ${fmt(current, unit)}`, `Status: ${ZONE_LABEL[zone]}`,
        nearest ? `Nearest threshold: ${nearest.label.replace(" Limit", "")} ${fmt(nearest.limit, unit)}` : "No threshold configured",
        nearest ? `Distance from it: ${fmt(nearest.distance, unit)}` : ""].filter(Boolean),
    },
    ...Object.fromEntries(points.map((p) => [p.key, { title: p.label, lines: [`${p.label}: ${fmt(p.value, unit)}`, `Meaning: ${p.meaning}`] }])),
  };
  const positions = { value: pct(current), ...Object.fromEntries(points.map((p) => [p.key, pct(p.value)])) };
  const edge = (p) => (p < 22 ? "is-start" : p > 78 ? "is-end" : "");
  const note = !actual ? "Sample preview — no variable is connected, so no live value is shown."
    : actual.state === "ok" ? (showActual ? actual.detail : "Sample position — switch to Live to see the connected value.")
    : `${actual.detail || "No usable value."} Showing a sample position instead.`;

  return (
    <div className={`interval-demo param-demo zone-${zone}`} role="group" aria-label="Number threshold preview">
      <div className="interval-demo-head">
        <span className={`interval-demo-badge ${showActual ? "is-live" : "is-sample"}`}>{showActual ? (actual.aggregated ? "Evaluated value" : "Live value") : "Sample preview"}</span>
        <span className={`interval-demo-status status-${zone === "normal" ? "normal" : zone === "unavailable" ? "unavailable" : zone.endsWith("alert") ? "overdue" : "due"}`}>{ZONE_LABEL[zone]}</span>
        {actual?.state === "ok" && (
          <div className="interval-demo-mode" role="group" aria-label="Preview source">
            <button type="button" aria-pressed={mode === "live"} onClick={() => setMode("live")}>Live</button>
            <button type="button" aria-pressed={mode === "try"} onClick={() => setMode("try")}>Try values</button>
          </div>
        )}
      </div>
      <div className="interval-demo-stage">
        <div className="interval-demo-bar" aria-hidden="true">
          {segments.map((s, i) => (
            <span key={i} className={`interval-demo-region ${ZONE_CLASS[s.zone] || "region-normal"}`} style={{ width: `${pct(s.to) - pct(s.from)}%` }}>
              {pct(s.to) - pct(s.from) > 15 && ZONE_LABEL[s.zone]}
            </span>
          ))}
        </div>
        {[...points.map((p) => [p.key, `${p.label}`, `interval-demo-limit ${p.key.endsWith("alert") ? "limit-overdue" : "limit-due"}`]), ["value", "Current value", "interval-demo-marker"]].map(([key, label, cls]) => (
          <button key={key} type="button" className={`${cls}${open === key ? " is-open" : ""}`} style={{ left: `${positions[key]}%` }}
            aria-label={`${label}: ${tips[key].lines.join(". ")}`} {...point(key, baseId)} />
        ))}
        {Object.keys(tips).map((key) => (
          <div key={key} id={`${baseId}-tip-${key}`} role="tooltip" className={`interval-demo-tip ${edge(positions[key])}${open === key ? " is-visible" : ""}`} style={{ left: `${positions[key]}%` }}>
            <strong>{tips[key].title}</strong>{tips[key].lines.map((l) => <span key={l}>{l}</span>)}
          </div>
        ))}
        <div className="interval-demo-scale" aria-hidden="true">
          {points.map((p) => <span key={p.key} style={{ left: `${positions[p.key]}%` }}>{p.value}</span>)}
        </div>
      </div>
      <dl className="interval-demo-figures">
        <div><dt>{showActual ? "Current" : "Sample current"}</dt><dd>{fmt(current, unit)}</dd></div>
        {points.map((p) => <div key={p.key}><dt>{sample ? `Sample ${p.label.replace(" Limit", "")}` : p.label.replace(" Limit", "")}</dt><dd>{fmt(p.value, unit)}</dd></div>)}
      </dl>
      {!showActual && (
        <label className="interval-demo-try"><span>Try a value</span>
          <input type="range" min={min} max={max} step="any" value={current} onChange={(e) => setTryValue(Number(e.target.value))}
            aria-valuetext={`${fmt(current, unit)}, ${ZONE_LABEL[zone]}`} /></label>
      )}
      <p className="interval-demo-note" role="status">{note}</p>
    </div>
  );
}

/** Boolean parameter preview: both states, which one is expected and what the live value is. */
export function BooleanDemo({ expected, severity, actual = null }) {
  const baseId = useId();
  const { open, point } = useTips();
  const state = actual?.state === "ok" ? Boolean(actual.value) : null;
  const unavailable = actual && actual.state !== "ok";
  const matching = state === null ? null : state === expected;
  const evaluation = !actual ? "Sample preview — no variable is connected."
    : actual.state === "loading" ? "Reading the connected variable…"
    : unavailable ? `${actual.state === "invalid" ? "Invalid" : "Unavailable"}: ${actual.detail || "no usable value"}. This is not treated as FALSE.`
    : matching ? "Matches the expected state." : "Not matching the expected state.";
  const tile = (value) => {
    const isExpected = value === expected;
    const tip = isExpected
      ? `${value ? "TRUE" : "FALSE"} is the expected (normal) state. No alert is raised while the value is ${value ? "TRUE" : "FALSE"}.`
      : `${value ? "TRUE" : "FALSE"} is not expected. When the value is ${value ? "TRUE" : "FALSE"} the rule raises a ${severity}.`;
    return (
      <div key={String(value)} className="bool-tile-wrap">
        <button type="button" className={`bool-tile ${isExpected ? "is-expected" : "is-trigger"}${state === value ? " is-current" : ""}${open === String(value) ? " is-open" : ""}`}
          {...point(String(value), baseId)} aria-label={`${value ? "TRUE" : "FALSE"} state. ${tip}`}>
          <strong>{value ? "TRUE" : "FALSE"}</strong>
          <span>{isExpected ? "Expected · Normal" : `Triggers ${severity}`}</span>
          {state === value && <em>Current</em>}
        </button>
        <div id={`${baseId}-tip-${String(value)}`} role="tooltip" className={`bool-tip${open === String(value) ? " is-visible" : ""}`}>{tip}</div>
      </div>
    );
  };
  return (
    <div className="interval-demo param-demo" role="group" aria-label="Boolean condition preview">
      <div className="interval-demo-head">
        <span className={`interval-demo-badge ${state !== null ? "is-live" : "is-sample"}`}>{state !== null ? "Live value" : unavailable ? "No live value" : "Sample preview"}</span>
        <span className={`interval-demo-status status-${matching === null ? "unavailable" : matching ? "normal" : severity === "alert" ? "overdue" : "due"}`}>
          {matching === null ? (unavailable ? "Unavailable" : "Preview") : matching ? "Normal" : severity === "alert" ? "Alert" : "Warning"}
        </span>
      </div>
      <div className="bool-tiles">{tile(true)}{tile(false)}</div>
      <dl className="interval-demo-figures">
        <div><dt>Expected state</dt><dd>{expected ? "TRUE" : "FALSE"}</dd></div>
        <div><dt>Current state</dt><dd>{state === null ? (unavailable ? actual.state : "sample") : state ? "TRUE" : "FALSE"}</dd></div>
        <div className="figure-remaining"><dt>Evaluation</dt><dd>{evaluation}</dd></div>
      </dl>
    </div>
  );
}
