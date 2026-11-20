import { api } from "../../../services/api.js";

const names = (items) => items.map((item) => `"${item.name}"`).join(", ");

/**
 * Manual progress reset of one interval or of every eligible interval of a rule.
 * `url` is POST /rules/{rule}/parameters/{parameter}/reset-progress or POST /rules/{rule}/reset-progress.
 * A dry run first lists exactly which intervals are affected, the user confirms, then the real request runs.
 * Resolves to { cancelled: true } or { cancelled: false, message }; request errors are thrown.
 */
export async function confirmAndResetProgress({ confirm, url, ruleName, single = false }) {
  const preview = await api.post(url, { dry_run: true });
  const affected = preview.reset || [];
  const skipped = preview.skipped || [];
  if (affected.length === 0) {
    throw new Error(
      skipped.length
        ? skipped.map((item) => `${item.name}: ${item.reason}`).join(" ")
        : "There is no interval to reset."
    );
  }
  const message =
    `Reset progress of ${single ? "interval" : `${affected.length} interval(s)`} ${names(affected)} in rule "${ruleName}"? ` +
    "Counting restarts from now, the saved progress and the alerts of these intervals only are cleared, and an unstarted maintenance for them is replaced by a new cycle. " +
    "Other parameters are not changed. This cannot be undone." +
    (skipped.length ? ` Not reset: ${skipped.map((item) => `${item.name} (${item.reason})`).join("; ")}` : "");
  if (!(await confirm(message, {
    title: single ? "Reset interval progress?" : "Reset all intervals?",
    confirmLabel: "Reset progress",
    cancelLabel: "Cancel",
    destructive: true,
  }))) {
    return { cancelled: true };
  }
  const result = await api.post(url, { dry_run: false });
  const done = result.reset || [];
  const left = result.skipped || [];
  return {
    cancelled: false,
    message: `Progress reset for ${names(done)}.` + (left.length ? ` Not reset: ${left.map((item) => item.name).join(", ")}.` : ""),
  };
}
