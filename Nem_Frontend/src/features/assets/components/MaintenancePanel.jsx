import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../../services/api.js";
import { EmptyState, Modal } from "../../../components/common/UI.jsx";
import { formatTime } from "../../../utils/format.js";
import {
  LEGACY_RULE_CHOICES,
  legacyRulePath,
} from "../rules/monitoringRuleFlow.js";
import "./MaintenancePanel.css";

const TYPES = ["preventive", "corrective", "inspection", "unplanned"];
const STATUSES = ["planned", "in_progress", "completed", "cancelled"];
const PRIORITIES = ["low", "medium", "high", "critical"];
const RECURRENCE_UNITS = ["days", "weeks", "months", "years"];

function todayDateInput() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function displayDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function localDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formValues(record) {
  return {
    title: record?.title || "",
    maintenance_type: record?.maintenance_type || "preventive",
    status: record?.status || "planned",
    planned_start_at: localDateTime(record?.planned_start_at),
    planned_end_at: localDateTime(record?.planned_end_at),
    priority: record?.priority || "medium",
    assigned_technician: record?.assigned_technician || "",
    actual_started_at: localDateTime(record?.actual_started_at),
    actual_completed_at: localDateTime(record?.actual_completed_at),
    notes: record?.notes || "",
    completion_notes: record?.completion_notes || "",
    parts_used: record?.parts_used || "",
    checklist: (record?.checklist || []).map((item) => item.item || "").join("\n"),
    next_due_at: localDateTime(record?.next_due_at),
    alert_id: record?.alert_id ? String(record.alert_id) : "",
  };
}

function nullableDate(value) {
  return value ? new Date(value).toISOString() : null;
}

function actualDuration(record) {
  if (!record.actual_started_at || !record.actual_completed_at) return "—";
  const seconds =
    (new Date(record.actual_completed_at).getTime() -
      new Date(record.actual_started_at).getTime()) /
    1000;
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function validateForm(values, requirePlannedDates) {
  const plannedStart = new Date(values.planned_start_at);
  const plannedEnd = new Date(values.planned_end_at);
  if (requirePlannedDates || values.planned_start_at || values.planned_end_at) {
    if (
      !values.planned_start_at ||
      !values.planned_end_at ||
      Number.isNaN(plannedStart.getTime()) ||
      Number.isNaN(plannedEnd.getTime())
    ) {
      return "Planned start and end are required.";
    }
    if (plannedEnd < plannedStart) {
      return "Planned end must not be before planned start.";
    }
  }

  if (
    values.actual_started_at &&
    Number.isNaN(new Date(values.actual_started_at).getTime())
  ) {
    return "Actual start is invalid.";
  }
  if (
    values.actual_completed_at &&
    Number.isNaN(new Date(values.actual_completed_at).getTime())
  ) {
    return "Actual completion is invalid.";
  }
  if (values.actual_started_at && values.actual_completed_at) {
    const actualStart = new Date(values.actual_started_at);
    const actualEnd = new Date(values.actual_completed_at);
    if (
      Number.isNaN(actualStart.getTime()) ||
      Number.isNaN(actualEnd.getTime()) ||
      actualEnd < actualStart
    ) {
      return "Actual completion must not be before actual start.";
    }
  }
  return "";
}

export default function MaintenancePanel({ assetId, onChanged }) {
  const navigate = useNavigate();
  const [records, setRecords] = useState([]);
  const [archivedRecords, setArchivedRecords] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deletingRecordId, setDeletingRecordId] = useState(null);
  const [deletingScheduleId, setDeletingScheduleId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState(null);
  const [legacyRuleOptionsOpen, setLegacyRuleOptionsOpen] = useState(false);
  const [values, setValues] = useState(() => formValues(null));
  const [scheduleValues, setScheduleValues] = useState(null);
  const [approvalDate, setApprovalDate] = useState("");

  const archiveCompleted = async (record) => {
    if (busy) return;
    if (
      !window.confirm(
        `Move completed maintenance "${record.title}" to the archived maintenance log? The record will be retained.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.del(`/maintenance/${record.id}`);
      setNotice("Completed maintenance moved to the archived log.");
      await Promise.all([loadRecords(), loadArchivedRecords()]);
      await onChanged?.();
    } catch (requestError) {
      setError(requestError.message || "Could not archive completed maintenance.");
    } finally {
      setBusy(false);
    }
  };

  const permanentlyDeleteRecord = async (record) => {
    if (busy) return;
    const scheduled =
      Boolean(record.schedule_id) &&
      !(record.status === "completed" && record.archived_at);
    const plannedDate = record.planned_start_at
      ? formatTime(record.planned_start_at)
      : null;
    const confirmation = scheduled
      ? `Delete the entire schedule "${record.title}"${plannedDate ? `, scheduled for ${plannedDate}` : ""}, including its linked maintenance entries?`
      : `Permanently delete maintenance "${record.title}"${plannedDate ? `, scheduled for ${plannedDate}` : ""}?`;
    if (!window.confirm(confirmation)) return;
    if (
      (scheduled || (record.planned_start_at && new Date(record.planned_start_at) > new Date())) &&
      !window.confirm(
        `Confirm again: permanently delete "${record.title}"${plannedDate ? ` scheduled for ${plannedDate}` : ""}? This cannot be undone.`
      )
    ) {
      return;
    }
    setBusy(true);
    setDeletingRecordId(record.id);
    setError("");
    setNotice("");
    try {
      await api.del(`/maintenance/${record.id}/permanent`);
      setNotice("Maintenance was permanently deleted.");
      await Promise.all([loadRecords(), loadArchivedRecords(), loadSchedules()]);
      await onChanged?.();
    } catch (requestError) {
      setError(
        requestError.message || "Could not permanently delete maintenance."
      );
    } finally {
      setDeletingRecordId(null);
      setBusy(false);
    }
  };

  const permanentlyDeleteSchedule = async (schedule) => {
    if (busy) return;
    const dueDate = schedule.current_due_date
      ? displayDate(schedule.current_due_date)
      : null;
    if (!window.confirm(
      `Delete maintenance schedule "${schedule.title}"${dueDate ? `, due ${dueDate}` : ""}, including its linked maintenance entries?`
    )) return;
    if (!window.confirm(
      `Confirm again: permanently delete schedule "${schedule.title}"${dueDate ? ` due ${dueDate}` : ""}? This cannot be undone.`
    )) return;
    setBusy(true);
    setDeletingScheduleId(schedule.id);
    setError("");
    setNotice("");
    try {
      await api.del(`/maintenance/schedules/${schedule.id}/permanent`);
      setNotice("Maintenance schedule was permanently deleted.");
      await Promise.all([loadRecords(), loadArchivedRecords(), loadSchedules()]);
      await onChanged?.();
    } catch (requestError) {
      setError(
        requestError.message || "Could not permanently delete maintenance schedule."
      );
    } finally {
      setDeletingScheduleId(null);
      setBusy(false);
    }
  };

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.getAll(
        `/maintenance?asset_id=${assetId}&limit=200`
      );
      setRecords(Array.isArray(result) ? result : []);
    } catch (requestError) {
      setError(requestError.message || "Could not load maintenance records.");
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  const loadSchedules = useCallback(async () => {
    try {
      const result = await api.getAll(`/maintenance/schedules?asset_id=${assetId}`);
      setSchedules(Array.isArray(result) ? result : []);
    } catch (requestError) {
      setError(requestError.message || "Could not load maintenance schedules.");
    }
  }, [assetId]);

  const loadArchivedRecords = useCallback(async () => {
    try {
      const result = await api.getAll(
        `/maintenance?asset_id=${assetId}&include_archived=true&limit=200`
      );
      setArchivedRecords(
        Array.isArray(result) ? result.filter((record) => record.archived_at) : []
      );
    } catch (requestError) {
      setError(requestError.message || "Could not load archived maintenance.");
    }
  }, [assetId]);

  useEffect(() => {
    loadRecords();
    loadSchedules();
    loadArchivedRecords();
  }, [loadRecords, loadSchedules, loadArchivedRecords]);

  useEffect(() => {
    if (!dialog || dialog.kind === "details") return;
    setValues(formValues(dialog.record));
  }, [dialog]);

  const openCreate = () => {
    navigate(`/assets/${assetId}/maintenance/schedules/new`);
  };

  // Opens the maintenance logbook for the current asset.
 
const openMaintenanceLogbook = () => {
  navigate(`/assets/${assetId}/maintenance/logbook`);
};

const openScheduleEdit = (schedule) => {
  navigate(
    `/assets/${assetId}/maintenance/schedules/${schedule.id}/edit`
  );
};

  const openEdit = (record) => {
  if (record.schedule_id) {
    navigate(
      `/assets/${assetId}/maintenance/schedules/${record.schedule_id}/edit`
    );
    return;
  }

  setError("");
  setNotice("");
  setDialog({ kind: "edit", record });
};

  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    if (dialog.kind === "schedule-create" || dialog.kind === "schedule-edit") {
      const form = scheduleValues;
      if (!form.title.trim() || !form.schedule_start_date || !form.first_due_date) {
        setError("Title, schedule start date, and first due date are required.");
        return;
      }
      if (form.first_due_date < form.schedule_start_date) {
        setError("First due date must not precede the schedule start date.");
        return;
      }
      if (
        form.recurrence_enabled &&
        (!Number.isInteger(Number(form.recurrence_interval)) ||
          Number(form.recurrence_interval) < 1)
      ) {
        setError("Recurrence interval must be a positive whole number.");
        return;
      }
      const schedulePayload = {
        title: form.title.trim(),
        maintenance_type: form.maintenance_type,
        priority: form.priority,
        assigned_technician: form.assigned_technician.trim() || null,
        description: form.description.trim() || null,
        schedule_start_date: form.schedule_start_date,
        first_due_date: form.first_due_date,
        recurrence_enabled: form.recurrence_enabled,
        recurrence_interval: form.recurrence_enabled
          ? Number(form.recurrence_interval)
          : null,
        recurrence_unit: form.recurrence_enabled ? form.recurrence_unit : null,
        ...(dialog.kind === "schedule-edit" ? { status: form.status } : {}),
      };
      setBusy(true);
      try {
        if (dialog.kind === "schedule-create") {
          await api.post("/maintenance/schedules", {
            asset_id: Number(assetId),
            ...schedulePayload,
          });
        } else {
          await api.patch(
            `/maintenance/schedules/${dialog.record.id}`,
            schedulePayload
          );
        }
        setDialog(null);
        setNotice(
          dialog.kind === "schedule-create"
            ? "Maintenance schedule created."
            : "Maintenance schedule updated."
        );
        await Promise.all([loadSchedules(), loadRecords(), loadArchivedRecords()]);
        await onChanged?.();
      } catch (requestError) {
        setError(requestError.message || "Could not save maintenance schedule.");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!values.title.trim()) {
      setError("Maintenance title is required.");
      return;
    }
    const terminalRecord =
      dialog.kind === "edit" &&
      ["completed", "cancelled"].includes(dialog.record.status);
    const validationError = validateForm(
      values,
      dialog.kind === "create" || !terminalRecord
    );
    if (validationError) {
      setError(validationError);
      return;
    }

    const checklist = values.checklist
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ({ item, completed: false }));
    const payload = {
      title: values.title.trim(),
      maintenance_type: values.maintenance_type,
      status: values.status,
      planned_start_at: nullableDate(values.planned_start_at),
      planned_end_at: nullableDate(values.planned_end_at),
      priority: values.priority,
      assigned_technician: values.assigned_technician.trim() || null,
      actual_started_at: nullableDate(values.actual_started_at),
      actual_completed_at:
        nullableDate(values.actual_completed_at) ||
        (dialog.kind === "create" && values.status === "completed"
          ? new Date().toISOString()
          : null),
      notes: values.notes.trim() || null,
      completion_notes: values.completion_notes.trim() || null,
      parts_used: values.parts_used.trim() || null,
      checklist: checklist.length ? checklist : null,
      next_due_at: nullableDate(values.next_due_at),
      alert_id: values.alert_id ? Number(values.alert_id) : null,
    };

    setBusy(true);
    try {
      await api.patch(`/maintenance/${dialog.record.id}`, payload);
      setDialog(null);
      setNotice("Maintenance job updated.");
      await Promise.all([loadRecords(), loadArchivedRecords()]);
      await onChanged?.();
    } catch (requestError) {
      setError(requestError.message || "Could not save maintenance.");
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (record, action) => {
    if (busy) return;
    if (
      action === "cancel" &&
      !window.confirm(`Cancel maintenance "${record.title}"? Its history will be retained.`)
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.post(`/maintenance/${record.id}/${action}`);
      const labels = {
        start: "Maintenance started.",
        complete: "Maintenance completed.",
        cancel: "Maintenance cancelled.",
      };
      setNotice(labels[action]);
      await Promise.all([loadRecords(), loadSchedules(), loadArchivedRecords()]);
      await onChanged?.();
      if (action === "complete" && result.schedule_id) {
        const schedule = await api.get(
          `/maintenance/schedules/${result.schedule_id}`
        );
        if (schedule.approval_status === "pending") {
          setApprovalDate(schedule.proposed_due_date);
          setDialog({ kind: "approval", record: schedule });
        }
      }
    } catch (requestError) {
      setError(requestError.message || `Could not ${action} maintenance.`);
    } finally {
      setBusy(false);
    }
  };

  const updateValue = (event) => {
    const { name, value } = event.target;
    setValues((previous) => ({ ...previous, [name]: value }));
  };
  const updateScheduleValue = (event) => {
    const { name, value, checked, type } = event.target;
    setScheduleValues((previous) => ({
      ...previous,
      [name]: type === "checkbox" ? checked : value,
    }));
  };
  const confirmNextOccurrence = async (schedule, dueDate) => {
    if (busy) return;
    if (!dueDate) {
      setError("Choose a due date before confirming the next occurrence.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.post(`/maintenance/schedules/${schedule.id}/confirm-next`, {
        due_date: dueDate,
      });
      setDialog(null);
      setNotice(`Next maintenance approved for ${displayDate(dueDate)}.`);
      await Promise.all([loadSchedules(), loadRecords()]);
    } catch (requestError) {
      setError(requestError.message || "Could not approve the next occurrence.");
    } finally {
      setBusy(false);
    }
  };
  const declineNextOccurrence = async (schedule) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.post(`/maintenance/schedules/${schedule.id}/decline-next`);
      setDialog(null);
      setNotice("No next maintenance occurrence was scheduled.");
      await loadSchedules();
    } catch (requestError) {
      setError(requestError.message || "Could not decline the next occurrence.");
    } finally {
      setBusy(false);
    }
  };
  const changeScheduleStatus = async (schedule, status) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.patch(`/maintenance/schedules/${schedule.id}`, { status });
      setNotice(status === "paused" ? "Recurrence paused." : "Recurrence resumed.");
      await loadSchedules();
    } catch (requestError) {
      setError(requestError.message || "Could not update recurrence status.");
    } finally {
      setBusy(false);
    }
  };
  const terminalEdit =
    dialog?.kind === "edit" &&
    ["completed", "cancelled"].includes(dialog.record.status);
  const plannedDatesRequired =
    dialog?.kind === "create" ||
    (dialog?.kind === "edit" && !terminalEdit);

  return (
    <>
      <section className="panel maintenance-panel">
        <div className="panel-head maintenance-heading">
          <div>
            <h2>Maintenance management</h2>
            <p className="muted">
              Schedule, track and review work for this asset.
            </p>
          </div>
          <div className="maintenance-heading-actions">
            <button
              type="button"
              className="btn-outline"
              onClick={() => setLegacyRuleOptionsOpen(true)}
              disabled={busy}
            >
              Other rule workflows
            </button>
            <button
  type="button"
  className="btn-primary"
  onClick={openMaintenanceLogbook}
  disabled={busy}
>
  View Maintenance Logbook
</button>
            <button
              type="button"
              className="btn-primary"
              onClick={openCreate}
              disabled={busy}
            >
              Add Maintenance
            </button>
          </div>
        </div>

        {error && <p className="notice error" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {loading ? (
          <p className="muted" role="status">Loading maintenance history…</p>
        ) : records.length === 0 ? (
          <EmptyState
            art={false}
            title="No maintenance jobs"
            lines={["Create a job to start tracking planned and completed work."]}
          />
        ) : (
          <div className="maintenance-table-wrap">
            <table className="table maintenance-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Planned</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Technician</th>
                  <th>Actual duration</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td>{record.title}</td>
                    <td className="capitalize">{record.maintenance_type}</td>
                    <td>
                      {record.planned_start_at ? formatTime(record.planned_start_at) : "—"}
                      <span className="maintenance-end">
                        {record.planned_end_at ? formatTime(record.planned_end_at) : "—"}
                      </span>
                    </td>
                    <td><span className={`maintenance-status ${record.status}`}>{record.status.replace("_", " ")}</span></td>
                    <td className="capitalize">{record.priority}</td>
                    <td>{record.assigned_technician || record.performed_by || "—"}</td>
                    <td>{actualDuration(record)}</td>
                    <td>
                      <div className="maintenance-actions">
                        <button type="button" className="btn-outline" onClick={() => setDialog({ kind: "details", record })}>View Details</button>
                        {record.status === "completed" ? (
                          <>
                            <button type="button" className="btn-danger" onClick={() => archiveCompleted(record)} disabled={busy}>Archive</button>
                            <button type="button" className="btn-danger" onClick={() => permanentlyDeleteRecord(record)} disabled={busy}>
                              {deletingRecordId === record.id ? "Deleting…" : "Delete permanently"}
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="btn-outline" onClick={() => openEdit(record)} disabled={busy}>Edit</button>
                            {record.status !== "in_progress" && (
                              <button type="button" className="btn-danger" onClick={() => permanentlyDeleteRecord(record)} disabled={busy}>
                                {deletingRecordId === record.id ? "Deleting…" : record.schedule_id ? "Delete schedule" : "Delete permanently"}
                              </button>
                            )}
                          </>
                        )}
                        {record.status === "planned" && (
                          <button type="button" className="btn-outline" onClick={() => runAction(record, "start")} disabled={busy}>Start</button>
                        )}
                        {!["completed", "cancelled"].includes(record.status) && (
                          <>
                            <button type="button" className="btn-primary" onClick={() => runAction(record, "complete")} disabled={busy}>Complete</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && archivedRecords.length > 0 && (
          <div className="maintenance-schedules">
            <h3>Archived maintenance log</h3>
            <p className="muted">
              Archived records remain stored for maintenance history and audit purposes.
            </p>
            <div className="maintenance-table-wrap">
              <table className="table maintenance-table">
                <thead>
                  <tr><th>Title</th><th>Type</th><th>Due date</th><th>Completed</th><th>Archived</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {archivedRecords.map((record) => (
                    <tr key={record.id}>
                      <td>{record.title}</td>
                      <td className="capitalize">{record.maintenance_type}</td>
                      <td>{displayDate(record.planned_due_date)}</td>
                      <td>{record.actual_completed_at ? formatTime(record.actual_completed_at) : "—"}</td>
                      <td>{formatTime(record.archived_at)}</td>
                      <td>
                        <button type="button" className="btn-danger" onClick={() => permanentlyDeleteRecord(record)} disabled={busy}>
                          {deletingRecordId === record.id ? "Deleting…" : "Delete permanently"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && schedules.length > 0 && (
          <div className="maintenance-schedules">
            <h3>Maintenance schedules</h3>
            <div className="maintenance-table-wrap">
              <table className="table maintenance-table">
                <thead>
                  <tr>
                    <th>Schedule</th><th>Recurrence</th><th>Current due</th><th>Day count (elapsed / total)</th><th>Due state</th><th>Last completed</th><th>Next proposed</th><th>Approval</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((schedule) => (
                    <tr key={schedule.id}>
                      <td>{schedule.title}</td>
                      <td>{schedule.recurrence_enabled ? `Every ${schedule.recurrence_interval} ${schedule.recurrence_unit}` : "One-time"}</td>
                      <td>{displayDate(schedule.current_due_date)}</td>
                      <td>{schedule.current_day_count}/{schedule.total_days}</td>
                      <td><span className={`maintenance-status ${schedule.due_status}`}>{schedule.due_status.replaceAll("_", " ")}</span></td>
                      <td>{schedule.last_completed_at ? formatTime(schedule.last_completed_at) : "—"}</td>
                      <td>{displayDate(schedule.proposed_due_date)}</td>
                      <td>{schedule.approval_status.replaceAll("_", " ")}</td>
                      <td>
                        <div className="maintenance-actions">
                          <button type="button" className="btn-outline" onClick={() => setDialog({ kind: "schedule-details", record: schedule })} disabled={busy}>View schedule</button>
                          <button type="button" className="btn-outline" onClick={() => openScheduleEdit(schedule)} disabled={busy}>Edit schedule</button>
                          <button type="button" className="btn-danger" onClick={() => permanentlyDeleteSchedule(schedule)} disabled={busy}>
                            {deletingScheduleId === schedule.id ? "Deleting…" : "Delete schedule"}
                          </button>
                          {schedule.approval_status === "pending" && (
                            <>
                              <button type="button" className="btn-primary" onClick={() => { setApprovalDate(schedule.proposed_due_date); setDialog({ kind: "approval", record: schedule }); }} disabled={busy}>Review next date</button>
                              <button type="button" className="btn-outline" onClick={() => { setApprovalDate(schedule.proposed_due_date); setDialog({ kind: "approval", record: schedule }); }} disabled={busy}>Change date</button>
                              <button type="button" className="btn-danger" onClick={() => declineNextOccurrence(schedule)} disabled={busy}>Do not schedule</button>
                            </>
                          )}
                          {schedule.recurrence_enabled && schedule.status === "active" && (
                            <button
                            type="button"
                            className="btn-outline"
                            onClick={() => changeScheduleStatus(schedule, "paused")}
                            disabled={busy}
                            >Pause recurrence</button>)}
                          {schedule.recurrence_enabled && schedule.status === "paused" && (
                            <button type="button" className="btn-outline" onClick={() => changeScheduleStatus(schedule, "active")} disabled={busy}>Resume recurrence</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {(dialog?.kind === "schedule-create" || dialog?.kind === "schedule-edit") && (
        <Modal title={dialog.kind === "schedule-create" ? "Add maintenance schedule" : "Edit maintenance schedule"} onClose={() => { if (!busy) setDialog(null); }} wide>
          <form className="maintenance-form" onSubmit={save}>
            {error && <p className="notice error" role="alert">{error}</p>}
            <div className="maintenance-form-grid">
              <label className="field">Maintenance title <span className="req">*</span>
                <input name="title" value={scheduleValues.title} onChange={updateScheduleValue} maxLength={200} required disabled={busy} />
              </label>
              <label className="field">Maintenance type
                <select name="maintenance_type" value={scheduleValues.maintenance_type} onChange={updateScheduleValue} disabled={busy}>
                  {TYPES.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
                </select>
              </label>
              <label className="field">Priority
                <select name="priority" value={scheduleValues.priority} onChange={updateScheduleValue} disabled={busy}>
                  {PRIORITIES.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
                </select>
              </label>
              <label className="field">Assigned technician
                <input name="assigned_technician" value={scheduleValues.assigned_technician} onChange={updateScheduleValue} maxLength={200} disabled={busy} />
              </label>
              <label className="field">Schedule start date <span className="req">*</span>
                <input type="date" name="schedule_start_date" value={scheduleValues.schedule_start_date} onChange={updateScheduleValue} required disabled={busy} />
                <small className="muted">The date this maintenance plan becomes effective.</small>
              </label>
              <label className="field">First maintenance due date <span className="req">*</span>
                <input type="date" name="first_due_date" value={scheduleValues.first_due_date} onChange={updateScheduleValue} required disabled={busy} />
                <small className="muted">The date by which the first maintenance occurrence must be completed.</small>
              </label>
              {dialog.kind === "schedule-edit" && (
                <label className="field">Schedule status
                  <select name="status" value={scheduleValues.status} onChange={updateScheduleValue} disabled={busy}>
                    {["active", "paused", "cancelled", "completed"].map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
                  </select>
                </label>
              )}
              <label className="field maintenance-checkbox">
                <input type="checkbox" name="recurrence_enabled" checked={scheduleValues.recurrence_enabled} onChange={updateScheduleValue} disabled={busy} />
                Enable recurring maintenance
              </label>
              {scheduleValues.recurrence_enabled && (
                <>
                  <label className="field">Repeat every
                    <input type="number" name="recurrence_interval" min="1" max="3650" step="1" value={scheduleValues.recurrence_interval} onChange={updateScheduleValue} required disabled={busy} />
                  </label>
                  <label className="field">Recurrence unit
                    <select name="recurrence_unit" value={scheduleValues.recurrence_unit} onChange={updateScheduleValue} disabled={busy}>
                      {RECURRENCE_UNITS.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
                    </select>
                  </label>
                </>
              )}
              <label className="field maintenance-form-wide">Description / work details
                <textarea name="description" value={scheduleValues.description} onChange={updateScheduleValue} rows={3} maxLength={10000} disabled={busy} />
              </label>
            </div>
            {error && <p className="notice error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-outline" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : dialog.kind === "schedule-create" ? "Create schedule" : "Save schedule"}</button>
            </div>
          </form>
        </Modal>
      )}

      {dialog?.kind === "schedule-details" && (
        <Modal
          title="Maintenance schedule"
          onClose={() => setDialog(null)}
          wide
        >
          <div className="schedule-details-view">
            <div className="schedule-details-banner">
              <div>
                <span className="schedule-details-eyebrow">
                  MAINTENANCE PLAN
                </span>
                <h3>{dialog.record.title}</h3>
                <p>Schedule information and maintenance progress</p>
              </div>

              <span
                className={`schedule-detail-pill ${
                  dialog.record.status === "active"
                    ? "is-active"
                    : dialog.record.status === "paused"
                      ? "is-paused"
                      : ""
                }`}
              >
                {dialog.record.status.replaceAll("_", " ")}
              </span>
            </div>

            <div className="schedule-details-grid">
              <div className="schedule-detail-card">
                <span className="schedule-detail-label">
                  Schedule start
                </span>
                <strong>
                  {displayDate(dialog.record.schedule_start_date)}
                </strong>
              </div>

              <div className="schedule-detail-card">
                <span className="schedule-detail-label">
                  First due date
                </span>
                <strong>
                  {displayDate(dialog.record.first_due_date)}
                </strong>
              </div>

              <div className="schedule-detail-card schedule-detail-highlight">
                <span className="schedule-detail-label">
                  Current due date
                </span>
                <strong>
                  {displayDate(dialog.record.current_due_date)}
                </strong>
              </div>

              <div className="schedule-detail-card">
                <span className="schedule-detail-label">
                  Recurrence
                </span>
                <strong>
                  {dialog.record.recurrence_enabled
                    ? `Every ${dialog.record.recurrence_interval} ${dialog.record.recurrence_unit}`
                    : "One-time"}
                </strong>
              </div>

              <div className="schedule-detail-card">
                <span className="schedule-detail-label">
                  Due state
                </span>
                <span
                  className={`schedule-detail-pill due-${dialog.record.due_status}`}
                >
                  {dialog.record.due_status.replaceAll("_", " ")}
                </span>
              </div>

              <div className="schedule-detail-card">
                <span className="schedule-detail-label">
                  Approval
                </span>
                <span
                  className={`schedule-detail-pill approval-${dialog.record.approval_status}`}
                >
                  {dialog.record.approval_status.replaceAll("_", " ")}
                </span>
              </div>

              <div className="schedule-detail-card">
                <span className="schedule-detail-label">
                  Proposed next due date
                </span>
                <strong>
                  {displayDate(dialog.record.proposed_due_date)}
                </strong>
              </div>

              <div className="schedule-detail-card">
                <span className="schedule-detail-label">
                  Last completed
                </span>
                <strong>
                  {dialog.record.last_completed_at
                    ? formatTime(dialog.record.last_completed_at)
                    : "—"}
                </strong>
              </div>

              <div className="schedule-detail-card">
                <span className="schedule-detail-label">
                  Assigned technician
                </span>
                <strong>
                  {dialog.record.assigned_technician || "—"}
                </strong>
              </div>

              <div className="schedule-detail-card schedule-detail-description">
                <span className="schedule-detail-label">
                  Description
                </span>
                <p>
                  {dialog.record.description || "No description provided."}
                </p>
              </div>
            </div>

            <div className="schedule-details-footer">
              <button
                type="button"
                className="btn-outline"
                onClick={() => setDialog(null)}
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}

      {dialog?.kind === "approval" && (
        <Modal title="Maintenance completed" onClose={() => { if (!busy) setDialog(null); }}>
          {error && <p className="notice error" role="alert">{error}</p>}
          <p>The previous maintenance was due on <strong>{displayDate(dialog.record.current_due_date)}</strong>.</p>
          <p>
            Based on the existing schedule
            {dialog.record.recurrence_interval ? ` (every ${dialog.record.recurrence_interval} ${dialog.record.recurrence_unit})` : ""},
            the next maintenance is proposed for{" "}
            <strong>{displayDate(dialog.record.proposed_due_date)}</strong>.
          </p>
          <p>
            Confirm the next occurrence for{" "}
            <strong>{displayDate(approvalDate || dialog.record.proposed_due_date)}</strong>
            {dialog.record.recurrence_interval ? ` with a recurrence of every ${dialog.record.recurrence_interval} ${dialog.record.recurrence_unit}.` : "."}
          </p>
          <label className="field">Confirmed next due date
            <input type="date" value={approvalDate} min={dialog.record.schedule_start_date} onChange={(event) => setApprovalDate(event.target.value)} disabled={busy} />
          </label>
          <p className="muted">Review the date and interval before approving the next occurrence.</p>
          <div className="modal-actions">
            <button type="button" className="btn-danger" onClick={() => declineNextOccurrence(dialog.record)} disabled={busy}>Do not schedule</button>
            <button type="button" className="btn-primary" onClick={() => confirmNextOccurrence(dialog.record, approvalDate)} disabled={busy}>Confirm date</button>
          </div>
        </Modal>
      )}

      

{dialog?.kind === "details" && (
  <Modal
    title="Maintenance details"
    onClose={() => setDialog(null)}
    wide
  >
    <div className="maintenance-details-view">
      <div className="maintenance-details-banner">
        <div>
          <span className="maintenance-details-eyebrow">
            MAINTENANCE RECORD
          </span>
          <h3>{dialog.record.title || "Maintenance details"}</h3>
          <p>Work summary and maintenance information</p>
        </div>
        <span className="maintenance-details-status">
          {dialog.record.status || "—"}
        </span>
      </div>

      <div className="maintenance-details-grid">
        <div className="maintenance-detail-card">
          <span>Type / Status / Priority</span>
          <strong>
            {[
              dialog.record.maintenance_type,
              dialog.record.status,
              dialog.record.priority,
            ].filter(Boolean).join(" / ") || "—"}
          </strong>
        </div>

        <div className="maintenance-detail-card">
          <span>Planned start / end</span>
          <strong>
            {dialog.record.planned_start_at
              ? formatTime(dialog.record.planned_start_at)
              : "—"}
            {" – "}
            {dialog.record.planned_end_at
              ? formatTime(dialog.record.planned_end_at)
              : "—"}
          </strong>
        </div>

        <div className="maintenance-detail-card">
          <span>Actual start / completion</span>
          <strong>
            {dialog.record.actual_started_at
              ? formatTime(dialog.record.actual_started_at)
              : "—"}
            {" – "}
            {dialog.record.actual_completed_at
              ? formatTime(dialog.record.actual_completed_at)
              : "—"}
          </strong>
        </div>

        <div className="maintenance-detail-card">
          <span>Assigned technician</span>
          <strong>
            {dialog.record.assigned_technician ||
              dialog.record.performed_by ||
              "—"}
          </strong>
        </div>

        <div className="maintenance-detail-card maintenance-detail-wide">
          <span>Description / work details</span>
          <p>{dialog.record.notes || "—"}</p>
        </div>

        <div className="maintenance-detail-card maintenance-detail-wide">
          <span>Completion notes</span>
          <p>{dialog.record.completion_notes || "—"}</p>
        </div>

        <div className="maintenance-detail-card">
          <span>Parts used</span>
          <p>{dialog.record.parts_used || "—"}</p>
        </div>

        <div className="maintenance-detail-card">
          <span>Next maintenance</span>
          <strong>
            {dialog.record.next_due_at
              ? formatTime(dialog.record.next_due_at)
              : "—"}
          </strong>
        </div>

        <div className="maintenance-detail-card">
          <span>Related alert</span>
          <strong>{dialog.record.alert_id || "—"}</strong>
        </div>

        <div className="maintenance-detail-card maintenance-detail-wide">
          <span>Checklist</span>
          <div>
            {Array.isArray(dialog.record.checklist)
              ? dialog.record.checklist.length
                ? dialog.record.checklist.map((item, index) => (
                    <p key={index}>
                      {typeof item === "string"
                        ? item
                        : item.item || item.label || item.title || "—"}
                      {typeof item === "object" && item?.completed
                        ? " ✓"
                        : ""}
                    </p>
                  ))
                : "—"
              : dialog.record.checklist || "—"}
          </div>
        </div>
      </div>

      <div className="maintenance-details-footer">
        <button
          type="button"
          className="btn-outline"
          onClick={() => setDialog(null)}
        >
          Close
        </button>
      </div>
    </div>
  </Modal>
)}

      {dialog?.kind === "edit" && (
        <Modal title="Edit maintenance" onClose={() => { if (!busy) setDialog(null); }} wide>
          <form className="maintenance-form" onSubmit={save}>
            {error && <p className="notice error" role="alert">{error}</p>}
            <div className="maintenance-form-grid">
              <label className="field">Title <span className="req">*</span>
                <input name="title" value={values.title} onChange={updateValue} required maxLength={200} disabled={busy} />
              </label>
              <label className="field">Type <span className="req">*</span>
                <select name="maintenance_type" value={values.maintenance_type} onChange={updateValue} required disabled={busy}>
                  {TYPES.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
                </select>
              </label>
              {dialog.kind === "create" && (
               <label className="field">Status <span className="req">*</span>
               <select
               name="status"
               value={values.status}
               onChange={updateValue}
               required
               disabled={busy}>
                {STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {item.replace("_", " ")}
                    </option>
                  ))}
                  </select>
                  </label>
              )}
              <label className="field">Priority <span className="req">*</span>
                <select name="priority" value={values.priority} onChange={updateValue} required disabled={busy}>
                  {PRIORITIES.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
                </select>
              </label>
              <label className="field">Planned start {plannedDatesRequired && <span className="req">*</span>}
                <input type="datetime-local" name="planned_start_at" value={values.planned_start_at} onChange={updateValue} required={plannedDatesRequired} disabled={busy} />
              </label>
              <label className="field">Planned end {plannedDatesRequired && <span className="req">*</span>}
                <input type="datetime-local" name="planned_end_at" value={values.planned_end_at} onChange={updateValue} required={plannedDatesRequired} disabled={busy} />
              </label>
              <label className="field">Assigned technician
                <input name="assigned_technician" value={values.assigned_technician} onChange={updateValue} maxLength={200} disabled={busy} />
              </label>
              <label className="field">Related alert ID
                <input type="number" min="1" name="alert_id" value={values.alert_id} onChange={updateValue} disabled={busy} />
              </label>
              <label className="field">Actual start
                <input type="datetime-local" name="actual_started_at" value={values.actual_started_at} onChange={updateValue} disabled={busy} />
              </label>
              <label className="field">Actual completion
                <input type="datetime-local" name="actual_completed_at" value={values.actual_completed_at} onChange={updateValue} disabled={busy} />
              </label>
              <label className="field">Next maintenance date
                <input type="datetime-local" name="next_due_at" value={values.next_due_at} onChange={updateValue} disabled={busy} />
              </label>
              <label className="field">Parts replaced or used
                <textarea name="parts_used" value={values.parts_used} onChange={updateValue} rows={2} disabled={busy} />
              </label>
              <label className="field maintenance-form-wide">Description / work details
                <textarea name="notes" value={values.notes} onChange={updateValue} rows={3} maxLength={10000} disabled={busy} />
              </label>
              <label className="field maintenance-form-wide">Completion notes
                <textarea name="completion_notes" value={values.completion_notes} onChange={updateValue} rows={3} disabled={busy} />
              </label>
              <label className="field maintenance-form-wide">Checklist (one item per line)
                <textarea name="checklist" value={values.checklist} onChange={updateValue} rows={3} disabled={busy} />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-outline" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : dialog.kind === "create" ? "Create maintenance" : "Save changes"}</button>
            </div>
          </form>
        </Modal>
      )}

      {legacyRuleOptionsOpen && (
        <Modal title="Additional asset rule workflows" onClose={() => setLegacyRuleOptionsOpen(false)}>
          <div className="rule-type-options">
            {LEGACY_RULE_CHOICES.map((choice) => (
              <button
                key={choice.kind}
                type="button"
                className="rule-type-option"
                onClick={() => {
                  setLegacyRuleOptionsOpen(false);
                  navigate(legacyRulePath(assetId, choice.kind));
                }}
              >
                <strong>{choice.label}</strong>
                <small>{choice.description}</small>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}