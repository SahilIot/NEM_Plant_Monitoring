
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import CopyRulesModal from "../components/CopyRulesModal.jsx";
import PredefinedRulesModal from "../../rules/components/PredefinedRulesModal.jsx";
import { api } from "../../../services/api.js";
import {
  createLiveUpdateScheduler,
  subscribeLiveUpdates,
} from "../../../services/liveUpdates.js";
import MaintenancePanel from "../components/MaintenancePanel.jsx";
import "./AssetDetail.css";
import {
  MONITORING_RULE_CHOICES,
  LEGACY_RULE_CHOICES,
  legacyRulePath,
  buildAssetMonitoringRule,
  monitoringRuleFormSelection,
} from "../rules/monitoringRuleFlow.js";
import {
  formatDuration,
  formatTime,
  formatValue,
} from "../../../utils/format.js";
import {
  CreateModal,
  EmptyState,
  Modal,
  StatusBadge,
} from "../../../components/common/UI.jsx";
import {
  GearIcon,
  AssetIcon,
  ExternalIcon,
  FilterIcon,
  RefreshIcon,
  PlusCircle,
  DotsIcon,
  ChevronDown,
  BookmarkIcon,
  FxIcon,
} from "../../../components/common/Icons.jsx";

const ORDER = { alert: 0, warning: 1, ok: 2 };

const HEALTH_LABEL = {
  alert: "Alert active",
  warning: "Warning active",
  ok: "No active alerts",
  off: "Disabled",
};

function thresholdMetrics(rule) {
  if (rule.rule_type === "runtime_duration") {
    const warnings = rule.parameters?.warning_thresholds_seconds;
    const alert = rule.parameters?.alert_threshold_seconds;
    if (Array.isArray(warnings) && warnings.length === 2 && alert != null) {
      return [
        { label: "Warning", value: `${(Number(warnings[0]) / 3600).toFixed(2)} h` },
        { label: "Higher warning", value: `${(Number(warnings[1]) / 3600).toFixed(2)} h` },
        { label: "Alert", value: `${(Number(alert) / 3600).toFixed(2)} h` },
      ];
    }
  }
  if (rule.rule_type === "boolean_count_threshold") {
    const warnings = rule.parameters?.warning_thresholds;
    const alert = rule.parameters?.alert_threshold;
    if (Array.isArray(warnings) && warnings.length === 2 && alert != null) {
      return [
        { label: "Warning", value: Number(warnings[0]).toLocaleString() },
        { label: "Higher warning", value: Number(warnings[1]).toLocaleString() },
        { label: "Alert", value: Number(alert).toLocaleString() },
      ];
    }
  }
  if (rule.threshold !== null && rule.threshold !== undefined) {
    return [
      {
        label: "Threshold",
        value: `${rule.operator || ""} ${formatValue(rule.threshold)}`.trim(),
      },
    ];
  }
  return [];
}

function thresholdSequence(rule) {
  const parameters = rule.parameters || {};
  if (
    rule.rule_type === "runtime_duration" &&
    Array.isArray(parameters.warning_thresholds_seconds) &&
    parameters.warning_thresholds_seconds.length === 2 &&
    parameters.alert_threshold_seconds != null
  ) {
    return [
      { label: "Warning", value: Number(parameters.warning_thresholds_seconds[0]) },
      { label: "Higher warning", value: Number(parameters.warning_thresholds_seconds[1]) },
      { label: "Alert", value: Number(parameters.alert_threshold_seconds) },
    ];
  }
  if (
    rule.rule_type === "boolean_count_threshold" &&
    Array.isArray(parameters.warning_thresholds) &&
    parameters.warning_thresholds.length === 2 &&
    parameters.alert_threshold != null
  ) {
    return [
      { label: "Warning", value: Number(parameters.warning_thresholds[0]) },
      { label: "Higher warning", value: Number(parameters.warning_thresholds[1]) },
      { label: "Alert", value: Number(parameters.alert_threshold) },
    ];
  }
  return [];
}

function formatTimeUntilDue(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Due now";
  let remaining = Math.ceil(seconds);
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const secondsLeft = remaining % 60;
  return `${days ? `${days}d ` : ""}${hours ? `${hours}h ` : ""}${minutes}m ${secondsLeft}s`;
}

function formatTimeUntilStart(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "Starting now";
  let remaining = Math.ceil(milliseconds / 1000);
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

const ruleFields = (
  variables,
  cycleVariableIds,
  runtimeVariableIds,
  mappingBypassEnabled
) => [
  {
    key: "name",
    label: "Rule name",
    required: true,
    placeholder: "e.g. Motor temperature limit",
  },
  {
    key: "description",
    label: "Description",
    type: "textarea",
    placeholder: "What should this rule watch?",
  },
  {
    key: "rule_type",
    label: "Rule type",
    type: "select",
    default: "parameter_threshold",
    options: [
      ["parameter_threshold", "Numeric value threshold"],
      ["boolean_count_threshold", "Boolean cycle-count thresholds"],
      ["runtime_duration", "Running time"],
    ],
    hint: mappingBypassEnabled
      ? "Choose a Boolean variable marked for the signal's actual purpose."
      : "Cycle counts come from this asset's configured PLC cycle signal.",
  },
  {
    key: "variable_id",
    label: "Numeric variable",
    type: "select",
    required: true,
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    options: variables
      .filter((v) => v.data_type === "number" || v.data_type === "integer")
      .map((v) => [
      v.id,
      `${v.name}${v.unit ? ` (${v.unit})` : ""}`,
    ]),
  },
  {
    key: "cycle_variable_id",
    label: mappingBypassEnabled
      ? "Boolean cycle signal"
      : "Configured Boolean cycle signal",
    type: "select",
    required: true,
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    options: variables
      .filter((v) => cycleVariableIds.includes(v.id))
      .map((v) => [v.id, `${v.name} (#${v.id})`]),
    hint: cycleVariableIds.length
      ? mappingBypassEnabled
        ? "Only variables marked as Cycle signal are available."
        : "Only Boolean variables configured as this asset's OPC UA cycle signal are available."
      : mappingBypassEnabled
        ? "Edit a Boolean variable in the asset's Variables panel and set its purpose to Cycle signal."
        : "No OPC UA cycle signal is configured for this asset. Configure it in backend OPCUA_MACHINE_MAPPINGS first.",
  },
  {
    key: "runtime_variable_id",
    label: "OPC UA Boolean running signal",
    type: "select",
    required: true,
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    options: variables
      .filter((variable) =>
        variable.data_type === "boolean" &&
        runtimeVariableIds.includes(variable.id)
      )
      .map((variable) => [variable.id, variable.name]),
    hint: mappingBypassEnabled
      ? runtimeVariableIds.length
        ? "Only variables marked as Machine running state are available."
        : "Edit a Boolean variable in the asset's Variables panel and set its purpose to Machine running state."
      : "Select a mapped Boolean OPC UA variable that is true while the machine runs.",
  },
  {
    key: "operator",
    label: "Trigger when value is",
    type: "select",
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    requiredWhen: { key: "rule_type", equals: "parameter_threshold" },
    default: ">=",
    options: [
      [">=", "Greater than or equal to"],
      [">", "Greater than"],
      ["<=", "Less than or equal to"],
      ["<", "Less than"],
      ["==", "Equal to"],
      ["!=", "Not equal to"],
    ],
  },
  {
    key: "threshold",
    label: "Threshold",
    type: "number",
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    requiredWhen: { key: "rule_type", equals: "parameter_threshold" },
    placeholder: "e.g. 900",
  },
  {
    key: "warning_threshold_1",
    label: "First warning at cycle count",
    type: "number",
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    requiredWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    placeholder: "e.g. 9000",
  },
  {
    key: "warning_threshold_2",
    label: "Second warning at cycle count",
    type: "number",
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    requiredWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    placeholder: "e.g. 9500",
  },
  {
    key: "alert_threshold",
    label: "Alert at cycle count",
    type: "number",
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    requiredWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    placeholder: "e.g. 10000",
  },
  {
    key: "runtime_warning_hours",
    label: "Warning threshold (hours)",
    type: "number",
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    requiredWhen: { key: "rule_type", equals: "runtime_duration" },
    placeholder: "e.g. 8",
  },
  {
    key: "runtime_warning_2_hours",
    label: "Higher warning threshold (hours)",
    type: "number",
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    requiredWhen: { key: "rule_type", equals: "runtime_duration" },
    placeholder: "e.g. 9",
  },
  {
    key: "runtime_alert_hours",
    label: "Alert threshold (hours)",
    type: "number",
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    requiredWhen: { key: "rule_type", equals: "runtime_duration" },
    placeholder: "e.g. 10",
  },
  {
    key: "severity",
    label: "Severity",
    type: "select",
    default: "warning",
    options: [
      ["warning", "Warning"],
      ["alert", "Alert"],
    ],
  },
];

const LOG_FIELDS = [
  {
    key: "text",
    label: "Entry",
    type: "textarea",
    required: true,
    placeholder: "What was done or noticed?",
  },
];

const VARIABLE_FIELDS = [
  {
    key: "name",
    label: "Name",
    required: true,
    placeholder: "e.g. Rotation count",
  },
  {
    key: "key",
    label: "Key",
    required: true,
    placeholder: "e.g. rotation_count",
    hint: "A short identifier that is unique within this asset.",
  },
  {
    key: "data_type",
    label: "Data type",
    type: "select",
    default: "number",
    options: [
      ["number", "Number"],
      ["integer", "Whole number"],
      ["boolean", "On / off"],
      ["string", "Text"],
    ],
  },
  {
    key: "signal_role",
    label: "Boolean purpose",
    type: "select",
    showWhen: { key: "data_type", equals: "boolean" },
    options: [
      ["running", "Machine running state (ON while running)"],
      ["cycle", "Cycle signal (OFF-to-ON means one cycle)"],
    ],
    hint: "Used when OPC UA mapping bypass is enabled. Choose the signal's actual meaning.",
  },
  {
    key: "unit",
    label: "Unit",
    placeholder: "e.g. °C, rpm, cycles",
  },
  {
    key: "opcua_node_id",
    label: "OPC UA NodeId",
    placeholder: "e.g. ns=2;s=Machine.Cycle",
    hint: "Optional. Enter the exact NodeId from the PLC. Restart the backend after changing it so the collector can subscribe.",
  },
    {
  key: "data_source",
  label: "Data source",
  type: "select",
  default: "none",
  options: [
    ["none", "No source"],
    ["connector", "Connector"],
  ],
},
  {
  key: "connector_id",
  label: "Select connector",
  type: "select",
  default: "",
  options: [
    ["opcua", "OPC UA Connector"],
    ["mqtt", "MQTT Connector"],
    ["modbus_tcp", "Modbus TCP Connector"],
    ["http", "HTTP / REST API Connector"],
    ["database", "Database Connector"],
  ],
  showWhen: {
    key: "data_source",
    equals: "connector",
  },
  hint: "Choose the connector that provides this variable's data.",
},
];

export default function AssetDetail() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const { assets, assetsLoaded, reload, refreshStatus } =
    useOutletContext();

  const assetId = Number(id);
  const asset = assets.find((a) => a.id === assetId);

  const [tab, setTab] = useState(
    location.state?.activeTab === "logbook" ? "logbook" : "status"
  );
  const [list, setList] = useState("activated");
  const [rules, setRules] = useState([]);
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const [variables, setVariables] = useState([]);
  const [allVariables, setAllVariables] = useState([]);
  const [runtimeReadings, setRuntimeReadings] = useState(new Map());
  const [clockNow, setClockNow] = useState(Date.now());
  const [cycleVariableIds, setCycleVariableIds] = useState([]);
  const [runtimeVariableIds, setRuntimeVariableIds] = useState([]);
  const [mappingBypassEnabled, setMappingBypassEnabled] = useState(false);
  const [editingVariable, setEditingVariable] = useState(null);
  const [ruleStates, setRuleStates] = useState(new Map());
  const [children, setChildren] = useState(false);
  const [sort, setSort] = useState("severity");
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const [menu, setMenu] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState(null);
  const [ruleActionMenuId, setRuleActionMenuId] = useState(null);
  const [lifecycleAction, setLifecycleAction] = useState(null);
  const [viewRule, setViewRule] = useState(null);
  const [actionNotice, setActionNotice] = useState("");
  const [sortMenu, setSortMenu] = useState(false);
  const [modal, setModal] = useState(null);
  const [monitoringRuleSelection, setMonitoringRuleSelection] = useState(null);
  const [showPredefinedRules, setShowPredefinedRules] = useState(false);
  const [addRuleMenu, setAddRuleMenu] = useState(false);
  const [logs, setLogs] = useState([]);
  const [logSearch, setLogSearch] = useState("");
  const [logSort, setLogSort] = useState("newest");
  const [logTypeFilter, setLogTypeFilter] = useState("all");
  const [showLogFilter, setShowLogFilter] = useState(false);
  const [logStartDate, setLogStartDate] = useState("");
  const [logEndDate, setLogEndDate] = useState("");
  const [events, setEvents] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [deletingAsset, setDeletingAsset] = useState(false);
  const [deletingVariableId, setDeletingVariableId] = useState(null);
  const [variableDeleteError, setVariableDeleteError] = useState("");
  const [variableDataSource, setVariableDataSource] = useState("none");
  const [variableConnector, setVariableConnector] = useState("");
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [showEventDetails, setShowEventDetails] = useState(false);

  const seq = useRef(0);
  const bulkRequest = useRef(false);
  const permanentDeleteRequest = useRef(false);

  
  const loadLive = useCallback(async ({
    includeRuleList = true,
    includePlcStatus = true,
  } = {}) => {
    const mine = ++seq.current;

    try {
      const [r, st, plc] = await Promise.allSettled([
        includeRuleList
          ? api.get(`/assets/${assetId}/rules?include_children=${children}`)
          : Promise.resolve(null),
        api.getAll("/monitoring/status", 500),
        includePlcStatus ? api.get("/plc/status") : Promise.resolve(null),
      ]);

      if (mine !== seq.current) return;

      if (!includeRuleList || r.status === "fulfilled") {
        const loadedRules = includeRuleList
          ? Array.isArray(r.value) ? r.value : []
          : rulesRef.current;
        if (includeRuleList) setRules(loadedRules);
        setLoadError("");
        const runtimeRules = loadedRules.filter((rule) =>
          rule.rule_type === "runtime_duration"
        );
        const signalReadings = await Promise.all(
          runtimeRules.map(async (rule) => {
            try {
              return [
                rule.variable_id,
                await api.get(`/readings/variables/${rule.variable_id}/latest`),
              ];
            } catch (error) {
              if (error.status === 404) return [rule.variable_id, null];
              throw error;
            }
          })
        );
        if (mine !== seq.current) return;
        setRuntimeReadings(new Map(signalReadings));
      } else if (r.status === "rejected") {
        setRules([]);
        setLoadError(
          r.reason?.message || "Unable to load rules."
        );
      }

      if (st.status === "fulfilled") {
        setRuleStates(
          new Map(
            (Array.isArray(st.value) ? st.value : []).map(
              (s) => [s.rule_id, s]
            )
          )
        );
      }

      if (includePlcStatus && plc.status === "fulfilled") {
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
                mapping.mapping_valid
            )
            .map((mapping) => Number(mapping.variable_id))
        );
        setRuntimeVariableIds(
          mappings
            .filter(
              (mapping) =>
                Number(mapping.asset_id) === assetId &&
                mapping.mapping_valid &&
                mapping.data_type === "boolean" &&
                mapping.role === "running_signal"
            )
            .map((mapping) => Number(mapping.variable_id))
        );
      }
    } catch (error) {
      setLoadError(error.message || "Unable to refresh asset monitoring.");
    }
  }, [assetId, children]);

  const liveScheduler = useMemo(
    () => createLiveUpdateScheduler(() => loadLive(), 200),
    [loadLive]
  );
  const statusScheduler = useMemo(
    () =>
      createLiveUpdateScheduler(
        () => loadLive({ includeRuleList: false, includePlcStatus: false }),
        250
      ),
    [loadLive]
  );
  const connectionScheduler = useMemo(
    () =>
      createLiveUpdateScheduler(
        () => loadLive({ includeRuleList: false }),
        250
      ),
    [loadLive]
  );

  const loadVariables = useCallback(async () => {
    try {
      const items = await api.getAll(
        `/assets/${assetId}/variables`
      );

      const loadedVariables = Array.isArray(items) ? items : [];
      setAllVariables(loadedVariables);
      setVariables(
        loadedVariables.filter((variable) => variable.is_active)
      );
    } catch (error) {
      setVariables([]);
      setAllVariables([]);
      setLoadError(
        error.message || "Unable to load variables."
      );
    }
  }, [assetId]);

  const loadLogs = useCallback(() => {
    return api
      .get(`/assets/${assetId}/logbook`)
      .then((items) => {
        setLogs(Array.isArray(items) ? items : []);
      })
      .catch((error) => {
        setLoadError(
          error.message || "Unable to load logbook."
        );
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
    [loadEvents]
  );

  const refreshMaintenanceData = useCallback(async () => {
    await Promise.all([refreshStatus?.(), loadLogs()]);
  }, [loadLogs, refreshStatus]);

  
  useEffect(() => {
    setTab("status");
    setList("activated");
    setFilter("");
    setRules([]);
    setAllVariables([]);
    setRuntimeReadings(new Map());
    setVariables([]);
    setLogs([]);
    setEvents([]);
    setLoadError("");

  loadVariables();
  loadLogs();
  loadLive();

    return () => {
      seq.current += 1;
    };
  }, [assetId, loadVariables, loadLogs, loadLive]);

  const hasRuntimeRules = rules.some(
    (rule) => rule.rule_type === "runtime_duration"
  );

  useEffect(() => {
    if (!hasRuntimeRules) return;

    let timer;
    const updateClock = () => {
      setClockNow(Date.now());
      timer = window.setTimeout(
        updateClock,
        1000 - (Date.now() % 1000)
      );
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
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
    };
  }, [hasRuntimeRules]);


  useEffect(() => {
    const navigationState = location.state;

    if (navigationState?.activeTab === "logbook") {
      setTab("logbook");
    }

    if (navigationState?.createdNotice) {
      setActionNotice(navigationState.createdNotice);
    }

    if (
      navigationState?.activeTab ||
      navigationState?.createdNotice
    ) {
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
      if (["assets", "variables", "nem_monitoring_rules"].some((table) =>
        changedTables.has(table)
      )) {
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
          setLoadError(
            error.message || "Unable to load events."
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tab, assetId]);

  const availableVariables = variables;
  const ruleFormFields = useMemo(
    () =>
      ruleFields(
        availableVariables,
        cycleVariableIds,
        runtimeVariableIds,
        mappingBypassEnabled
      ),
    [
      availableVariables,
      cycleVariableIds,
      runtimeVariableIds,
      mappingBypassEnabled,
    ]
  );

  const isAct = (rule) => rule.state === "activated";
  const nAct = rules.filter(isAct).length;
  const nNot = rules.length - nAct;

  let shown = rules
    .filter((rule) =>
      list === "activated"
        ? isAct(rule)
        : !isAct(rule)
    )
    .filter((rule) =>
      (rule.name || "")
        .toLowerCase()
        .includes(filter.toLowerCase())
    );

  shown = [...shown].sort((a, b) =>
    sort === "name"
      ? (a.name || "").localeCompare(b.name || "")
      : (ORDER[a.status] ?? 3) -
        (ORDER[b.status] ?? 3)
  );

  
const filteredLogs = [...logs].sort((a, b) => {
  const dateA = new Date(a.time || a.created_at || 0).getTime();
  const dateB = new Date(b.time || b.created_at || 0).getTime();
  return (Number.isFinite(dateB) ? dateB : 0) -
         (Number.isFinite(dateA) ? dateA : 0);
});
 
  const refreshAll = async () => {
    await Promise.all([
      loadLive(),
      refreshStatus?.(),
    ]);
  };

  const confirmLifecycleChange = async () => {
    if (!lifecycleAction || deletingRuleId !== null) return;
    const { rule, action } = lifecycleAction;
    setDeletingRuleId(rule.id);
    setLoadError("");
    try {
      await api.post(`/rules/${rule.id}/${action}`);
      await refreshAll();
      setLifecycleAction(null);
      setRuleActionMenuId(null);
    } catch (error) {
      setLoadError(error.message || `Could not ${action} this rule.`);
    } finally {
      setDeletingRuleId(null);
    }
  };

  const lifecycleStatus = (rule) =>
    rule.lifecycle_status ||
    (rule.is_enabled ? "in_progress" : "deactivated");

  const lifecycleLabel = (rule) => {
    const status = lifecycleStatus(rule);
    if (status === "in_progress") return "Activated · In progress";
    if (status === "suspended") return "Suspended";
    if (status === "completed") return "Completed";
    return "Deactivated";
  };

  const remove = async (rule) => {
    if (
      !window.confirm(
        `Archive the rule “${rule.name}”? It will be hidden from the rule list, and its alert and evaluation history will be retained.`
      )
    ) {
      return;
    }

    try {
      await api.del(`/rules/${rule.id}`);
      await refreshAll();
    } catch (error) {
      setLoadError(error.message);
    }
  };

  const permanentlyDeleteRule = async (rule) => {
    if (permanentDeleteRequest.current) return;
    if (
      !window.confirm(
        `Permanently delete “${rule.name}”? This irreversibly removes the rule, its alerts, and its evaluation history. Maintenance records linked to its alerts must be removed first.`
      )
    ) {
      return;
    }

    permanentDeleteRequest.current = true;
    setDeletingRuleId(rule.id);
    setLoadError("");
    setActionNotice("");
    try {
      await api.del(`/rules/${rule.id}/permanent`);
      await refreshAll();
      setActionNotice(`Rule “${rule.name}” was permanently deleted.`);
    } catch (error) {
      setLoadError(error.message || "Could not permanently delete the rule.");
    } finally {
      permanentDeleteRequest.current = false;
      setDeletingRuleId(null);
    }
  };

  const addRule = async (values) => {
    const rule = buildAssetMonitoringRule(values, assetId, {
      variables: availableVariables,
      cycleVariableIds,
      runtimeVariableIds,
    });
    await api.post(`/assets/${assetId}/rules`, rule);

    setModal(null);
    setMonitoringRuleSelection(null);
    setList("activated");
    await refreshAll();
  };

  const openMonitoringRuleForm = (choiceId) => {
  setModal(null);
  setMonitoringRuleSelection(null);

  navigate(`/assets/${assetId}/monitoring-rules/new/${choiceId}`);
};

  const monitoringRuleFormFields = useMemo(
    () =>
      ruleFormFields.map((field) =>
        field.key === "rule_type" && monitoringRuleSelection
          ? {
              ...field,
              disabled: true,
              options: field.options.filter(
                ([ruleType]) =>
                  ruleType === monitoringRuleSelection.ruleType
              ),
            }
          : field
      ),
    [ruleFormFields, monitoringRuleSelection]
  );

  const bulk = async (state) => {
    if (bulkRequest.current || bulkSaving) return;
    const affected = rules.filter((rule) =>
      state === "activated" ? !isAct(rule) : isAct(rule)
    ).length;
    if (state === "not_activated" && affected > 0) {
      const scope = children
        ? "this asset and its included child assets"
        : "this asset only";
      if (!window.confirm(
        `Deactivate ${affected} active rule(s) on ${scope}? Active alerts for those rules will be resolved.`
      )) {
        return;
      }
    }
    bulkRequest.current = true;
    setBulkSaving(true);
    setLoadError("");
    setActionNotice("");
    setMenu(false);
    try {
      const result = await api.post(
        `/assets/${assetId}/rules/bulk?include_children=${children}`,
        { state }
      );
      await refreshAll();
      const action = state === "activated" ? "activated" : "deactivated";
      const skipped = result.skipped || [];
      setActionNotice(
        `${result.updated} rule(s) ${action}.` +
          (skipped.length
            ? ` ${skipped.length} rule(s) were skipped because they are not eligible: ${skipped.map((item) => item.name).join(", ")}.`
            : "")
      );
    } catch (error) {
      setLoadError(error.message || "Could not update rule states.");
    } finally {
      bulkRequest.current = false;
      setBulkSaving(false);
    }
  };

  const addLog = async (values) => {
    if (!values.text?.trim()) {
      throw new Error("Enter a logbook entry.");
    }

    await api.post(`/assets/${assetId}/logbook`, {
      text: values.text.trim(),
    });

    setModal(null);
    loadLogs();
  };

  const saveAsset = async (values) => {
    await api.patch(`/assets/${assetId}`, {
      name: values.name.trim(),
      asset_type: values.asset_type.trim(),
      description: values.description?.trim() || null,
      is_active: String(values.is_active) === "true",
    });

    setModal(null);
    await reload();
  };

  const addVariable = async (values) => {
    await api.post(`/assets/${assetId}/variables`, {
      name: values.name.trim(),
      key: values.key.trim(),
      data_type: values.data_type,
      signal_role:
        values.data_type === "boolean" && values.signal_role
          ? values.signal_role
          : null,
      unit: values.unit?.trim() || null,
      opcua_node_id: values.opcua_node_id?.trim() || null,
    // Data source and connector
    data_source: values.data_source || "none",
    connector_id:
      values.data_source === "connector"
        ? values.connector_id || null
        : null,
  });

  setEditingVariable(null);
  setModal("variables");
  await loadVariables();
};

  const updateVariable = async (values) => {
    if (!editingVariable) return;
    await api.patch(`/variables/${editingVariable.id}`, {
      name: values.name.trim(),
      key: values.key.trim(),
      data_type: values.data_type,
      signal_role:
        values.data_type === "boolean" && values.signal_role
          ? values.signal_role
          : null,
      unit: values.unit?.trim() || null,
      opcua_node_id: values.opcua_node_id?.trim() || null,
    });

    setEditingVariable(null);
    setModal("variables");
    await loadVariables();
  };

  const deleteAsset = async () => {
    if (deletingAsset) return;
    const confirmed = window.confirm(
      `Permanently delete asset "${asset.name}" and its asset-scoped event history? This cannot be undone. Deletion is blocked if it still has child assets, variables, readings, rules, alerts, or maintenance records.`
    );
    if (!confirmed) return;

    setDeletingAsset(true);
    setLoadError("");
    try {
      await api.del(`/assets/${assetId}`);
      await reload();
      navigate("/assets", { replace: true });
    } catch (error) {
      setLoadError(error.message || "Could not delete the asset.");
    } finally {
      setDeletingAsset(false);
    }
  };

  const deleteVariable = async (variable) => {
    if (deletingVariableId !== null) return;
    const confirmed = window.confirm(
      `Permanently delete variable "${variable.name}"? Variables with readings, monitoring rules, alerts, or an OPC UA mapping cannot be deleted.`
    );
    if (!confirmed) return;

    setDeletingVariableId(variable.id);
    setVariableDeleteError("");
    try {
      await api.del(`/variables/${variable.id}`);
      await loadVariables();
    } catch (error) {
      setVariableDeleteError(
        error.message || "Could not delete this variable."
      );
    } finally {
      setDeletingVariableId(null);
    }
  };

  if (!asset) {
    return assetsLoaded ? (
      <div className="panel">
        <EmptyState
          title="This asset was not found"
          lines={[
            "It may have been removed. Pick another asset from the panel.",
          ]}
        />
      </div>
    ) : (
      <div className="loading" role="status">
        Loading…
      </div>
    );
  }

  const health = asset.health || "ok";

  return (
    <div className="asset-page">
      {loadError && (
        <div className="banner error" role="alert">
          <p>{loadError}</p>
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              setLoadError("");
              refreshAll();
            }}
          >
            Dismiss and retry
          </button>
        </div>
      )}
      {actionNotice && (
        <div className="banner success" role="status">
          <p>{actionNotice}</p>
          <button
            type="button"
            className="btn-outline"
            onClick={() => setActionNotice("")}
          >
            Dismiss
          </button>
        </div>
      )}
      {bulkSaving && (
        <div className="banner" role="status" aria-live="polite">
          <p>Updating rule states and resolving alerts where required…</p>
        </div>
      )}

      <div className="asset-head">
        <div>
          <h1 className="page-title">{asset.name}</h1>

          <div className="asset-sub">
            <span className={"health-chip " + health}>
              <i className={"lamp " + health} />
              {HEALTH_LABEL[health]}
            </span>

            <span className="muted">{asset.asset_type}</span>

            {asset.description && (
              <span className="muted">
                {asset.description}
              </span>
            )}
          </div>
        </div>

        <div className="asset-links">
          <button
            className="link-btn"
            onClick={() => setModal("settings")}
          >
            <GearIcon size={17} /> Asset settings
          </button>

          <button
            className="link-btn danger-link"
            onClick={deleteAsset}
            disabled={deletingAsset}
            title="Permanently delete this asset if it has no related records"
          >
            {deletingAsset ? "Deleting asset…" : "Delete asset"}
          </button>

          <button
            className="link-btn"
            onClick={() => setModal("variables")}
          >
            <AssetIcon size={17} /> Variables
          </button>

          <button
            className="icon-outline"
            title="Open in new tab"
            aria-label="Open in new tab"
            onClick={() =>
              window.open(window.location.href, "_blank")
            }
          >
            <ExternalIcon size={18} />
          </button>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {[
          ["status", "Current status"],
          ["logbook", "Maintenance logbook"],
          ["events", "Event log"],
        ].map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "status" && (
        <>
          <div className="toolbar rule-toolbar">
            <button
              className={
                "icon-outline sm" +
                (showFilter ? " on" : "")
              }
              onClick={() => setShowFilter(!showFilter)}
              title="Filter rules"
              aria-label="Filter rules"
            >
              <FilterIcon size={17} />
            </button>

            {showFilter && (
              <input
                className="mini-input"
                placeholder="Filter rules"
                aria-label="Filter rules"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}

            <div className="segment">
              <button
                className={
                  list === "activated" ? "active" : ""
                }
                onClick={() => setList("activated")}
              >
                Activated <span>({nAct})</span>
              </button>

              <button
                className={
                  list === "not_activated" ? "active" : ""
                }
                onClick={() => setList("not_activated")}
              >
                Not activated <span>({nNot})</span>
              </button>
            </div>

            <button
              className="icon-outline sm"
              onClick={refreshAll}
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshIcon size={17} />
            </button>

            <label className="switch-label">
              <input
                type="checkbox"
                className="sr-only"
                checked={children}
                onChange={() => setChildren(!children)}
              />

              <span
                className={
                  "switch" + (children ? " on" : "")
                }
                aria-hidden="true"
              >
                <i />
              </span>

              Include child assets
            </label>

            <div className="spacer" />

            <div className="dropdown">
              <button
                className="link-btn"
                onClick={() => setSortMenu(!sortMenu)}
                aria-haspopup="menu"
                aria-expanded={sortMenu}
              >
                Sort by {sort === "name" ? "name" : "severity"}{" "}
                <ChevronDown size={14} />
              </button>

              {sortMenu && (
                <div className="menu" role="menu">
                  <div
                    role="menuitem"
                    onClick={() => {
                      setSort("severity");
                      setSortMenu(false);
                    }}
                  >
                    Severity
                  </div>

                  <div
                    role="menuitem"
                    onClick={() => {
                      setSort("name");
                      setSortMenu(false);
                    }}
                  >
                    Name
                  </div>
                </div>
              )}
            </div>
            <button
            className="btn-primary"
            onClick={() => setModal("addRuleOptions")}
            >
              <PlusCircle size={17} /> Add Rule
              </button>

            <div className="dropdown">
              <button
                className="icon-outline sm"
                onClick={() => setMenu(!menu)}
                title="Rule actions"
                aria-label="Rule actions"
                aria-haspopup="menu"
                aria-expanded={menu}
              >
                <DotsIcon size={17} />
              </button>
                {menu && (
                  <div className="menu right" role="menu">
                      <button
                      type="button"
                      disabled={bulkSaving}
                      role="menuitem"
                      onClick={() => bulk("activated")}
                      >
                        {bulkSaving ? "Updating rules…" : "Activate all rules"}
                      </button>
                        <button
                        type="button"
                        disabled={bulkSaving}
                      role="menuitem"
                        onClick={() => bulk("not_activated")}
                        >Deactivate all rules</button>
                        </div>
                      )}
                    </div>
                    </div>

          {shown.length === 0 ? (
            <div className="panel">
              <EmptyState
                art={false}
                title={
                  list === "activated"
                    ? "No activated rules"
                    : "No rules are switched off"
                }
                lines={[
                  list === "activated"
                    ? "Select “Add rule” to watch a variable on this asset."
                    : "Rules you deactivate are kept here and can be activated again.",
                ]}
              />
            </div>
          ) : (
            <div className="rule-list">
              {shown.map((rule) => {
                const state = ruleStates.get(rule.id);

                const currentValue =
                  state?.latest_value ?? rule.latest_value;
                const runtimeReading = runtimeReadings.get(rule.variable_id);
                const evaluatedAt = state?.last_evaluated_at
                  ? new Date(state.last_evaluated_at).getTime()
                  : Number.NaN;
                const signalAt = runtimeReading?.recorded_at
                  ? new Date(runtimeReading.recorded_at).getTime()
                  : Number.NaN;
                const signalIsFresh =
                  Number.isFinite(signalAt) &&
                  clockNow - signalAt <=
                    (Number(rule.stale_after_seconds) || 300) * 1000;
                const runtimeIsRunning =
                  rule.rule_type === "runtime_duration" &&
                  state?.status !== "unknown" &&
                  runtimeReading?.value === true &&
                  signalIsFresh;
                const displayedValue =
                  runtimeIsRunning &&
                  Number.isFinite(currentValue) &&
                  Number.isFinite(evaluatedAt)
                    ? currentValue +
                      Math.max(0, clockNow - evaluatedAt) / 1000
                    : currentValue;
                const numericCurrentValue =
                  displayedValue === null || displayedValue === undefined
                    ? Number.NaN
                    : Number(displayedValue);
                const canShowNextThreshold =
                  lifecycleStatus(rule) === "in_progress" &&
                  ["ok", "warning"].includes(rule.status) &&
                  Number.isFinite(numericCurrentValue) &&
                  (rule.rule_type !== "runtime_duration" || signalIsFresh);
                const nextThreshold = canShowNextThreshold
                  ? thresholdSequence(rule).find(
                      (threshold) => threshold.value > numericCurrentValue
                    )
                  : null;
                const formattedCurrentValue =
                  rule.rule_type === "runtime_duration"
                    ? formatDuration(displayedValue)
                    : rule.rule_type === "boolean_count_threshold" &&
                        Number.isFinite(numericCurrentValue)
                      ? numericCurrentValue.toLocaleString()
                      : formatValue(displayedValue);
                const formattedNextThreshold = nextThreshold
                  ? rule.rule_type === "runtime_duration"
                    ? formatDuration(nextThreshold.value)
                    : nextThreshold.value.toLocaleString()
                  : null;
                const scheduledActivationAt =
                  rule.rule_type === "runtime_duration"
                    ? Date.parse(rule.parameters?.activation_at)
                    : Number.NaN;
                const scheduledStartCountdown =
                  lifecycleStatus(rule) === "in_progress" &&
                  Number.isFinite(scheduledActivationAt) &&
                  scheduledActivationAt > clockNow
                    ? scheduledActivationAt - clockNow
                    : null;
                const runtimeCountdown =
                  rule.rule_type === "runtime_duration" &&
                  lifecycleStatus(rule) === "in_progress" &&
                  ["ok", "warning"].includes(rule.status) &&
                  Number.isFinite(numericCurrentValue)
                    ? thresholdSequence(rule).find(
                        (threshold) => threshold.value > numericCurrentValue
                      )
                    : null;

                return (
                  <article
                    key={rule.id}
                    className={`rule-row rule-card ${rule.status || "unknown"}${ruleActionMenuId === rule.id ? " rule-card-menu-open" : ""}`}
                  >
                    <span className={"sev " + rule.status} />

                    <div className="rule-name rule-card-main">
                      <strong>{rule.name}</strong>
                      {rule.description && (
                        <small className="rule-description">{rule.description}</small>
                      )}
                    </div>

                    <div className="rule-evaluation">
                      <StatusBadge status={rule.status} />
                      <span className="rule-lifecycle-label">
                        {lifecycleLabel(rule)}
                      </span>
                    </div>

                    <div className="rule-card-metrics">
                      <div className="rule-current-next-value">
                        <span>
                          {list === "not_activated"
                            ? "Last evaluated"
                            : scheduledStartCountdown !== null
                              ? "Start in"
                              : runtimeCountdown
                                ? "Due in"
                              : rule.rule_type === "boolean_count_threshold"
                                ? "Current / Target"
                              : rule.rule_type === "runtime_duration" &&
                                  lifecycleStatus(rule) === "in_progress" &&
                                  ["ok", "warning"].includes(rule.status)
                                ? "Due"
                                : "Current / Next"}
                        </span>
                        <b>
                          {list === "not_activated"
                            ? rule.last_evaluated_at
                              ? formatTime(rule.last_evaluated_at)
                              : "Not evaluated yet"
                            : scheduledStartCountdown !== null
                              ? formatTimeUntilStart(scheduledStartCountdown)
                            : runtimeCountdown
                              ? formatTimeUntilDue(
                                  runtimeCountdown.value - numericCurrentValue
                                )
                              : rule.rule_type === "runtime_duration" &&
                                  lifecycleStatus(rule) === "in_progress" &&
                                  ["ok", "warning"].includes(rule.status)
                                ? "Threshold reached"
                            : <>
                                {displayedValue !== null && displayedValue !== undefined
                                  ? formattedCurrentValue
                                  : "—"}
                                {" / "}
                                {nextThreshold
                                  ? rule.rule_type === "boolean_count_threshold"
                                    ? formattedNextThreshold
                                    : `${nextThreshold.label} at ${formattedNextThreshold}`
                                  : "—"}
                              </>}
                        </b>
                      </div>
                    </div>

                    <div className="rule-card-actions">
                      <div className="dropdown rule-actions-menu">
                        <button
                          type="button"
                          className="icon-outline sm"
                          title={`More actions for ${rule.name}`}
                          aria-label={`More actions for ${rule.name}`}
                          aria-haspopup="menu"
                          aria-expanded={ruleActionMenuId === rule.id}
                          onClick={() =>
                            setRuleActionMenuId((current) =>
                              current === rule.id ? null : rule.id
                            )
                          }
                        >
                          <DotsIcon size={17} />
                        </button>
                        {ruleActionMenuId === rule.id && (
                          <div className="menu right" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setRuleActionMenuId(null);
                                setViewRule(rule);
                              }}
                            >
                              View rule
                            </button>
                            {lifecycleStatus(rule) === "in_progress" && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setRuleActionMenuId(null);
                                  setLifecycleAction({ rule, action: "suspend" });
                                }}
                                disabled={deletingRuleId !== null}
                              >
                                Suspend rule
                              </button>
                            )}
                            {lifecycleStatus(rule) === "suspended" && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setRuleActionMenuId(null);
                                  setLifecycleAction({ rule, action: "resume" });
                                }}
                                disabled={deletingRuleId !== null}
                              >
                                Activate rule
                              </button>
                            )}
                            {lifecycleStatus(rule) === "deactivated" && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setRuleActionMenuId(null);
                                  setLifecycleAction({ rule, action: "activate" });
                                }}
                                disabled={deletingRuleId !== null}
                              >
                                Activate rule
                              </button>
                            )}
                            {["in_progress", "suspended"].includes(lifecycleStatus(rule)) && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setRuleActionMenuId(null);
                                  setLifecycleAction({ rule, action: "deactivate" });
                                }}
                                disabled={deletingRuleId !== null}
                              >
                                Deactivate rule
                              </button>
                            )}
                            {lifecycleStatus(rule) !== "in_progress" &&
                              lifecycleStatus(rule) !== "completed" && (
                                <>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setRuleActionMenuId(null);
                                      remove(rule);
                                    }}
                                    disabled={deletingRuleId !== null}
                                  >
                                    Archive
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setRuleActionMenuId(null);
                                      permanentlyDeleteRule(rule);
                                    }}
                                    disabled={deletingRuleId !== null}
                                  >
                                    {deletingRuleId === rule.id
                                      ? "Deleting…"
                                      : "Delete permanently"}
                                  </button>
                                </>
                              )}
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}

{tab === "logbook" && (
  <>
    <MaintenancePanel
      assetId={assetId}
      onChanged={refreshMaintenanceData}
    />

   
<div className="panel maintenance-log-notes-panel">
  <div className="panel-head maintenance-log-notes-head">
    <div>
      <h2>Maintenance Logbook</h2>
      <span className="muted">
        {filteredLogs.length} maintenance entries
      </span>
    </div>
  </div>

  {logs.length === 0 ? (
    <EmptyState
      art={false}
      title="No maintenance entries"
      lines={[
        "Maintenance records and notes will appear here."
      ]}
    />
  ) : (
    <div className="maintenance-table-wrap">
      <table className="table maintenance-notes-table">
        <thead>
          <tr>
            <th className="col-time">Date and time</th>
            <th>Entry</th>
            <th>Entry type</th>
            <th>Assigned rule</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody>
          {filteredLogs.map((entry) => {
            const timestamp = entry.time || entry.created_at;

            return (
              <tr key={entry.id}>
                <td className="col-time">
                  {timestamp ? formatTime(timestamp) : "—"}
                </td>

                <td className="maintenance-note-text">
                  {entry.text || entry.title || entry.summary || "—"}
                </td>

                <td>
                  {entry.maintenance_type || "Note"}
                </td>

                <td>
                  {entry.assigned_rule ||
                    entry.rule_name ||
                    entry.alert_id ||
                    "—"}
                </td>

                <td>
                  <div className="maintenance-actions">
                    <button
                      type="button"
                      className="btn-outline"
                      onClick={() => {
                        if (entry.schedule_id) {
                          navigate(
                            `/assets/${assetId}/maintenance/schedules/${entry.schedule_id}/edit`
                          );
                        } else if (entry.maintenance_type) {
                          navigate(
                            `/assets/${assetId}/maintenance/logbook`,
                            {
                              state: {
                                activeTab: "logbook",
                                editMaintenanceId: entry.id,
                              },
                            }
                          );
                        } else {
                          setModal("log");
                        }
                      }}
                    >
                      Update
                    </button>

                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => {
                        if (
                          !window.confirm(
                            "Are you sure you want to delete this entry?"
                          )
                        ) {
                          return;
                        }

                        api.del(
                          `/assets/${assetId}/logbook/${entry.id}`
                        )
                          .then(() => loadLogs())
                          .catch((error) =>
                            setLoadError(
                              error.message ||
                                "Could not delete this entry."
                            )
                          );
                      }}
                    >
                      Delete
                    </button>
                    <button
                    type="button"
                    className="btn-outline"
                    onClick={() => {
                      setSelectedEntry(entry);
                      setModal("view");
                      }}
                      >
                        View
                        </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  )}
</div>
  </>
)}


      

{/* Event Log */}
{tab === "events" && (
  <div className="event-log-section">
    <div className="table-responsive">
      <table className="data-table event-log-table">
        <thead>
          <tr>
            <th>Date &amp; Time</th>
            <th>Event</th>
            <th>Assigned Rule</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody>
          {events.length === 0 ? (
            <tr>
              <td colSpan={4} className="empty-state">
                No events found.
              </td>
            </tr>
          ) : (
            events.map((event) => {
              const assignedRule =
                event.rule_name ||
                event.assigned_rule ||
                event.rule?.name ||
                (event.rule_id != null
                  ? `Rule #${event.rule_id}`
                  : "Not assigned");

              const eventTime = event.time
                ? new Date(event.time).toLocaleString()
                : "—";

              return (
                <tr key={event.id}>
                  <td>{eventTime}</td>

                  <td>
                    {event.text || event.message || "—"}
                  </td>

                  <td>{assignedRule}</td>

                  <td>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        setSelectedEvent(event);
                        setShowEventDetails(true);
                      }}
                    >
                      View
                    </button>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  </div>
)}


{showEventDetails && selectedEvent && (
  <div className="modal-overlay">
    <div
      className="modal-content"
      role="dialog"
      aria-modal="true"
      aria-labelledby="event-details-title"
    >
      <div className="modal-header">
        <h3 id="event-details-title">Event Details</h3>

        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setShowEventDetails(false);
            setSelectedEvent(null);
          }}
        >
          Close
        </button>
      </div>

      <div className="modal-body">
        <p>
          <strong>Date &amp; Time:</strong>{" "}
          {selectedEvent.time
            ? new Date(selectedEvent.time).toLocaleString()
            : "—"}
        </p>

        <p>
          <strong>Event:</strong>{" "}
          {selectedEvent.text || selectedEvent.message || "—"}
        </p>

        <p>
          <strong>Assigned Rule:</strong>{" "}
          {selectedEvent.rule_name ||
            selectedEvent.assigned_rule ||
            selectedEvent.rule?.name ||
            (selectedEvent.rule_id != null
              ? `Rule #${selectedEvent.rule_id}`
              : "Not assigned")}
        </p>
      </div>
    </div>
  </div>
)}
  
{modal === "addRuleOptions" && (
  <Modal
    title="Add Rule"
    onClose={() => setModal(null)}
  >
    <div className="rule-type-options">
      <button
        type="button"
        className="rule-type-option"
        onClick={() => setModal("ruleTypeOptions")}
      >
        <strong>Create a Rule</strong>
        <small>Create an interval, time, or usage-based rule.</small>
      </button>

      <button
        type="button"
        className="rule-type-option"
        onClick={() => {
          setModal(null);
          setShowPredefinedRules(true);
        }}
      >
        <strong>Assign Predefined Monitoring Rules</strong>
        <small>Assign predefined rules to this asset.</small>
      </button>

      <button
        type="button"
        className="rule-type-option"
        onClick={() => setModal("copyRules")}
      >
        <strong>Copy from Another Asset</strong>
        <small>Copy rules from another asset.</small>
      </button>
    </div>
  </Modal>
)}

{modal === "ruleTypeOptions" && (
  <Modal
    title="Create a Rule"
    onClose={() => setModal(null)}
  >
    <div className="rule-type-options">
      {LEGACY_RULE_CHOICES.map((choice) => (
        <button
          key={choice.kind}
          type="button"
          className="rule-type-option"
          onClick={() => {
            setModal(null);
            navigate(legacyRulePath(assetId, choice.kind));
          }}
        >
          <strong>{choice.label}</strong>
          <small>{choice.description}</small>
        </button>
      ))}
    </div>
  </Modal>
)}

{lifecycleAction && (
  <Modal
    title={
      lifecycleAction.action === "suspend"
        ? "Suspend monitoring rule"
        : lifecycleAction.action === "deactivate"
          ? "Deactivate monitoring rule"
          : lifecycleAction.action === "resume"
            ? "Resume monitoring rule"
            : "Activate monitoring rule"
    }
    onClose={() => {
      if (deletingRuleId === null) {
        setLifecycleAction(null);
        setLoadError("");
      }
    }}
  >
    <p>
      {lifecycleAction.action === "suspend"
        ? "Suspending pauses rule evaluation and prevents new alerts. The rule configuration and history will be retained."
        : lifecycleAction.action === "deactivate"
          ? "Are you sure you want to deactivate this monitoring rule? This disables monitoring but does not mark the rule completed. Its configuration and history will be retained."
          : lifecycleAction.action === "resume"
            ? "Resume monitoring using this rule's saved configuration?"
            : "Activate monitoring using this rule's saved configuration?"}
    </p>
    {loadError && <p className="notice error" role="alert">{loadError}</p>}
    <div className="modal-actions">
      <button
        type="button"
        className="btn-outline"
        disabled={deletingRuleId !== null}
        onClick={() => {
          setLifecycleAction(null);
          setLoadError("");
        }}
      >
        Cancel
      </button>
      <button
        type="button"
        className="btn-primary"
        disabled={deletingRuleId !== null}
        onClick={confirmLifecycleChange}
      >
        {deletingRuleId === lifecycleAction.rule.id
          ? "Saving…"
          : lifecycleAction.action === "suspend"
            ? "Confirm suspension"
            : lifecycleAction.action === "deactivate"
              ? "Deactivate"
              : lifecycleAction.action === "resume"
                ? "Resume rule"
                : "Activate rule"}
      </button>
    </div>
  </Modal>
)}

{tab === "logbook" && modal === "view" && selectedEntry && (
  <Modal
    title="Maintenance Logbook Entry"
    onClose={() => {
      setModal(null);
      setSelectedEntry(null);
    }}
    wide
  >
    <dl className="rule-detail-grid">
      <div>
        <dt>Date and time</dt>
        <dd>
          {selectedEntry.time || selectedEntry.created_at
            ? formatTime(selectedEntry.time || selectedEntry.created_at)
            : "—"}
        </dd>
      </div>

      <div>
        <dt>Entry</dt>
        <dd>
          {selectedEntry.text ||
            selectedEntry.title ||
            selectedEntry.summary ||
            "—"}
        </dd>
      </div>

      <div>
        <dt>Entry type</dt>
        <dd>{selectedEntry.maintenance_type || "Note"}</dd>
      </div>

      <div>
        <dt>Assigned rule</dt>
        <dd>
          {selectedEntry.assigned_rule ||
            selectedEntry.rule_name ||
            selectedEntry.alert_id ||
            "—"}
        </dd>
      </div>

      {selectedEntry.notes && (
        <div>
          <dt>Notes</dt>
          <dd>{selectedEntry.notes}</dd>
        </div>
      )}

      {selectedEntry.id != null && (
        <div>
          <dt>Entry ID</dt>
          <dd>{selectedEntry.id}</dd>
        </div>
      )}
    </dl>

    <div className="modal-actions">
      <button
        type="button"
        className="btn-primary"
        onClick={() => {
          setModal(null);
          setSelectedEntry(null);
        }}
      >
        Close
      </button>
    </div>
  </Modal>
)}

      
{modal === "copyRules" && (
  <CopyRulesModal
    assetId={assetId}
    assets={assets}
    cycleVariableIds={cycleVariableIds}
    onClose={() => setModal(null)}
    onCopied={async (result) => {
      setModal(null);
      await refreshAll();
      setActionNotice(
        `${result.created.length} rule(s) copied to this asset and created inactive.` +
          (result.already_copied?.length
            ? ` ${result.already_copied.length} matching rule(s) were already present.`
            : "")
      );
    }}
  />
)}


      {modal === "add" && (
        <CreateModal
          title={monitoringRuleSelection?.title || "Create monitoring rule"}
          submitLabel="Create rule"
          intro={
            availableVariables.length
              ? undefined
              : "This asset has no active variables yet. Add one under Variables, then come back to create a rule."
          }
          fields={monitoringRuleFormFields}
          initialValues={monitoringRuleSelection?.initialValues}
          onSubmit={addRule}
          onClose={() => {
            setModal(null);
            setMonitoringRuleSelection(null);
          }}
        />
      )}

      {modal === "log" && (
        <CreateModal
          title="New logbook entry"
          submitLabel="Add entry"
          fields={LOG_FIELDS}
          onSubmit={addLog}
          onClose={() => setModal(null)}
        />
      )}

      {modal === "settings" && (
        <CreateModal
          title="Asset settings"
          submitLabel="Save changes"
          onSubmit={saveAsset}
          onClose={() => setModal(null)}
          fields={[
            {
              key: "name",
              label: "Name",
              required: true,
              default: asset.name,
            },
            {
              key: "asset_type",
              label: "Type",
              required: true,
              default: asset.asset_type,
            },
            {
              key: "description",
              label: "Description",
              type: "textarea",
              default: asset.description || "",
            },
            {
              key: "is_active",
              label: "Monitoring",
              type: "select",
              default: String(asset.is_active),
              options: [
                ["true", "Enabled"],
                ["false", "Disabled"],
              ],
              hint:
                "Disabled assets stay in the hierarchy but are greyed out.",
            },
          ]}
        />
      )}

      {(modal === "addVariable" || modal === "editVariable") && (
        <CreateModal
          title={editingVariable ? "Edit variable" : "Add variable"}
          submitLabel={editingVariable ? "Save variable" : "Add variable"}
          fields={VARIABLE_FIELDS}
          initialValues={editingVariable || {}}
          onSubmit={editingVariable ? updateVariable : addVariable}
          onClose={() => {
            setEditingVariable(null);
            setModal("variables");
          }}
        />
      )}

      {modal === "variables" && (
        <Modal
          title="Variables"
          onClose={() => {
            if (deletingVariableId === null) {
              setModal(null);
              setVariableDeleteError("");
            }
          }}
        >
          {variableDeleteError && (
            <p className="notice error" role="alert">
              {variableDeleteError}
            </p>
          )}
          {allVariables.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Key</th>
                  <th>Type</th>
                  <th>Boolean purpose</th>
                  <th>Unit</th>
                  <th>OPC UA NodeId</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {allVariables.map((variable) => (
                  <tr key={variable.id}>
                    <td>{variable.name}</td>
                    <td>{variable.key}</td>
                    <td>{variable.data_type}</td>
                    <td>
                      {variable.signal_role === "running"
                        ? "Machine running"
                        : variable.signal_role === "cycle"
                          ? "Cycle signal"
                          : "—"}
                    </td>
                    <td>{variable.unit || "—"}</td>
                    <td
                      title={variable.opcua_node_id || undefined}
                      style={{ maxWidth: 180, overflowWrap: "anywhere" }}
                    >
                      {variable.opcua_node_id || "—"}
                    </td>
                    <td>{variable.is_active ? "Active" : "Inactive"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={() => {
                          setEditingVariable(variable);
                          setModal("editVariable");
                        }}
                        disabled={deletingVariableId !== null}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => deleteVariable(variable)}
                        disabled={deletingVariableId !== null}
                      >
                        {deletingVariableId === variable.id
                          ? "Deleting…"
                          : "Delete"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              No variables are configured for this asset.
            </p>
          )}

          <div className="modal-actions">
            <button
              className="btn-outline"
              onClick={() => {
                setEditingVariable(null);
                setModal("addVariable");
              }}
              disabled={deletingVariableId !== null}
            >
              Add variable
            </button>

            <button
              className="btn-primary"
              onClick={() => setModal(null)}
              disabled={deletingVariableId !== null}
            >
              Close
            </button>
          </div>
        </Modal>
      )}

      {showPredefinedRules && (
        <PredefinedRulesModal
          assetId={assetId}
          onClose={() => setShowPredefinedRules(false)}
          onAssigned={async (result) => {
            setShowPredefinedRules(false);
            setList("not_activated");
            await refreshAll();
            const assigned = result.created?.length || 0;
            const existing = result.already_assigned?.length || 0;
            setActionNotice(
              `${assigned} predefined rule(s) assigned and created inactive.` +
                (existing ? ` ${existing} rule(s) were already assigned.` : "")
            );
          }}
        />
      )}
    </div>
  );
}