import React, { useRef, useState } from "react";
import { Modal } from "../../../components/common/UI.jsx";

// Convert the current UTC timestamp to the browser-local value expected by datetime-local.
function localDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function registrationValues(record, defaultTechnician) {
  const checklist = Array.isArray(record.checklist) ? record.checklist : [];
  return {
    actual_completed_at: localDateTime(new Date().toISOString()),
    performed_by:
      record.performed_by || record.assigned_technician || defaultTechnician || "",
    notes: "",
    completion_notes: record.completion_notes || "",
    parts_used: record.parts_used || "",
    checklist: checklist
      .map((item) => `${item.completed ? "[x]" : "[ ]"} ${item.item || ""}`)
      .join("\n"),
  };
}

// Shared by the schedule details and current-maintenance views to keep completion validation consistent.
export default function MaintenanceRegistrationDialog({
  record,
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

  const submit = async (event) => {
    event.preventDefault();
    if (submittingRef.current) return;
    setValidationError("");

    if (
      !values.performed_by.trim() ||
      !values.notes.trim() ||
      !values.completion_notes.trim()
    ) {
      setValidationError(
        "Enter the responsible technician, work performed, and completion remarks."
      );
      return;
    }

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

    const checklist = values.checklist
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({
        item: line.replace(/^\[[ x]\]\s*/i, ""),
        completed: /^\[x\]\s*/i.test(line),
      }));

    // Send only fields already supported by the maintenance record model.
    const payload = {
      actual_completed_at: completedAt.toISOString(),
      performed_by: values.performed_by.trim(),
      notes: values.notes.trim(),
      completion_notes: values.completion_notes.trim(),
      parts_used: values.parts_used.trim() || null,
      checklist: checklist.length ? checklist : null,
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
            Maintenance record
            <input
              type="text"
              value={record.title || record.summary || "Maintenance"}
              readOnly
            />
          </label>
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
            Technician responsible
            <input
              type="text"
              required
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
            Work performed
            <textarea
              required
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
            Completion remarks
            <textarea
              required
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
          <label className="maintenance-form-wide">
            Checklist / inspection results (one item per line; prefix completed items with [x])
            <textarea
              rows={3}
              value={values.checklist}
              onChange={(event) =>
                setValues((previous) => ({
                  ...previous,
                  checklist: event.target.value,
                }))
              }
            />
          </label>
        </div>
        <p className="muted">
          Linked schedule documents remain available in the maintenance schedule details.
        </p>
        <div className="modal-actions">
          <button type="submit" className="btn-primary" disabled={busy}>
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
