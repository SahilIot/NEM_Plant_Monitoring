
import React, { useEffect, useState } from "react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { LoadingIndicator } from "../../../components/common/UI.jsx";
import "./CreateMaintenanceSchedulePage.css";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import {
  rememberNavigationOrigin,
  returnToNavigationOrigin,
} from "../../../utils/navigation.js";

// Available maintenance types, priorities, and recurrence units.
const TYPES = [
  "preventive",
  "corrective",
  "inspection",
  "unplanned",
];

const PRIORITIES = ["low", "medium", "high", "critical"];

const RECURRENCE_UNITS = ["days", "weeks", "months", "years"];

// Returns today's date in YYYY-MM-DD format using the local timezone.
function todayDateInput() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;

  return new Date(now.getTime() - offset)
    .toISOString()
    .slice(0, 10);
}

// Converts a date value into the format required by datetime-local inputs.
function localDateTimeInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

// Converts local date and time input into a UTC ISO string.
function utcDateTime(value) {
  return value ? new Date(value).toISOString() : null;
}

// Extracts a readable error message from an API or JavaScript error.
function getErrorMessage(err, fallback) {
  return (
    err?.response?.data?.detail ||
    err?.response?.data?.message ||
    err?.message ||
    fallback
  );
}

// Handles different API response formats for instructions and documents.
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

  // Initialize authentication, permissions, route parameters, and navigation.
  const { user } = useAuth();
  const canManageMaintenance = ["Administrator", "Supervisor"].includes(user?.role);
  const isSupervisor = user?.role === "Supervisor";
  const { id, scheduleId, recordId } = useParams();
  const isStandaloneEdit = Boolean(recordId);
  const isEdit = Boolean(scheduleId || recordId);
  const navigate = useNavigate();
  const location = useLocation();

  // Identify maintenance suggestion mode and previously selected maintenance data.
  const isSuggestion = location.pathname === "/maintenance/suggest";
  const maintenanceRecord = location.state?.maintenanceRecord;

  // Define the fallback destination when returning from this page.
  const returnFallback = isSuggestion
    ? {
        pathname: "/configuration/rules",
        state: { maintenanceSuggestionSubmitted: true },
      }
    : {
        pathname: `/assets/${id}`,
        state: { activeTab: "logbook" },
      };

  // Remember the previous navigation location for proper back navigation.
  useEffect(() => {
    rememberNavigationOrigin(location.state?.from);
  }, [location.state?.from]);

  // Maintain all maintenance form fields in a single state object.
  const [form, setForm] = useState({
    title: "",
    maintenance_type: "preventive",
    priority: "medium",
    assigned_technician: "",
    description: "",
    actual_started_at: "",
    actual_completed_at: "",
    completion_notes: "",
    parts_used: "",
    checklist: "",
    next_due_at: "",
    alert_id: "",
    schedule_start_date: todayDateInput(),
    first_due_date: "",
    recurrence_enabled: true,
    recurrence_interval: "1",
    recurrence_unit: "months",
    schedule_mode: "calendar",
    signal_variable_id: "",
    runtime_interval_hours: "",
    usage_interval_count: "",
  });

  // Manage form submission, loading, editing, and API error states.
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [editingBlocked, setEditingBlocked] = useState(isEdit);
  const [scheduleConfigurationLocked, setScheduleConfigurationLocked] =
  useState(false);
  const [error, setError] = useState("");

  // Store active PLC variables associated with the selected asset.
  const [assetVariables, setAssetVariables] = useState([]);
  const [variablesLoading, setVariablesLoading] = useState(false);
  const [variablesError, setVariablesError] = useState("");

  // Manage the instruction and document selection modal.
  const [instructionPickerOpen, setInstructionPickerOpen] =
    useState(false);
  const [instructions, setInstructions] = useState([]);
  const [selectedDocuments, setSelectedDocuments] = useState([]);
  const [instructionsLoading, setInstructionsLoading] =
    useState(false);
  const [instructionsError, setInstructionsError] = useState("");
  const [instructionSearch, setInstructionSearch] = useState("");

  // Store available assets and the selected asset for maintenance suggestions.
  const [suggestionAssets, setSuggestionAssets] = useState([]);
  const [suggestionAssetId, setSuggestionAssetId] = useState("");

  // Load available assets when a Supervisor opens the maintenance suggestion page.
  useEffect(() => {
    if (!isSuggestion) return undefined;
    let cancelled = false;

    api.getAll("/assets", 200)
      .then((items) => {
        if (!cancelled) {
          setSuggestionAssets(Array.isArray(items) ? items : []);
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(
            getErrorMessage(
              requestError,
              "Could not load assets for the maintenance suggestion."
            )
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isSuggestion]);

  // Load active Boolean PLC variables for runtime and usage maintenance schedules.
  useEffect(() => {
    if (
      isSuggestion ||
      isStandaloneEdit ||
      !id ||
      !Number.isFinite(Number(id))
    ) {
      return undefined;
    }

    let cancelled = false;

    async function loadAssetVariables() {
      setVariablesLoading(true);
      setVariablesError("");

      try {
        const items = await api.getAll(`/assets/${id}/variables`);

        if (cancelled) return;

        setAssetVariables(
          (Array.isArray(items) ? items : []).filter(
            (variable) =>
              variable.is_active &&
              String(variable.data_type).toLowerCase() === "boolean"
          )
        );
      } catch (requestError) {
        if (cancelled) return;

        setAssetVariables([]);
        setVariablesError(
          getErrorMessage(
            requestError,
            "Unable to load PLC variables for this asset."
          )
        );
      } finally {
        if (!cancelled) {
          setVariablesLoading(false);
        }
      }
    }

    loadAssetVariables();

    return () => {
      cancelled = true;
    };
  }, [id, isSuggestion, isStandaloneEdit]);

  // Load existing schedule or maintenance record when editing.
  useEffect(() => {
    if (!isEdit) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    async function loadSchedule() {
      setLoading(true);
      setEditingBlocked(isEdit);
      setError("");

      try {
        let record;
        let currentOccurrence = null;

        // Fetch schedule details and its current occurrence when editing a schedule.
        if (scheduleId) {
          const response = await api.get(
            `/maintenance/schedules/${scheduleId}`
          );
          const data = response?.data ?? response;
          record = data?.schedule ?? data;

          const currentOccurrenceId =
            record?.current_occurrence_id ??
            (maintenanceRecord?.schedule_id === Number(scheduleId)
              ? maintenanceRecord.id
              : null);

          if (currentOccurrenceId != null) {
            const occurrenceResponse = await api.get(
              `/maintenance/${currentOccurrenceId}`
            );
            const occurrenceData =
              occurrenceResponse?.data ?? occurrenceResponse;
            currentOccurrence = occurrenceData?.record ?? occurrenceData;
          }

        // Fetch an individual maintenance record in standalone edit mode.
        } else if (isStandaloneEdit) {
          const response = await api.get(`/maintenance/${recordId}`);
          const data = response?.data ?? response;
          record = data?.record ?? data;
          currentOccurrence = record;

        // Use the maintenance record passed through navigation state.
        } else {
          record = maintenanceRecord;
        }

        // Validate the retrieved maintenance data before updating the form.
        if (
          !record ||
          typeof record !== "object" ||
          Array.isArray(record)
        ) {
          throw new Error("Invalid maintenance data returned.");
        }

        if (cancelled) return;

        // Prevent editing when the current maintenance occurrence is in progress.
        const activeOccurrence = currentOccurrence?.status === "in_progress";
        setEditingBlocked(activeOccurrence);

        if (activeOccurrence) {
          setError("In-progress maintenance cannot be edited.");
        }

        setScheduleConfigurationLocked(
          !isStandaloneEdit && record.current_occurrence_id != null
        );

        // Prepare schedule dates according to the editing mode.
        const startDate = isStandaloneEdit
          ? localDateTimeInput(record.planned_start_at || record.start_date)
          : record.schedule_start_date ||
            record.planned_start_at ||
            record.start_date ||
            todayDateInput();

        const dueDate = isStandaloneEdit
          ? localDateTimeInput(record.planned_end_at || record.next_due_at)
          : record.first_due_date ||
            record.planned_end_at ||
            record.next_due_at ||
            "";

        // Populate the form with existing maintenance information.
        setForm({
          title: record.title ?? "",
          maintenance_type:
            record.maintenance_type ?? "preventive",
          priority: record.priority ?? "medium",
          assigned_technician:
            record.assigned_technician ?? "",
          description:
            record.description ?? record.notes ?? "",
          actual_started_at: localDateTimeInput(record.actual_started_at),
          actual_completed_at: localDateTimeInput(record.actual_completed_at),
          completion_notes: record.completion_notes ?? "",
          parts_used: record.parts_used ?? "",
          checklist: (record.checklist || [])
            .map((item) => item.item || "")
            .join("\n"),
          next_due_at: localDateTimeInput(record.next_due_at),
          alert_id: record.alert_id ? String(record.alert_id) : "",
          schedule_start_date: String(startDate).slice(
            0,
            isStandaloneEdit ? 16 : 10
          ),
          first_due_date: dueDate
            ? String(dueDate).slice(0, isStandaloneEdit ? 16 : 10)
            : "",
          recurrence_enabled: Boolean(record.recurrence_enabled),
          recurrence_interval: String(
            record.recurrence_interval ?? 1
          ),
          recurrence_unit:
            record.recurrence_unit ?? "months",
          schedule_mode: record.schedule_mode ?? "calendar",
          signal_variable_id:
            record.signal_variable_id != null
              ? String(record.signal_variable_id)
              : "",
          runtime_interval_hours:
            record.runtime_interval_hours != null
              ? String(record.runtime_interval_hours)
              : "",
          usage_interval_count:
            record.usage_interval_count != null
              ? String(record.usage_interval_count)
              : "",
        });

        // Restore previously attached instructions and documents.
        setSelectedDocuments(record.instruction_documents || []);

      } catch (err) {
        console.error("Failed to load maintenance:", err);

        if (!cancelled) {
          if (isEdit) setEditingBlocked(true);

          setError(
            getErrorMessage(
              err,
              "Could not load maintenance details."
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
  }, [isEdit, isStandaloneEdit, scheduleId, recordId, maintenanceRecord]);

  // Handle changes to form inputs, selects, textareas, and checkboxes.
  const updateField = (event) => {
    const { name, value, checked, type } = event.target;

    setForm((previous) => ({
      ...previous,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  // Load available instructions and documents from the backend.
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

  // Open the document picker and load the latest available documents.
  const openInstructionPicker = () => {
    setInstructionPickerOpen(true);
    setInstructionSearch("");
    loadInstructions();
  };

  // Add or remove a document from the selected document list.
  const toggleInstruction = (item) => {
    setSelectedDocuments((previous) =>
      previous.some((selected) => selected.id === item.id)
        ? previous.filter((selected) => selected.id !== item.id)
        : [...previous, item]
    );

    setInstructionsError("");
  };

  // Return to the previous page or the appropriate fallback destination.
  const goToMaintenanceLog = () => {
    returnToNavigationOrigin(
      navigate,
      location.state?.from,
      returnFallback
    );
  };

  // Validate form data, prepare the request payload, and submit maintenance details.
  const handleSubmit = async (event) => {
    event.preventDefault();

    // Check user permissions and prevent duplicate submissions.
    const canSubmit = isSuggestion ? isSupervisor : canManageMaintenance;
    if (!canSubmit || busy || editingBlocked) return;

    setError("");

    // Validate the asset ID for normal maintenance schedule operations.
    if (
      !isSuggestion &&
      (!String(id ?? "").trim() || !Number.isFinite(Number(id)))
    ) {
      setError("A valid asset ID is required.");
      return;
    }

    // Validate the maintenance title for users who can manage maintenance details.
    if ((!isSupervisor || isSuggestion) && !form.title.trim()) {
      setError("Maintenance title is required.");
      return;
    }

    // Ensure an asset is selected before submitting a maintenance suggestion.
    if (isSuggestion && !suggestionAssetId) {
      setError("Select the asset for this maintenance suggestion.");
      return;
    }

    // Determine whether the current operation uses calendar-based scheduling.
    // Suggestions and standalone maintenance records retain the calendar workflow.
    const isCalendarSchedule =
      isSuggestion ||
      isStandaloneEdit ||
      form.schedule_mode === "calendar";

    // Read the recurrence interval used by calendar-based schedules.
    let interval = Number(form.recurrence_interval);

    // Validate schedule dates and recurrence settings for calendar schedules.
    if (isCalendarSchedule) {
      if (!form.schedule_start_date || !form.first_due_date) {
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

    // Validate PLC signal selection and interval settings for runtime and usage schedules.
    } else {
      const signalVariableId = Number(form.signal_variable_id);

      if (
        !Number.isInteger(signalVariableId) ||
        signalVariableId < 1
      ) {
        setError("Select a valid PLC signal variable.");
        return;
      }

      // Validate the maintenance interval based on machine running hours.
      if (form.schedule_mode === "runtime") {
        const runtimeHours = Number(form.runtime_interval_hours);

        if (!Number.isFinite(runtimeHours) || runtimeHours <= 0) {
          setError("Runtime interval must be greater than zero hours.");
          return;
        }
      }

      // Validate the maintenance interval based on completed usage cycles.
      if (form.schedule_mode === "usage") {
        const usageCount = Number(form.usage_interval_count);

        if (!Number.isInteger(usageCount) || usageCount <= 0) {
          setError("Usage interval must be a positive whole number.");
          return;
        }
      }
    }

    // Include start and due dates only for calendar-based schedules.
    const scheduleDates = isCalendarSchedule
      ? {
          schedule_start_date: form.schedule_start_date,
          first_due_date: form.first_due_date,
        }
      : {};

    // Prepare common maintenance details and mode-specific configuration.
    const scheduleDetails = {
      title: form.title.trim(),
      maintenance_type: form.maintenance_type,
      priority: form.priority,
      assigned_technician: form.assigned_technician.trim() || null,
      description: form.description.trim() || null,
      ...scheduleDates,

      // Calendar schedules use recurrence settings.
      // Runtime and usage schedules use their respective PLC configuration.
      ...(isCalendarSchedule
        ? {
            recurrence_enabled: form.recurrence_enabled,
            recurrence_interval: form.recurrence_enabled
              ? interval
              : null,
            recurrence_unit: form.recurrence_enabled
              ? form.recurrence_unit
              : null,
          }
        : {
            schedule_mode: form.schedule_mode,
            signal_variable_id: Number(form.signal_variable_id),

            ...(form.schedule_mode === "runtime"
              ? {
                  // Maintenance interval based on machine running hours.
                  runtime_interval_hours: Number(
                    form.runtime_interval_hours
                  ),
                }
              : {
                  // Maintenance interval based on completed usage cycles.
                  usage_interval_count: Number(
                    form.usage_interval_count
                  ),
                }),
          }),

      // Attach the selected instruction and document IDs to the maintenance plan.
      instruction_document_ids: selectedDocuments.map(
        (item) => item.id
      ),
    };

    // Prepare different payloads for suggestions, Supervisor updates, and normal operations.
    const payload = isSuggestion
      ? {
          asset_id: Number(suggestionAssetId),
          ...scheduleDetails,
        }
      : isSupervisor
        ? {
            ...scheduleDates,
            ...(isEdit && !isStandaloneEdit && form.recurrence_enabled
              ? {
                  recurrence_interval: interval,
                  recurrence_unit: form.recurrence_unit,
                }
              : {}),
          }
        : {
            ...scheduleDetails,
          };

    // Convert checklist text into the structure expected by the backend.
    const checklistItems = form.checklist
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ({ item, completed: false }));

    setBusy(true);

    try {

      // Submit a maintenance suggestion for Administrator review.
      if (isSuggestion) {
        await api.post("/rule-template-requests", {
          suggestion_type: "maintenance",
          maintenance: payload,
        });

      // Update an existing standalone maintenance record.
      } else if (isStandaloneEdit) {
        const recordPayload = isSupervisor
          ? {
              planned_start_at: utcDateTime(form.schedule_start_date),
              planned_end_at: utcDateTime(form.first_due_date),
            }
          : {
              title: form.title.trim(),
              maintenance_type: form.maintenance_type,
              priority: form.priority,
              assigned_technician:
                form.assigned_technician.trim() || null,
              notes: form.description.trim() || null,
              planned_start_at: utcDateTime(form.schedule_start_date),
              planned_end_at: utcDateTime(form.first_due_date),
              actual_started_at: utcDateTime(form.actual_started_at),
              actual_completed_at: utcDateTime(form.actual_completed_at),
              completion_notes: form.completion_notes.trim() || null,
              parts_used: form.parts_used.trim() || null,
              checklist: checklistItems.length ? checklistItems : null,
              next_due_at: utcDateTime(form.next_due_at),
              ...(form.alert_id.trim()
                ? { alert_id: Number(form.alert_id) }
                : {}),
            };

        await api.patch(`/maintenance/${recordId}`, recordPayload);

      // Update an existing maintenance schedule.
      } else if (isEdit) {
        await api.patch(`/maintenance/schedules/${scheduleId}`, payload);

      // Create a new maintenance schedule for the selected asset.
      } else {
        await api.post("/maintenance/schedules", {
          asset_id: Number(id),
          ...payload,
        });
      }

      // Navigate back after successful submission and display the appropriate confirmation.
      returnToNavigationOrigin(
        navigate,
        location.state?.from,
        returnFallback,
        {
          notice: {
            text: isSuggestion
              ? "Maintenance suggestion submitted for Administrator review."
              : isEdit
                ? "Maintenance schedule updated."
                : "Maintenance schedule created.",
          },
        }
      );

    } catch (requestError) {
      // Display the backend error if the maintenance request fails.
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

  // Filter instructions and documents according to the search input.
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

  // Render the maintenance schedule creation and editing page.
  return (
    <main className="create-schedule-page">

      {/* Page header and navigation controls. */}
      <div className="create-schedule-header">
        <button
          type="button"
          className="btn-outline"
          onClick={goToMaintenanceLog}
          disabled={busy}
        >
          {isSuggestion ? "← Back to Rule Library" : "← Back"}
        </button>

        <div>
          <p className="create-schedule-eyebrow">
            MAINTENANCE MANAGEMENT
          </p>

          <h1>
            {isSuggestion
              ? "Suggest maintenance schedule"
              : isEdit
                ? "Edit maintenance"
                : "Add maintenance"}
          </h1>

          <p className="create-schedule-subtitle">
            {isSuggestion
              ? "Submit a maintenance plan for Administrator review. It will not be scheduled until approved."
              : isSupervisor
                ? "Update schedule dates and the recurrence interval. Other maintenance details are read-only."
                : "Configure the maintenance plan, first due date and recurrence for this asset."}
          </p>
        </div>
      </div>

      {/* Main form containing all maintenance configuration sections. */}
      <form
        className="create-schedule-card"
        onSubmit={handleSubmit}
      >
        {/* Display validation, permission, and API error messages. */}
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}

        {!canManageMaintenance && !isSuggestion && (
          <div className="notice" role="status">
            You do not have permission to create or edit maintenance schedules.
          </div>
        )}

        {isSuggestion && !isSupervisor && (
          <div className="notice" role="status">
            Only Supervisors can submit maintenance suggestions.
          </div>
        )}

        {/* Show a loading indicator while existing maintenance data is being fetched. */}
        {loading ? (
          <LoadingIndicator compact message="Loading maintenance schedule" />
        ) : (
          <>
            <fieldset
              className="create-schedule-fieldset"
              disabled={
                busy ||
                (isSuggestion ? !isSupervisor : !canManageMaintenance) ||
                editingBlocked
              }
            >

              {/* Asset selection is required when submitting a maintenance suggestion. */}
              {isSuggestion && (
                <section className="create-schedule-section">
                  <h2>Asset</h2>

                  <label className="field">
                    <span className="field-label">
                      Maintenance asset <span className="req" aria-hidden="true">*</span>
                    </span>

                    <select
                      value={suggestionAssetId}
                      onChange={(event) => setSuggestionAssetId(event.target.value)}
                      required
                    >
                      <option value="">Select an asset</option>

                      {suggestionAssets.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </section>
              )}

              {/* Basic maintenance information and assignment details. */}
              {(!isSupervisor || isSuggestion) && (
                <section className="create-schedule-section">
                  <h2>Schedule details</h2>

                  <p className="muted">
                    Enter the basic maintenance information.
                  </p>

                  <div className="create-schedule-grid">
                    <label className="field">
                      <span className="field-label">
                        Maintenance title <span className="req" aria-hidden="true">*</span>
                      </span>

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
                      <span className="field-label">Assigned technician</span>

                      <input
                        name="assigned_technician"
                        value={form.assigned_technician}
                        onChange={updateField}
                        maxLength={200}
                        placeholder="Technician name"
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Maintenance type</span>

                      <select
                        name="maintenance_type"
                        value={form.maintenance_type}
                        onChange={updateField}
                      >
                        {TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type.charAt(0).toUpperCase() + type.slice(1)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="field">
                      <span className="field-label">Priority</span>

                      <select
                        name="priority"
                        value={form.priority}
                        onChange={updateField}
                      >
                        {PRIORITIES.map((priority) => (
                          <option key={priority} value={priority}>
                            {priority.charAt(0).toUpperCase() + priority.slice(1)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </section>
              )}

              {/* Execution and completion information for standalone maintenance records. */}
              {isStandaloneEdit && !isSupervisor && (
                <section className="create-schedule-section">
                  <h2>Execution details</h2>

                  <p className="muted">
                    Update the existing execution and completion fields for this maintenance record.
                  </p>

                  <div className="create-schedule-grid">
                    <label className="field">
                      <span className="field-label">Actual start</span>

                      <input
                        type="datetime-local"
                        name="actual_started_at"
                        value={form.actual_started_at}
                        onChange={updateField}
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Actual completion</span>

                      <input
                        type="datetime-local"
                        name="actual_completed_at"
                        value={form.actual_completed_at}
                        onChange={updateField}
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Next due date and time</span>

                      <input
                        type="datetime-local"
                        name="next_due_at"
                        value={form.next_due_at}
                        onChange={updateField}
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Alert ID</span>

                      <input
                        type="number"
                        name="alert_id"
                        min="1"
                        value={form.alert_id}
                        onChange={updateField}
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Parts used</span>

                      <textarea
                        name="parts_used"
                        value={form.parts_used}
                        onChange={updateField}
                        rows={3}
                        maxLength={10000}
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Completion notes</span>

                      <textarea
                        name="completion_notes"
                        value={form.completion_notes}
                        onChange={updateField}
                        rows={3}
                        maxLength={10000}
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Checklist items</span>

                      <textarea
                        name="checklist"
                        value={form.checklist}
                        onChange={updateField}
                        rows={4}
                        placeholder="One checklist item per line"
                      />
                    </label>
                  </div>
                </section>
              )}

              {/* Allow Administrators to choose the maintenance scheduling method. */}
              {!isStandaloneEdit &&
                !isSuggestion &&
                !isSupervisor && (
                  <section className="create-schedule-section">
                    <h2>Maintenance schedule mode</h2>

                    <p className="muted">
                      Choose whether maintenance is planned by calendar,
                      machine running time, or completed usage cycles.
                    </p>

                    <label className="field">
                      <span className="field-label">Schedule mode</span>

                      <select
                        name="schedule_mode"
                        value={form.schedule_mode}
                        disabled={isEdit}
                        onChange={(event) => {
                          const value = event.target.value;

                          setForm((previous) => ({
                            ...previous,
                            schedule_mode: value,
                            signal_variable_id: "",
                          }));
                        }}
                      >
                        <option value="calendar">Calendar based</option>
                        <option value="runtime">Runtime based</option>
                        <option value="usage">Usage based</option>
                      </select>

                      {isEdit && (
                        <small className="muted">
                          Existing schedule mode cannot be changed.
                        </small>
                      )}
                    </label>
                  </section>
                )}

              {/* Configure PLC signals and maintenance intervals for runtime and usage schedules. */}
              {!isStandaloneEdit &&
                !isSuggestion &&
                !isSupervisor &&
                form.schedule_mode !== "calendar" && (
                  <section className="create-schedule-section">
                    <h2>
                      {form.schedule_mode === "runtime"
                        ? "Runtime configuration"
                        : "Usage configuration"}
                    </h2>

                    <p className="muted">
                      {form.schedule_mode === "runtime"
                        ? "Select the active Boolean running signal used to accumulate machine operating hours."
                        : "Select the active Boolean cycle signal. Each False-to-True transition counts as one completed cycle."}
                    </p>

                    <div className="create-schedule-grid">
                      {/* Select the PLC variable based on its assigned signal role. */}
                      <label className="field">
                        <span className="field-label">
                          PLC signal variable
                          <span className="req" aria-hidden="true">*</span>
                        </span>

                        <select
                          name="signal_variable_id"
                          value={form.signal_variable_id}
                          onChange={updateField}
                          required
                          disabled={scheduleConfigurationLocked}
                        >
                          <option value="">
                            {variablesLoading
                              ? "Loading variables..."
                              : "Select a PLC variable"}
                          </option>

                          {assetVariables
                            .filter(
                              (variable) =>
                                variable.signal_role ===
                                (form.schedule_mode === "runtime"
                                  ? "running"
                                  : "cycle")
                            )
                            .map((variable) => (
                              <option
                                key={variable.id}
                                value={variable.id}
                              >
                                {variable.name ||
                                  variable.display_name ||
                                  variable.variable_key ||
                                  variable.key ||
                                  `Variable ${variable.id}`}
                              </option>
                            ))}
                        </select>

                        <small className="muted">
                          Required signal role:{" "}
                          {form.schedule_mode === "runtime"
                            ? "running"
                            : "cycle"}
                        </small>

                        {variablesLoading && (
                          <small className="muted">
                            Loading asset variables...
                          </small>
                        )}

                        {variablesError && (
                          <small role="alert">
                            {variablesError}
                          </small>
                        )}
                      </label>

                      {/* Enter the maintenance threshold in hours or completed cycles. */}
                      {form.schedule_mode === "runtime" ? (
                        <label className="field">
                          <span className="field-label">
                            Maintenance interval (hours)
                            <span className="req" aria-hidden="true">*</span>
                          </span>

                          <input
                            type="number"
                            name="runtime_interval_hours"
                            min="0.01"
                            step="any"
                            value={form.runtime_interval_hours}
                            onChange={updateField}
                            required
                            disabled={scheduleConfigurationLocked}
                            placeholder="e.g. 500"
                          />
                        </label>
                      ) : (
                        <label className="field">
                          <span className="field-label">
                            Maintenance interval (cycles)
                            <span className="req" aria-hidden="true">*</span>
                          </span>

                          <input
                            type="number"
                            name="usage_interval_count"
                            min="1"
                            step="1"
                            value={form.usage_interval_count}
                            onChange={updateField}
                            required
                            disabled={scheduleConfigurationLocked}
                            placeholder="e.g. 1000"
                          />
                        </label>
                      )}
                    </div>
                    {/* Explain why runtime/usage configuration is locked. */}
                    {scheduleConfigurationLocked && (
                      <small className="muted" role="status">
                        PLC signal and maintenance interval cannot be changed while
                        a maintenance occurrence is pending or in progress.
                        </small>
                    )}
                  </section>
                )}

              {/* Configure planned start and first due dates for calendar-based schedules. */}
              {(isStandaloneEdit ||
                isSuggestion ||
                form.schedule_mode === "calendar") && (
                <section className="create-schedule-section">
                  <h2>Dates</h2>

                  <p className="muted">
                    {isSupervisor && !isSuggestion
                      ? "Supervisors may update only these schedule dates."
                      : "Select when the plan starts and when the first maintenance is due."}
                  </p>

                  <div className="create-schedule-grid">
                    <label className="field">
                      <span className="field-label">
                        {isStandaloneEdit ? "Planned start date and time" : "Schedule start date"} <span className="req" aria-hidden="true">*</span>
                      </span>

                      <input
                        type={isStandaloneEdit ? "datetime-local" : "date"}
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
                      <span className="field-label">
                        {isStandaloneEdit ? "Planned due date and time" : "First maintenance due date"} <span className="req" aria-hidden="true">*</span>
                      </span>

                      <input
                        type={isStandaloneEdit ? "datetime-local" : "date"}
                        name="first_due_date"
                        value={form.first_due_date}
                        min={form.schedule_start_date || undefined}
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
              )}

              {/* Configure automatic recurring maintenance for calendar schedules. */}
              {form.schedule_mode === "calendar" &&
                (!isSupervisor ||
                  isSuggestion ||
                  (isEdit && !isStandaloneEdit && form.recurrence_enabled)) && (
                  <section className="create-schedule-section">
                    <h2>Recurring maintenance</h2>

                    <p className="muted">
                      {isSupervisor && !isSuggestion
                        ? "Changing this interval updates the next future occurrence; completed history remains unchanged."
                        : "Automatically plan repeated maintenance when recurrence is enabled."}
                    </p>

                    {/* Enable or disable automatic recurrence. */}
                    {(!isSupervisor || isSuggestion) && (
                      <label className="field create-schedule-checkbox">
                        <input
                          type="checkbox"
                          name="recurrence_enabled"
                          checked={form.recurrence_enabled}
                          onChange={updateField}
                        />

                        Enable recurring maintenance
                      </label>
                    )}

                    {/* Set the recurrence interval and its time unit. */}
                    {form.recurrence_enabled && (
                      <div className="create-schedule-grid recurrence-grid">
                        <label className="field">
                          <span className="field-label">Repeat every</span>

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
                          <span className="field-label">Recurrence unit</span>

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
                )}

              {/* Enter maintenance instructions and attach reusable documents. */}
              {(!isSupervisor || isSuggestion) && (
                <section className="create-schedule-section">
                  <h2>Description / work details</h2>

                  <p className="muted">
                    Instructions for the maintenance team.
                  </p>

                  <label className="field">
                    <span className="field-label">Description / work details</span>

                    <textarea
                      name="description"
                      value={form.description}
                      onChange={updateField}
                      rows={3}
                      maxLength={10000}
                      placeholder="Enter maintenance instructions..."
                    />
                  </label>

                  {/* Open the reusable instructions and documents selector. */}
                  <button
                    type="button"
                    className="btn-outline create-schedule-instructions"
                    onClick={openInstructionPicker}
                    disabled={busy}
                  >
                    Add from instructions and documents
                  </button>

                  {/* Display all documents currently attached to the maintenance plan. */}
                  {selectedDocuments.length > 0 && (
                    <div className="selected-instruction-list" aria-live="polite">
                      <h3>Attached instructions and documents</h3>

                      {selectedDocuments.map((item) => (
                        <div className="selected-instruction-item" key={item.id}>
                          <span>
                            <strong>{item.title || "Untitled document"}</strong>
                            <small>{item.kind || "Document"}</small>
                          </span>

                          <button
                            type="button"
                            className="btn-outline"
                            onClick={() => setSelectedDocuments((previous) =>
                              previous.filter((selected) => selected.id !== item.id)
                            )}
                            disabled={busy}
                            aria-label={`Remove ${item.title || "document"}`}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </fieldset>

            {/* Form actions for cancelling or submitting the maintenance operation. */}
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
                disabled={
                  busy ||
                  (isSuggestion ? !isSupervisor : !canManageMaintenance) ||
                  editingBlocked
                }
                title={
                  editingBlocked
                    ? "In-progress maintenance cannot be edited."
                    : (isSuggestion ? !isSupervisor : !canManageMaintenance)
                      ? "You do not have permission to create or edit maintenance schedules."
                      : undefined
                }
              >
                {busy
                  ? isEdit
                    ? "Updating maintenance..."
                    : "Creating maintenance..."
                  : isSuggestion
                    ? "Submit suggestion"
                    : isEdit
                      ? "Save changes"
                      : "Add maintenance"}
              </button>
            </div>
          </>
        )}
      </form>

      {/* Modal for searching, selecting, and attaching instructions and documents. */}
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
            {/* Modal heading and close action. */}
            <div className="instruction-picker-header">
              <div>
                <h2 id="instruction-picker-title">
                  Instructions and documents
                </h2>

                <p className="muted">
                  Select the instructions and documents to attach to this maintenance schedule.
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

            {/* Search available documents by title, type, or description. */}
            <input
              type="search"
              value={instructionSearch}
              onChange={(event) =>
                setInstructionSearch(event.target.value)
              }
              placeholder="Search instructions and documents..."
              aria-label="Search instructions and documents"
            />

            {/* Display document loading and API error states. */}
            {instructionsLoading && (
              <LoadingIndicator compact message="Loading documents" />
            )}

            {instructionsError && (
              <div className="notice error" role="alert">
                {instructionsError}
              </div>
            )}

            {/* Display a message when no documents match the search. */}
            {!instructionsLoading &&
              !instructionsError &&
              filteredInstructions.length === 0 && (
                <p className="muted">
                  {instructions.length === 0
                    ? "No documents were returned by the API. Check the browser console and API response."
                    : "No documents match your search."}
                </p>
              )}

            {/* Render selectable document cards and their attachment information. */}
            {!instructionsLoading && (
              <div className="instruction-document-grid">
                {filteredInstructions.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`instruction-document-tile${selectedDocuments.some((selected) => selected.id === item.id) ? " selected" : ""}`}
                    onClick={() => toggleInstruction(item)}
                    aria-pressed={selectedDocuments.some((selected) => selected.id === item.id)}
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
                      attachment(s) ·{" "}
                      {selectedDocuments.some((selected) => selected.id === item.id)
                        ? "Selected"
                        : "Click to select"}
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
