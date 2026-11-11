import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  CalendarDays,
  ClipboardCheck,
  Eye,
  FileText,
  Pause,
  Pencil,
  Play,
  Timer,
  Trash2,
} from "lucide-react";
import { api, getAuthToken } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { captureNavigationOrigin } from "../../../utils/navigation.js";
import {
  EmptyState,
  FloatingMenu,
  LoadingIndicator,
  Modal,
  useConfirmation,
} from "../../../components/common/UI.jsx";
import { DotsIcon } from "../../../components/common/Icons.jsx";
import { auditUser, formatAuditTime, formatTime } from "../../../utils/format.js";
import MaintenanceDetails from "./MaintenanceDetails.jsx";
import {
  LEGACY_RULE_CHOICES,
  legacyRulePath,
} from "../rules/monitoringRuleFlow.js";
import "./MaintenancePanel.css";

const API_BASE = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/+$/, "");
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

// "Overdue by 3 days" / "Due today" / "Due in 12 days" for a YYYY-MM-DD due date.
function dueLabel(value) {
  if (!value) return "";
  const due = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(due.getTime())) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86_400_000);
  if (days < 0) return `Overdue by ${-days} ${-days === 1 ? "day" : "days"}`;
  if (days === 0) return "Due today";
  return `Due in ${days} ${days === 1 ? "day" : "days"}`;
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

function actualDuration(record, now = Date.now()) {
  if (!record.actual_started_at) return "—";
  const endTime = record.actual_completed_at
    ? new Date(record.actual_completed_at).getTime()
    : now;
  const seconds = (endTime - new Date(record.actual_started_at).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function plannedDurationDays(record) {
  if (!record.planned_start_at || !record.planned_end_at) {
    return "—";
  }

  const start = new Date(record.planned_start_at);
  const end = new Date(record.planned_end_at);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return "—";
  }

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const days = Math.ceil((end - start) / millisecondsPerDay);

  return `${days} ${days === 1 ? "day" : "days"}`;
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

export default function MaintenancePanel({
  assetId,
  onChanged,
  onActionNotification,
  navigationState,
}) {
  const confirm = useConfirmation();
  const { user } = useAuth();
  const isAdministrator = user?.role === "Administrator";
  const isSupervisor = user?.role === "Supervisor";
  const canAddMaintenance = user?.role === "Administrator";
  const canManageMaintenance = ["Administrator", "Supervisor"].includes(user?.role);
  const navigate = useNavigate();
  const location = useLocation();
  const [records, setRecords] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);
  const [activeMaintenanceTab, setActiveMaintenanceTab] = useState("schedules");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState(null);
  const [materialViewer, setMaterialViewer] = useState(null);
  const [materialError, setMaterialError] = useState("");
  const [actionMenuRecordId, setActionMenuRecordId] = useState(null);
  const actionMenuTriggerRef = useRef(null);
  const startRequestRef = useRef(false);
  const [legacyRuleOptionsOpen, setLegacyRuleOptionsOpen] = useState(false);
  const [values, setValues] = useState(() => formValues(null));
  const [scheduleValues, setScheduleValues] = useState({
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
    status: "active",
  });
  const [approvalDate, setApprovalDate] = useState("");
  const [clockNow, setClockNow] = useState(Date.now());

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.getAll(`/maintenance?asset_id=${assetId}&limit=200`);
      setRecords(Array.isArray(result) ? result : []);
    } catch (requestError) {
      setError(requestError.message || "Could not load maintenance records.");
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  const loadSchedules = useCallback(async () => {
    setSchedulesLoaded(false);
    try {
      const result = await api.getAll(`/maintenance/schedules?asset_id=${assetId}`);
      setSchedules(Array.isArray(result) ? result : []);
    } catch (requestError) {
      setError(requestError.message || "Could not load maintenance schedules.");
    } finally {
      setSchedulesLoaded(true);
    }
  }, [assetId]);

  // One delete at a time, including while the confirmation dialog is open.
  const deleteGuard = useRef(false);

  const runPermanentDeleteRecord = async (record) => {
    if (!isAdministrator || busy) return;
    const confirmed = await confirm(
      record.status === "planned" && record.schedule_id != null
        ? "Permanently delete this maintenance? Its recurring schedule, all of its maintenance records and history, and its active notifications will be deleted. This action cannot be undone."
        : "Are you sure you want to delete this maintenance? This action cannot be undone.",
      {
        title: "Delete Maintenance?",
        confirmLabel: "Delete Maintenance",
        destructive: true,
      }
    );
    if (!confirmed) return;

    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.del(`/maintenance/${record.id}`);
      setNotice("Maintenance was permanently deleted.");
      await Promise.all([loadRecords(), loadSchedules()]);
      await onChanged?.();
    } catch (requestError) {
      setError(requestError.message || "Could not permanently delete maintenance.");
    } finally {
      setBusy(false);
    }
  };

  const permanentlyDeleteRecord = async (record) => {
    if (deleteGuard.current) return;
    deleteGuard.current = true;
    try {
      await runPermanentDeleteRecord(record);
    } finally {
      deleteGuard.current = false;
    }
  };

  useEffect(() => {
    loadRecords();
    loadSchedules();
  }, [loadRecords, loadSchedules]);

  useEffect(() => {
    const timerIsRunning = records.some((record) => record.status === "in_progress");
    if (!timerIsRunning) return undefined;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [records]);

  useEffect(() => {
    const previewUrl = materialViewer?.previewUrl;
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [materialViewer?.previewUrl]);

  useEffect(() => {
    if (actionMenuRecordId === null) return undefined;

    const handlePointerDown = (event) => {
      if (!(event.target instanceof Element)) return;
      if (
        actionMenuTriggerRef.current?.contains(event.target) ||
        event.target.closest("[data-maintenance-action-menu]")
      ) {
        return;
      }
      setActionMenuRecordId(null);
    };
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      setActionMenuRecordId(null);
      actionMenuTriggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionMenuRecordId]);

  // Fill the forms whenever a form dialog opens.
  useEffect(() => {
    if (!dialog) return;

    if (dialog.kind === "schedule-create" || dialog.kind === "schedule-edit") {
      const record = dialog.record;

      setScheduleValues({
        title: record?.title || "",
        maintenance_type: record?.maintenance_type || "preventive",
        priority: record?.priority || "medium",
        assigned_technician: record?.assigned_technician || "",
        description: record?.description || "",
        schedule_start_date: record?.schedule_start_date
          ? String(record.schedule_start_date).slice(0, 10)
          : todayDateInput(),
        first_due_date: record?.first_due_date
          ? String(record.first_due_date).slice(0, 10)
          : "",
        recurrence_enabled:
          record?.recurrence_enabled == null ? true : Boolean(record.recurrence_enabled),
        recurrence_interval: String(record?.recurrence_interval ?? 1),
        recurrence_unit: record?.recurrence_unit || "months",
        status: record?.status || "active",
      });
      return;
    }

    // A new maintenance job starts from empty defaults; an edit starts from its record.
    if (dialog.kind === "create" || dialog.kind === "edit") {
      setValues(formValues(dialog.record));
    }
  }, [dialog]);

  const openCreate = () => {
    if (!canManageMaintenance) return;
    navigate(`/assets/${assetId}/maintenance/schedules/new`, {
      state: {
        from: captureNavigationOrigin(location, {
          ...(navigationState || location.state),
          activeTab: "logbook",
        }),
      },
    });
  };

  const openEdit = (record) => {
    if (!canManageMaintenance) return;

    setError("");
    setNotice("");

    const from = captureNavigationOrigin(location, {
      ...(navigationState || location.state),
      activeTab: "logbook",
    });

    if (record.schedule_id) {
      navigate(
        `/assets/${assetId}/maintenance/schedules/${record.schedule_id}/edit`,
        { state: { from, maintenanceRecord: record } }
      );
      return;
    }

    navigate(`/assets/${assetId}/maintenance/${record.id}/edit`, {
      state: { from, maintenanceRecord: record },
    });
  };

  const openScheduleEdit = (schedule) => {
    if (!canManageMaintenance) return;
    setError("");
    setNotice("");
    navigate(`/assets/${assetId}/maintenance/schedules/${schedule.id}/edit`, {
      state: {
        from: captureNavigationOrigin(location, {
          ...(navigationState || location.state),
          activeTab: "logbook",
        }),
        maintenanceRecord: records.find((record) => record.schedule_id === schedule.id),
      },
    });
  };

  const save = async (event) => {
    event.preventDefault();
    if (!canManageMaintenance || busy) return;
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
          setNotice("Maintenance schedule created.");
        } else {
          await api.patch(`/maintenance/schedules/${dialog.record.id}`, schedulePayload);
          setNotice("Maintenance schedule updated.");
        }

        setDialog(null);
        await Promise.all([loadSchedules(), loadRecords()]);
        await onChanged?.();
      } catch (requestError) {
        setError(requestError.message || "Could not save maintenance schedule.");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!isSupervisor && !values.notes.trim()) {
      setError("Please enter notes for the maintenance job.");
      return;
    }

    const terminalRecord =
      dialog.kind === "edit" &&
      ["completed", "cancelled"].includes(dialog.record.status);
    const validationValues = isSupervisor
      ? { ...values, actual_started_at: "", actual_completed_at: "" }
      : values;
    const validationError = validateForm(
      validationValues,
      dialog.kind === "create" || !terminalRecord
    );
    if (validationError) {
      setError(validationError);
      return;
    }

    // Keep the "completed" flag of checklist items that already existed.
    const completedByText = new Map(
      (dialog.kind === "edit" ? dialog.record.checklist || [] : []).map((item) => [
        item.item,
        Boolean(item.completed),
      ])
    );
    const checklist = values.checklist
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ({ item, completed: completedByText.get(item) ?? false }));

    const payload = isSupervisor
      ? {
          planned_start_at: nullableDate(values.planned_start_at),
          planned_end_at: nullableDate(values.planned_end_at),
        }
      : {
          title: values.title.trim(),
          maintenance_type: values.maintenance_type,
          planned_start_at: nullableDate(values.planned_start_at),
          planned_end_at: nullableDate(values.planned_end_at),
          ...(dialog.kind === "create" ? { status: values.status } : {}),
          priority: values.priority,
          assigned_technician: values.assigned_technician.trim() || null,
          actual_started_at: nullableDate(values.actual_started_at),
          actual_completed_at:
            nullableDate(values.actual_completed_at) ||
            (dialog.kind === "create" && values.status === "completed"
              ? new Date().toISOString()
              : null),
          notes: values.notes.trim(),
          completion_notes: values.completion_notes.trim() || null,
          parts_used: values.parts_used.trim() || null,
          checklist: checklist.length ? checklist : null,
          next_due_at: nullableDate(values.next_due_at),
          ...(values.alert_id.trim() ? { alert_id: Number(values.alert_id) } : {}),
        };

    setBusy(true);
    try {
      if (dialog.kind === "create") {
        await api.post("/maintenance", {
          asset_id: Number(assetId),
          ...payload,
        });
        setNotice("Maintenance job created.");
      } else {
        await api.patch(`/maintenance/${dialog.record.id}`, payload);
        setNotice("Maintenance job updated.");
      }

      setDialog(null);
      await loadRecords();
      await onChanged?.();
    } catch (requestError) {
      setError(requestError.message || "Could not save maintenance.");
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
    if (!canManageMaintenance || busy) return;
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
      setNotice(`Next maintenance is now scheduled for ${displayDate(dueDate)}.`);
      await Promise.all([loadSchedules(), loadRecords()]);
      await onChanged?.();
    } catch (requestError) {
      setError(requestError.message || "Could not approve the next occurrence.");
    } finally {
      setBusy(false);
    }
  };

  const declineNextOccurrence = async (schedule) => {
    if (!canManageMaintenance || busy) return;
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
    if (!canManageMaintenance || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.patch(`/maintenance/schedules/${schedule.id}`, { status });
      setNotice(status === "paused" ? "Schedule paused." : "Schedule resumed.");
      await loadSchedules();
    } catch (requestError) {
      setError(requestError.message || "Could not update recurrence status.");
    } finally {
      setBusy(false);
    }
  };

  const changeMaintenanceStatus = async (record) => {
    if (!canManageMaintenance || busy) return;
    const isStarting = record.status === "planned";
    if (!isStarting && record.status !== "in_progress") return;
    if (isStarting && startRequestRef.current) return;
    if (isStarting) startRequestRef.current = true;
    let startSucceeded = false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updatedRecord = await api.post(
        `/maintenance/${record.id}/${isStarting ? "start" : "complete"}`
      );
      if (isStarting) {
        startSucceeded = true;
        onActionNotification?.("Maintenance started.", "success", assetId);
      }
      if (!isStarting && updatedRecord.schedule_id) {
        const result = await api.getAll(`/maintenance/schedules?asset_id=${assetId}`);
        const updatedSchedules = Array.isArray(result) ? result : [];
        setSchedules(updatedSchedules);
        const updatedSchedule = updatedSchedules.find(
          (schedule) => schedule.id === updatedRecord.schedule_id
        );
        if (updatedSchedule?.approval_status === "pending") {
          setApprovalDate(updatedSchedule.proposed_due_date || "");
          setDialog({ kind: "approval", record: updatedSchedule });
        } else {
          setDialog({ kind: "details", record: updatedRecord });
        }
      } else {
        setDialog({ kind: "details", record: updatedRecord });
      }
      setRecords((previous) =>
        previous.map((item) => (item.id === updatedRecord.id ? updatedRecord : item))
      );
      if (!isStarting) setNotice("Maintenance finished.");
      await loadRecords();
      await onChanged?.();
      if (!isStarting) await loadSchedules();
    } catch (requestError) {
      if (isStarting && !startSucceeded) {
        onActionNotification?.(
          requestError.message || "Could not start maintenance.",
          "error",
          assetId
        );
      } else {
        setError(
          requestError.message ||
            `Could not ${isStarting ? "refresh" : "finish"} maintenance.`
        );
      }
    } finally {
      if (isStarting) startRequestRef.current = false;
      setBusy(false);
    }
  };

  // A schedule without a planned occurrence (for example after "Do not schedule") can still be
  // started: create a job from the schedule's details, then start it.
  const startFromSchedule = async (schedule) => {
    if (!canManageMaintenance || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    let created;
    try {
      const now = new Date();
      const payload = {
        asset_id: Number(assetId),
        title: schedule.title,
        maintenance_type: schedule.maintenance_type || "preventive",
        priority: schedule.priority || "medium",
        status: "planned",
        assigned_technician: schedule.assigned_technician || null,
        notes: schedule.description || `Started from schedule "${schedule.title}".`,
        planned_start_at: now.toISOString(),
        planned_end_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };
      try {
        created = await api.post("/maintenance", { ...payload, schedule_id: schedule.id });
      } catch {
        created = await api.post("/maintenance", payload); // server does not accept schedule_id
      }
    } catch (requestError) {
      setError(requestError.message || "Could not create maintenance from this schedule.");
      setBusy(false);
      return;
    }
    setBusy(false);
    if (created.schedule_id == null) {
      setNotice("Maintenance started as a standalone job (it is not linked to this schedule).");
    }
    await changeMaintenanceStatus({ ...created, status: created.status || "planned" });
  };

  const terminalEdit =
    dialog?.kind === "edit" &&
    ["completed", "cancelled"].includes(dialog.record.status);
  const plannedDatesRequired =
    dialog?.kind === "create" || (dialog?.kind === "edit" && !terminalEdit);

  const documentsForRecord = (record) =>
    schedules.find((schedule) => schedule.id === record.schedule_id)
      ?.instruction_documents || [];

  const openMaterialFile = async (document, file, action) => {
    setMaterialError("");
    try {
      const token = getAuthToken();
      const response = await fetch(
        `${API_BASE}/documents/${document.id}/files/${file.id}/${action}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      if (!response.ok) {
        let message = `Could not ${action === "view" ? "open" : "download"} ${file.name} (${response.status}).`;
        const responseText = await response.text();
        if (responseText) {
          try {
            const body = JSON.parse(responseText);
            message = body.detail || message;
          } catch {
            message = responseText;
          }
        }
        throw new Error(message);
      }

      const objectUrl = URL.createObjectURL(await response.blob());
      if (action === "view") {
        setMaterialViewer((current) => ({
          ...current,
          document,
          file,
          previewUrl: objectUrl,
        }));
        return;
      }

      // `document` is the maintenance document here, so use window.document for the DOM.
      const downloadLink = window.document.createElement("a");
      downloadLink.href = objectUrl;
      downloadLink.download = file.name;
      window.document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (requestError) {
      setMaterialError(requestError.message || `Could not ${action} ${file.name}.`);
    }
  };

  const today = todayDateInput();
  const visibleRecords = records.filter(
    (record) =>
      !(
        record.schedule_id != null &&
        (record.status === "in_progress" ||
          (record.status === "planned" && record.planned_due_date <= today))
      )
  );
  // Calendar schedules first, soonest due date on top; runtime/usage schedules follow.
  const dueTime = (schedule) =>
    (schedule.schedule_mode || "calendar") !== "calendar" || !schedule.current_due_date
      ? Infinity
      : new Date(`${String(schedule.current_due_date).slice(0, 10)}T00:00:00`).getTime();
  const activeSchedules = schedules
    .filter((schedule) => schedule.approval_status !== "pending")
    .sort((a, b) => {
      const first = dueTime(a);
      const second = dueTime(b);
      return first === second ? 0 : first < second ? -1 : 1;
    });
  const pendingSchedules = schedules.filter(
    (schedule) => schedule.approval_status === "pending"
  );

  const renderRecordCard = (record) => (
    <article
      className={`maintenance-record-card ${record.status || "planned"}`}
      key={record.id}
    >
      <span className="maintenance-record-indicator" aria-hidden="true" />
      <div className="maintenance-record-main">
        <strong>{record.title}</strong>
        <small>
          {record.maintenance_type || "Maintenance"} · {record.priority || "medium"} priority
        </small>
      </div>
      <div className="maintenance-record-status">
        <span className={`maintenance-status ${record.status}`}>
          {record.status === "in_progress" ? (
            <>
              <Timer size={13} aria-hidden="true" /> Started
            </>
          ) : (
            String(record.status || "planned").replaceAll("_", " ")
          )}
        </span>
        <small>
          {record.planned_start_at ? formatTime(record.planned_start_at) : "No planned start"}
          {" — "}
          {record.planned_end_at ? formatTime(record.planned_end_at) : "No planned end"}
        </small>
      </div>
      <div className="maintenance-record-meta">
        <span>
          <small>Technician</small>
          <strong>{record.assigned_technician || record.performed_by || "—"}</strong>
        </span>
        <span>
          <small>Planned duration</small>
          <strong>{plannedDurationDays(record)}</strong>
        </span>
        <span>
          <small>Actual duration</small>
          <strong>{actualDuration(record, clockNow)}</strong>
        </span>
      </div>
      <div className="maintenance-actions">
        <button
          type="button"
          ref={actionMenuRecordId === record.id ? actionMenuTriggerRef : null}
          className="icon-outline sm maintenance-actions-trigger"
          title={`Maintenance actions for ${record.title}`}
          aria-label={`Maintenance actions for ${record.title}`}
          aria-haspopup="menu"
          aria-expanded={actionMenuRecordId === record.id}
          disabled={busy}
          onClick={() =>
            setActionMenuRecordId((current) =>
              current === record.id ? null : record.id
            )
          }
        >
          <DotsIcon size={17} />
        </button>
        {actionMenuRecordId === record.id && (
          <FloatingMenu align="right" role="menu" data-maintenance-action-menu="">
            <button
              type="button"
              className="maintenance-action-menu-item"
              role="menuitem"
              onClick={() => {
                setActionMenuRecordId(null);
                setDialog({ kind: "details", record });
              }}
            >
              <Eye size={16} aria-hidden="true" />
              <span>View maintenance</span>
            </button>
            <button
              type="button"
              className="maintenance-action-menu-item maintenance-action-menu-item--edit"
              role="menuitem"
              onClick={() => {
                setActionMenuRecordId(null);
                openEdit(record);
              }}
              disabled={!canManageMaintenance}
              title={
                !canManageMaintenance
                  ? "You do not have permission to edit maintenance records."
                  : undefined
              }
            >
              <Pencil size={16} aria-hidden="true" />
              <span>Edit maintenance</span>
            </button>
            <button
              type="button"
              className="maintenance-action-menu-item"
              role="menuitem"
              onClick={() => {
                setActionMenuRecordId(null);
                setMaterialError("");
                const documents = documentsForRecord(record);
                if (documents.length > 0) {
                  setMaterialViewer({
                    document: documents[0],
                    file: null,
                    documents,
                  });
                }
              }}
              disabled={busy || documentsForRecord(record).length === 0}
              title={
                documentsForRecord(record).length > 0
                  ? "View attached instructions and documents"
                  : "No instruction or document attached"
              }
            >
              <FileText size={16} aria-hidden="true" />
              <span>Materials</span>
            </button>
            {isAdministrator && (
              <button
                type="button"
                className="maintenance-action-menu-item maintenance-action-menu-item--delete"
                role="menuitem"
                onClick={() => {
                  setActionMenuRecordId(null);
                  permanentlyDeleteRecord(record);
                }}
                disabled={busy || record.status === "in_progress"}
                title={
                  record.status === "in_progress"
                    ? "In-progress maintenance cannot be deleted."
                    : "Permanently delete this maintenance"
                }
              >
                <Trash2 size={16} aria-hidden="true" />
                <span>Delete Maintenance</span>
              </button>
            )}
          </FloatingMenu>
        )}
      </div>
    </article>
  );

  const renderScheduleCard = (schedule) => {
    const mode = schedule.schedule_mode || "calendar";
    const isRuntime = mode === "runtime";
    const isUsage = mode === "usage";

    const threshold = isRuntime
      ? Number(schedule.runtime_interval_hours || 0)
      : isUsage
        ? Number(schedule.usage_interval_count || 0)
        : 0;
    const progress = Number(schedule.current_progress || 0);
    const progressUnit =
      schedule.progress_unit || (isRuntime ? "hours" : isUsage ? "cycles" : "days");

    return (
      <article
        className={`maintenance-schedule-card ${schedule.status || "active"}`}
        key={schedule.id}
      >
        <div className="maintenance-schedule-indicator" />

        <div
          className="maintenance-schedule-main"
          role="button"
          tabIndex={0}
          style={{ cursor: "pointer" }}
          onClick={() => setDialog({ kind: "schedule-details", record: schedule })}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setDialog({ kind: "schedule-details", record: schedule });
            }
          }}
        >
          <strong>{schedule.title}</strong>
          <small>
            {mode === "runtime"
              ? "Runtime-based maintenance"
              : mode === "usage"
                ? "Usage-based maintenance"
                : "Calendar-based maintenance"}
            {" · "}
            {schedule.maintenance_type || "Maintenance"}
            {" · "}
            {schedule.priority || "medium"} priority
          </small>
        </div>

        <div className="maintenance-schedule-status">
          <span
            className={`maintenance-schedule-status-badge ${schedule.status || "active"}`}
          >
            {String(schedule.status || "active").replaceAll("_", " ")}
          </span>
          <small>
            {isRuntime || isUsage
              ? `PLC Variable: #${schedule.signal_variable_id}`
              : `Next due: ${displayDate(schedule.current_due_date)}${
                  schedule.status === "active" && dueLabel(schedule.current_due_date)
                    ? ` · ${dueLabel(schedule.current_due_date)}`
                    : ""
                }`}
          </small>
        </div>

        <div className="maintenance-schedule-meta">
          <span>
            <small>{isRuntime || isUsage ? "Progress" : "Recurrence"}</small>
            <strong>
              {isRuntime || isUsage
                ? `${progress.toFixed(1)} / ${threshold} ${progressUnit}`
                : schedule.recurrence_enabled
                  ? `Every ${schedule.recurrence_interval} ${schedule.recurrence_unit}`
                  : "Disabled"}
            </strong>
          </span>
          <span>
            <small>Technician</small>
            <strong>{schedule.assigned_technician || "—"}</strong>
          </span>
        </div>

        
<div className="maintenance-schedule-actions">
  <button
    type="button"
    ref={actionMenuRecordId === `schedule-${schedule.id}` ? actionMenuTriggerRef : null}
    className="icon-outline sm maintenance-actions-trigger"
    title={`Schedule actions for ${schedule.title}`}
    aria-label={`Schedule actions for ${schedule.title}`}
    aria-haspopup="menu"
    aria-expanded={actionMenuRecordId === `schedule-${schedule.id}`}
    disabled={busy}
    onClick={() =>
      setActionMenuRecordId((current) =>
        current === `schedule-${schedule.id}`
          ? null
          : `schedule-${schedule.id}`
      )
    }
  >
    <DotsIcon size={17} />
  </button>

  {actionMenuRecordId === `schedule-${schedule.id}` && (
    <FloatingMenu
      align="right"
      role="menu"
      data-maintenance-action-menu=""
    >
      <button
        type="button"
        className="maintenance-action-menu-item"
        role="menuitem"
        onClick={() => {
          setActionMenuRecordId(null);
          setDialog({ kind: "schedule-details", record: schedule });
        }}
      >
        <Eye size={16} aria-hidden="true" />
        <span>View schedule</span>
      </button>

      {canManageMaintenance && (
        <>
          <button
            type="button"
            className="maintenance-action-menu-item maintenance-action-menu-item--edit"
            role="menuitem"
            onClick={() => {
              setActionMenuRecordId(null);
              openScheduleEdit(schedule);
            }}
            disabled={busy}
          >
            <Pencil size={16} aria-hidden="true" />
            <span>Edit schedule</span>
          </button>

          {["active", "paused"].includes(schedule.status || "active") && (
            <button
              type="button"
              className="maintenance-action-menu-item"
              role="menuitem"
              onClick={() => {
                setActionMenuRecordId(null);
                changeScheduleStatus(
                  schedule,
                  schedule.status === "paused" ? "active" : "paused"
                );
              }}
              disabled={busy}
            >
              {schedule.status === "paused" ? (
                <Play size={16} aria-hidden="true" />
              ) : (
                <Pause size={16} aria-hidden="true" />
              )}
              <span>
                {schedule.status === "paused"
                  ? "Resume schedule"
                  : "Pause schedule"}
              </span>
            </button>
          )}
        </>
      )}
    </FloatingMenu>
  )}
</div>
      </article>
    );
  };

  // Schedule view: start the work, follow the instructions, open linked documents.
  const renderScheduleDetails = () => {
    const schedule = schedules.find((item) => item.id === dialog.record.id) || dialog.record;
    const scheduleRecords = records.filter((record) => record.schedule_id === schedule.id);
    const runningRecord = scheduleRecords.find((record) => record.status === "in_progress");
    const nextRecord = scheduleRecords
      .filter((record) => record.status === "planned")
      .sort((a, b) =>
        String(a.planned_due_date || a.planned_start_at || "").localeCompare(
          String(b.planned_due_date || b.planned_start_at || "")
        )
      )[0];
    const documents = schedule.instruction_documents || [];
    const steps = documents.filter(
      (item) => item.description || /instruction/i.test(String(item.kind || ""))
    );
    const fileDocuments = documents.filter((item) => item.files?.length > 0);

    const scheduleClosed = ["cancelled", "completed"].includes(schedule.status);
    const startBlockedReason = !canManageMaintenance
      ? "You do not have permission to manage maintenance."
      : runningRecord
        ? "A maintenance for this schedule is already in progress."
        : scheduleClosed
          ? `This schedule is ${schedule.status} and cannot start maintenance.`
          : "";
    const registerBlockedReason = !canManageMaintenance
      ? "You do not have permission to manage maintenance."
      : !runningRecord
        ? "Start the maintenance first, then register it when the work is done."
        : "";

    const viewScheduleFile = (doc, file) => {
      setMaterialViewer({ document: doc, file: null, documents: fileDocuments });
      openMaterialFile(doc, file, "view");
    };

    return (
      <Modal
        title="Maintenance schedule"
        onClose={() => {
          if (!busy) setDialog(null);
        }}
        wide
      >
        <div className="maintenance-schedule-details-view">
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        {schedule.status === "paused" && (
          <p
            className="notice schedule-resume-notice"
            role="status"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
          >
            <span>This schedule is paused. Resume it to keep its due dates and alerts running.</span>
            {canManageMaintenance && (
              <button
                type="button"
                className="btn-outline"
                onClick={() => changeScheduleStatus(schedule, "active")}
                disabled={busy}
              >
                Resume schedule
              </button>
            )}
          </p>
        )}

        <div className="schedule-summary-grid">
          <div>
            <small style={{ display: "block" }}>Status</small>
            <strong>{String(schedule.status || "active").replaceAll("_", " ")}</strong>
          </div>
          <div>
            <small style={{ display: "block" }}>Next due</small>
            <strong>
              {displayDate(schedule.current_due_date)}
              {schedule.status === "active" && dueLabel(schedule.current_due_date)
                ? ` · ${dueLabel(schedule.current_due_date)}`
                : ""}
            </strong>
          </div>
          <div>
            <small style={{ display: "block" }}>Recurrence</small>
            <strong>
              {schedule.recurrence_enabled
                ? `Every ${schedule.recurrence_interval} ${schedule.recurrence_unit}`
                : "Disabled"}
            </strong>
          </div>
          <div>
            <small style={{ display: "block" }}>Technician</small>
            <strong>{schedule.assigned_technician || "—"}</strong>
          </div>
        </div>

        <div className="schedule-run-head">
          <div>
            <h3 className="schedule-run-title">Instructions</h3>
            <button
              type="button"
              className="btn-outline schedule-start-btn"
              onClick={() => (nextRecord ? changeMaintenanceStatus(nextRecord) : startFromSchedule(schedule))}
              disabled={busy || Boolean(startBlockedReason)}
              title={startBlockedReason || "Start this maintenance"}
            >
              <Play size={15} aria-hidden="true" /> {busy ? "Please wait…" : "Start maintenance"}
            </button>
            {runningRecord && (
              <p className="muted">
                Maintenance in progress since{" "}
                {runningRecord.actual_started_at
                  ? formatTime(runningRecord.actual_started_at)
                  : "—"}
                .
              </p>
            )}
            {!runningRecord && !nextRecord && canManageMaintenance && !scheduleClosed && (
              <p className="muted">
                No planned maintenance yet. Start will create one from this schedule and begin it.
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => changeMaintenanceStatus(runningRecord)}
            disabled={busy || Boolean(registerBlockedReason)}
            title={registerBlockedReason || "Finish and register this maintenance"}
          >
            <ClipboardCheck size={16} aria-hidden="true" /> Register maintenance
          </button>
        </div>

        {steps.length === 0 ? (
          schedule.description ? (
            <ol className="schedule-steps">
              <li>
                <span className="schedule-step-dot" aria-hidden="true" />
                <div>
                  <strong>Work details</strong>
                  <p className="maintenance-instruction-text">{schedule.description}</p>
                </div>
              </li>
            </ol>
          ) : (
            <p className="muted">
              No instructions added for this schedule. Use Edit schedule to add work details.
            </p>
          )
        ) : (
          <ol className="schedule-steps">
            {steps.map((step) => {
              const minutes = Number(step.duration_minutes ?? step.estimated_minutes);
              return (
                <li key={step.id}>
                  <span className="schedule-step-dot" aria-hidden="true" />
                  <div>
                    <strong>{step.title || "Instruction"}</strong>
                    {Number.isFinite(minutes) && minutes > 0 && <em> ({minutes} minutes)</em>}
                    {step.description && (
                      <p className="maintenance-instruction-text">{step.description}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        <h3 className="schedule-run-title">Documents</h3>
        {fileDocuments.length === 0 ? (
          <div className="schedule-docs-empty">
            <FileText size={36} aria-hidden="true" />
            <strong>No documents linked</strong>
            <span>To link documents, edit this schedule.</span>
            {canManageMaintenance && (
              <button
                type="button"
                className="btn-outline"
                onClick={() => openScheduleEdit(schedule)}
                disabled={busy}
              >
                Edit schedule
              </button>
            )}
          </div>
        ) : (
          <div className="maintenance-material-list">
            {materialError && (
              <p className="notice error" role="alert">
                {materialError}
              </p>
            )}
            {fileDocuments.map((doc) => (
              <section key={doc.id} className="maintenance-material-item">
                <h3>{doc.title || "Untitled document"}</h3>
                <p className="muted">{doc.kind || "Document"}</p>
                <div className="maintenance-material-files">
                  {doc.files.map((file) => (
                    <div key={file.id} className="maintenance-material-files">
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={() => viewScheduleFile(doc, file)}
                      >
                        View {file.name}
                      </button>
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={() => openMaterialFile(doc, file, "download")}
                      >
                        Download
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <h3 className="schedule-run-title">Maintenance history</h3>
        {scheduleRecords.length === 0 ? (
          <p className="muted">Nothing has been done for this schedule yet.</p>
        ) : (
          <ul className="schedule-history">
            {[...scheduleRecords]
              .sort((a, b) =>
                String(b.planned_start_at || "").localeCompare(String(a.planned_start_at || ""))
              )
              .slice(0, 5)
              .map((record) => (
                <li
                  key={record.id}
                  style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0" }}
                >
                  <span>
                    <strong>{String(record.status || "planned").replaceAll("_", " ")}</strong>
                    {" · "}
                    {record.planned_start_at ? formatTime(record.planned_start_at) : "No planned start"}
                  </span>
                  <span>{actualDuration(record, clockNow)}</span>
                </li>
              ))}
          </ul>
        )}

        <h3 className="schedule-run-title">Schedule details</h3>
        <dl className="maintenance-details">
            <dt>Title</dt>
            <dd>{schedule.title}</dd>
            <dt>Schedule start</dt>
            <dd>{displayDate(schedule.schedule_start_date)}</dd>
            <dt>First due date</dt>
            <dd>{displayDate(schedule.first_due_date)}</dd>
            <dt>Current due date</dt>
            <dd>{displayDate(schedule.current_due_date)}</dd>
            <dt>Recurrence</dt>
            <dd>
              {schedule.recurrence_enabled
                ? `Every ${schedule.recurrence_interval} ${schedule.recurrence_unit}`
                : "Disabled"}
            </dd>
            <dt>Schedule status / due state</dt>
            <dd>
              {String(schedule.status || "—").replaceAll("_", " ")} /{" "}
              {String(schedule.due_status || "—").replaceAll("_", " ")}
            </dd>
            <dt>Approval</dt>
            <dd>{String(schedule.approval_status || "—").replaceAll("_", " ")}</dd>
            <dt>Proposed next due date</dt>
            <dd>{displayDate(schedule.proposed_due_date)}</dd>
            <dt>Last completed</dt>
            <dd>
              {schedule.last_completed_at
                ? formatTime(schedule.last_completed_at)
                : "—"}
            </dd>
            <dt>Assigned technician</dt>
            <dd>{schedule.assigned_technician || "—"}</dd>
            <dt>Description</dt>
            <dd>{schedule.description || "—"}</dd>
            <dt>Created by</dt>
            <dd>{auditUser(schedule.created_by)}</dd>
            <dt>Created on</dt>
            <dd>{formatAuditTime(schedule.created_at)}</dd>
            <dt>Last updated by</dt>
            <dd>{auditUser(schedule.updated_by)}</dd>
            <dt>Last updated on</dt>
            <dd>
              {schedule.updated_by
                ? formatAuditTime(schedule.updated_at)
                : "Unknown"}
            </dd>
          </dl>
        <div className="modal-actions">
          <button
            type="button"
            className="btn-outline"
            onClick={() => setDialog(null)}
            disabled={busy}
          >
            Close
          </button>
        </div>
      </div>
      </Modal>
    );
  };

  return (
    <>
      <section className="panel maintenance-panel">
        <div className="panel-head maintenance-heading">
          <div>
            <h2>Maintenance management</h2>
            <p className="muted">Schedule, track and review work for this asset.</p>
          </div>
          <div className="maintenance-heading-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                if (!canAddMaintenance || busy) return;
                setError("");
                setNotice("");
                openCreate();
              }}
              disabled={!canAddMaintenance || busy}
              title={
                !canAddMaintenance
                  ? "Only Administrators can add maintenance jobs."
                  : "Add Maintenance"
              }
            >
              Add Maintenance
            </button>
          </div>
        </div>

        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {!canManageMaintenance && (
          <p className="muted" role="status">
            Maintenance records and schedules are view-only for your role.
          </p>
        )}

        <div
          className="maintenance-logbook-tabs"
          role="tablist"
          aria-label="Maintenance sections"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeMaintenanceTab === "schedules"}
            className={`maintenance-logbook-tab ${
              activeMaintenanceTab === "schedules" ? "active" : ""
            }`}
            onClick={() => setActiveMaintenanceTab("schedules")}
          >
            <CalendarDays size={16} aria-hidden="true" />
            Schedules
            <span>{activeSchedules.length}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeMaintenanceTab === "jobs"}
            className={`maintenance-logbook-tab ${
              activeMaintenanceTab === "jobs" ? "active" : ""
            }`}
            onClick={() => setActiveMaintenanceTab("jobs")}
          >
            <FileText size={16} aria-hidden="true" />
            Jobs & History
            <span>{visibleRecords.length}</span>
          </button>
        </div>

        {activeMaintenanceTab === "schedules" && (
          <>
            {pendingSchedules.map((schedule) => (
              <section className="maintenance-next-approval" key={schedule.id}>
                <div>
                  <strong>{schedule.title}</strong>
                  <small>
                    Next occurrence proposed for {displayDate(schedule.proposed_due_date)}
                    {schedule.recurrence_enabled
                      ? ` · Every ${schedule.recurrence_interval} ${schedule.recurrence_unit}`
                      : ""}
                  </small>
                </div>

                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || !canManageMaintenance}
                  onClick={() => {
                    setApprovalDate(schedule.proposed_due_date || "");
                    setDialog({ kind: "approval", record: schedule });
                  }}
                >
                  Review next date
                </button>
              </section>
            ))}

            {schedulesLoaded && (
              <section className="maintenance-schedules">
                <h3>Maintenance schedules</h3>

                <p className="muted">
                  View calendar-based, runtime-based and usage-based maintenance
                  schedules for this asset.
                </p>

                {activeSchedules.length === 0 ? (
                  <p className="muted">No maintenance schedules available.</p>
                ) : (
                  <div className="maintenance-schedule-list">
                    {activeSchedules.map(renderScheduleCard)}
                  </div>
                )}
              </section>
            )}
          </>
        )}

        {activeMaintenanceTab === "jobs" && (
          <>
            {loading ? (
              <LoadingIndicator compact message="Loading maintenance history" />
            ) : visibleRecords.length === 0 ? (
              <EmptyState
                art={false}
                title={records.length === 0 ? "No maintenance jobs" : "No other maintenance jobs"}
                lines={
                  records.length === 0
                    ? ["Create a job to start tracking planned and completed work."]
                    : [
                        "Due-today scheduled work and active scheduled work are shown in Current status.",
                      ]
                }
              />
            ) : (
              <div className="maintenance-record-list">
                {visibleRecords.map(renderRecordCard)}
              </div>
            )}
          </>
        )}
      </section>

      {(dialog?.kind === "schedule-create" || dialog?.kind === "schedule-edit") && (
        <Modal
          title={
            dialog.kind === "schedule-create"
              ? "Add maintenance schedule"
              : "Edit maintenance schedule"
          }
          onClose={() => {
            if (!busy) setDialog(null);
          }}
          wide
        >
          <form className="maintenance-form" onSubmit={save}>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <fieldset
              disabled={!canManageMaintenance}
              style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
            >
              <div className="maintenance-form-grid">
                <label className="field">
                  Maintenance title <span className="req">*</span>
                  <input
                    name="title"
                    value={scheduleValues.title}
                    onChange={updateScheduleValue}
                    maxLength={200}
                    required
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  Maintenance type
                  <select
                    name="maintenance_type"
                    value={scheduleValues.maintenance_type}
                    onChange={updateScheduleValue}
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
                    value={scheduleValues.priority}
                    onChange={updateScheduleValue}
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
                    value={scheduleValues.assigned_technician}
                    onChange={updateScheduleValue}
                    maxLength={200}
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  Schedule start date <span className="req">*</span>
                  <input
                    type="date"
                    name="schedule_start_date"
                    value={scheduleValues.schedule_start_date}
                    onChange={updateScheduleValue}
                    required
                    disabled={busy}
                  />
                  <small className="muted">
                    The date this maintenance plan becomes effective.
                  </small>
                </label>
                <label className="field">
                  First maintenance due date <span className="req">*</span>
                  <input
                    type="date"
                    name="first_due_date"
                    value={scheduleValues.first_due_date}
                    onChange={updateScheduleValue}
                    required
                    disabled={busy}
                  />
                  <small className="muted">
                    The date by which the first maintenance occurrence must be completed.
                  </small>
                </label>
                {dialog.kind === "schedule-edit" && (
                  <label className="field">
                    Schedule status
                    <select
                      name="status"
                      value={scheduleValues.status}
                      onChange={updateScheduleValue}
                      disabled={busy}
                    >
                      {["active", "paused", "cancelled", "completed"].map((item) => (
                        <option key={item} value={item}>
                          {item.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="field maintenance-checkbox">
                  <input
                    type="checkbox"
                    name="recurrence_enabled"
                    checked={scheduleValues.recurrence_enabled}
                    onChange={updateScheduleValue}
                    disabled={busy}
                  />
                  Enable recurring maintenance
                </label>
                {scheduleValues.recurrence_enabled && (
                  <>
                    <label className="field">
                      Repeat every
                      <input
                        type="number"
                        name="recurrence_interval"
                        min="1"
                        max="3650"
                        step="1"
                        value={scheduleValues.recurrence_interval}
                        onChange={updateScheduleValue}
                        required
                        disabled={busy}
                      />
                    </label>
                    <label className="field">
                      Recurrence unit
                      <select
                        name="recurrence_unit"
                        value={scheduleValues.recurrence_unit}
                        onChange={updateScheduleValue}
                        disabled={busy}
                      >
                        {RECURRENCE_UNITS.map((item) => (
                          <option key={item} value={item}>
                            {item[0].toUpperCase() + item.slice(1)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <label className="field maintenance-form-wide">
                  Description / work details
                  <textarea
                    name="description"
                    value={scheduleValues.description}
                    onChange={updateScheduleValue}
                    rows={3}
                    maxLength={10000}
                    disabled={busy}
                  />
                </label>
              </div>
            </fieldset>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn-outline"
                onClick={() => setDialog(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={busy || !canManageMaintenance}
                title={
                  !canManageMaintenance
                    ? "You do not have permission to manage maintenance schedules."
                    : undefined
                }
              >
                {busy
                  ? "Saving…"
                  : dialog.kind === "schedule-create"
                    ? "Create schedule"
                    : "Save schedule"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {dialog?.kind === "schedule-details" && renderScheduleDetails()}

      {materialViewer && (
        <Modal
          title={
            materialViewer.file?.name ||
            materialViewer.document.title ||
            "Instructions and documents"
          }
          onClose={() => setMaterialViewer(null)}
          wide
        >
          {materialViewer.file ? (
            <>
              <button
                type="button"
                className="btn-outline"
                onClick={() => {
                  setMaterialError("");
                  setMaterialViewer((current) => ({
                    ...current,
                    file: null,
                    previewUrl: null,
                  }));
                }}
              >
                Back to instructions and documents
              </button>
              {materialError && (
                <p className="notice error" role="alert">
                  {materialError}
                </p>
              )}
              <iframe
                title={materialViewer.file.name}
                src={materialViewer.previewUrl || undefined}
                className="maintenance-document-preview"
              />
            </>
          ) : (
            <div className="maintenance-material-list">
              {materialError && (
                <p className="notice error" role="alert">
                  {materialError}
                </p>
              )}
              {materialViewer.documents.map((document) => (
                <section key={document.id} className="maintenance-material-item">
                  <h3>{document.title || "Untitled document"}</h3>
                  <p className="muted">{document.kind || "Instruction"}</p>
                  {document.description && (
                    <p className="maintenance-instruction-text">{document.description}</p>
                  )}
                  {document.files?.length > 0 ? (
                    <div className="maintenance-material-files">
                      {document.files.map((file) => (
                        <div key={file.id} className="maintenance-material-files">
                          <button
                            type="button"
                            className="btn-outline"
                            onClick={() => openMaterialFile(document, file, "view")}
                          >
                            View {file.name}
                          </button>
                          <button
                            type="button"
                            className="btn-outline"
                            onClick={() => openMaterialFile(document, file, "download")}
                          >
                            Download
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    !document.description && (
                      <p className="muted">
                        No instruction text or document file is available.
                      </p>
                    )
                  )}
                </section>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="btn-outline"
              onClick={() => setMaterialViewer(null)}
            >
              Close
            </button>
          </div>
        </Modal>
      )}

      {dialog?.kind === "approval" && (
        <Modal
          title="Maintenance completed"
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <p>
            The previous maintenance was due on{" "}
            <strong>{displayDate(dialog.record.current_due_date)}</strong>.
          </p>
          <p>
            Based on the existing schedule
            {dialog.record.recurrence_interval
              ? ` (every ${dialog.record.recurrence_interval} ${dialog.record.recurrence_unit})`
              : ""}
            , the next maintenance is proposed for{" "}
            <strong>{displayDate(dialog.record.proposed_due_date)}</strong>.
          </p>
          <p>
            Confirm the next occurrence for{" "}
            <strong>{displayDate(approvalDate || dialog.record.proposed_due_date)}</strong>
            {dialog.record.recurrence_interval
              ? ` with a recurrence of every ${dialog.record.recurrence_interval} ${dialog.record.recurrence_unit}.`
              : "."}
          </p>
          <label className="field">
            Confirmed next due date
            <input
              type="date"
              value={approvalDate}
              min={dialog.record.schedule_start_date}
              onChange={(event) => setApprovalDate(event.target.value)}
              disabled={busy || !canManageMaintenance}
            />
          </label>
          <p className="muted">
            Review the date and interval before approving the next occurrence.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn-danger"
              onClick={() => declineNextOccurrence(dialog.record)}
              disabled={busy || !canManageMaintenance}
              title={
                !canManageMaintenance
                  ? "You do not have permission to manage maintenance schedules."
                  : undefined
              }
            >
              Do not schedule
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => confirmNextOccurrence(dialog.record, approvalDate)}
              disabled={busy || !canManageMaintenance}
              title={
                !canManageMaintenance
                  ? "You do not have permission to manage maintenance schedules."
                  : undefined
              }
            >
              Confirm date
            </button>
          </div>
        </Modal>
      )}

      {dialog?.kind === "details" && (
        <Modal title="Maintenance details" onClose={() => setDialog(null)} wide>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <MaintenanceDetails record={dialog.record} now={clockNow} />
          <div className="modal-actions">
            {dialog.record.status === "planned" && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => changeMaintenanceStatus(dialog.record)}
                disabled={busy || !canManageMaintenance}
                title={
                  !canManageMaintenance
                    ? "You do not have permission to manage maintenance."
                    : undefined
                }
              >
                {busy ? "Starting…" : "Start"}
              </button>
            )}
            {dialog.record.status === "in_progress" && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => changeMaintenanceStatus(dialog.record)}
                disabled={busy || !canManageMaintenance}
                title={
                  !canManageMaintenance
                    ? "You do not have permission to manage maintenance."
                    : undefined
                }
              >
                {busy ? "Finishing…" : "Finish"}
              </button>
            )}
            <button
              type="button"
              className="btn-outline"
              onClick={() => openEdit(dialog.record)}
              disabled={busy || !canManageMaintenance}
              title={
                !canManageMaintenance
                  ? "You do not have permission to edit maintenance records."
                  : undefined
              }
            >
              Edit
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => setDialog(null)}
              disabled={busy}
            >
              Close
            </button>
          </div>
        </Modal>
      )}

      {(dialog?.kind === "create" || dialog?.kind === "edit") && (
        <Modal
          title={dialog.kind === "create" ? "Add maintenance" : "Edit maintenance"}
          onClose={() => {
            if (!busy) setDialog(null);
          }}
          wide
        >
          <form className="maintenance-form" onSubmit={save}>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <fieldset
              disabled={!canManageMaintenance}
              style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
            >
              <div className="maintenance-form-grid">
                {!isSupervisor && (
                  <>
                    <label className="field">
                      Title <span className="req">*</span>
                      <input
                        name="title"
                        value={values.title}
                        onChange={updateValue}
                        required
                        maxLength={200}
                        disabled={busy}
                      />
                    </label>
                    <label className="field">
                      Type <span className="req">*</span>
                      <select
                        name="maintenance_type"
                        value={values.maintenance_type}
                        onChange={updateValue}
                        required
                        disabled={busy}
                      >
                        {TYPES.map((item) => (
                          <option key={item} value={item}>
                            {item[0].toUpperCase() + item.slice(1)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {dialog.kind === "create" && (
                      <label className="field">
                        Status <span className="req">*</span>
                        <select
                          name="status"
                          value={values.status}
                          onChange={updateValue}
                          required
                          disabled={busy}
                        >
                          {STATUSES.map((item) => (
                            <option key={item} value={item}>
                              {item.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="field">
                      Priority <span className="req">*</span>
                      <select
                        name="priority"
                        value={values.priority}
                        onChange={updateValue}
                        required
                        disabled={busy}
                      >
                        {PRIORITIES.map((item) => (
                          <option key={item} value={item}>
                            {item.charAt(0).toUpperCase() + item.slice(1)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <label className="field">
                  Planned start {plannedDatesRequired && <span className="req">*</span>}
                  <input
                    type="datetime-local"
                    name="planned_start_at"
                    value={values.planned_start_at}
                    onChange={updateValue}
                    required={plannedDatesRequired}
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  Planned end {plannedDatesRequired && <span className="req">*</span>}
                  <input
                    type="datetime-local"
                    name="planned_end_at"
                    value={values.planned_end_at}
                    onChange={updateValue}
                    required={plannedDatesRequired}
                    disabled={busy}
                  />
                </label>
                {!isSupervisor && (
                  <>
                    <label className="field">
                      Assigned technician
                      <input
                        name="assigned_technician"
                        value={values.assigned_technician}
                        onChange={updateValue}
                        maxLength={200}
                        disabled={busy}
                      />
                    </label>
                    <label className="field">
                      Actual start
                      <input
                        type="datetime-local"
                        name="actual_started_at"
                        value={values.actual_started_at}
                        onChange={updateValue}
                        disabled={busy}
                      />
                    </label>
                    <label className="field">
                      Actual completion
                      <input
                        type="datetime-local"
                        name="actual_completed_at"
                        value={values.actual_completed_at}
                        onChange={updateValue}
                        disabled={busy}
                      />
                    </label>
                    <label className="field maintenance-form-wide">
                      Description / work details
                      <textarea
                        name="notes"
                        value={values.notes}
                        onChange={updateValue}
                        rows={3}
                        maxLength={10000}
                        required
                        disabled={busy}
                      />
                    </label>
                  </>
                )}
              </div>
            </fieldset>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-outline"
                onClick={() => setDialog(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={busy || !canManageMaintenance}
                title={
                  !canManageMaintenance
                    ? "You do not have permission to manage maintenance."
                    : undefined
                }
              >
                {busy
                  ? "Saving…"
                  : dialog.kind === "create"
                    ? "Create maintenance"
                    : "Save changes"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {legacyRuleOptionsOpen && (
        <Modal
          title="Additional asset rule workflows"
          onClose={() => setLegacyRuleOptionsOpen(false)}
        >
          <div className="rule-type-options">
            {LEGACY_RULE_CHOICES.map((choice) => (
              <button
                key={choice.kind}
                type="button"
                className="rule-type-option"
                onClick={() => {
                  setLegacyRuleOptionsOpen(false);
                  navigate(legacyRulePath(assetId, choice.kind), {
                    state: {
                      from: captureNavigationOrigin(location, {
                        ...(navigationState || location.state),
                        activeTab: "logbook",
                      }),
                    },
                  });
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
