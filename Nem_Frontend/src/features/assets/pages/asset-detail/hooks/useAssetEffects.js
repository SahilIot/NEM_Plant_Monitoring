import { useEffect } from "react";
import { subscribeLiveUpdates } from "../../../../../services/liveUpdates.js";
import { api } from "../../../../../services/api.js";

// Effects: reset on asset change, runtime clock, navigation notices, live updates, event log fetch.
export default function useAssetEffects(ctx) {
  const {
    setTab,
    setList,
    setFilter,
    setRules,
    setAllVariables,
    setRuntimeReadings,
    setVariables,
    setLogs,
    setMaintenanceTypeFilter,
    setMaintenanceStartDateTime,
    setMaintenanceEndDateTime,
    setEvents,
    setEventTypeFilter,
    setEventStartDateTime,
    setEventEndDateTime,
    setSelectedEvent,
    setShowEventDetails,
    setLoadError,
    loadVariables,
    loadLogs,
    loadLive,
    seq,
    assetId,
    rules,
    setClockNow,
    location,
    setActionNotice,
    navigate,
    liveScheduler,
    tab,
    eventsScheduler,
    children,
    assets,
    connectionScheduler,
    statusScheduler,
  } = ctx;

  useEffect(() => {
    setTab("status");
    setList("activated");
    setFilter("");
    setRules([]);
    setAllVariables([]);
    setRuntimeReadings(new Map());
    setVariables([]);
    setLogs([]);
    setMaintenanceTypeFilter("");
    setMaintenanceStartDateTime("");
    setMaintenanceEndDateTime("");
    setEvents([]);
    setEventTypeFilter("");
    setEventStartDateTime("");
    setEventEndDateTime("");
    setSelectedEvent(null);
    setShowEventDetails(false);
    setLoadError("");

    loadVariables();
    loadLogs();
    loadLive();

    return () => {
      seq.current += 1;
    };
  }, [assetId, loadVariables, loadLogs, loadLive]);

  const hasRuntimeRules = rules.some(
    (rule) => rule.rule_type === "runtime_duration",
  );

  useEffect(() => {
    if (!hasRuntimeRules) return;

    let timer;
    const updateClock = () => {
      setClockNow(Date.now());
      timer = window.setTimeout(updateClock, 1000 - (Date.now() % 1000));
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      updateClock();
    };

    updateClock();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [hasRuntimeRules]);

  useEffect(() => {
    const navigationState = location.state;

    if (navigationState?.activeTab === "logbook") {
      setTab("status");
    }

    if (navigationState?.createdNotice) {
      setActionNotice(navigationState.createdNotice);
    }

    if (navigationState?.activeTab || navigationState?.createdNotice) {
      navigate(location.pathname, {
        replace: true,
        state: null,
      });
    }
  }, [location.pathname, location.state, navigate]);

  useEffect(() => {
    return subscribeLiveUpdates((update) => {
      if (update.resync_required) {
        liveScheduler();
        loadVariables();
        loadLogs();
        if (tab === "events") eventsScheduler();
        return;
      }
      if (update.type === "disconnected") return;
      const changedTables = new Set(update.changed_tables || []);
      const relevantTables = [
        "assets",
        "variables",
        "readings",
        "nem_readings",
        "nem_monitoring_rules",
        "nem_rule_states",
        "nem_rule_counter_states",
        "machine_monitoring_states",
        "nem_alerts",
        "nem_maintenance_records",
        "nem_maintenance_schedules",
        "nem_monitoring_events",
      ];
      if (
        update.type !== "opcua_status" &&
        !relevantTables.some((table) => changedTables.has(table))
      ) {
        return;
      }
      const affectedAssets = update.asset_ids || [];
      const displayedAssetIds = new Set([assetId]);
      if (children) {
        let expanded = true;
        while (expanded) {
          expanded = false;
          for (const candidate of assets) {
            if (
              candidate.parent_asset_id != null &&
              displayedAssetIds.has(candidate.parent_asset_id) &&
              !displayedAssetIds.has(candidate.id)
            ) {
              displayedAssetIds.add(candidate.id);
              expanded = true;
            }
          }
        }
      }
      if (
        affectedAssets.length > 0 &&
        !affectedAssets.some((id) => displayedAssetIds.has(id))
      ) {
        return;
      }
      if (update.type === "opcua_status") {
        connectionScheduler();
        return;
      }
      if (
        ["assets", "variables", "nem_monitoring_rules"].some((table) =>
          changedTables.has(table),
        )
      ) {
        liveScheduler();
      } else if (
        [
          "readings",
          "nem_readings",
          "nem_rule_states",
          "nem_rule_counter_states",
          "machine_monitoring_states",
          "nem_alerts",
        ].some((table) => changedTables.has(table))
      ) {
        statusScheduler();
      }
      if (changedTables.has("variables") || changedTables.has("assets")) {
        loadVariables();
      }
      if (
        changedTables.has("nem_maintenance_records") ||
        changedTables.has("nem_maintenance_schedules")
      ) {
        loadLogs();
      }
      if (changedTables.has("nem_monitoring_events") && tab === "events") {
        eventsScheduler();
      }
    });
  }, [assetId, assets, children, loadLive, loadLogs, loadVariables]);

  useEffect(() => {
    if (tab !== "events") return;

    let cancelled = false;

    api
      .get(`/assets/${assetId}/events`)
      .then((items) => {
        if (!cancelled) {
          setEvents(Array.isArray(items) ? items : []);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error.message || "Unable to load events.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tab, assetId]);
}
