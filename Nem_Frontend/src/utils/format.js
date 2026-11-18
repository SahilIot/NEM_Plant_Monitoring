
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

