import React from "react";
import { eventActionLabel, eventAuditSummary } from "./eventHelpers.js";
import { Download, Trash2 } from "lucide-react";

export default function EventsTab({ ctx }) {
  const {
    assetFileName,
    deleteEvent,
    deletingEventId,
    eventDeleteError,
    eventEndDateTime,
    eventStartDateTime,
    eventTypeFilter,
    eventTypes,
    events,
    exportError,
    exportExcel,
    exportFileDate,
    exporting,
    filteredEvents,
    isAdministrator,
    setEventDeleteError,
    setEventEndDateTime,
    setEventStartDateTime,
    setEventTypeFilter,
    setSelectedEvent,
    setShowEventDetails,
  } = ctx;
  return (
    <div className="event-log-section">
      <div className="event-log-heading">
        <div>
          <h2>Event log</h2>
          <span className="muted">{filteredEvents.length} events</span>
        </div>
        <button
          type="button"
          className="icon-outline sm export-icon"
          title={
            exporting
              ? "Preparing Excel export"
              : "Export filtered events to Excel"
          }
          aria-label="Export event log to Excel"
          disabled={filteredEvents.length === 0 || exporting}
          onClick={() =>
            exportExcel({
              headers: [
                "Date and time",
                "Event",
                "Details",
                "Asset",
                "Assigned rule",
              ],
              rows: filteredEvents.map((event) => [
                event.time || event.occurred_at
                  ? new Date(event.time || event.occurred_at).toLocaleString()
                  : "",
                eventActionLabel(event.event_type),
                [event.text || event.message || "", eventAuditSummary(event)]
                  .filter(Boolean)
                  .join(" · "),
                event.asset_name ||
                  (event.asset_id != null
                    ? `Asset ${event.asset_id}`
                    : "System"),
                event.rule_name ||
                  event.assigned_rule ||
                  event.rule?.name ||
                  (event.event_type === "maintenance_completed"
                    ? "Maintenance"
                    : event.rule_id != null
                      ? `Rule #${event.rule_id}`
                      : "Not assigned"),
              ]),
              sheetName: "Event log",
              fileName: `${assetFileName}-event-log-${exportFileDate}.xlsx`,
              confirmMessage: `Download ${filteredEvents.length} filtered events as an Excel file?`,
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
      {eventDeleteError && (
        <div className="event-log-error" role="alert">
          {eventDeleteError}
        </div>
      )}
      <div className="event-log-filters" aria-label="Filter event log">
        <label>
          <span>Event</span>
          <select
            value={eventTypeFilter}
            onChange={(event) => setEventTypeFilter(event.target.value)}
          >
            <option value="">All events</option>
            {eventTypes.map((eventType) => (
              <option key={eventType} value={eventType}>
                {eventActionLabel(eventType)}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>From</span>
          <input
            type="datetime-local"
            value={eventStartDateTime}
            onChange={(event) => setEventStartDateTime(event.target.value)}
          />
        </label>

        <label>
          <span>To</span>
          <input
            type="datetime-local"
            value={eventEndDateTime}
            onChange={(event) => setEventEndDateTime(event.target.value)}
          />
        </label>

        <button
          type="button"
          className="btn-outline"
          onClick={() => {
            setEventTypeFilter("");
            setEventStartDateTime("");
            setEventEndDateTime("");
          }}
          disabled={
            !eventTypeFilter && !eventStartDateTime && !eventEndDateTime
          }
        >
          Clear filters
        </button>
        <span className="event-filter-count">
          Showing {filteredEvents.length} of {events.length} events
        </span>
      </div>

      <div className="table-responsive">
        <table className="data-table event-log-table">
          <thead>
            <tr>
              <th>Date &amp; Time</th>
              <th>Event</th>
              <th>Asset</th>
              <th>Assigned Rule</th>
              <th>Actions</th>
            </tr>
          </thead>

          <tbody>
            {filteredEvents.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty-state">
                  {events.length === 0
                    ? "No events found."
                    : "No events match these filters."}
                </td>
              </tr>
            ) : (
              filteredEvents.map((event) => {
                const assignedRule =
                  event.rule_name ||
                  event.assigned_rule ||
                  event.rule?.name ||
                  (event.event_type === "maintenance_completed"
                    ? "Maintenance"
                    : null) ||
                  (event.rule_id != null
                    ? `Rule #${event.rule_id}`
                    : "Not assigned");

                const eventTime =
                  event.time || event.occurred_at
                    ? new Date(event.time || event.occurred_at).toLocaleString()
                    : "—";

                return (
                  <tr key={event.id}>
                    <td>{eventTime}</td>

                    <td>
                      <strong>{eventActionLabel(event.event_type)}</strong>
                      <div>{event.text || event.message || "—"}</div>
                      {eventAuditSummary(event) && (
                        <small className="muted">
                          {eventAuditSummary(event)}
                        </small>
                      )}
                    </td>

                    <td>
                      {event.asset_name ||
                        (event.asset_id != null
                          ? `Asset ${event.asset_id}`
                          : "System")}
                    </td>

                    <td>{assignedRule}</td>

                    <td>
                      <div className="event-row-actions">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setEventDeleteError("");
                            setSelectedEvent(event);
                            setShowEventDetails(true);
                          }}
                        >
                          View
                        </button>
                        <button
                          type="button"
                          className="event-delete-icon"
                          title={
                            !isAdministrator
                              ? "Administrator access required to delete events."
                              : "Permanently delete event"
                          }
                          aria-label={`Permanently delete ${eventActionLabel(event.event_type)} event`}
                          disabled={
                            deletingEventId !== null || !isAdministrator
                          }
                          onClick={() => deleteEvent(event)}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
