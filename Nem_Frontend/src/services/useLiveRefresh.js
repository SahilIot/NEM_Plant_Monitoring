import { useEffect, useRef } from "react";
import { createLiveUpdateScheduler, subscribeLiveUpdates } from "./liveUpdates.js";

/**
 * Re-run `load` when a live update says the data it shows has changed.
 *
 * The page still does its own first load through REST. After that, the shared WebSocket connection
 * (one per session) tells it when to refetch: after a matching change, after a reconnect and after any
 * missed message. Refreshes are coalesced and never overlap, so a slow response cannot overwrite a newer one.
 *
 * tables: database tables whose change matters. events: event-name prefixes (for example "alert.").
 * assetId: when given, changes that name only other assets are ignored.
 */
export function useLiveRefresh(load, { tables = [], events = [], delay = 250, enabled = true, assetId = null } = {}) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const key = `${tables.join(",")}|${events.join(",")}|${assetId}`;

  useEffect(() => {
    if (!enabled) return undefined;
    const refresh = createLiveUpdateScheduler(() => loadRef.current?.(), delay);
    const unsubscribe = subscribeLiveUpdates((update) => {
      if (update.resync_required) {
        refresh();
        return;
      }
      if (update.type !== "database_change") return;
      const assets = update.asset_ids || [];
      if (assetId !== null && assets.length > 0 && !assets.map(Number).includes(Number(assetId))) return;
      const changed = update.changed_tables || [];
      const named = update.events || [];
      if (tables.some((table) => changed.includes(table)) || events.some((prefix) => named.some((name) => name.startsWith(prefix)))) {
        refresh();
      }
    });
    return () => {
      unsubscribe();
      refresh.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delay, enabled]);
}
