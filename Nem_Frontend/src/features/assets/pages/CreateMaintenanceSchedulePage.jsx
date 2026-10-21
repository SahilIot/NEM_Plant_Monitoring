import React, { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import "./CreateMaintenanceSchedulePage.css";

const TYPES = ["preventive", "corrective", "inspection", "unplanned"];
const PRIORITIES = ["low", "medium", "high", "critical"];
const RECURRENCE_UNITS = ["days", "weeks", "months", "years"];

function todayDateInput() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export default function CreateMaintenanceSchedulePage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    title: "",
    maintenance_type: "preventive",
    priority: "medium",
    assigned_technician: "",
    description: "",
    schedule_start_date: todayDateInput(),
    first_due_date: "",
    recurrence_enabled: true,
    recurrence_interval: "1",
    recurrence_unit: "months",
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const updateField = (event) => {
    const { name, value, checked, type } = event.target;

    setForm((previous) => ({
      ...previous,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (busy) return;

    setError("");

    if (!form.title.trim()) {
      setError("Maintenance title is required.");
      return;
    }

    if (!form.schedule_start_date || !form.first_due_date) {
      setError("Schedule start date and first due date are required.");
      return;
    }

    if (form.first_due_date < form.schedule_start_date) {
      setError("First due date must not precede the schedule start date.");
      return;
    }

    const interval = Number(form.recurrence_interval);

    if (
      form.recurrence_enabled &&
      (!Number.isInteger(interval) || interval < 1 || interval > 3650)
    ) {
      setError("Recurrence interval must be a whole number between 1 and 3650.");
      return;
    }

    setBusy(true);

    try {
      await api.post("/maintenance/schedules", {
        asset_id: Number(id),
        title: form.title.trim(),
        maintenance_type: form.maintenance_type,
        priority: form.priority,
        assigned_technician: form.assigned_technician.trim() || null,
        description: form.description.trim() || null,
        schedule_start_date: form.schedule_start_date,
        first_due_date: form.first_due_date,
        recurrence_enabled: form.recurrence_enabled,
        recurrence_interval: form.recurrence_enabled ? interval : null,
        recurrence_unit: form.recurrence_enabled
          ? form.recurrence_unit
          : null,
      });

      navigate(`/assets/${id}`, {
        state: { maintenanceNotice: "Maintenance schedule created." },
      });
    } catch (requestError) {
      setError(
        requestError.message || "Could not create maintenance schedule."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="create-schedule-page">
      <div className="create-schedule-header">
        <div>
          <p className="create-schedule-eyebrow">MAINTENANCE MANAGEMENT</p>
          <h1>Add maintenance schedule</h1>
          <p className="create-schedule-subtitle">
            Configure the maintenance plan, first due date and recurrence for
            this asset.
          </p>
        </div>

        <button
          type="button"
          className="btn-outline"
          onClick={() => navigate(`/assets/${id}`)}
          disabled={busy}
        >
          Back to asset
        </button>
      </div>

      <form className="create-schedule-card" onSubmit={handleSubmit}>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}

        <section className="create-schedule-section">
          <h2>Schedule details</h2>
          <p className="muted">Enter the basic maintenance information.</p>

          <div className="create-schedule-grid">
            <label className="field">
              Maintenance title <span className="req">*</span>
              <input
                name="title"
                value={form.title}
                onChange={updateField}
                maxLength={200}
                required
                disabled={busy}
                placeholder="e.g. Monthly machine inspection"
              />
            </label>

            <label className="field">
              Maintenance type
              <select
                name="maintenance_type"
                value={form.maintenance_type}
                onChange={updateField}
                disabled={busy}
              >
                {TYPES.map((item) => (
                  <option key={item} value={item}>
                    {item[0].toUpperCase() + item.slice(1)}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              Priority
              <select
                name="priority"
                value={form.priority}
                onChange={updateField}
                disabled={busy}
              >
                {PRIORITIES.map((item) => (
                  <option key={item} value={item}>
                    {item[0].toUpperCase() + item.slice(1)}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              Assigned technician
              <input
                name="assigned_technician"
                value={form.assigned_technician}
                onChange={updateField}
                maxLength={200}
                disabled={busy}
                placeholder="Technician name"
              />
            </label>
          </div>
        </section>

        <section className="create-schedule-section">
          <h2>Dates</h2>
          <p className="muted">
            Select when the plan starts and when the first maintenance is due.
          </p>

          <div className="create-schedule-grid">
            <label className="field">
              Schedule start date <span className="req">*</span>
              <input
                type="date"
                name="schedule_start_date"
                value={form.schedule_start_date}
                onChange={updateField}
                required
                disabled={busy}
              />
              <small className="muted">
                When this maintenance plan becomes effective.
              </small>
            </label>

            <label className="field">
              First maintenance due date <span className="req">*</span>
              <input
                type="date"
                name="first_due_date"
                value={form.first_due_date}
                min={form.schedule_start_date}
                onChange={updateField}
                required
                disabled={busy}
              />
              <small className="muted">
                The due date for the first maintenance occurrence.
              </small>
            </label>
          </div>
        </section>

        <section className="create-schedule-section">
          <h2>Recurring maintenance</h2>
          <p className="muted">
            Automatically plan repeated maintenance when recurrence is enabled.
          </p>

          <label className="field create-schedule-checkbox">
            <input
              type="checkbox"
              name="recurrence_enabled"
              checked={form.recurrence_enabled}
              onChange={updateField}
              disabled={busy}
            />
            Enable recurring maintenance
          </label>

          {form.recurrence_enabled && (
            <div className="create-schedule-grid recurrence-grid">
              <label className="field">
                Repeat every
                <input
                  type="number"
                  name="recurrence_interval"
                  min="1"
                  max="3650"
                  step="1"
                  value={form.recurrence_interval}
                  onChange={updateField}
                  required
                  disabled={busy}
                />
              </label>

              <label className="field">
                Recurrence unit
                <select
                  name="recurrence_unit"
                  value={form.recurrence_unit}
                  onChange={updateField}
                  disabled={busy}
                >
                  {RECURRENCE_UNITS.map((item) => (
                    <option key={item} value={item}>
                      {item[0].toUpperCase() + item.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </section>

        <section className="create-schedule-section">
          <h2>Description / work details</h2>

          <label className="field">
            Instructions for the maintenance team
            <textarea
              name="description"
              value={form.description}
              onChange={updateField}
              rows={5}
              maxLength={10000}
              disabled={busy}
              placeholder="Describe the inspection, servicing or repair work..."
            />
          </label>
        </section>

        <div className="create-schedule-actions">
          <button
            type="button"
            className="btn-outline"
            onClick={() => navigate(`/assets/${id}`)}
            disabled={busy}
          >
            Cancel
          </button>

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Creating schedule..." : "Create schedule"}
          </button>
        </div>
      </form>
    </main>
  );
}
