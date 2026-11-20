import React, { useEffect, useRef, useState } from "react";
import { Modal } from "../../../components/common/UI.jsx";
import { api } from "../../../services/api.js";
import { formatTime } from "../../../utils/format.js";
import { READING_STATUS_LABEL, formatProcessValue } from "./MaintenanceRecordData.jsx";

// Convert the current UTC timestamp to the browser-local value expected by datetime-local.
function localDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

// Rows of the structured checklist. Older records only have { item, completed }; a stable id is derived for them.
function checklistRows(items) {
  return (Array.isArray(items) ? items : [])
    .filter((entry) => entry && typeof entry.item === "string")
    .map((entry, index) => ({
      id: entry.id || `item-${index + 1}`,
      item: entry.item,
      completed: Boolean(entry.completed),
      note: entry.note || "",
      source: entry.source || "custom",
      instruction_id: entry.instruction_id ?? null,
      instruction_title: entry.instruction_title || "",
    }));
}

function registrationValues(record, defaultTechnician) {
  return {
    actual_completed_at: localDateTime(new Date().toISOString()),
    performed_by:
      record.performed_by || record.assigned_technician || defaultTechnician || "",
    notes: "",
    completion_notes: record.completion_notes || "",
    parts_used: record.parts_used || "",
  };
}

// Shared by the schedule details and current-maintenance views to keep completion validation consistent.
export default function MaintenanceRegistrationDialog({
  record,
  scheduleTitle,
  defaultTechnician,
  busy = false,
  error = "",
  onClose,
  onSubmit,
}) {
  const [values, setValues] = useState(() =>
    registrationValues(record, defaultTechnician)
  );
  const [validationError, setValidationError] = useState("");
  const submittingRef = useRef(false);
  const [checklist, setChecklist] = useState(() => checklistRows(record.checklist));
  const [processValues, setProcessValues] = useState([]);
  // Technician input per parameter id; empty text = not confirmed.
  const [confirmed, setConfirmed] = useState({});
  const [contextState, setContextState] = useState({ loading: true, error: "" });

  // Last valid readings (previous 7 days) and the checklist suggested by the rule's instructions.
  useEffect(() => {
    let cancelled = false;
    api
      .get(`/maintenance/${record.id}/registration-context`)
      .then((context) => {
        if (cancelled) return;
        setProcessValues(Array.isArray(context.actual_values) ? context.actual_values : []);
        setChecklist(checklistRows(context.checklist));
        setContextState({ loading: false, error: "" });
      })
      .catch((error) => {
        if (cancelled) return;
        // Completion stays possible: the record's own checklist is kept and no process values are recorded.
        setContextState({
          loading: false,
          error: error?.message || "Could not load the last recorded values and instruction checklist.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [record.id]);

  const updateChecklist = (id, patch) =>
    setChecklist((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const addChecklistItem = () =>
    setChecklist((rows) => [
      ...rows,
      { id: `new-${Date.now()}-${rows.length}`, item: "", completed: false, note: "", source: "custom", instruction_id: null, instruction_title: "" },
    ]);

  const submit = async (event) => {
    event.preventDefault();
    if (submittingRef.current) return;
    setValidationError("");

    const completedAt = new Date(values.actual_completed_at);
    if (!values.actual_completed_at || Number.isNaN(completedAt.getTime())) {
      setValidationError("Enter a valid actual completion date and time.");
      return;
    }
    const actualStart = record.actual_started_at
      ? new Date(record.actual_started_at)
      : null;
    if (
      actualStart &&
      (Number.isNaN(actualStart.getTime()) || completedAt < actualStart)
    ) {
      setValidationError("Actual completion must not be before actual start.");
      return;
    }

    const checklistPayload = checklist
      .map((row) => ({
        // Rows added here have no stored id yet; the server assigns a stable one.
        id: String(row.id).startsWith("new-") ? null : row.id,
        item: row.item.trim(),
        completed: row.completed,
        note: row.note.trim() || null,
        source: row.source,
        instruction_id: row.instruction_id,
      }))
      .filter((row) => row.item);

    // Only technician-entered values are sent; names, units and the last recorded reading come from the server.
    const actualValues = [];
    for (const entry of processValues) {
      const text = String(confirmed[entry.parameter_id] ?? "").trim();
      if (!text) continue;
      if (entry.expected_type === "number") {
        const number = Number(text);
        if (!Number.isFinite(number)) {
          setValidationError(`Enter a valid number for ${entry.parameter_name}.`);
          return;
        }
        actualValues.push({ parameter_id: entry.parameter_id, confirmed_value: number });
      } else {
        actualValues.push({ parameter_id: entry.parameter_id, confirmed_value: text === "true" });
      }
    }

    // Send only fields already supported by the maintenance record model.
    const payload = {
      actual_completed_at: completedAt.toISOString(),
      // Technician, work performed and remarks are optional; blank values leave the record's existing details unchanged.
      performed_by: values.performed_by.trim() || null,
      notes: values.notes.trim() || null,
      completion_notes: values.completion_notes.trim() || null,
      parts_used: values.parts_used.trim() || null,
      checklist: checklistPayload.length ? checklistPayload : null,
      // Sent whenever the rule has process values, even if none was confirmed, so the last recorded readings are kept.
      ...(processValues.length ? { actual_values: actualValues } : {}),
    };

    submittingRef.current = true;
    try {
      await onSubmit(payload);
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <Modal title="Register maintenance completion" onClose={onClose} wide>
      <form className="maintenance-form" onSubmit={submit}>
        {(validationError || error) && (
          <p className="notice error" role="alert">
            {validationError || error}
          </p>
        )}
        <p className="muted">
          Record the work and completion details before completing this maintenance.
        </p>
        <div className="maintenance-form-grid">
          <label>
            Maintenance schedule / record
            <input
              type="text"
              value={`${scheduleTitle || record.title || record.summary || "Maintenance"} · Record #${record.id}`}
              readOnly
            />
          </label>
          {record.planned_due_date && (
            <label>
              Scheduled due date
              <input type="text" value={record.planned_due_date} readOnly />
            </label>
          )}
          <label>
            Actual completion date and time
            <input
              type="datetime-local"
              required
              value={values.actual_completed_at}
              onChange={(event) =>
                setValues((previous) => ({
                  ...previous,
                  actual_completed_at: event.target.value,
                }))
              }
            />
          </label>
          <label className="maintenance-form-wide">
            Technician responsible (optional)
            <input
              type="text"
              maxLength={200}
              value={values.performed_by}
              onChange={(event) =>
                setValues((previous) => ({
                  ...previous,
                  performed_by: event.target.value,
                }))
              }
            />
          </label>
          <label className="maintenance-form-wide">
            Work performed (optional)
            <textarea
              maxLength={10000}
              rows={4}
              value={values.notes}
              onChange={(event) =>
                setValues((previous) => ({
                  ...previous,
                  notes: event.target.value,
                }))
              }
            />
          </label>
          <label className="maintenance-form-wide">
            Completion remarks (optional)
            <textarea
              maxLength={10000}
              rows={3}
              value={values.completion_notes}
              onChange={(event) =>
                setValues((previous) => ({
                  ...previous,
                  completion_notes: event.target.value,
                }))
              }
            />
          </label>
          <label className="maintenance-form-wide">
            Parts or components replaced
            <textarea
              maxLength={10000}
              rows={2}
              value={values.parts_used}
              onChange={(event) =>
                setValues((previous) => ({
                  ...previous,
                  parts_used: event.target.value,
                }))
              }
            />
          </label>
          {contextState.error && (
            <p className="notice error maintenance-form-wide" role="alert">
              {contextState.error} You can still register the completion.
            </p>
          )}
          {processValues.length > 0 && (
            <fieldset className="maintenance-form-wide maintenance-process-values">
              <legend>Actual process values</legend>
              <p className="muted">
                The last recorded value is retrieved automatically from the previous 7 days. Confirm it or enter the
                actual value you observed; both are saved with their timestamps.
              </p>
              {processValues.map((entry) => {
                const last = entry.last_recorded || {};
                const hasValue = last.value !== null && last.value !== undefined;
                const current = confirmed[entry.parameter_id] ?? "";
                return (
                  <div className="maintenance-process-value" key={entry.parameter_id}>
                    <div className="maintenance-process-value-head">
                      <strong>{entry.parameter_name}</strong>
                      <span className="muted">
                        {entry.variable_name}
                        {entry.is_source_parameter ? " · triggered this maintenance" : ""}
                      </span>
                    </div>
                    <div className="maintenance-process-value-line">
                      <span>Last recorded (automatic)</span>
                      <strong>
                        {hasValue ? formatProcessValue(last.value, entry.expected_type, entry.unit) : "No valid reading"}
                      </strong>
                      <span className="muted">{hasValue ? formatTime(last.recorded_at) : ""}</span>
                      <span className={`maintenance-reading-status is-${last.status}`} title={last.message || ""}>
                        {READING_STATUS_LABEL[last.status] || last.status}
                      </span>
                    </div>
                    {last.status !== "ok" && last.message && <p className="muted">{last.message}</p>}
                    <div className="maintenance-process-value-line">
                      <label>
                        <span>Actual value (technician)</span>
                        {entry.expected_type === "number" ? (
                          <input
                            type="number"
                            step="any"
                            value={current}
                            onChange={(event) => setConfirmed((previous) => ({ ...previous, [entry.parameter_id]: event.target.value }))}
                          />
                        ) : (
                          <select
                            value={current}
                            onChange={(event) => setConfirmed((previous) => ({ ...previous, [entry.parameter_id]: event.target.value }))}
                          >
                            <option value="">Not confirmed</option>
                            <option value="true">TRUE</option>
                            <option value="false">FALSE</option>
                          </select>
                        )}
                      </label>
                      <button
                        type="button"
                        className="btn-outline"
                        disabled={!hasValue}
                        onClick={() =>
                          setConfirmed((previous) => ({
                            ...previous,
                            [entry.parameter_id]: entry.expected_type === "number" ? String(last.value) : String(Boolean(last.value)),
                          }))
                        }
                      >
                        Confirm last recorded value
                      </button>
                    </div>
                  </div>
                );
              })}
            </fieldset>
          )}
          <fieldset className="maintenance-form-wide maintenance-checklist-editor">
            <legend>Checklist / inspection results</legend>
            <p className="muted">
              Items come from the instructions linked to the rule; none is mandatory. Edit, add or remove items as needed.
            </p>
            {contextState.loading && <p className="muted">Loading…</p>}
            {!contextState.loading && checklist.map((row) => (
              <div className="maintenance-checklist-row" key={row.id}>
                <input
                  type="checkbox"
                  aria-label={`Completed: ${row.item || "checklist item"}`}
                  checked={row.completed}
                  onChange={(event) => updateChecklist(row.id, { completed: event.target.checked })}
                />
                <div className="maintenance-checklist-fields">
                  <input
                    type="text"
                    maxLength={500}
                    aria-label="Checklist item"
                    value={row.item}
                    onChange={(event) => updateChecklist(row.id, { item: event.target.value })}
                  />
                  <input
                    type="text"
                    maxLength={2000}
                    aria-label="Note (optional)"
                    placeholder="Note (optional)"
                    value={row.note}
                    onChange={(event) => updateChecklist(row.id, { note: event.target.value })}
                  />
                  {row.instruction_title && <span className="muted">From instruction: {row.instruction_title}</span>}
                </div>
                <button
                  type="button"
                  className="btn-outline"
                  aria-label="Remove checklist item"
                  onClick={() => setChecklist((rows) => rows.filter((other) => other.id !== row.id))}
                >
                  Remove
                </button>
              </div>
            ))}
            {!contextState.loading && (
              <button type="button" className="btn-outline" onClick={addChecklistItem}>
                Add checklist item
              </button>
            )}
          </fieldset>
        </div>
        <p className="muted">
          Linked schedule documents remain available in the maintenance schedule details.
        </p>
        <div className="modal-actions">
          <button type="submit" className="btn-primary" disabled={busy || contextState.loading}>
            {busy ? "Registering…" : "Register completion"}
          </button>
          <button type="button" className="btn-outline" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
