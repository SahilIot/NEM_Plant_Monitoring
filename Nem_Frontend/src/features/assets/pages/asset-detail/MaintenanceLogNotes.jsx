import React from "react";
import { formatTime } from "../../../../utils/format.js";
import { Download, Trash2 } from "lucide-react";
import { EmptyState } from "../../../../components/common/UI.jsx";

export default function MaintenanceLogNotes({ ctx }) {
  const {
    assetFileName,
    deleteLogEntry,
    deletingLogId,
    exportError,
    exportExcel,
    exportFileDate,
    exporting,
    filteredLogs,
    isAdministrator,
    logs,
    maintenanceEndDateTime,
    maintenanceStartDateTime,
    maintenanceTypeFilter,
    maintenanceTypes,
    setMaintenanceEndDateTime,
    setMaintenanceStartDateTime,
    setMaintenanceTypeFilter,
    setModal,
    setSelectedEntry,
  } = ctx;
  return (
    <div className="panel maintenance-log-notes-panel">
      <div className="panel-head maintenance-log-notes-head">
        <div>
          <h2>Maintenance Logbook</h2>
          <span className="muted">
            {filteredLogs.length} maintenance entries
          </span>
        </div>
        <button
          type="button"
          className="icon-outline sm export-icon"
          title={
            exporting
              ? "Preparing Excel export"
              : "Export filtered maintenance logbook entries to Excel"
          }
          aria-label="Export maintenance logbook entries to Excel"
          disabled={filteredLogs.length === 0 || exporting}
          onClick={() =>
            exportExcel({
              headers: ["Date and time", "Entry", "Entry type", "Technician"],
              rows: filteredLogs.map((entry) => [
                entry.time || entry.created_at
                  ? formatTime(entry.time || entry.created_at)
                  : "",
                entry.text || entry.title || entry.summary || "",
                entry.maintenance_type || "Note",
                entry.assigned_technician || "",
              ]),
              sheetName: "Maintenance logbook",
              fileName: `${assetFileName}-maintenance-logbook-${exportFileDate}.xlsx`,
              confirmMessage: `Download ${filteredLogs.length} filtered maintenance logbook entries as an Excel file?`,
            })
          }
        >
          <Download size={17} aria-hidden="true" />
        </button>
      </div>
      {exportError && (
        <p className="notice error" role="alert">
          {exportError}
        </p>
      )}

      <div
        className="maintenance-log-filters"
        aria-label="Filter maintenance logbook"
      >
        <label>
          <span>Entry type</span>
          <select
            value={maintenanceTypeFilter}
            onChange={(event) => setMaintenanceTypeFilter(event.target.value)}
          >
            <option value="">All types</option>
            {maintenanceTypes.map((type) => (
              <option key={type} value={type}>
                {type.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>From</span>
          <input
            type="datetime-local"
            value={maintenanceStartDateTime}
            onChange={(event) =>
              setMaintenanceStartDateTime(event.target.value)
            }
          />
        </label>

        <label>
          <span>To</span>
          <input
            type="datetime-local"
            value={maintenanceEndDateTime}
            onChange={(event) => setMaintenanceEndDateTime(event.target.value)}
          />
        </label>

        <button
          type="button"
          className="btn-outline"
          onClick={() => {
            setMaintenanceTypeFilter("");
            setMaintenanceStartDateTime("");
            setMaintenanceEndDateTime("");
          }}
          disabled={
            !maintenanceTypeFilter &&
            !maintenanceStartDateTime &&
            !maintenanceEndDateTime
          }
        >
          Clear filters
        </button>
        <span className="maintenance-log-filter-count">
          Showing {filteredLogs.length} of {logs.length} entries
        </span>
      </div>

      {filteredLogs.length === 0 ? (
        <EmptyState
          art={false}
          title={
            logs.length === 0
              ? "No maintenance entries"
              : "No entries match these filters"
          }
          lines={
            logs.length === 0
              ? ["Maintenance records and notes will appear here."]
              : []
          }
        />
      ) : (
        <div className="maintenance-table-wrap">
          <table className="table maintenance-notes-table">
            <thead>
              <tr>
                <th className="col-time">Date and time</th>
                <th>Entry</th>
                <th>Entry type</th>
                <th>Technician</th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>
              {filteredLogs.map((entry) => {
                const timestamp = entry.time || entry.created_at;

                return (
                  <tr key={entry.id}>
                    <td className="col-time">
                      {timestamp ? formatTime(timestamp) : "—"}
                    </td>

                    <td className="maintenance-note-text">
                      {entry.text || entry.title || entry.summary || "—"}
                    </td>

                    <td>{entry.maintenance_type || "Note"}</td>

                    <td>{entry.assigned_technician || "—"}</td>

                    <td>
                      <div className="maintenance-actions">
                        <button
                          type="button"
                          className="btn-outline"
                          onClick={() => {
                            setSelectedEntry(entry);
                            setModal("view");
                          }}
                          disabled={deletingLogId !== null}
                        >
                          View
                        </button>
                        <button
                          type="button"
                          className="maintenance-delete-icon"
                          title="Permanently delete maintenance log entry"
                          aria-label={`Permanently delete maintenance log entry ${entry.title || entry.summary || entry.id}`}
                          onClick={() => deleteLogEntry(entry)}
                          disabled={deletingLogId !== null || !isAdministrator}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
