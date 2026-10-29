import { api } from "../../../../../services/api.js";

// Maintenance logbook filtering, adding and deleting entries.
export default function useMaintenanceLog(ctx) {
  const {
    logs,
    maintenanceTypeFilter,
    maintenanceStartDateTime,
    maintenanceEndDateTime,
    canManageLogbook,
    assetId,
    setModal,
    loadLogs,
    isAdministrator,
    deletingLogId,
    confirm,
    setDeletingLogId,
    setLoadError,
    refreshStatus,
  } = ctx;

  const maintenanceTypes = [
    ...new Set(logs.map((entry) => entry.maintenance_type).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));

  const filteredLogs = [...logs]
    .filter((entry) => {
      if (
        maintenanceTypeFilter &&
        entry.maintenance_type !== maintenanceTypeFilter
      ) {
        return false;
      }
      const timestamp = new Date(
        entry.time || entry.created_at || "",
      ).getTime();
      const start = maintenanceStartDateTime
        ? new Date(maintenanceStartDateTime).getTime()
        : Number.NaN;
      const end = maintenanceEndDateTime
        ? new Date(maintenanceEndDateTime).getTime()
        : Number.NaN;
      if (
        Number.isFinite(start) &&
        (!Number.isFinite(timestamp) || timestamp < start)
      ) {
        return false;
      }
      if (
        Number.isFinite(end) &&
        (!Number.isFinite(timestamp) || timestamp > end)
      ) {
        return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        new Date(b.time || b.created_at || 0).getTime() -
        new Date(a.time || a.created_at || 0).getTime(),
    );

  const addLog = async (values) => {
    if (!canManageLogbook) return;
    if (!values.text?.trim()) {
      throw new Error("Enter a logbook entry.");
    }

    await api.post(`/assets/${assetId}/logbook`, {
      text: values.text.trim(),
    });

    setModal(null);
    loadLogs();
  };

  const deleteLogEntry = async (entry) => {
    if (!isAdministrator || deletingLogId !== null) return;
    if (
      !(await confirm(
        "Permanently delete this maintenance log entry? This cannot be undone.",
        {
          title: "Delete maintenance entry",
          confirmLabel: "Delete permanently",
          destructive: true,
        },
      ))
    ) {
      return;
    }

    setDeletingLogId(entry.id);
    setLoadError("");
    try {
      await api.del(`/maintenance/${entry.id}/permanent`);
      await loadLogs();
      await refreshStatus?.();
    } catch (error) {
      setLoadError(
        error.message || "Could not permanently delete this maintenance entry.",
      );
    } finally {
      setDeletingLogId(null);
    }
  };

  return {
    maintenanceTypes,
    filteredLogs,
    addLog,
    deleteLogEntry,
  };
}
