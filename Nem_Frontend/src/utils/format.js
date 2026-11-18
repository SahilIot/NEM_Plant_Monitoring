
export function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Full local-timezone date/time for audit fields; "Unknown" when never recorded.
export function formatAuditTime(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString([], {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Date only (e.g. "Oct 23, 2026") for compact list lines.
export function formatAuditDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function auditUser(value) {
  return value || "Unknown";
}

export function timeAgo(value, now = Date.now()) {
  if (!value) return "never";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return String(value);
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return "0h 0m 0s";
  const wholeSeconds = Math.floor(total);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${wholeSeconds % 60}s`;
}

export function formatValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? String(value)
      : value.toLocaleString([], { maximumFractionDigits: 2 });
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

// Elapsed time as HH:MM:SS. Hours keep growing past 24 (never wrapped to days). Rounded to the nearest second so
// float noise (1.1 h = 3960.0000000000005 s) cannot show as 01:05:59. Null, non-numeric, negative and infinite
// input show 00:00:00. Display only: callers keep the stored value for calculations.
export function formatClock(seconds) {
  const value = seconds === null || seconds === undefined || seconds === "" ? NaN : Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "00:00:00";
  const total = Math.round(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

// Same, for a value stored in hours (runtime schedule progress and limits).
export function formatDurationHours(hours) {
  const value = hours === null || hours === undefined || hours === "" ? NaN : Number(hours);
  return formatClock(value * 3600);
}

// True for the unit names the backend uses for time-based progress (rule schedules report "hours").
export const isHoursUnit = (unit) => /^hours?$/i.test(String(unit || "").trim());
