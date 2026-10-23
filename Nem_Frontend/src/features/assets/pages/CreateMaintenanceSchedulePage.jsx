
import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import "./CreateMaintenanceSchedulePage.css";

const TYPES = [
  "preventive",
  "corrective",
  "inspection",
  "unplanned",
];

const PRIORITIES = ["low", "medium", "high", "critical"];

const RECURRENCE_UNITS = ["days", "weeks", "months", "years"];

function todayDateInput() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;

  return new Date(now.getTime() - offset)
    .toISOString()
    .slice(0, 10);
}

function getErrorMessage(err, fallback) {
  return (
    err?.response?.data?.detail ||
    err?.response?.data?.message ||
    err?.message ||
    fallback
  );
}

function getDocumentsArray(response) {
  const data = response?.data ?? response;

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.documents)) {
    return data.documents;
  }

  if (Array.isArray(data?.items)) {
    return data.items;
  }

  if (Array.isArray(data?.results)) {
    return data.results;
  }

  return [];
}

export default function CreateMaintenanceSchedulePage() {
  const { id, scheduleId } = useParams();
  const isEdit = Boolean(scheduleId);
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
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState("");

  // Instructions and documents picker state.
  const [instructionPickerOpen, setInstructionPickerOpen] =
    useState(false);
  const [instructions, setInstructions] = useState([]);
  const [instructionsLoading, setInstructionsLoading] =
    useState(false);
  const [instructionsError, setInstructionsError] = useState("");
  const [instructionSearch, setInstructionSearch] = useState("");

  // Load existing schedule when editing.
  useEffect(() => {
    if (!isEdit || !scheduleId) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    async function loadSchedule() {
      setLoading(true);
      setError("");

      try {
        const response = await api.get(
          `/maintenance/schedules/${scheduleId}`
        );

        const data = response?.data ?? response;
        const schedule = data?.schedule ?? data;

        if (
          !schedule ||
          typeof schedule !== "object" ||
          Array.isArray(schedule) ||
          schedule.title == null
        ) {
          throw new Error(
            "Invalid schedule data returned by the server."
          );
        }

        if (cancelled) return;

        setForm({
          title: schedule.title ?? "",
          maintenance_type:
            schedule.maintenance_type ?? "preventive",
          priority: schedule.priority ?? "medium",
          assigned_technician:
            schedule.assigned_technician ?? "",
          description: schedule.description ?? "",
          schedule_start_date: schedule.schedule_start_date
            ? String(schedule.schedule_start_date).slice(0, 10)
            : todayDateInput(),
          first_due_date: schedule.first_due_date
            ? String(schedule.first_due_date).slice(0, 10)
            : "",
          recurrence_enabled:
            schedule.recurrence_enabled == null
              ? true
              : Boolean(schedule.recurrence_enabled),
          recurrence_interval: String(
            schedule.recurrence_interval ?? 1
          ),
          recurrence_unit:
            schedule.recurrence_unit ?? "months",
        });
      } catch (err) {
        console.error("Failed to load schedule:", err);

        if (!cancelled) {
          setError(
            getErrorMessage(
              err,
              "Could not load maintenance schedule."
            )
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadSchedule();

    return () => {
      cancelled = true;
    };
  }, [isEdit, scheduleId]);

  const updateField = (event) => {
    const { name, value, checked, type } = event.target;

    setForm((previous) => ({
      ...previous,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  // Load instructions and documents for the picker.
  const loadInstructions = async () => {
    setInstructionsLoading(true);
    setInstructionsError("");

    try {
      const response = await api.get("/documents");
      const documents = getDocumentsArray(response);

      setInstructions(documents);
    } catch (err) {
      console.error("Failed to load documents:", err);

      setInstructionsError(
        getErrorMessage(
          err,
          "Instructions and documents could not be loaded."
        )
      );
    } finally {
      setInstructionsLoading(false);
    }
  };

  const openInstructionPicker = () => {
    setInstructionPickerOpen(true);
    setInstructionSearch("");
    loadInstructions();
  };

  const selectInstruction = (item) => {
    const text = [item.title, item.description]
      .filter(Boolean)
      .join("\n\n");

    if (!text.trim()) {
      setInstructionsError(
        "This document does not contain a title or description to add."
      );
      return;
    }

    setForm((previous) => ({
      ...previous,
      description: previous.description.trim()
        ? `${previous.description.trim()}\n\n${text}`
        : text,
    }));

    setInstructionPickerOpen(false);
    setInstructionsError("");
  };

  const goToMaintenanceLog = () => {
    navigate(`/assets/${id}`, {
      state: { activeTab: "logbook" },
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (busy) return;

    setError("");

    if (!String(id ?? "").trim() || !Number.isFinite(Number(id))) {
      setError("A valid asset ID is required.");
      return;
    }

    if (!form.title.trim()) {
      setError("Maintenance title is required.");
      return;
    }

    if (
      !form.schedule_start_date ||
      !form.first_due_date
    ) {
      setError(
        "Schedule start date and first due date are required."
      );
      return;
    }

    if (form.first_due_date < form.schedule_start_date) {
      setError(
        "First due date must not precede the schedule start date."
      );
      return;
    }

    const interval = Number(form.recurrence_interval);

    if (
      form.recurrence_enabled &&
      (!Number.isInteger(interval) ||
        interval < 1 ||
        interval > 3650)
    ) {
      setError(
        "Recurrence interval must be a whole number between 1 and 3650."
      );
      return;
    }

    const payload = {
      asset_id: Number(id),
      title: form.title.trim(),
      maintenance_type: form.maintenance_type,
      priority: form.priority,
      assigned_technician:
        form.assigned_technician.trim() || null,
      description: form.description.trim() || null,
      schedule_start_date: form.schedule_start_date,
      first_due_date: form.first_due_date,
      recurrence_enabled: form.recurrence_enabled,
      recurrence_interval: form.recurrence_enabled
        ? interval
        : null,
      recurrence_unit: form.recurrence_enabled
        ? form.recurrence_unit
        : null,
    };

    setBusy(true);

    try {
      if (isEdit) {
        await api.patch(
          `/maintenance/schedules/${scheduleId}`,
          payload
        );
      } else {
        await api.post("/maintenance/schedules", payload);
      }

      navigate(`/assets/${id}`, {
        state: {
          activeTab: "logbook",
          createdNotice: isEdit
            ? "Maintenance schedule updated."
            : "Maintenance schedule created.",
        },
      });
    } catch (requestError) {
      console.error(
        "Maintenance schedule request failed:",
        requestError
      );

      setError(
        getErrorMessage(
          requestError,
          `Could not ${
            isEdit ? "update" : "create"
          } maintenance schedule.`
        )
      );
    } finally {
      setBusy(false);
    }
  };

  const filteredInstructions = instructions.filter((item) => {
    const query = instructionSearch.trim().toLowerCase();

    if (!query) return true;

    return [
      item.title,
      item.kind,
      item.description,
    ].some((value) =>
      String(value || "").toLowerCase().includes(query)
    );
  });

  return (
    <main className="create-schedule-page">
      <div className="create-schedule-header">
        <button
          type="button"
          className="btn-outline"
          onClick={goToMaintenanceLog}
          disabled={busy}
        >
          Back to Maintenance log
        </button>

        <div>
          <p className="create-schedule-eyebrow">
            MAINTENANCE MANAGEMENT
          </p>

          <h1>
            {isEdit
              ? "Edit maintenance schedule"
              : "Add maintenance schedule"}
          </h1>

          <p className="create-schedule-subtitle">
            Configure the maintenance plan, first due date and
            recurrence for this asset.
          </p>
        </div>
      </div>

      <form
        className="create-schedule-card"
        onSubmit={handleSubmit}
      >
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <p className="muted">
            Loading maintenance schedule...
          </p>
        ) : (
          <>
            <fieldset
              className="create-schedule-fieldset"
              disabled={busy}
              style={{
                border: 0,
                padding: 0,
                margin: 0,
                minWidth: 0,
              }}
            >
              <section className="create-schedule-section">
                <h2>Schedule details</h2>

                <p className="muted">
                  Enter the basic maintenance information.
                </p>

                <div className="create-schedule-grid">
                  <label className="field">
                    Maintenance title{" "}
                    <span className="req">*</span>

                    <input
                      name="title"
                      value={form.title}
                      onChange={updateField}
                      maxLength={200}
                      required
                      placeholder="e.g. Monthly machine inspection"
                    />
                  </label>

                  <label className="field">
                    Assigned technician

                    <input
                      name="assigned_technician"
                      value={form.assigned_technician}
                      onChange={updateField}
                      maxLength={200}
                      placeholder="Technician name"
                    />
                  </label>
                </div>
              </section>

              <section className="create-schedule-section">
                <h2>Dates</h2>

                <p className="muted">
                  Select when the plan starts and when the first
                  maintenance is due.
                </p>

                <div className="create-schedule-grid">
                  <label className="field">
                    Schedule start date{" "}
                    <span className="req">*</span>

                    <input
                      type="date"
                      name="schedule_start_date"
                      value={form.schedule_start_date}
                      onChange={updateField}
                      required
                    />

                    <small className="muted">
                      When this maintenance plan becomes effective.
                    </small>
                  </label>

                  <label className="field">
                    First maintenance due date{" "}
                    <span className="req">*</span>

                    <input
                      type="date"
                      name="first_due_date"
                      value={form.first_due_date}
                      min={form.schedule_start_date}
                      onChange={updateField}
                      required
                    />

                    <small className="muted">
                      The due date for the first maintenance
                      occurrence.
                    </small>
                  </label>
                </div>
              </section>

              <section className="create-schedule-section">
                <h2>Recurring maintenance</h2>

                <p className="muted">
                  Automatically plan repeated maintenance when
                  recurrence is enabled.
                </p>

                <label className="field create-schedule-checkbox">
                  <input
                    type="checkbox"
                    name="recurrence_enabled"
                    checked={form.recurrence_enabled}
                    onChange={updateField}
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
                      />
                    </label>

                    <label className="field">
                      Recurrence unit

                      <select
                        name="recurrence_unit"
                        value={form.recurrence_unit}
                        onChange={updateField}
                        required
                      >
                        {RECURRENCE_UNITS.map((item) => (
                          <option key={item} value={item}>
                            {item.charAt(0).toUpperCase() +
                              item.slice(1)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </section>

              <section className="create-schedule-section">
                <h2>Description / work details</h2>

                <p className="muted">
                  Instructions for the maintenance team.
                </p>

                <label className="field">
                  Description / work details

                  <textarea
                    name="description"
                    value={form.description}
                    onChange={updateField}
                    rows={4}
                    maxLength={10000}
                    placeholder="Enter maintenance instructions..."
                  />
                </label>
                <button
                type="button"
                className="btn-outline"
                onClick={() => navigate("/configuration/documents")}
                disabled={busy}
                >
                  Add from instructions and documents
                  </button>
              </section>
            </fieldset>

            <div className="create-schedule-actions">
              <button
                type="button"
                className="btn-outline"
                onClick={goToMaintenanceLog}
                disabled={busy}
              >
                Cancel
              </button>

              <button
                type="submit"
                className="btn-primary"
                disabled={busy}
              >
                {busy
                  ? isEdit
                    ? "Updating schedule..."
                    : "Creating schedule..."
                  : isEdit
                    ? "Update schedule"
                    : "Create schedule"}
              </button>
            </div>
          </>
        )}
      </form>

      {instructionPickerOpen && (
  <div
    className="instruction-picker-overlay"
    role="presentation"
    onClick={() => setInstructionPickerOpen(false)}
  >
    <section
      className="instruction-picker-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="instruction-picker-title"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="instruction-picker-header">
        <div>
          <h2 id="instruction-picker-title">
            Instructions and documents
          </h2>
          <p className="muted">
            Select a document to add its details to the maintenance description.
          </p>
        </div>

        <button
          type="button"
          className="btn-outline"
          onClick={() => setInstructionPickerOpen(false)}
        >
          Close
        </button>
      </div>

      <input
        type="search"
        value={instructionSearch}
        onChange={(event) =>
          setInstructionSearch(event.target.value)
        }
        placeholder="Search instructions and documents..."
        aria-label="Search instructions and documents"
      />

      {instructionsLoading && (
        <p className="muted">Loading documents...</p>
      )}

      {instructionsError && (
        <div className="notice error" role="alert">
          {instructionsError}
        </div>
      )}

      {!instructionsLoading &&
        !instructionsError &&
        filteredInstructions.length === 0 && (
          <p className="muted">
            {instructions.length === 0
              ? "No documents were returned by the API. Check the browser console and API response."
              : "No documents match your search."}
          </p>
        )}

      {!instructionsLoading && (
        <div className="instruction-document-grid">
          {filteredInstructions.map((item) => (
            <button
              key={item.id}
              type="button"
              className="instruction-document-tile"
              onClick={() => selectInstruction(item)}
            >
              <strong>{item.title || "Untitled document"}</strong>

              <span className="muted">
                {item.kind || item.document_type || "Document"}
              </span>

              {item.description && (
                <span>{item.description}</span>
              )}

              <span className="muted">
                {Array.isArray(item.files)
                  ? item.files.length
                  : 0}{" "}
                attachment(s)
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  </div>
)}
    </main>
  );
}
