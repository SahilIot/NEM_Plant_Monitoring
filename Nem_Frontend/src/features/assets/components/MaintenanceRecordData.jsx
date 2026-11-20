import React from "react";
import { formatTime } from "../../../utils/format.js";

// Display helpers for the structured data stored on a maintenance record:
//   checklist:     [{ id?, item, completed, note?, source? }]  (older records only have item + completed)
//   actual_values: [{ parameter_name, variable_name, unit, expected_type, last_recorded, confirmed }]

export const READING_STATUS_LABEL = {
  ok: "Recent",
  stale: "Stale",
  missing: "No reading",
  invalid: "Invalid",
  inactive: "Variable inactive",
};

export function formatProcessValue(value, expectedType, unit) {
  if (value === null || value === undefined) return "—";
  if (expectedType === "boolean" || typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return unit ? `${value} ${unit}` : String(value);
}

// Plain-text versions for spreadsheet exports.
export function checklistText(checklist) {
  if (!Array.isArray(checklist)) return "";
  return checklist
    .map((entry) => `${entry.completed ? "[x]" : "[ ]"} ${entry.item || ""}${entry.note ? ` — ${entry.note}` : ""}`)
    .join("\n");
}

export function actualValuesText(actualValues) {
  if (!Array.isArray(actualValues)) return "";
  return actualValues
    .map((entry) => {
      const last = entry.last_recorded || {};
      const lastText = last.value === null || last.value === undefined
        ? `last recorded: ${READING_STATUS_LABEL[last.status] || "none"}`
        : `last recorded ${formatProcessValue(last.value, entry.expected_type, entry.unit)} (${last.recorded_at ? formatTime(last.recorded_at) : "—"}, ${READING_STATUS_LABEL[last.status] || last.status})`;
      const confirmed = entry.confirmed
        ? `confirmed ${formatProcessValue(entry.confirmed.value, entry.expected_type, entry.unit)} (${formatTime(entry.confirmed.confirmed_at)}${entry.confirmed.confirmed_by ? `, ${entry.confirmed.confirmed_by}` : ""})`
        : "not confirmed";
      return `${entry.parameter_name || "Parameter"} / ${entry.variable_name || "variable"}: ${lastText}; ${confirmed}`;
    })
    .join("\n");
}

// Read-only checklist. Old free-text items (no id / note) render exactly as before.
export function ChecklistView({ checklist, className = "" }) {
  if (!Array.isArray(checklist) || checklist.length === 0) return null;
  return (
    <ul className={`maintenance-record-checklist ${className}`.trim()}>
      {checklist.map((item, index) => (
        <li key={`${item.id || item.item}-${index}`}>
          <span
            className={
              item.completed
                ? "schedule-history-checklist-result is-complete"
                : "schedule-history-checklist-result"
            }
          >
            {item.completed ? "Complete" : "Incomplete"}
          </span>
          <span>{item.item}</span>
          {item.note && <em className="maintenance-record-note">Note: {item.note}</em>}
        </li>
      ))}
    </ul>
  );
}

// Read-only process values: the automatically retrieved reading and the technician's value are labelled separately.
export function ActualValuesView({ actualValues }) {
  if (!Array.isArray(actualValues) || actualValues.length === 0) return null;
  return (
    <div className="maintenance-record-values">
      <strong>Actual process values</strong>
      <ul>
        {actualValues.map((entry, index) => {
          const last = entry.last_recorded || {};
          return (
            <li key={`${entry.parameter_id || entry.parameter_name}-${index}`}>
              <span className="maintenance-record-value-name">
                {entry.parameter_name || "Parameter"}
                {entry.variable_name ? ` · ${entry.variable_name}` : ""}
              </span>
              <span>
                Last recorded (automatic):{" "}
                {last.value === null || last.value === undefined
                  ? "none"
                  : `${formatProcessValue(last.value, entry.expected_type, entry.unit)} at ${formatTime(last.recorded_at)}`}{" "}
                <span className={`maintenance-reading-status is-${last.status || "missing"}`}>
                  {READING_STATUS_LABEL[last.status] || last.status || ""}
                </span>
              </span>
              <span>
                Confirmed by technician:{" "}
                {entry.confirmed
                  ? `${formatProcessValue(entry.confirmed.value, entry.expected_type, entry.unit)} at ${formatTime(entry.confirmed.confirmed_at)}${entry.confirmed.confirmed_by ? ` by ${entry.confirmed.confirmed_by}` : ""}${entry.confirmed.method === "entered" ? " (entered)" : ""}`
                  : "not confirmed"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
