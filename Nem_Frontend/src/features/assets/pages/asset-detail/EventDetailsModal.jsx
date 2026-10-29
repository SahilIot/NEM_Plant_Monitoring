import React from "react";
import { Modal } from "../../../../components/common/UI.jsx";
import { eventActionLabel } from "./eventHelpers.js";
import { formatTime } from "../../../../utils/format.js";
import { Trash2 } from "lucide-react";

export default function EventDetailsModal({ ctx }) {
  const {
    deleteEvent,
    deletingEventId,
    eventDeleteError,
    isAdministrator,
    selectedEvent,
    setSelectedEvent,
    setShowEventDetails,
  } = ctx;
  return (
    <Modal
      title="Event Details"
      onClose={() => {
        setShowEventDetails(false);
        setSelectedEvent(null);
      }}
    >
      <div className="event-details-content">
        {eventDeleteError && (
          <p className="event-log-error" role="alert">
            {eventDeleteError}
          </p>
        )}
        <p>
          <strong>Date &amp; Time:</strong>{" "}
          {selectedEvent.time || selectedEvent.occurred_at
            ? new Date(
                selectedEvent.time || selectedEvent.occurred_at,
              ).toLocaleString()
            : "—"}
        </p>

        <p>
          <strong>Action:</strong> {eventActionLabel(selectedEvent.event_type)}
        </p>

        <p>
          <strong>Event details:</strong>{" "}
          {selectedEvent.text || selectedEvent.message || "—"}
        </p>
        {selectedEvent.metadata?.acknowledged_by && (
          <>
            <p>
              <strong>Acknowledged by:</strong>{" "}
              {selectedEvent.metadata.acknowledged_by}
            </p>
            <p>
              <strong>Acknowledged at:</strong>{" "}
              {selectedEvent.metadata.acknowledged_at
                ? formatTime(selectedEvent.metadata.acknowledged_at)
                : selectedEvent.time || selectedEvent.occurred_at
                  ? formatTime(selectedEvent.time || selectedEvent.occurred_at)
                  : "—"}
            </p>
          </>
        )}
        {selectedEvent.metadata?.completed_by && (
          <>
            <p>
              <strong>Completed by:</strong>{" "}
              {selectedEvent.metadata.completed_by}
            </p>
            <p>
              <strong>Completed at:</strong>{" "}
              {selectedEvent.metadata.completed_at
                ? formatTime(selectedEvent.metadata.completed_at)
                : selectedEvent.time || selectedEvent.occurred_at
                  ? formatTime(selectedEvent.time || selectedEvent.occurred_at)
                  : "—"}
            </p>
            <p>
              <strong>Result:</strong> Rule successfully completed.
            </p>
          </>
        )}

        <p>
          <strong>Asset:</strong>{" "}
          {selectedEvent.asset_name ||
            (selectedEvent.asset_id != null
              ? `Asset ${selectedEvent.asset_id}`
              : "System")}
        </p>

        <p>
          <strong>Assigned Rule:</strong>{" "}
          {selectedEvent.rule_name ||
            selectedEvent.assigned_rule ||
            selectedEvent.rule?.name ||
            (selectedEvent.rule_id != null
              ? `Rule #${selectedEvent.rule_id}`
              : "Not assigned")}
        </p>
        <div className="event-details-actions">
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              setShowEventDetails(false);
              setSelectedEvent(null);
            }}
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
