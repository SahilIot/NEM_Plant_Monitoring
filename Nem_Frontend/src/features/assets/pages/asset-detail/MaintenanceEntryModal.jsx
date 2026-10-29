import React from "react";
import { Modal } from "../../../../components/common/UI.jsx";
import { formatDuration, formatTime } from "../../../../utils/format.js";

export default function MaintenanceEntryModal({ ctx }) {
  const { selectedEntry, setModal, setSelectedEntry } = ctx;
  return (
    <Modal
      title="Maintenance Logbook Entry"
      onClose={() => {
        setModal(null);
        setSelectedEntry(null);
      }}
      wide
    >
      <dl className="rule-detail-grid">
        <div>
          <dt>Date and time</dt>
          <dd>
            {selectedEntry.time || selectedEntry.created_at
              ? formatTime(selectedEntry.time || selectedEntry.created_at)
              : "—"}
          </dd>
        </div>

        <div>
          <dt>Entry</dt>
          <dd>
            {selectedEntry.text ||
              selectedEntry.title ||
              selectedEntry.summary ||
              "—"}
          </dd>
        </div>

        <div>
          <dt>Entry type</dt>
          <dd>{selectedEntry.maintenance_type || "Note"}</dd>
        </div>

        <div>
          <dt>Technician</dt>
          <dd>{selectedEntry.assigned_technician || "—"}</dd>
        </div>

        <div>
          <dt>Priority</dt>
          <dd>{selectedEntry.priority || "—"}</dd>
        </div>

        <div>
          <dt>Actual start</dt>
          <dd>
            {selectedEntry.actual_started_at
              ? formatTime(selectedEntry.actual_started_at)
              : "—"}
          </dd>
        </div>

        <div>
          <dt>Actual completion</dt>
          <dd>
            {selectedEntry.actual_completed_at
              ? formatTime(selectedEntry.actual_completed_at)
              : "—"}
          </dd>
        </div>

        <div>
          <dt>Actual duration</dt>
          <dd>
            {Number.isFinite(selectedEntry.actual_duration_seconds)
              ? formatDuration(selectedEntry.actual_duration_seconds)
              : "—"}
          </dd>
        </div>

        {selectedEntry.notes && (
          <div>
            <dt>Notes</dt>
            <dd>{selectedEntry.notes}</dd>
          </div>
        )}

        {selectedEntry.completion_notes && (
          <div>
            <dt>Completion notes</dt>
            <dd>{selectedEntry.completion_notes}</dd>
          </div>
        )}

        {selectedEntry.parts_used && (
          <div>
            <dt>Parts used</dt>
            <dd>{selectedEntry.parts_used}</dd>
          </div>
        )}

        {Array.isArray(selectedEntry.checklist) &&
          selectedEntry.checklist.length > 0 && (
            <div>
              <dt>Checklist</dt>
              <dd>
                {selectedEntry.checklist
                  .map(
                    (item) =>
                      `${item.completed ? "Complete" : "Incomplete"}: ${item.item}`,
                  )
                  .join(", ")}
              </dd>
            </div>
          )}

        {selectedEntry.id != null && (
          <div>
            <dt>Entry ID</dt>
            <dd>{selectedEntry.id}</dd>
          </div>
        )}
      </dl>

      <div className="modal-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            setModal(null);
            setSelectedEntry(null);
          }}
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
