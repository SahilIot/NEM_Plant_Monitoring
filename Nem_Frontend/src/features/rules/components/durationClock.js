import { useSyncExternalStore } from "react";

/*
 * One shared one-second display clock for every live duration on the page.
 * It only drives re-renders; the displayed value is always computed from the backend baseline and
 * Date.now(), so a throttled or paused tab simply catches up on the next tick.
 * The interval exists only while at least one component is subscribed.
 */
const listeners = new Set();
let timer = null;
let snapshot = Date.now();

function subscribe(listener) {
  listeners.add(listener);
  snapshot = Date.now();
  if (timer === null) {
    timer = window.setInterval(() => {
      snapshot = Date.now();
      listeners.forEach((notify) => notify());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export const useDisplayClock = () => useSyncExternalStore(subscribe, () => snapshot);

/** HH:MM:SS from hours. Hours never wrap at 24; sub-second precision is dropped for display only. */
export function formatDuration(hours) {
  const total = Math.max(0, Math.floor(Number(hours) * 3600 + 1e-6));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

const HOUR_MS = 3600000;

/**
 * Display value (hours) of an interval parameter at `nowMs` (server-aligned).
 * Uses only backend-provided baseline data (`p.value` as of `live.baseline_at`) and never decides on its own
 * that a machine is running: `live.running` / `live.running_until` come from the backend's latest reading and
 * its freshness limit, so interpolation stops exactly where the backend stops crediting time.
 */
export function liveHours(p, nowMs) {
  const live = p.live;
  if (!live || p.status === "unknown" || p.value === null || p.value === undefined) return p.value;
  if (live.mode === "calendar") {
    const start = Date.parse(p.schedule?.start_at);
    if (!Number.isFinite(start)) return p.value;
    return nowMs < start ? 0 : (nowMs - start) / HOUR_MS;
  }
  if (live.mode === "timer") {
    if (!live.running) return p.value;
    const baseline = Date.parse(live.baseline_at);
    const until = Date.parse(live.running_until);
    if (!Number.isFinite(baseline) || !Number.isFinite(until)) return p.value;
    // The backend may have credited time up to a reading stamped slightly after "now"; the (negative) offset
    // then lines the value up with the present instead of jumping ahead and stalling.
    return Number(p.value) + (Math.min(nowMs, until) - baseline) / HOUR_MS;
  }
  return p.value;
}

/** "3 days 04:05:06" (days omitted when zero). Pure display helper; `ms` is a non-negative millisecond span. */
export function formatCalendarSpan(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const days = Math.floor(total / 86400);
  const clock = formatDuration((total % 86400) / 3600);
  return days > 0 ? `${days} ${days === 1 ? "day" : "days"} ${clock}` : clock;
}

/** "27 November 2026, 09:30 AM" in the viewer's local timezone (date only for legacy date-only baselines). */
export function formatCalendarMoment(value, dateOnly = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const day = date.getDate(), month = date.toLocaleString("en-GB", { month: "long" }), year = date.getFullYear();
  if (dateOnly) return `${day} ${month} ${year}`;
  const h = date.getHours(), pad = (n) => String(n).padStart(2, "0");
  return `${day} ${month} ${year}, ${pad(h % 12 || 12)}:${pad(date.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * Live state of a Calendar Time parameter at `nowMs`, from the backend's saved baseline and calendar-computed
 * due/overdue instants (the same ones the evaluator uses). Returns null when the schedule is unusable.
 * Date-only (legacy) values are UTC dates: they are interpreted as 00:00 UTC, matching the backend's date semantics.
 */
export function calendarProgress(schedule, nowMs) {
  const parse = (v) => (v ? Date.parse(v) : NaN);
  const start = parse(schedule?.start_at), due = parse(schedule?.due_at), overdue = parse(schedule?.overdue_at);
  if (![start, due, overdue].every(Number.isFinite)) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(schedule.start_at));
  const phase = nowMs >= overdue ? "overdue" : nowMs >= due ? "due" : "normal";
  return {
    start, due, overdue, dateOnly, phase, notStarted: nowMs < start,
    elapsedMs: Math.max(0, nowMs - start), toStartMs: Math.max(0, start - nowMs),
    toDueMs: Math.max(0, due - nowMs), toOverdueMs: Math.max(0, overdue - nowMs), pastOverdueMs: Math.max(0, nowMs - overdue),
  };
}
