// Delete eligibility for maintenance records and schedules. It mirrors the server rules in
// Nem_Backend/app/api/routes/maintenance.py so a button is only offered when the request can succeed; the server stays
// the authority (Administrator-only endpoints, 409 on any protected case) and its message is shown if it still refuses.

export const RULE_PROTECTED_REASON =
  "Maintenance created from a monitoring rule is protected: it is controlled by its rule and its history is preserved. Deactivate or edit the rule instead.";
export const IN_PROGRESS_REASON = "In-progress maintenance cannot be deleted. Complete it first.";
export const SCHEDULE_HISTORY_REASON =
  "This schedule has maintenance records, so its history must be preserved and it cannot be deleted. Cancel the schedule instead to stop future maintenance.";

// Only Administrators see Delete at all (Supervisors and Operators never get the item).
export function recordDeleteState(record, { isAdministrator, busy = false, records = [] }) {
  if (!isAdministrator) return { visible: false, enabled: false, reason: "" };
  const finished = record.status === "completed" || record.status === "cancelled";
  if (record.rule_context != null && !finished) return { visible: true, enabled: false, reason: RULE_PROTECTED_REASON };
  if (record.status === "in_progress") return { visible: true, enabled: false, reason: IN_PROGRESS_REASON };
  const series = record.status === "planned" && record.schedule_id != null;
  if (series && records.some((item) => item.schedule_id === record.schedule_id && item.status === "in_progress")) {
    return {
      visible: true,
      enabled: false,
      reason: "Another maintenance in this recurring series is in progress. Complete it before deleting the series.",
    };
  }
  if (busy) return { visible: true, enabled: false, reason: "Another maintenance action is in progress. Please wait." };
  return {
    visible: true,
    enabled: true,
    reason: series
      ? "Permanently delete this maintenance together with its whole recurring schedule and records"
      : "Permanently delete this maintenance",
  };
}

export function scheduleDeleteState(schedule, { isAdministrator, busy = false, records = [] }) {
  if (!isAdministrator) return { visible: false, enabled: false, reason: "" };
  if (schedule.schedule_mode === "rule") {
    const open = records.some((item) => item.schedule_id === schedule.id && item.status !== "completed" && item.status !== "cancelled");
    if (schedule.status !== "cancelled" || open) return { visible: true, enabled: false, reason: RULE_PROTECTED_REASON };
    if (busy) return { visible: true, enabled: false, reason: "Another maintenance action is in progress. Please wait." };
    return { visible: true, enabled: true, reason: "Permanently delete this cancelled rule schedule together with its finished records" };
  }
  if (schedule.status === "cancelled") {
    if (records.some((item) => item.schedule_id === schedule.id && item.status === "in_progress")) {
      return { visible: true, enabled: false, reason: IN_PROGRESS_REASON };
    }
    if (busy) return { visible: true, enabled: false, reason: "Another maintenance action is in progress. Please wait." };
    return { visible: true, enabled: true, reason: "Permanently delete this cancelled schedule together with its records" };
  }
  if (schedule.current_occurrence_id != null || records.some((item) => item.schedule_id === schedule.id)) {
    return { visible: true, enabled: false, reason: SCHEDULE_HISTORY_REASON };
  }
  if (busy) return { visible: true, enabled: false, reason: "Another maintenance action is in progress. Please wait." };
  return { visible: true, enabled: true, reason: "Permanently delete this schedule (it has no maintenance records)" };
}

// Text for the confirmation dialog: names the item and states exactly what the server will remove.
export function recordDeleteConfirmation(record, { assetName } = {}) {
  const name = record.title || record.summary || `maintenance #${record.id}`;
  const status = String(record.status || "planned").replaceAll("_", " ");
  const technician = record.assigned_technician || record.performed_by;
  const details = [
    `Maintenance: ${name}`,
    assetName ? `Asset: ${assetName}` : null,
    `Status: ${status}`,
    technician ? `Technician: ${technician}` : null,
  ].filter(Boolean).join("\n");
  if (record.status === "planned" && record.schedule_id != null) {
    return `Permanently delete this planned maintenance?\n\n${details}\n\nThis deletes the complete recurring schedule it belongs to: the schedule itself, ALL of its maintenance records and history, and its active notifications. This cannot be undone.`;
  }
  const kind = record.status === "completed" || record.status === "cancelled" ? `${record.status} ` : "";
  return `Delete this ${kind}maintenance record permanently?\n\n${details}\n\nOnly this selected maintenance record is permanently removed and this cannot be undone. Its schedule, the other maintenance records, alerts and shared documents are kept.`;
}
