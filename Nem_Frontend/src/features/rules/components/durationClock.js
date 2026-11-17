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
