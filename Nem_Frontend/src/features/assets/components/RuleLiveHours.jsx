import React, { useEffect, useRef, useState } from "react";
import { api } from "../../../services/api.js";
import { createLiveUpdateScheduler, shareInFlight, subscribeLiveUpdates } from "../../../services/liveUpdates.js";
import { liveHours, useDisplayClock } from "../../rules/components/durationClock.js";
import { formatDurationHours } from "../../../utils/format.js";

const RELEVANT_TABLES = new Set([
  "nem_rule_states", "nem_rule_parameter_states", "nem_rule_parameters", "nem_alerts", "nem_monitoring_rules",
]);
const FALLBACK_POLL_MS = 30000;

// Current progress (HH:MM:SS) of a rule-generated maintenance schedule that is measured in hours.
// The schedule row only stores progress in coarse steps, so, exactly like the rule status page, the value
// is extrapolated each second from the rule parameter's live baseline (liveHours) and re-synchronised on live
// updates. It never decides on its own that the machine is running; counters and anything without a live baseline
// simply show the stored `current_progress` (the `fallback`).
export default function RuleLiveHours({ schedule }) {
  const ruleId = schedule?.source_rule_id;
  const parameterId = schedule?.source_parameter_id;
  const enabled = schedule?.status === "active" && ruleId != null && parameterId != null;
  const [parameter, setParameter] = useState(null);
  const offsetRef = useRef(0);
  const shown = useRef({ hours: null, baseline: null });
  const clock = useDisplayClock();

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let sequence = 0;
    const load = async () => {
      const mine = ++sequence;
      try {
        const detail = await shareInFlight(`rule-status-detail:${ruleId}`, () => api.get(`/rules/${ruleId}/status-detail`), { fresh: true });
        if (disposed || mine !== sequence) return;
        const serverMs = Date.parse(detail.server_time);
        if (Number.isFinite(serverMs)) {
          const offset = serverMs - Date.now();
          if (Math.abs(offset - offsetRef.current) > 1500) offsetRef.current = offset;
        }
        setParameter((detail.parameters || []).find((item) => Number(item.id) === Number(parameterId)) || null);
      } catch {
        // Keep showing the stored value when the live detail cannot be loaded.
      }
    };
    load();
    const refresh = createLiveUpdateScheduler(load, 250);
    const unsubscribe = subscribeLiveUpdates((update) => {
      if (update.type === "connected" || update.type === "reconnected") { refresh(); return; }
      if (update.type !== "database_change") return;
      if ((update.changed_tables || []).some((table) => RELEVANT_TABLES.has(table)) || update.resync_required) refresh();
    });
    const poll = window.setInterval(refresh, FALLBACK_POLL_MS);
    return () => {
      disposed = true;
      unsubscribe();
      refresh.dispose();
      window.clearInterval(poll);
    };
  }, [enabled, ruleId, parameterId]);

  const stored = Number(schedule?.current_progress || 0);
  let hours = stored;
  if (enabled && parameter && parameter.live?.mode === "timer") {
    const computed = liveHours(parameter, clock + offsetRef.current);
    if (typeof computed === "number" && Number.isFinite(computed)) {
      hours = computed;
      const previous = shown.current;
      // Same baseline: time only moves forward. A new baseline slightly behind the local clock holds instead of jumping back.
      if (previous.hours !== null && parameter.live.baseline_at === previous.baseline) hours = Math.max(computed, previous.hours);
      else if (previous.hours !== null && computed < previous.hours && previous.hours - computed < 3 / 3600) hours = previous.hours;
      shown.current = { hours, baseline: parameter.live.baseline_at };
    }
  }
  return <>{formatDurationHours(hours)}</>;
}
