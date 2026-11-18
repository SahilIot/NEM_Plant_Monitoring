import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Eye, Pencil, Trash2 } from "lucide-react";
import { api } from "../../../services/api.js";
import { shareInFlight } from "../../../services/liveUpdates.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { captureNavigationOrigin } from "../../../utils/navigation.js";
import { recordDeleteConfirmation, recordDeleteState } from "../maintenanceDeletion.js";
import {
  EmptyState,
  FloatingMenu,
  LoadingIndicator,
  Modal,
  useConfirmation,
} from "../../../components/common/UI.jsx";
import MaintenanceDetails from "./MaintenanceDetails.jsx";
import MaintenanceRegistrationDialog from "./MaintenanceRegistrationDialog.jsx";
import { DotsIcon } from "../../../components/common/Icons.jsx";
import "./MaintenancePanel.css";

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

// A job created from a monitoring rule cannot be started until its rule reaches Due (the server enforces this too).
const isLockedUntilDue = (record) => record?.start_eligibility === "not_due";
const NOT_DUE_TITLE = "Not due yet. Start becomes available when the rule reaches its Due limit.";

function formatNumber(value) {
  return value == null || Number.isNaN(Number(value)) ? "—" : String(Number(Number(value).toFixed(2)));
}

export default function CurrentMaintenanceCards({
  assetId,
  refreshKey = 0,
  assetName,
  onChanged,
  onActionNotification,
  onCompletedRecordsCount,
  showCompleted = false,
  navigationState,
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const confirm = useConfirmation();
  const isAdministrator = user?.role === "Administrator";
  const canManageMaintenance = ["Administrator", "Supervisor"].includes(user?.role);
  const canOperateDueMaintenance = user?.role === "Operator";
  const [records, setRecords] = useState([]);
  const [completedRecords, setCompletedRecords] = useState([]);
  // Rule-created schedules by id: their current value, Due limit and eligibility come from the schedule.
  const [ruleSchedules, setRuleSchedules] = useState({});
  const [loading, setLoading] = useState(true);
  const [startingRecordId, setStartingRecordId] = useState(null);
  const [completingRecordId, setCompletingRecordId] = useState(null);
  const [deletingRecordId, setDeletingRecordId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [registrationRecord, setRegistrationRecord] = useState(null);
  const [clockNow, setClockNow] = useState(Date.now());
  const [editingRecordId, setEditingRecordId] = useState(null);
  const [actionMenuRecordId, setActionMenuRecordId] = useState(null);
  const actionMenuTriggerRef = useRef(null);
  const startRequestRef = useRef(false);
  const lastLoadedDate = useRef("");
  const loadingRef = useRef(false);
  const reloadPending = useRef(false);
  const [reloadTick, setReloadTick] = useState(0);
  const busy =
    startingRecordId !== null ||
    completingRecordId !== null ||
    deletingRecordId !== null;

const openEdit = (record) => {
  if (
    !canManageMaintenance ||
    record.status === "in_progress" ||
    record.status === "completed"
  ) return;

  setEditingRecordId(record.id);

  if (record.schedule_id) {
    navigate(
      `/assets/${assetId}/maintenance/schedules/${record.schedule_id}/edit`,
      {
        state: {
          from: captureNavigationOrigin(location, {
            ...(navigationState || location.state),
            activeTab:
              navigationState?.activeTab || location.state?.activeTab || "status",
          }),
          maintenanceRecord: record,
        },
      }
    );
    return;
  }

  navigate(
    `/assets/${assetId}/maintenance/${record.id}/edit`,
    {
      state: {
        from: captureNavigationOrigin(location, {
          ...(navigationState || location.state),
          activeTab:
            navigationState?.activeTab || location.state?.activeTab || "status",
        }),
        maintenanceRecord: record,
      },
    }
  );
};

  // One delete at a time, including while the confirmation dialog is open.
  const deleteGuard = useRef(false);
  const permanentlyDeleteRecord = async (record) => {
    if (deleteGuard.current) return;
    deleteGuard.current = true;
    try {
      await runPermanentDeleteRecord(record);
    } finally {
      deleteGuard.current = false;
    }
  };

  const runPermanentDeleteRecord = async (record) => {
    if (!recordDeleteState(record, { isAdministrator }).enabled || busy) return;
    if (
      !(await confirm(
        recordDeleteConfirmation(record, { assetName }),
        {
          title: "Delete Maintenance?",
          confirmLabel: "Delete Maintenance",
          destructive: true,
        }
      ))
    ) return;
    setDeletingRecordId(record.id);
    setError("");
    setNotice("");
    try {
      await api.del(`/maintenance/${record.id}`);
      setSelectedRecord(null);
      setNotice("Maintenance was permanently deleted.");
      await Promise.all([
        loadCurrentMaintenance(),
        Promise.resolve(onChanged?.()),
      ]);
    } catch (deleteError) {
      setError(deleteError.message || "Could not permanently delete maintenance.");
    } finally {
      setDeletingRecordId(null);
    }
  };

  const loadCurrentMaintenance = useCallback(async () => {
    if (loadingRef.current) {
      reloadPending.current = true; // a change arrived mid-load: read again once this load ends
      return false;
    }
    loadingRef.current = true;
    setError("");
    try {
      const [schedules, maintenanceRecords] = await Promise.all([
        shareInFlight(`maintenance-schedules:${assetId}`, () => api.getAll(`/maintenance/schedules?asset_id=${assetId}`), { fresh: true }),
        shareInFlight(`maintenance-records:${assetId}`, () => api.getAll(`/maintenance?asset_id=${assetId}`), { fresh: true }),
      ]);
      const recordsById = new Map(
        maintenanceRecords.map((record) => [record.id, record])
      );
      const today = todayDateInput();
      lastLoadedDate.current = today;
      const completedScheduledRecords = maintenanceRecords.filter(
        (record) =>
          record.schedule_id != null && record.status === "completed"
      );
      setCompletedRecords(completedScheduledRecords);
      setRuleSchedules(
        Object.fromEntries(
          schedules
            .filter((schedule) => schedule.schedule_mode === "rule")
            .map((schedule) => [schedule.id, schedule])
        )
      );
      onCompletedRecordsCount?.(completedScheduledRecords.length);
      // Rule-generated schedules are not listed under the rules in Current Status any more: they are opened from the
      // rule's parameter, and managed in the Maintenance Logbook. Calendar schedules keep their cards here.
      setRecords(
        schedules
          .filter(
            (schedule) =>
              schedule.schedule_mode !== "rule" &&
              schedule.status === "active" &&
              schedule.approval_status !== "pending"
          )
          .map((schedule) => recordsById.get(schedule.current_occurrence_id))
          .filter(
            (record) =>
              record &&
              (record.status === "in_progress" ||
                (record.status === "planned" &&
                  // Runtime/usage jobs have no due date: they are created when the limit is reached, so they are due now.
                  (!record.planned_due_date || record.planned_due_date <= today)))
          )
      );
      return true;
    } catch (loadError) {
      setError(loadError.message || "Could not load current maintenance.");
      return false;
    } finally {
      loadingRef.current = false;
      setLoading(false);
      if (reloadPending.current) {
        reloadPending.current = false;
        setReloadTick((current) => current + 1);
      }
    }
  }, [assetId, onCompletedRecordsCount]);

  useEffect(() => {
    loadCurrentMaintenance();
  }, [loadCurrentMaintenance, refreshKey, reloadTick]);

  useEffect(() => {
    if (actionMenuRecordId === null) return undefined;

    const handlePointerDown = (event) => {
      if (!(event.target instanceof Element)) return;
      if (
        actionMenuTriggerRef.current?.contains(event.target) ||
        event.target.closest("[data-current-maintenance-action-menu]")
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

  useEffect(() => {
    let midnightTimer;
    let dateRefreshInProgress = false;
    let disposed = false;

    const refreshIfDateChanged = async () => {
      if (
        disposed ||
        document.visibilityState !== "visible" ||
        todayDateInput() === lastLoadedDate.current ||
        dateRefreshInProgress
      ) {
        return;
      }

      dateRefreshInProgress = true;
      try {
        await loadCurrentMaintenance();
      } finally {
        dateRefreshInProgress = false;
      }
    };

    const scheduleMidnightRefresh = () => {
      if (disposed) return;
      window.clearTimeout(midnightTimer);
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1
      );
      midnightTimer = window.setTimeout(async () => {
        await refreshIfDateChanged();
        if (!disposed) scheduleMidnightRefresh();
      }, Math.max(0, nextMidnight.getTime() - now.getTime()) + 100);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshIfDateChanged();
      }
      scheduleMidnightRefresh();
    };

    scheduleMidnightRefresh();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      window.clearTimeout(midnightTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadCurrentMaintenance]);

  useEffect(() => {
    if (selectedRecord?.status !== "in_progress") return undefined;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [selectedRecord?.id, selectedRecord?.status]);

  const startMaintenance = async (record) => {
    if (isLockedUntilDue(record) || record.rule_context) return;
    if (
      !canManageMaintenance &&
      !(canOperateDueMaintenance && record.schedule_id != null &&
        (!record.planned_due_date || record.planned_due_date <= todayDateInput()))
    ) return;
    if (startingRecordId !== null || startRequestRef.current) return;
    startRequestRef.current = true;
    setStartingRecordId(record.id);
    setError("");
    setNotice("");
    try {
      await api.post(`/maintenance/${record.id}/start`);
      onActionNotification?.("Maintenance started.", "success", assetId);
      try {
        await Promise.all([
          loadCurrentMaintenance(),
          Promise.resolve(onChanged?.()),
        ]);
      } catch (refreshError) {
        setError(
          refreshError.message ||
            "Maintenance started, but the current maintenance could not be refreshed."
        );
      }
    } catch (startError) {
      onActionNotification?.(
        startError.message || "Could not start maintenance.",
        "error",
        assetId
      );
    } finally {
      startRequestRef.current = false;
      setStartingRecordId(null);
    }
  };

  const completeMaintenance = async (record) => {
    if (
      !canManageMaintenance &&
      !(canOperateDueMaintenance && record.schedule_id != null &&
        (!record.planned_due_date || record.planned_due_date <= todayDateInput()))
    ) return;
    if (completingRecordId !== null) return;
    // Collect registration details before invoking the existing completion API.
    setSelectedRecord(null);
    setRegistrationRecord(record);
  };

  const submitMaintenanceRegistration = async (payload) => {
    const record = registrationRecord;
    if (!record || completingRecordId !== null) return;
    setCompletingRecordId(record.id);
    setError("");
    try {
      // Reuse the existing completion endpoint after the shared registration form is submitted.
      await api.post(`/maintenance/${record.id}/complete`, payload);
      setRegistrationRecord(null);
      await Promise.all([
        loadCurrentMaintenance(),
        Promise.resolve(onChanged?.()),
      ]);
    } catch (completeError) {
      setError(completeError.message || "Could not register maintenance completion.");
    } finally {
      setCompletingRecordId(null);
    }
  };

  if (loading && records.length === 0) {
    return <LoadingIndicator compact message="Loading maintenance" />;
  }

  const displayedRecords = showCompleted ? completedRecords : records;

  return (
    <>
      {showCompleted && (
        <h3 className="current-maintenance-heading">Completed maintenance</h3>
      )}
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && (
        <div className="banner success" role="status">
          <p>{notice}</p>
        </div>
      )}
      {showCompleted && displayedRecords.length === 0 ? (
        error ? null : (
          <EmptyState
            art={false}
            title="No completed scheduled maintenance"
            lines={["Completed scheduled maintenance will appear here."]}
          />
        )
      ) : (
      <div className="rule-list current-maintenance-list">
        {displayedRecords.map((record) => {
          const inProgress = record.status === "in_progress";
          const completed = record.status === "completed";
          const overdue =
            !completed &&
            record.status === "planned" &&
            record.planned_due_date < todayDateInput();
          return (
            <article
              className={`rule-card rule-row current-maintenance-card ${completed ? "completed" : inProgress ? "in-progress" : "due"}`}
              key={record.id}
            >
              <span className={`sev ${completed ? "ok" : "warning"}`} aria-hidden="true" />
              <div className="rule-name rule-card-main">
                <strong>{record.title}</strong>
                <small className="rule-context">
                  {record.maintenance_type || "Maintenance"} · {record.priority || "medium"} priority
                </small>
              </div>
              <div className="rule-evaluation">
                <span className="badge">
                  {completed
                    ? "Completed"
                    : inProgress
                      ? "In progress"
                      : record.rule_context && (ruleSchedules[record.schedule_id] && ruleSchedules[record.schedule_id].source_parameter_id == null)
                        ? "Unavailable — rule deleted"
                      : isLockedUntilDue(record)
                        ? "Not Due"
                        : record.rule_context && record.start_eligibility === "ready"
                          ? "Ready to Start"
                      : overdue
                        ? "Overdue"
                        : record.planned_due_date
                          ? "Due today"
                          : "Due"}
                </span>
                {(() => {
                  const schedule = ruleSchedules[record.schedule_id];
                  const context = record.rule_context || {};
                  if (!schedule && !context.rule_name) return null;
                  const unit = schedule?.threshold_unit || context.threshold_unit || "";
                  return (
                    <small className="rule-context">
                      {schedule?.source_rule_name || context.rule_name} · {schedule?.source_parameter_name || context.parameter_name}
                      {" · Current "}{formatNumber(schedule?.current_progress)} {unit}
                      {" · Due at "}{formatNumber(schedule?.due_threshold ?? context.due_threshold)} {unit}
                      {schedule?.created_at ? ` · Created ${new Date(schedule.created_at).toLocaleDateString()}` : ""}
                    </small>
                  );
                })()}
                <small>
                  {record.planned_due_date ? displayDate(record.planned_due_date) : ""}
                  {record.planned_due_date && record.assigned_technician ? " · " : ""}
                  {record.assigned_technician
                    ? ` · ${record.assigned_technician}`
                    : ""}
                </small>
              </div>
              <div className="rule-card-actions current-maintenance-actions">
                {record.rule_context && record.schedule_id != null && !completed && (
                  // Rule-created maintenance is started and completed only from Logbook -> Schedule Details.
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={() => navigate(
                      `/assets/${assetId}/maintenance/schedules/${record.schedule_id}/details`,
                      { state: { from: captureNavigationOrigin(location, {
                        ...(navigationState || location.state),
                        activeTab: "status",
                      }) } }
                    )}
                    title="Open the schedule in the Maintenance Logbook to start or complete it."
                  >
                    {inProgress ? "Open to complete"
                      : isLockedUntilDue(record) || (ruleSchedules[record.schedule_id] && ruleSchedules[record.schedule_id].source_parameter_id == null) ? "View schedule"
                      : "Open to start"}
                  </button>
                )}
                {!record.rule_context && !inProgress && !completed && (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => startMaintenance(record)}
                    disabled={
                      startingRecordId !== null ||
                      isLockedUntilDue(record) ||
                      (!canManageMaintenance &&
                        !(canOperateDueMaintenance &&
                          record.schedule_id != null &&
                          (!record.planned_due_date || record.planned_due_date <= todayDateInput())))
                    }
                    title={
                      isLockedUntilDue(record)
                        ? NOT_DUE_TITLE
                        : !canManageMaintenance &&
                      !(canOperateDueMaintenance &&
                        record.schedule_id != null &&
                        (!record.planned_due_date || record.planned_due_date <= todayDateInput()))
                        ? "Operators can start scheduled maintenance due today or overdue."
                        : undefined
                    }
                  >
                    {startingRecordId === record.id ? "Starting…" : "Start"}
                  </button>
                )}
                <div className="current-maintenance-action-menu">
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
                      <FloatingMenu
                        align="right"
                        role="menu"
                        data-current-maintenance-action-menu=""
                        data-maintenance-action-menu=""
                      >
                        <button
                          type="button"
                          className="maintenance-action-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setActionMenuRecordId(null);
                            setSelectedRecord(record);
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
                          disabled={
                            !canManageMaintenance ||
                            inProgress ||
                            completed ||
                            busy
                          }
                          title={
                            inProgress
                              ? "In-progress maintenance cannot be edited."
                              : completed
                                ? "Completed maintenance cannot be edited."
                                : !canManageMaintenance
                                  ? "You do not have permission to edit maintenance records."
                                  : undefined
                          }
                        >
                          <Pencil size={16} aria-hidden="true" />
                          <span>Edit maintenance</span>
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
                            disabled={!recordDeleteState(record, { isAdministrator, busy }).enabled}
                            title={recordDeleteState(record, { isAdministrator, busy }).reason}
                          >
                            <Trash2 size={16} aria-hidden="true" />
                            <span>Delete Maintenance</span>
                          </button>
                        )}
                      </FloatingMenu>
                    )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      )}
      {selectedRecord && (
        <Modal
          title="Maintenance details"
          onClose={() => setSelectedRecord(null)}
          wide
        >          
          <MaintenanceDetails record={selectedRecord} now={clockNow} />
          <div className="modal-actions">
            {selectedRecord.status === "in_progress" && !selectedRecord.rule_context && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => completeMaintenance(selectedRecord)}
                disabled={
                  completingRecordId !== null ||
                  (!canManageMaintenance &&
                    !(canOperateDueMaintenance &&
                      selectedRecord.schedule_id != null &&
                      (!selectedRecord.planned_due_date || selectedRecord.planned_due_date <= todayDateInput())))
                }
                title={
                  !canManageMaintenance &&
                  !(canOperateDueMaintenance &&
                    selectedRecord.schedule_id != null &&
                    (!selectedRecord.planned_due_date || selectedRecord.planned_due_date <= todayDateInput()))
                    ? "Operators can complete scheduled maintenance due today or overdue."
                    : undefined
                }
              >
                {completingRecordId === selectedRecord.id
                  ? "Completing…"
                  : "Complete maintenance"}
              </button>
            )}
            <button
              type="button"
              className="btn-outline"
              onClick={() => openEdit(selectedRecord)}
              disabled={
                busy ||
                !canManageMaintenance ||
                selectedRecord.status === "in_progress" ||
                selectedRecord.status === "completed"
              }
              title={
                selectedRecord.status === "in_progress"
                  ? "In-progress maintenance cannot be edited."
                  : selectedRecord.status === "completed"
                    ? "Completed maintenance cannot be edited."
                    : !canManageMaintenance
                      ? "You do not have permission to edit maintenance records."
                      : undefined
              }
            >
              <Pencil size={13} /> Edit
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => setSelectedRecord(null)}
              disabled={completingRecordId !== null}
            >
              Close
            </button>
          </div>
          {error && <p className="notice error" role="alert">{error}</p>}
        </Modal>
      )}
      {registrationRecord && (
        <MaintenanceRegistrationDialog
          record={registrationRecord}
          defaultTechnician={user?.username}
          busy={completingRecordId !== null}
          error={error}
          onClose={() => {
            if (completingRecordId === null) setRegistrationRecord(null);
          }}
          onSubmit={submitMaintenanceRegistration}
        />
      )}
    </>
  );
}
