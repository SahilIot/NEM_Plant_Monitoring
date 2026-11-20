import React, { useEffect, useId, useState } from "react";
import {
  SAMPLE_VALUES,
  STATUS_LABEL,
  demoScale,
  formatAmount,
  intervalStatus,
  parameterById,
} from "./intervalConfig.js";
import "./IntervalDemo.css";

/**
 * Compact interval preview: Normal / Due / Overdue regions, the current value and both limits.
 *
 * - `due` / `overdue`: the limits the user has entered when both are valid, otherwise null (sample limits
 *   are shown and labelled as a sample).
 * - `actual`: null when no variable is connected, otherwise { state, value, detail } where state is
 *   "loading" | "ok" | "unavailable" | "invalid". A real value is shown only when state is "ok".
 */
export default function IntervalDemo({ parameterId, due, overdue, actual = null, calendarUnit = null }) {
  const parameter = parameterById(parameterId);
  const counter = parameter.aggregation === "counter";
  const calendarTime = Boolean(calendarUnit);
  const calendarSamples = {
  days: { current: 5, due: 10, overdue: 12 },
  weeks: { current: 2, due: 4, overdue: 5 },
  months: { current: 2, due: 3, overdue: 4 },
  years: { current: 1, due: 2, overdue: 3 },
};

const sample = calendarUnit
  ? calendarSamples[calendarUnit] || calendarSamples.days
  : SAMPLE_VALUES[parameter.unit];
  const sampleLimits = !(due && overdue);
  const limits = sampleLimits ? { due: sample.due, overdue: sample.overdue } : { due, overdue };
  const actualReady = actual?.state === "ok";

  const [mode, setMode] = useState("live"); // "live" | "try"
  const [tryValue, setTryValue] = useState(null);
  const [active, setActive] = useState(null); // which marker's tooltip is open
  const [pinned, setPinned] = useState(null); // opened by tap / Enter, closed by tapping again or Escape
  const baseId = useId();

  // A different parameter or unit starts the explorer from its own default again.
  useEffect(() => {
    setTryValue(null);
  }, [parameterId, calendarUnit]);

  const defaultTry = sampleLimits
  ? sample.current
  : calendarTime
    ? Math.round(limits.due * 0.65)
    : Math.round(limits.due * 0.65 * 100) / 100;
  const sliderStep = counter || calendarTime ? 1 : "any";
  const explorerValue = tryValue ?? defaultTry;
  const showActual = actualReady && mode === "live";
  const value = showActual ? Number(actual.value) : explorerValue;
  const scale = demoScale(value, limits.due, limits.overdue);
  const status = intervalStatus(value, limits.due, limits.overdue); 

  const fmt = (amount) => {
    if (!calendarTime) return formatAmount(amount, parameterId);

    const number = Number(amount);
    if (!Number.isFinite(number)) return "—";

    const rounded = Number.isInteger(number)
      ? String(number)
      : String(Math.round(number * 100) / 100);

    return `${rounded} ${calendarUnit}`;
  };

  let remaining = "";
  if (status === "normal") {
    remaining = `${fmt(limits.due - value)} until Due`;
  } else if (status === "due") {
    remaining = `Due now. ${fmt(limits.overdue - value)} until Overdue`;
  } else if (status === "overdue") {
    remaining = `Overdue by ${fmt(value - limits.overdue)}`;
  }
  const sliderMax = Math.max(limits.overdue * 1.5, value);

  const open = pinned || active;
  const tooltips = {
    value: {
      title: showActual ? "Current value (live)" : "Current value (sample)",
      lines: [
        `Current value: ${fmt(value)}`,
        `Current status: ${STATUS_LABEL[status]}`,
        status === "normal"
          ? `Distance remaining until Due: ${fmt(limits.due - value)}`
          : remaining,
      ],
    },
    due: {
      title: "Due boundary",
      lines: [`Due limit: ${fmt(limits.due)}`, "Meaning: Maintenance is due at this value."],
    },
    overdue: {
      title: "Overdue boundary",
      lines: [
        `Overdue limit: ${fmt(limits.overdue)}`,
        "Meaning: Maintenance is overdue once the value reaches this limit.",
      ],
    },
  };

  const point = (key) => ({
    onMouseEnter: () => setActive(key),
    onMouseLeave: () => setActive((current) => (current === key ? null : current)),
    onFocus: () => setActive(key),
    onBlur: () => {
      setActive((current) => (current === key ? null : current));
      setPinned((current) => (current === key ? null : current));
    },
    onClick: () => setPinned((current) => (current === key ? null : key)),
    onKeyDown: (event) => {
      if (event.key === "Escape") {
        setActive(null);
        setPinned(null);
      }
    },
    "aria-describedby": `${baseId}-tip-${key}`,
  });

  const edge = (pct) => (pct < 22 ? "is-start" : pct > 78 ? "is-end" : "");
  const positions = { value: scale.valuePct, due: scale.duePct, overdue: scale.overduePct };

  let sourceNote;
  if (!actual) {
    sourceNote = "Sample preview — no variable is connected, so no live value is shown.";
  } else if (actual.state === "loading") {
    sourceNote = "Reading the connected variable…";
  } else if (actual.state === "ok") {
    sourceNote = showActual
      ? actual.detail || "Live value from the connected variable."
      : "Sample position — drag the slider to explore. Switch to Live to see the connected value.";
  } else {
    sourceNote = `${actual.detail || "The connected variable has no usable value."} Showing a sample position instead.`;
  }
  if (sampleLimits && actual?.state === "ok" && showActual) {
    sourceNote += " Limits shown are samples until you enter Due and Overdue.";
  }

  return (
    <div
      className={`interval-demo is-${status}`}
      role="group"
      aria-label="Interval preview"
    >
      <div className="interval-demo-head">
        <span className={`interval-demo-badge ${showActual ? "is-live" : "is-sample"}`}>
          {showActual ? "Live value" : "Sample preview"}
        </span>
        <span className={`interval-demo-status status-${status}`}>
          {STATUS_LABEL[status]}
        </span>
        {actualReady && (
          <div className="interval-demo-mode" role="group" aria-label="Preview source">
            <button type="button" aria-pressed={mode === "live"} onClick={() => setMode("live")}>Live</button>
            <button type="button" aria-pressed={mode === "try"} onClick={() => setMode("try")}>Try values</button>
          </div>
        )}
      </div>

      <div className="interval-demo-stage">
        <div className="interval-demo-bar" aria-hidden="true">
          <span className="interval-demo-region region-normal" style={{ width: `${scale.duePct}%` }}>
            {scale.duePct > 14 && "Normal"}
          </span>
          <span
            className="interval-demo-region region-due"
            style={{ width: `${scale.overduePct - scale.duePct}%` }}
          >
            {scale.overduePct - scale.duePct > 11 && "Due"}
          </span>
          <span
            className="interval-demo-region region-overdue"
            style={{ width: `${100 - scale.overduePct}%` }}
          >
            {100 - scale.overduePct > 14 && "Overdue"}
          </span>
        </div>

        {[
          ["due", "Due boundary", "interval-demo-limit limit-due"],
          ["overdue", "Overdue boundary", "interval-demo-limit limit-overdue"],
          ["value", "Current value", "interval-demo-marker"],
        ].map(([key, label, className]) => (
          <button
            key={key}
            type="button"
            className={`${className}${open === key ? " is-open" : ""}`}
            style={{ left: `${positions[key]}%` }}
            aria-label={`${label}: ${tooltips[key].lines.join(". ")}`}
            {...point(key)}
          />
        ))}

        {["value", "due", "overdue"].map((key) => (
          <div
            key={key}
            id={`${baseId}-tip-${key}`}
            role="tooltip"
            className={`interval-demo-tip ${edge(positions[key])}${open === key ? " is-visible" : ""}`}
            style={{ left: `${positions[key]}%` }}
          >
            <strong>{tooltips[key].title}</strong>
            {tooltips[key].lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        ))}

        <div className="interval-demo-scale" aria-hidden="true">
          <span style={{ left: "0%" }}>0</span>
          <span className="scale-due" style={{ left: `${scale.duePct}%` }}>{limits.due}</span>
          <span className="scale-overdue" style={{ left: `${scale.overduePct}%` }}>{limits.overdue}</span>
        </div>
      </div>

      <dl className="interval-demo-figures">
        <div>
          <dt>{showActual ? "Current" : "Sample current"}</dt>
          <dd>{fmt(value)}</dd>
        </div>
        <div>
          <dt>{sampleLimits ? "Sample Due" : "Due"}</dt>
          <dd>{fmt(limits.due)}</dd>
        </div>
        <div>
          <dt>{sampleLimits ? "Sample Overdue" : "Overdue"}</dt>
          <dd>{fmt(limits.overdue)}</dd>
        </div>
        <div className="figure-remaining">
          <dt>Position</dt>
          <dd>{remaining}</dd>
        </div>
      </dl>

      {!showActual && (
        <label className="interval-demo-try">
          <span>Try a value ({calendarTime ? calendarUnit : parameter.unitLabel})</span>
          <input
            type="range"
            min="0"
            max={sliderMax}
            step={sliderStep}
            value={Math.min(explorerValue, sliderMax)}
            onChange={(event) => setTryValue(Number(event.target.value))}
            aria-valuetext={`${fmt(explorerValue)}, ${STATUS_LABEL[status]}`}
          />
        </label>
      )}

      <p className="interval-demo-note" role="status">{sourceNote}</p>
    </div>
  );
}
