import React from "react";

/** Wraps a numeric input and shows its unit inside the control. */
export function UnitInput({ unit, children }) {
  return (
    <div className="rule-input-unit">
      {children}
      <span className="rule-input-unit-label" aria-hidden="true">{unit}</span>
    </div>
  );
}

/** Label, optional marker, control and helper text for one form field. */
export function RuleField({
  id,
  label,
  optional = false,
  hint,
  wide = false,
  threshold = false,
  children,
}) {
  return (
    <div
      className={
        "form-group" +
        (wide ? " form-group-wide" : "") +
        (threshold ? " form-group-threshold" : "")
      }
    >
      <label htmlFor={id}>
        {label}
        {optional && <span className="optional-label"> Optional</span>}
      </label>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  );
}
