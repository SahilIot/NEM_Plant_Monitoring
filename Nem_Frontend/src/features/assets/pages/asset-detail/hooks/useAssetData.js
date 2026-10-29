import { useCallback, useMemo } from "react";
import { api } from "../../../../../services/api.js";
import { createLiveUpdateScheduler } from "../../../../../services/liveUpdates.js";

// API loaders (rules, variables, logbook, events) and live-update schedulers.
export default function useAssetData(ctx) {
  const {
    seq,
    ruleListSeq,
    ruleStatusSeq,
    plcStatusSeq,
    assetId,
    children,
    setRules,
    setRuntimeReadings,
    setLoadError,
    setRuleStates,
    setMappingBypassEnabled,
    setCycleVariableIds,
    setRuntimeVariableIds,
    setAllVariables,
    setVariables,
    setLogs,
    setEvents,
    refreshStatus,
  } = ctx;

  const loadLive = useCallback(
    async ({ includeRuleList = true, includePlcStatus = true } = {}) => {
      const generation = seq.current;
      const ruleRequest = includeRuleList ? ++ruleListSeq.current : null;
      const statusRequest = ++ruleStatusSeq.current;
      const plcRequest = includePlcStatus ? ++plcStatusSeq.current : null;

      try {
        const [r, st, plc] = await Promise.allSettled([
          includeRuleList
            ? api.get(`/assets/${assetId}/rules?include_children=${children}`)
            : Promise.resolve(null),
          api.getAll("/monitoring/status", 500),
          includePlcStatus ? api.get("/plc/status") : Promise.resolve(null),
        ]);

        if (generation !== seq.current) return;

        if (
          includeRuleList &&
          ruleRequest === ruleListSeq.current &&
          r.status === "fulfilled"
        ) {
          const loadedRules = Array.isArray(r.value) ? r.value : [];
          setRules(loadedRules);
          const runtimeRules = loadedRules.filter(
            (rule) => rule.rule_type === "runtime_duration",
          );
          const signalReadings = await Promise.all(
            runtimeRules.map(async (rule) => {
              try {
                return [
                  rule.variable_id,
                  await api.get(
                    `/readings/variables/${rule.variable_id}/latest`,
                  ),
                ];
              } catch (error) {
                if (error.status === 404) return [rule.variable_id, null];
                throw error;
              }
            }),
          );
          if (
            generation === seq.current &&
            ruleRequest === ruleListSeq.current
          ) {
            setRuntimeReadings(new Map(signalReadings));
            setLoadError("");
          }
        } else if (
          includeRuleList &&
          ruleRequest === ruleListSeq.current &&
          r.status === "rejected"
        ) {
          setLoadError(r.reason?.message || "Unable to load rules.");
        }

        if (
          statusRequest === ruleStatusSeq.current &&
          st.status === "fulfilled"
        ) {
          setRuleStates(
            new Map(
              (Array.isArray(st.value) ? st.value : []).map((s) => [
                s.rule_id,
                s,
              ]),
            ),
          );
        }

        if (
          includePlcStatus &&
          plcRequest === plcStatusSeq.current &&
          plc.status === "fulfilled"
        ) {
          const mappings = Array.isArray(plc.value?.mappings)
            ? plc.value.mappings
            : [];
          const bypassEnabled = plc.value?.mapping_bypass_enabled === true;
          setMappingBypassEnabled(bypassEnabled);
          setCycleVariableIds(
            mappings
              .filter(
                (mapping) =>
                  Number(mapping.asset_id) === assetId &&
                  mapping.role === "cycle_signal" &&
                  mapping.mapping_valid,
              )
              .map((mapping) => Number(mapping.variable_id)),
          );
          setRuntimeVariableIds(
            mappings
              .filter(
                (mapping) =>
                  Number(mapping.asset_id) === assetId &&
                  mapping.mapping_valid &&
                  mapping.data_type === "boolean" &&
                  mapping.role === "running_signal",
              )
              .map((mapping) => Number(mapping.variable_id)),
          );
        }
      } catch (error) {
        if (generation === seq.current) {
          setLoadError(error.message || "Unable to refresh asset monitoring.");
        }
      }
    },
    [assetId, children],
  );

  const liveScheduler = useMemo(
    () => createLiveUpdateScheduler(() => loadLive(), 200),
    [loadLive],
  );

  const statusScheduler = useMemo(
    () =>
      createLiveUpdateScheduler(
        () => loadLive({ includeRuleList: false, includePlcStatus: false }),
        250,
      ),
    [loadLive],
  );

  const connectionScheduler = useMemo(
    () =>
      createLiveUpdateScheduler(
        () => loadLive({ includeRuleList: false }),
        250,
      ),
    [loadLive],
  );

  const loadVariables = useCallback(async () => {
    try {
      const items = await api.getAll(`/assets/${assetId}/variables`);

      const loadedVariables = Array.isArray(items) ? items : [];
      setAllVariables(loadedVariables);
      setVariables(loadedVariables.filter((variable) => variable.is_active));
    } catch (error) {
      setVariables([]);
      setAllVariables([]);
      setLoadError(error.message || "Unable to load variables.");
    }
  }, [assetId]);

  const loadLogs = useCallback(() => {
    return api
      .get(`/assets/${assetId}/logbook`)
      .then((items) => {
        setLogs(Array.isArray(items) ? items : []);
      })
      .catch((error) => {
        setLoadError(error.message || "Unable to load logbook.");
      });
  }, [assetId]);

  const loadEvents = useCallback(async () => {
    try {
      const items = await api.get(`/assets/${assetId}/events`);
      setEvents(Array.isArray(items) ? items : []);
    } catch (error) {
      setLoadError(error.message || "Unable to load events.");
    }
  }, [assetId]);

  const eventsScheduler = useMemo(
    () => createLiveUpdateScheduler(loadEvents, 250),
    [loadEvents],
  );

  const refreshMaintenanceData = useCallback(async () => {
    await Promise.all([refreshStatus?.(), loadLogs()]);
  }, [loadLogs, refreshStatus]);

  return {
    loadLive,
    liveScheduler,
    statusScheduler,
    connectionScheduler,
    loadVariables,
    loadLogs,
    eventsScheduler,
    refreshMaintenanceData,
  };
}
