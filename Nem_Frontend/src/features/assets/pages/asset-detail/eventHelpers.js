import { formatTime } from "../../../../utils/format.js";

export function eventActionLabel(eventType) {
  if (!eventType) return "Event";
  if (eventType === "alert_acknowledged") return "Alert Acknowledged";
  if (eventType === "rule_completed") return "Rule Completed";
  return eventType
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function eventAuditSummary(event) {
  const metadata = event?.metadata || {};
  const parts = [];
  if (metadata.acknowledged_by) {
    parts.push(`Acknowledged by ${metadata.acknowledged_by}`);
  }
  if (metadata.acknowledged_at) {
    parts.push(`at ${formatTime(metadata.acknowledged_at)}`);
  }
  if (metadata.completed_by) {
    parts.push(`Completed by ${metadata.completed_by}`);
  }
  if (metadata.completed_at) {
    parts.push(`at ${formatTime(metadata.completed_at)}`);
  }
  return parts.join(" · ");
}
