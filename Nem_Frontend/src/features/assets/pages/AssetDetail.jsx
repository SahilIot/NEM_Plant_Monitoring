
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  Bell,
  Download,
  Tag,
  Eye,
  Pencil,
  Pause,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";
import CopyRulesModal from "../components/CopyRulesModal.jsx";
import PredefinedRulesModal from "../../rules/components/PredefinedRulesModal.jsx";
import RuleCategoryOptions from "../../rules/components/RuleCategoryOptions.jsx";
import RuleCollectionAssignmentModal from "../../rules/components/RuleCollectionAssignmentModal.jsx";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import {
  MAINTENANCE_LIFECYCLE_EVENTS,
  createLiveUpdateScheduler,
  subscribeLiveUpdates,
} from "../../../services/liveUpdates.js";
import AssetSupervisors from "../components/AssetSupervisors.jsx";
import AssetDeletionDialog from "../components/AssetDeletionDialog.jsx";
import CurrentMaintenanceCards from "../components/CurrentMaintenanceCards.jsx";
import MaintenanceDetails from "../components/MaintenanceDetails.jsx";
import MaintenancePanel from "../components/MaintenancePanel.jsx";
import RuleStatusDetail from "../../rules/components/RuleStatusDetail.jsx";
import ParameterEditDialog from "../../rules/components/ParameterEditDialog.jsx";
import NotificationSettingsDialog from "../../rules/components/NotificationSettingsDialog.jsx";
import ComponentIdentifierDialog from "../../rules/components/ComponentIdentifierDialog.jsx";
import "./AssetDetail.css";
import {
  legacyRulePath,
} from "../rules/monitoringRuleFlow.js";
import {
  formatTime,
} from "../../../utils/format.js";
import {
  captureNavigationOrigin,
  consumeNavigationFlash,
  hasNavigationFlash,
} from "../../../utils/navigation.js";
import {
  CreateModal,
  EmptyState,
  FloatingMenu,
  LoadingIndicator,
  Modal,
  StatusBadge,
  useConfirmation,
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
} from "../../../components/common/Icons.jsx";
import { BackButton } from "../../../components/common/NavButtons.jsx";
import { actualValuesText, checklistText } from "../components/MaintenanceRecordData.jsx";

const ORDER = { alert: 0, warning: 1, ok: 2 };

const HEALTH_LABEL = {
  alert: "Alert active",
  warning: "Warning active",
  ok: "No active alerts",
  off: "Disabled",
};

function eventActionLabel(eventType) {
  if (!eventType) return "Event";
  if (eventType === "alert_acknowledged") return "Alert Acknowledged";
  if (eventType === "rule_completed") return "Rule Completed";
  return eventType
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function eventTone(eventType) {
  const type = String(eventType || "").toLowerCase();
  if (/resolved|completed|returned|normal|cleared/.test(type)) return "ok";
  if (/acknowledged/.test(type)) return "info";
  if (/alert/.test(type)) return "alert";
  if (/warning|stale|disconnect|unavailable|not_evaluated/.test(type)) return "warn";
  return "neutral";
}

function eventAuditSummary(event) {
  const metadata = event?.metadata || {};
  const parts = [];
  if (metadata.acknowledged_by) {
    parts.push(`Acknowledged by ${metadata.acknowledged_by}`);
  }
  if (metadata.acknowledged_at) {
    parts.push(`at ${formatTime(metadata.acknowledged_at)}`);
  }
  if (metadata.completed_by) {
    parts.push(`Completed by ${metadata.completed_by}`);
  }
  if (metadata.completed_at) {
    parts.push(`at ${formatTime(metadata.completed_at)}`);
  }
  return parts.join(" · ");
}

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
    key: "is_active",
    label: "Status",
    type: "select",
    default: "true",
    options: [
      ["true", "Active"],
      ["false", "Inactive"],
    ],
    hint: "Inactive variables are not polled or evaluated. Their rules, readings, alerts and history are kept.",
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

// "Parameters: 3 · 1 Normal · 1 Due · 1 Overdue" for a rule card. Suspended and deactivated parameters are
// counted separately and never as Normal; a rule that is not running reports that nothing is evaluated.
function parameterSummary(rule) {
  const items = rule.parameter_items || [];
  if (items.length === 0) return "No parameters";
  if (rule.lifecycle_status && rule.lifecycle_status !== "in_progress") return `${items.length} · not evaluating`;
  const evaluating = items.filter((item) => item.lifecycle_status === "active");
  const intervalOnly = items.every((item) => item.kind === "interval");
  const labels = intervalOnly
    ? [["normal", "Normal"], ["warning", "Due"], ["alert", "Overdue"]]
    : [["normal", "Normal"], ["warning", "Warning"], ["alert", "Alert"]];
  const parts = [...labels, ["unknown", "Not evaluated"]]
    .map(([status, label]) => [evaluating.filter((item) => item.status === status).length, label])
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  for (const [name, label] of [["suspended", "Suspended"], ["deactivated", "Deactivated"]]) {
    const count = items.filter((item) => item.lifecycle_status === name).length;
    if (count > 0) parts.push(`${count} ${label}`);
  }
  return [String(items.length), ...parts].join(" · ");
}

export default function AssetDetail() {
  const confirm = useConfirmation();
  const { user } = useAuth();
  const isAdministrator = user?.role === "Administrator";
  const isSupervisor = user?.role === "Supervisor";
  const isOperator = user?.role === "Operator";
  const canManageRules = isAdministrator || isSupervisor;
  const canChangeRuleLifecycle = isAdministrator;
  const canManageLogbook = canManageRules;
  const { id, scheduleId, ruleId } = useParams();
  // Dedicated page for one multi-parameter rule: /assets/:id/rules/:ruleId/status
  const detailRuleId = ruleId ? Number(ruleId) : null;
  const location = useLocation();
  const navigate = useNavigate();

  const { assets, assetsLoaded, reload, refreshStatus } =
    useOutletContext();

  const assetId = Number(id);
  const routeState = location.state || {};
  const asset = assets.find((a) => a.id === assetId);

  const [tab, setTab] = useState(
  scheduleId
    ? "logbook"
    : ["status", "logbook", "events"].includes(routeState.activeTab)
      ? routeState.activeTab
      : "status"
);
  const [list, setList] = useState(
    ["activated", "not_activated"].includes(routeState.assetRuleList)
      ? routeState.assetRuleList
      : "activated"
  );
  const [rules, setRules] = useState([]);
  const [completedMaintenanceCount, setCompletedMaintenanceCount] = useState(0);
  const [maintenanceRefreshKey, setMaintenanceRefreshKey] = useState(0);
  const [maintenanceRecordsKey, setMaintenanceRecordsKey] = useState(0);
  // Bumped by live updates so the Schedules list re-reads the backend's authoritative progress.
  const [scheduleProgressKey, setScheduleProgressKey] = useState(0);
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const [variables, setVariables] = useState([]);
  const [allVariables, setAllVariables] = useState([]);
  const [cycleVariableIds, setCycleVariableIds] = useState([]);
  const [runtimeVariableIds, setRuntimeVariableIds] = useState([]);
  const [editingVariable, setEditingVariable] = useState(null);
  const [children, setChildren] = useState(
    Boolean(routeState.assetIncludeChildren)
  );
  const [sort, setSort] = useState(
    routeState.assetRuleSort === "name" ? "name" : "severity"
  );
  const [filter, setFilter] = useState(routeState.assetRuleFilter || "");
  const [showFilter, setShowFilter] = useState(false);
  const [menu, setMenu] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState(null);
  const [ruleActionMenuId, setRuleActionMenuId] = useState(null);
  const [lifecycleAction, setLifecycleAction] = useState(null);
  // "Edit parameter" on the multi-parameter detail page: the rule being edited, and a refresh trigger.
  const [parameterEdit, setParameterEdit] = useState(null); // { ruleId, parameterId, alwaysSelect }
  const [notificationRuleId, setNotificationRuleId] = useState(null); // rule whose notification settings are open
  const [componentRuleId, setComponentRuleId] = useState(null); // rule whose component identifier is being edited
  const [eventComponentFilter, setEventComponentFilter] = useState("");
  const [statusRefresh, setStatusRefresh] = useState(0);
  const openRuleStatusPage = (ruleId) => {
    navigate(`/assets/${assetId}/rules/${ruleId}/status`, {
      state: { ...assetNavigationState, activeTab: "status" },
    });
  };
  const closeRuleStatusPage = () => {
    navigate(`/assets/${assetId}`, { state: { ...assetNavigationState, activeTab: "status" } });
  };
  const [actionNotification, setActionNotification] = useState(null);
  const actionNotice =
    actionNotification?.assetId === assetId ? actionNotification : null;
  const activeAssetId = useRef(assetId);
  activeAssetId.current = assetId;
  const setActionNotice = (message) => {
    if (!message) {
      setActionNotification(null);
      return;
    }
    setActionNotification({
      text: message,
      type: "success",
      assetId: activeAssetId.current,
    });
  };
  const notifyAction = (
    message,
    type = "success",
    notificationAssetId = activeAssetId.current
  ) => {
    if (notificationAssetId !== activeAssetId.current) return;
    setActionNotification({
      text: message,
      type,
      assetId: notificationAssetId,
    });
  };
  const [sortMenu, setSortMenu] = useState(false);
  const [modal, setModal] = useState(null);
  const [showPredefinedRules, setShowPredefinedRules] = useState(false);
  // Keep the new collection workflow independent of the existing predefined-rule modal.
  const [showRuleCollections, setShowRuleCollections] = useState(false);
  const [logs, setLogs] = useState([]);
  const [selectedMaintenanceLogIds, setSelectedMaintenanceLogIds] = useState([]);
  const [bulkDeletingMaintenanceLogs, setBulkDeletingMaintenanceLogs] = useState(false);
  const [maintenanceTypeFilter, setMaintenanceTypeFilter] = useState(
    routeState.maintenanceTypeFilter || ""
  );
  const [maintenanceStartDateTime, setMaintenanceStartDateTime] = useState(
    routeState.maintenanceStartDateTime || ""
  );
  const [maintenanceEndDateTime, setMaintenanceEndDateTime] = useState(
    routeState.maintenanceEndDateTime || ""
  );
  const [events, setEvents] = useState([]);
  const [selectedEventIds, setSelectedEventIds] = useState([]);
  const [bulkDeletingEvents, setBulkDeletingEvents] = useState(false);
  const [eventTypeFilter, setEventTypeFilter] = useState(
    routeState.eventTypeFilter || ""
  );
  const [eventStartDateTime, setEventStartDateTime] = useState(
    routeState.eventStartDateTime || ""
  );
  const [eventEndDateTime, setEventEndDateTime] = useState(
    routeState.eventEndDateTime || ""
  );
  const [loadError, setLoadError] = useState("");
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [deletingAsset, setDeletingAsset] = useState(false);
  const [showDeleteAsset, setShowDeleteAsset] = useState(false);
  const [togglingVariableId, setTogglingVariableId] = useState(null);
  const [deletingVariableId, setDeletingVariableId] = useState(null);
  const [variableDeleteError, setVariableDeleteError] = useState("");
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [showEventDetails, setShowEventDetails] = useState(false);
  const [maintenanceEventRecord, setMaintenanceEventRecord] = useState(null);
  const [maintenanceEventLoading, setMaintenanceEventLoading] = useState(false);
  const [maintenanceEventError, setMaintenanceEventError] = useState("");
  const [deletingEventId, setDeletingEventId] = useState(null);
  const [eventDeleteError, setEventDeleteError] = useState("");
  const [deletingLogId, setDeletingLogId] = useState(null);
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);

  const seq = useRef(0);
  const ruleListSeq = useRef(0);
  const plcStatusSeq = useRef(0);
  const bulkRequest = useRef(false);
  const permanentDeleteRequest = useRef(false);
  const bulkMaintenanceDeleteRequest = useRef(false);
  const bulkEventDeleteRequest = useRef(false);
  const skipNextRouteStateRestore = useRef(false);
  const assetRouteGeneration = useRef(0);

  useEffect(() => {
    assetRouteGeneration.current += 1;
    return () => {
      assetRouteGeneration.current += 1;
    };
  }, [assetId]);

  useEffect(() => {
    setActionNotification(null);
  }, [assetId]);

  useEffect(() => {
    setSelectedMaintenanceLogIds([]);
  }, [
    assetId,
    tab,
    maintenanceTypeFilter,
    maintenanceStartDateTime,
    maintenanceEndDateTime,
  ]);

  useEffect(() => {
    setSelectedEventIds([]);
  }, [assetId, tab, eventTypeFilter, eventStartDateTime, eventEndDateTime]);

  const assetNavigationState = {
    ...(location.state || {}),
    activeTab: tab,
    assetRuleList: list,
    assetRuleFilter: filter,
    assetRuleSort: sort,
    assetIncludeChildren: children,
    maintenanceTypeFilter,
    maintenanceStartDateTime,
    maintenanceEndDateTime,
    eventTypeFilter,
    eventStartDateTime,
    eventEndDateTime,
  };

  const maintenanceEventRecordId = Number(
    selectedEvent?.metadata?.maintenance_record_id
  );
  useEffect(() => {
    if (
      !showEventDetails ||
      !Number.isInteger(maintenanceEventRecordId) ||
      maintenanceEventRecordId <= 0
    ) {
      setMaintenanceEventRecord(null);
      setMaintenanceEventLoading(false);
      setMaintenanceEventError("");
      return undefined;
    }

    let active = true;
    setMaintenanceEventRecord(null);
    setMaintenanceEventLoading(true);
    setMaintenanceEventError("");
    api.get(`/maintenance/${maintenanceEventRecordId}`)
      .then((record) => {
        if (active) setMaintenanceEventRecord(record);
      })
      .catch((error) => {
        if (active) {
          setMaintenanceEventError(
            error.message || "Could not load the related maintenance record."
          );
        }
      })
      .finally(() => {
        if (active) setMaintenanceEventLoading(false);
      });

    return () => {
      active = false;
    };
  }, [maintenanceEventRecordId, showEventDetails]);

  useEffect(() => {
    if (!menu && !sortMenu && ruleActionMenuId === null) return undefined;

    const closeMenus = () => {
      setMenu(false);
      setSortMenu(false);
      setRuleActionMenuId(null);
    };
    const handlePointerDown = (event) => {
      if (!(event.target instanceof Element)) return;
      const openDropdowns = document.querySelectorAll(
        ".asset-page .dropdown[data-menu-open='true']"
      );
      if (event.target.closest(".floating-menu")) return;
      if (event.target.closest(".logbook-action-menu-trigger")) return;
      if (![...openDropdowns].some((dropdown) => dropdown.contains(event.target))) {
        closeMenus();
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeMenus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu, ruleActionMenuId, sortMenu]);

  
  const loadLive = useCallback(async ({
    includeRuleList = true,
    includePlcStatus = true,
  } = {}) => {
    const generation = seq.current;
    const ruleRequest = includeRuleList ? ++ruleListSeq.current : null;
    const plcRequest = includePlcStatus ? ++plcStatusSeq.current : null;

    try {
      const [r, plc] = await Promise.allSettled([
        includeRuleList
          ? api.get(`/assets/${assetId}/rules?include_children=${children}`)
          : Promise.resolve(null),
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
        setRulesLoaded(true);
        if (
          generation === seq.current &&
          ruleRequest === ruleListSeq.current
        ) {
          setLoadError("");
        }
      } else if (
        includeRuleList &&
        ruleRequest === ruleListSeq.current &&
        r.status === "rejected"
      ) {
        setLoadError(
          r.reason?.message || "Unable to load rules."
        );
        setRulesLoaded(true);
      }

      if (
        includePlcStatus &&
        plcRequest === plcStatusSeq.current &&
        plc.status === "fulfilled"
      ) {
        const mappings = Array.isArray(plc.value?.mappings)
          ? plc.value.mappings
          : [];
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
      if (generation === seq.current) {
        setLoadError(error.message || "Unable to refresh asset monitoring.");
      }
    }
  }, [assetId, children]);

  const liveScheduler = useMemo(
    () => createLiveUpdateScheduler(() => loadLive(), 200),
    [loadLive]
  );
  // A rule or parameter changed its evaluated status (Normal / Due / Overdue / Warning / Alert ...): re-read the
  // rule list, which carries each rule's status. (This used to be loadLive with both parts switched off, which made
  // no request at all, so the rule cards kept their old status until the page was reloaded.)
  const statusScheduler = useMemo(
    () => createLiveUpdateScheduler(() => loadLive({ includeRuleList: true, includePlcStatus: false }), 250),
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
    const generation = seq.current;
    try {
      const items = await api.getAll(
        `/assets/${assetId}/variables`
      );
      if (generation !== seq.current) return;

      const loadedVariables = Array.isArray(items) ? items : [];
      setAllVariables(loadedVariables);
      setVariables(
        loadedVariables.filter((variable) => variable.is_active)
      );
    } catch (error) {
      if (generation !== seq.current) return;
      setVariables([]);
      setAllVariables([]);
      setLoadError(
        error.message || "Unable to load variables."
      );
    }
  }, [assetId]);

  // Latest request wins: a slow, older logbook response must never replace a newer one.
  const logsRequest = useRef(0);
  const loadLogs = useCallback(() => {
    const generation = seq.current;
    const request = ++logsRequest.current;
    return api
      .get(`/assets/${assetId}/logbook`)
      .then((items) => {
        if (generation !== seq.current || request !== logsRequest.current) return;
        setLogs(Array.isArray(items) ? items : []);
      })
      .catch((error) => {
        if (generation !== seq.current) return;
        setLoadError(
          error.message || "Unable to load logbook."
        );
      });
  }, [assetId]);

  const loadEvents = useCallback(async () => {
    const generation = seq.current;
    try {
      const items = await api.get(`/assets/${assetId}/events`);
      if (generation !== seq.current) return;
      setEvents(Array.isArray(items) ? items : []);
    } catch (error) {
      if (generation !== seq.current) return;
      setLoadError(error.message || "Unable to load events.");
    }
  }, [assetId]);

  const eventsScheduler = useMemo(
    () => createLiveUpdateScheduler(loadEvents, 250),
    [loadEvents]
  );

  // Live maintenance changes are collected for a moment and applied once, and only for what actually changed:
  // records -> logbook list (only while that tab is open), job list and current cards; schedules alone (progress
  // saved by the evaluator or collector) -> the Logbook's schedule list (when open), nothing else.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const logsStale = useRef(false);
  const pendingMaintenance = useRef({ records: false, schedules: false, structural: false });
  const maintenanceScheduler = useMemo(
    () =>
      createLiveUpdateScheduler(() => {
        const pending = pendingMaintenance.current;
        pendingMaintenance.current = { records: false, schedules: false, structural: false };
        if (pending.records) {
          if (tabRef.current === "logbook") loadLogs();
          else logsStale.current = true;
          setMaintenanceRecordsKey((current) => current + 1);
          setMaintenanceRefreshKey((current) => current + 1);
        } else if (pending.structural) {
          setMaintenanceRefreshKey((current) => current + 1);
        }
        if (pending.schedules) {
          setScheduleProgressKey((current) => current + 1);
        }
      }, 250),
    [loadLogs]
  );
  useEffect(() => () => maintenanceScheduler.dispose(), [maintenanceScheduler]);
  useEffect(() => {
    if (tab === "logbook" && logsStale.current) {
      logsStale.current = false;
      loadLogs();
    }
  }, [tab, loadLogs]);

  const refreshMaintenanceData = useCallback(async () => {
    setMaintenanceRefreshKey((current) => current + 1);
    await Promise.all([refreshStatus?.(), loadLogs()]);
  }, [loadLogs, refreshStatus]);

  const deleteEvent = async (event) => {
    if (
      !isAdministrator ||
      deletingEventId !== null ||
      bulkEventDeleteRequest.current
    ) {
      return;
    }
    if (
      !(await confirm("Permanently delete this event? This cannot be undone.", {
        title: "Delete event",
        confirmLabel: "Delete permanently",
        destructive: true,
      }))
    ) {
      return;
    }
    setActionNotice("");
    setDeletingEventId(event.id);
    setEventDeleteError("");
    try {
      await api.del(`/events/${event.id}`);
      await loadEvents();
      setSelectedEventIds((current) =>
        current.filter((id) => id !== event.id)
      );
      setActionNotice("Event was permanently deleted.");
    } catch (error) {
      setEventDeleteError(error.message || "Could not delete this event.");
    } finally {
      setDeletingEventId(null);
    }
  };

  
  useEffect(() => {
    const restoredState = location.state || {};
    setTab(
  scheduleId
    ? "logbook"
    : ["status", "logbook", "events"].includes(restoredState.activeTab)
      ? restoredState.activeTab
      : "status"
);
    setList(
      ["activated", "not_activated"].includes(restoredState.assetRuleList)
        ? restoredState.assetRuleList
        : "activated"
    );
    setFilter(restoredState.assetRuleFilter || "");
    setSort(restoredState.assetRuleSort === "name" ? "name" : "severity");
    setChildren(Boolean(restoredState.assetIncludeChildren));
    setRules([]);
    setRulesLoaded(false);
    setAllVariables([]);
    setVariables([]);
    setLogs([]);
    setMaintenanceTypeFilter(restoredState.maintenanceTypeFilter || "");
    setMaintenanceStartDateTime(
      restoredState.maintenanceStartDateTime || ""
    );
    setMaintenanceEndDateTime(restoredState.maintenanceEndDateTime || "");
    setEvents([]);
    setEventTypeFilter(restoredState.eventTypeFilter || "");
    setEventStartDateTime(restoredState.eventStartDateTime || "");
    setEventEndDateTime(restoredState.eventEndDateTime || "");
    setSelectedEvent(null);
    setShowEventDetails(false);
    setLoadError("");

    loadVariables();
    loadLogs();

    return () => {
      seq.current += 1;
    };
  }, [assetId, scheduleId, loadVariables, loadLogs]);

  useEffect(() => {
    loadLive();
  }, [loadLive]);

  useEffect(() => {
    if (
      location.state?.createdNotice ||
      hasNavigationFlash(location)
    ) {
      return;
    }

    const storedState = location.state || {};
    const contextKeys = [
      "activeTab",
      "assetRuleList",
      "assetRuleFilter",
      "assetRuleSort",
      "assetIncludeChildren",
      "maintenanceTypeFilter",
      "maintenanceStartDateTime",
      "maintenanceEndDateTime",
      "eventTypeFilter",
      "eventStartDateTime",
      "eventEndDateTime",
    ];
    if (
      contextKeys.every(
        (key) => storedState[key] === assetNavigationState[key]
      )
    ) {
      return;
    }

    skipNextRouteStateRestore.current = true;
    navigate(
      `${location.pathname}${location.search}${location.hash}`,
      {
        replace: true,
        state: { ...storedState, ...assetNavigationState },
      }
    );
  }, [
    tab,
    list,
    filter,
    sort,
    children,
    maintenanceTypeFilter,
    maintenanceStartDateTime,
    maintenanceEndDateTime,
    eventTypeFilter,
    eventStartDateTime,
    eventEndDateTime,
    location.pathname,
    location.search,
    location.hash,
    location.key,
    location.state,
    navigate,
  ]);

  useEffect(() => {
    if (skipNextRouteStateRestore.current) {
      skipNextRouteStateRestore.current = false;
      return;
    }

    const navigationState = location.state;
    const flash = consumeNavigationFlash(location);
    const restoredState = flash?.state || navigationState;

    if (scheduleId) {
  setTab("logbook");
} else if (
  ["status", "logbook", "events"].includes(restoredState?.activeTab)
) {
  setTab(restoredState.activeTab);
}
    if (
      ["activated", "not_activated"].includes(
        restoredState?.assetRuleList
      )
    ) {
      setList(restoredState.assetRuleList);
    }
    if (restoredState?.assetRuleFilter != null) {
      setFilter(restoredState.assetRuleFilter);
    }
    if (restoredState?.assetRuleSort) {
      setSort(restoredState.assetRuleSort);
    }
    if (restoredState?.assetIncludeChildren != null) {
      setChildren(Boolean(restoredState.assetIncludeChildren));
    }
    if (restoredState?.maintenanceTypeFilter != null) {
      setMaintenanceTypeFilter(restoredState.maintenanceTypeFilter);
    }
    if (restoredState?.maintenanceStartDateTime != null) {
      setMaintenanceStartDateTime(restoredState.maintenanceStartDateTime);
    }
    if (restoredState?.maintenanceEndDateTime != null) {
      setMaintenanceEndDateTime(restoredState.maintenanceEndDateTime);
    }
    if (restoredState?.eventTypeFilter != null) {
      setEventTypeFilter(restoredState.eventTypeFilter);
    }
    if (restoredState?.eventStartDateTime != null) {
      setEventStartDateTime(restoredState.eventStartDateTime);
    }
    if (restoredState?.eventEndDateTime != null) {
      setEventEndDateTime(restoredState.eventEndDateTime);
    }

    if (navigationState?.createdNotice) {
      setActionNotice(navigationState.createdNotice);
    }
    if (flash?.text) setActionNotice(flash.text);

    if (navigationState?.createdNotice) {
      const retainedState = { ...navigationState };
      delete retainedState.createdNotice;
      navigate(
        `${location.pathname}${location.search}${location.hash}`,
        {
        replace: true,
          state: retainedState,
        }
      );
    }
  }, [
    location.pathname,
    location.search,
    location.hash,
    location.state,
    location.key,
    navigate,
  ]);


  useEffect(() => {
    return subscribeLiveUpdates((update) => {
      if (update.resync_required) {
        liveScheduler();
        loadVariables();
        if (tabRef.current === "logbook") loadLogs();
        else logsStale.current = true;
        // Includes WebSocket reconnects: restore the latest schedule progress.
        setScheduleProgressKey((current) => current + 1);
        setMaintenanceRefreshKey((current) => current + 1);
        setMaintenanceRecordsKey((current) => current + 1);
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
        // Named by the backend only when a rule's or parameter's status really changed (not for every reading or
        // counter tick), so this stays a handful of requests per transition rather than one per event.
        (update.events || []).some((name) => name.startsWith("rule.") || name.startsWith("parameter."))
      ) {
        statusScheduler();
      }
      if (changedTables.has("variables") || changedTables.has("assets")) {
        loadVariables();
      }
      const recordsChanged = changedTables.has("nem_maintenance_records");
      const schedulesChanged = changedTables.has("nem_maintenance_schedules");
      if (recordsChanged || schedulesChanged) {
        const named = update.events || [];
        // A schedule that only advanced its progress is not a lifecycle change: the cards need a full re-read only
        // when a schedule was created, became ready, started, completed, cancelled or deleted.
        const structural = named.some((name) => MAINTENANCE_LIFECYCLE_EVENTS.has(name));
        const pending = pendingMaintenance.current;
        pending.records = pending.records || recordsChanged;
        pending.schedules = pending.schedules || schedulesChanged;
        pending.structural = pending.structural || structural;
        maintenanceScheduler();
      }
      if (changedTables.has("nem_monitoring_events") && tabRef.current === "events") {
        eventsScheduler();
      }
    });
  }, [assetId, assets, children, loadLive, loadLogs, loadVariables, maintenanceScheduler]);

 
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

  const isAct = (rule) => rule.state === "activated";
  const nAct = rules.filter(isAct).length;
  const nNot = rules.length - nAct + completedMaintenanceCount;

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

  
const maintenanceTypes = [...new Set(
  logs.map((entry) => entry.maintenance_type).filter(Boolean)
)].sort((a, b) => a.localeCompare(b));
const filteredLogs = [...logs]
  .filter((entry) => {
    if (
      maintenanceTypeFilter &&
      entry.maintenance_type !== maintenanceTypeFilter
    ) {
      return false;
    }
    const timestamp = new Date(entry.time || entry.created_at || "").getTime();
    const start = maintenanceStartDateTime
      ? new Date(maintenanceStartDateTime).getTime()
      : Number.NaN;
    const end = maintenanceEndDateTime
      ? new Date(maintenanceEndDateTime).getTime()
      : Number.NaN;
    if (Number.isFinite(start) && (!Number.isFinite(timestamp) || timestamp < start)) {
      return false;
    }
    if (Number.isFinite(end) && (!Number.isFinite(timestamp) || timestamp > end)) {
      return false;
    }
    return true;
  })
  .sort(
    (a, b) =>
      new Date(b.time || b.created_at || 0).getTime() -
      new Date(a.time || a.created_at || 0).getTime()
  );

const eventTypes = [...new Set(events.map((event) => event.event_type).filter(Boolean))]
  .sort((a, b) => eventActionLabel(a).localeCompare(eventActionLabel(b)));
const eventComponents = [...new Set(events.map((event) => event.component_identifier).filter(Boolean))]
  .sort((a, b) => a.localeCompare(b));
const filteredEvents = [...events]
  .filter((event) => {
    if (eventTypeFilter && event.event_type !== eventTypeFilter) return false;
    if (eventComponentFilter && event.component_identifier !== eventComponentFilter) return false;
    const timestamp = new Date(event.time || event.occurred_at || "").getTime();
    const start = eventStartDateTime
      ? new Date(eventStartDateTime).getTime()
      : Number.NaN;
    const end = eventEndDateTime
      ? new Date(eventEndDateTime).getTime()
      : Number.NaN;
    if (Number.isFinite(start) && (!Number.isFinite(timestamp) || timestamp < start)) {
      return false;
    }
    if (Number.isFinite(end) && (!Number.isFinite(timestamp) || timestamp > end)) {
      return false;
    }
    return true;
  })
  .sort(
    (a, b) =>
      new Date(b.time || b.occurred_at || 0).getTime() -
      new Date(a.time || a.occurred_at || 0).getTime()
  );
 
  // CSV / JSON export of the event log. The server applies the same asset, type and date filters as the on-screen log
  // and returns every matching event, not just the page that is loaded.
  const exportEventsFile = async (format) => {
    const params = new URLSearchParams({ format });
    if (eventTypeFilter) params.set("event_type", eventTypeFilter);
    if (eventComponentFilter) params.set("component_identifier", eventComponentFilter);
    for (const [key, value] of [["start_time", eventStartDateTime], ["end_time", eventEndDateTime]]) {
      const date = value ? new Date(value) : null;
      if (date && !Number.isNaN(date.getTime())) params.set(key, date.toISOString());
    }
    setExportError("");
    setExporting(true);
    try {
      await api.download(`/assets/${assetId}/events/export?${params}`, `${assetFileName}-event-log-${exportFileDate}.${format}`);
    } catch (error) {
      setExportError(error.message || `Could not export the event log as ${format.toUpperCase()}.`);
    } finally {
      setExporting(false);
    }
  };

  const exportExcel = async ({
    rows,
    headers,
    sheetName,
    fileName,
    confirmMessage,
  }) => {
    if (
      !(await confirm(confirmMessage, {
        title: "Export Excel file",
        confirmLabel: "Download",
      }))
    ) return;
    setExportError("");
    setExporting(true);
    try {
      const XLSX = await import("@e965/xlsx");
      const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
      XLSX.writeFile(workbook, fileName);
    } catch (error) {
      setExportError(error.message || "Could not export the Excel file.");
    } finally {
      setExporting(false);
    }
  };

  const exportFileDate = new Date().toISOString().slice(0, 10);
  const assetFileName =
    (asset?.name || `asset-${assetId}`)
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || `asset-${assetId}`;

  const refreshAll = async () => {
    await Promise.all([
      loadLive(),
      refreshStatus?.(),
    ]);
  };

  const confirmLifecycleChange = async () => {
    // Supervisors may only activate a Not Activated rule after reviewing it.
    if (
      !(canChangeRuleLifecycle || (isSupervisor && lifecycleAction?.action === "activate")) ||
      !lifecycleAction ||
      deletingRuleId !== null
    ) return;
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

  // Action menu items for one rule; shared by the rule card and the details-section header.
  const renderRuleMenu = (rule) => {
    // On the rule's own detail page "View rule" would only reopen the page.
    const onDetailPage = detailRuleId === rule.id;
    return (
<FloatingMenu align="right" role="menu">
    {!onDetailPage && (
    <button
      type="button"
      className="rule-action-menu-item rule-action-menu-item--view"
      role="menuitem"
      onClick={() => {
        setRuleActionMenuId(null);
        openRuleStatusPage(rule.id);
      }}
    >
      <Eye size={16} aria-hidden="true" />
      <span>View rule</span>
    </button>
    )}

    <button
      type="button"
      className="rule-action-menu-item rule-action-menu-item--edit"
      role="menuitem"
      onClick={() => {
        setRuleActionMenuId(null);
        // Editing always starts from the parameter selector, whether the rule has one parameter or many.
        setParameterEdit({ ruleId: rule.id, parameterId: null, alwaysSelect: true });
      }}
      disabled={!canManageRules && !isSupervisor}
      title={
        isSupervisor
          ? "Supervisors can change the Due and Overdue values only."
          : !canManageRules
            ? "You do not have permission to manage monitoring rules."
            : undefined
      }
    >
      <Pencil size={16} aria-hidden="true" />
      <span>Edit parameter</span>
    </button>

    <button
      type="button"
      className="rule-action-menu-item rule-action-menu-item--edit"
      role="menuitem"
      onClick={() => {
        setRuleActionMenuId(null);
        setNotificationRuleId(rule.id);
      }}
      disabled={!canManageRules && !isSupervisor}
      title={!canManageRules && !isSupervisor ? "You do not have permission to manage monitoring rules." : undefined}
    >
      <Bell size={16} aria-hidden="true" />
      <span>Notification settings</span>
    </button>

    <button
      type="button"
      className="rule-action-menu-item rule-action-menu-item--edit"
      role="menuitem"
      onClick={() => {
        setRuleActionMenuId(null);
        setComponentRuleId(rule.id);
      }}
      disabled={!canManageRules && !isSupervisor}
      title={!canManageRules && !isSupervisor ? "You do not have permission to manage monitoring rules." : undefined}
    >
      <Tag size={16} aria-hidden="true" />
      <span>Component identifier</span>
    </button>

    {/* Suspend rule */}
    {lifecycleStatus(rule) === "in_progress" && (
      <button
        type="button"
        className="rule-action-menu-item rule-action-menu-item--lifecycle"
        role="menuitem"
        onClick={() => {
          setRuleActionMenuId(null);
          setLifecycleAction({ rule, action: "suspend" });
        }}
        disabled={!canChangeRuleLifecycle || deletingRuleId !== null}
        title={
          !canChangeRuleLifecycle
            ? "Only Administrators can change monitoring rule states."
            : undefined
        }
      >
        <Pause size={16} aria-hidden="true" />
        Suspend rule
      </button>
    )}

    {/* Activate rule: suspended */}
    {lifecycleStatus(rule) === "suspended" && (
      <button
        type="button"
        className="rule-action-menu-item rule-action-menu-item--lifecycle"
        role="menuitem"
        onClick={() => {
          setRuleActionMenuId(null);
          setLifecycleAction({ rule, action: "resume" });
        }}
        disabled={deletingRuleId !== null || !isAdministrator}
        title={
          !isAdministrator
              ? "Only Administrators can activate suspended rules."
            : undefined
        }
      >
        <Power size={16} aria-hidden="true" />
        Activate rule
      </button>
    )}

    {/* Activate rule: deactivated */}
    {lifecycleStatus(rule) === "deactivated" && (
      <button
        type="button"
        className="rule-action-menu-item rule-action-menu-item--lifecycle"
        role="menuitem"
        onClick={() => {
          setRuleActionMenuId(null);
          setLifecycleAction({ rule, action: "activate" });
        }}
        disabled={deletingRuleId !== null || !(canChangeRuleLifecycle || isSupervisor)}
        title={
          !(canChangeRuleLifecycle || isSupervisor)
            ? "Only Administrators and Supervisors can activate monitoring rules."
            : undefined
        }
      >
        <Power size={16} aria-hidden="true" />
        Activate rule
      </button>
    )}

    {/* Deactivate rule */}
    {["in_progress", "suspended"].includes(lifecycleStatus(rule)) && (
      <button
        type="button"
        className="rule-action-menu-item rule-action-menu-item--lifecycle"
        role="menuitem"
        onClick={() => {
          setRuleActionMenuId(null);
          setLifecycleAction({ rule, action: "deactivate" });
        }}
        disabled={!canChangeRuleLifecycle || deletingRuleId !== null}
        title={
          !canChangeRuleLifecycle
            ? "Only Administrators can change monitoring rule states."
            : undefined
        }
      >
        <Power size={16} aria-hidden="true" />
        Deactivate rule
      </button>
    )}

    {lifecycleStatus(rule) !== "in_progress" && (
      <button
        type="button"
        className="rule-action-menu-item rule-action-menu-item--delete"
        role="menuitem"
        onClick={() => {
          setRuleActionMenuId(null);
          permanentlyDeleteRule(rule);
        }}
        disabled={!isAdministrator || deletingRuleId !== null}
        title={!isAdministrator ? "Only Administrators can permanently delete rules." : "Permanently delete rule"}
      >
        <Trash2 size={16} aria-hidden="true" />
        <span>{deletingRuleId === rule.id ? "Deleting…" : "Delete rule"}</span>
      </button>
    )}
                          </FloatingMenu>
    );
  };

  const selectRuleList = (nextList) => {
    setList(nextList);
  };

  const permanentlyDeleteRule = async (rule) => {
    if (!isAdministrator || permanentDeleteRequest.current) return;
    permanentDeleteRequest.current = true;
    setDeletingRuleId(rule.id);
    setLoadError("");
    setActionNotice("");
    try {
      if (!(await confirm(
        `Permanently delete “${rule.name}”? This irreversibly removes the rule, its alerts, and its evaluation history. Maintenance records linked to its alerts must be removed first.`,
        {
          title: "Permanently delete rule",
          confirmLabel: "Delete permanently",
          destructive: true,
        }
      ))) return;
      await api.del(`/rules/${rule.id}`);
      await refreshAll();
      setActionNotice(`Rule “${rule.name}” was permanently deleted.`);
    } catch (error) {
      setLoadError(error.message || "Could not permanently delete the rule.");
    } finally {
      permanentDeleteRequest.current = false;
      setDeletingRuleId(null);
    }
  };

  // Activate All: only Not Activated rules of this asset (child assets only when included).
  const activateAll = async () => {
    if (!canManageRules || bulkRequest.current || bulkSaving) return;
    setMenu(false);
    setLoadError("");
    setActionNotice("");
    bulkRequest.current = true;
    setBulkSaving(true);
    try {
      const query = `include_children=${children}`;
      const preview = await api.post(`/assets/${assetId}/rules/activate-all?${query}&dry_run=true`, {});
      if (!preview.eligible) {
        setActionNotice("There are no Not Activated rules to activate.");
        return;
      }
      const scope = children ? "this asset and its included child assets" : "this asset only";
      bulkRequest.current = false;
      setBulkSaving(false);
      if (!(await confirm(
        `Activate ${preview.eligible} rule(s) on ${scope}? Rules that are suspended or completed are not changed, and rules that cannot be activated are skipped with a reason.`,
        { title: `Activate all rules — ${asset?.name || "asset"}`, confirmLabel: "Activate all" }
      ))) {
        return;
      }
      bulkRequest.current = true;
      setBulkSaving(true);
      const result = await api.post(`/assets/${assetId}/rules/activate-all?${query}`, {});
      await refreshAll();
      const skipped = result.skipped || [];
      setActionNotice(
        `${result.activated} rule(s) activated.` +
          (skipped.length
            ? ` ${skipped.length} skipped: ${skipped.map((item) => `${item.name} (${item.reason})`).join("; ")}`
            : "")
      );
    } catch (error) {
      setLoadError(error.message || "Could not activate the rules.");
    } finally {
      bulkRequest.current = false;
      setBulkSaving(false);
    }
  };

  const bulk = async (state) => {
    if (!canChangeRuleLifecycle || bulkRequest.current || bulkSaving) return;
    const affected = rules.filter((rule) =>
      state === "activated" ? !isAct(rule) : isAct(rule)
    ).length;
    if (state === "not_activated" && affected > 0) {
      const scope = children
        ? "this asset and its included child assets"
        : "this asset only";
      if (!(await confirm(
        `Deactivate ${affected} active rule(s) on ${scope}? Active alerts for those rules will be resolved.`,
        {
          title: "Deactivate rules",
          confirmLabel: "Deactivate",
          destructive: true,
        }
      ))) {
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
    if (!canManageLogbook) return;
    if (!values.text?.trim()) {
      throw new Error("Enter a logbook entry.");
    }

    await api.post(`/assets/${assetId}/logbook`, {
      text: values.text.trim(),
    });

    setModal(null);
    loadLogs();
  };

  const deleteLogEntry = async (entry) => {
    if (
      !isAdministrator ||
      deletingLogId !== null ||
      bulkMaintenanceDeleteRequest.current
    ) {
      return;
    }
    if (
      !(await confirm(
        "Permanently delete this maintenance log entry? This cannot be undone.",
        {
          title: "Delete maintenance entry",
          confirmLabel: "Delete permanently",
          destructive: true,
        }
      ))
    ) {
      return;
    }

    setActionNotice("");
    setDeletingLogId(entry.id);
    setLoadError("");
    try {
      const result = await api.del(`/assets/${assetId}/logbook`, {
        ids: [entry.id],
      });
      setSelectedMaintenanceLogIds((current) =>
        current.filter((id) => id !== entry.id)
      );
      setActionNotice(
        result.deleted_count
          ? "Maintenance log entry was permanently deleted."
          : "Maintenance log entry was already deleted."
      );
      await loadLogs();
      try {
        await refreshStatus?.();
      } catch (error) {
        setLoadError(
          `The entry was deleted, but maintenance status could not be refreshed: ${error.message || "Unknown error"}`
        );
      }
    } catch (error) {
      setLoadError(error.message || "Could not permanently delete this maintenance entry.");
    } finally {
      setDeletingLogId(null);
    }
  };

  const deleteSelectedMaintenanceLogs = async () => {
    if (
      !isAdministrator ||
      bulkMaintenanceDeleteRequest.current ||
      deletingLogId !== null ||
      selectedMaintenanceLogIds.length === 0
    ) {
      return;
    }

    bulkMaintenanceDeleteRequest.current = true;
    const ids = [...new Set(selectedMaintenanceLogIds)];
    if (
      !(await confirm(
        `You are about to permanently delete ${ids.length} records. This action cannot be undone.`,
        {
          title: "Delete selected records permanently?",
          confirmLabel: "Delete Permanently",
          cancelLabel: "Cancel",
          destructive: true,
        }
      ))
    ) {
      bulkMaintenanceDeleteRequest.current = false;
      return;
    }

    setBulkDeletingMaintenanceLogs(true);
    setActionNotice("");
    setLoadError("");
    try {
      const result = await api.del(`/assets/${assetId}/logbook`, { ids });
      setSelectedMaintenanceLogIds([]);
      setActionNotice(
        `${result.deleted_count} maintenance logbook record(s) permanently deleted.`
      );
      await loadLogs();
      try {
        await refreshStatus?.();
      } catch (error) {
        setLoadError(
          `Records were deleted, but maintenance status could not be refreshed: ${error.message || "Unknown error"}`
        );
      }
    } catch (error) {
      setLoadError(error.message || "Could not delete the selected maintenance records.");
    } finally {
      bulkMaintenanceDeleteRequest.current = false;
      setBulkDeletingMaintenanceLogs(false);
    }
  };

  const deleteSelectedEvents = async () => {
    if (
      !isAdministrator ||
      bulkEventDeleteRequest.current ||
      deletingEventId !== null ||
      selectedEventIds.length === 0
    ) {
      return;
    }

    bulkEventDeleteRequest.current = true;
    const ids = [...new Set(selectedEventIds)];
    if (
      !(await confirm(
        `You are about to permanently delete ${ids.length} records. This action cannot be undone.`,
        {
          title: "Delete selected records permanently?",
          confirmLabel: "Delete Permanently",
          cancelLabel: "Cancel",
          destructive: true,
        }
      ))
    ) {
      bulkEventDeleteRequest.current = false;
      return;
    }

    setBulkDeletingEvents(true);
    setActionNotice("");
    setEventDeleteError("");
    try {
      const result = await api.del(`/assets/${assetId}/events`, { ids });
      setSelectedEventIds([]);
      await loadEvents();
      setActionNotice(
        `${result.deleted_count} event logbook record(s) permanently deleted.`
      );
    } catch (error) {
      setEventDeleteError(error.message || "Could not delete the selected events.");
    } finally {
      bulkEventDeleteRequest.current = false;
      setBulkDeletingEvents(false);
    }
  };

  const saveAsset = async (values) => {
    if (!isAdministrator) return;
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
    if (!isAdministrator) return;
    await api.post(`/assets/${assetId}/variables`, {
      name: values.name.trim(),
      key: values.key.trim(),
      data_type: values.data_type,
      signal_role:
        values.data_type === "boolean" && values.signal_role
          ? values.signal_role
          : null,
      unit: values.unit?.trim() || null,
      is_active: String(values.is_active) !== "false",
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
    if (!isAdministrator || !editingVariable) return;
    await api.patch(`/variables/${editingVariable.id}`, {
      name: values.name.trim(),
      key: values.key.trim(),
      data_type: values.data_type,
      signal_role:
        values.data_type === "boolean" && values.signal_role
          ? values.signal_role
          : null,
      unit: values.unit?.trim() || null,
      is_active: String(values.is_active) !== "false",
      opcua_node_id: values.opcua_node_id?.trim() || null,
    });

    setEditingVariable(null);
    setModal("variables");
    await loadVariables();
  };

  const deleteAsset = () => {
    if (!isAdministrator || deletingAsset) return;
    setShowDeleteAsset(true);
  };

  const setAssetActive = async (active) => {
    if (!isAdministrator || deletingAsset) return;
    if (!active) {
      const ok = await confirm(
        `Deactivate "${asset.name}"? Monitoring stops and no readings are accepted. All variables, rules, alerts, history and maintenance records are kept, and you can reactivate it at any time.`,
        { title: "Deactivate asset", confirmLabel: "Deactivate" }
      );
      if (!ok) return;
    }
    setLoadError("");
    try {
      await api.patch(`/assets/${assetId}`, { is_active: active });
      await reload();
      setActionNotice(active ? `Asset "${asset.name}" was reactivated.` : `Asset "${asset.name}" was deactivated. All records were kept.`);
    } catch (error) {
      setLoadError(error.message || "Could not change the asset status.");
    }
  };

  const toggleVariableActive = async (variable) => {
    if (!isAdministrator || togglingVariableId !== null) return;
    const next = !variable.is_active;
    if (!next) {
      const ok = await confirm(
        `Deactivate variable "${variable.name}"? It stops being polled and rules that use it show as not evaluated. Rule mappings, readings, alerts, counters and history are kept. On reactivation, monitoring resumes after a fresh valid reading.`,
        { title: "Deactivate variable", confirmLabel: "Deactivate" }
      );
      if (!ok) return;
    }
    setTogglingVariableId(variable.id);
    setVariableDeleteError("");
    try {
      await api.patch(`/variables/${variable.id}`, { is_active: next });
      await loadVariables();
    } catch (error) {
      setVariableDeleteError(error.message || "Could not change the variable status.");
    } finally {
      setTogglingVariableId(null);
    }
  };

  const deleteVariable = async (variable) => {
    if (!isAdministrator || deletingVariableId !== null) return;
    setVariableDeleteError("");
    let summary;
    try {
      summary = await api.get(`/variables/${variable.id}/deletion-summary`);
    } catch (error) {
      setVariableDeleteError(error.message || "Could not check what depends on this variable.");
      return;
    }
    const c = summary.counts;
    const used = [
      c.rules && `${c.rules} monitoring rule(s)`,
      c.rule_parameters && `${c.rule_parameters} rule parameter(s)`,
      c.maintenance_schedules && `${c.maintenance_schedules} maintenance schedule(s)`,
      c.alerts && `${c.alerts} alert(s)`,
      c.readings && `${c.readings} stored reading(s)`,
    ].filter(Boolean);
    if (!summary.can_delete) {
      setVariableDeleteError(
        `"${variable.name}" cannot be deleted. ${summary.blockers.join(" ")} ${summary.alternative}`
      );
      return;
    }
    const confirmed = await confirm(
      `Permanently delete variable "${variable.name}"? ` +
        (used.length ? `This permanently deletes ${used.join(", ")}. ` : "Nothing depends on it. ") +
        "Rules, alerts and maintenance configuration are never deleted with a variable. This cannot be undone.",
      {
        title: "Permanently delete variable",
        confirmLabel: "Delete permanently",
        destructive: true,
      }
    );
    if (!confirmed) return;

    setDeletingVariableId(variable.id);
    setVariableDeleteError("");
    try {
      await api.del(`/variables/${variable.id}${summary.requires_confirmation ? "?confirm=true" : ""}`);
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
      <LoadingIndicator className="loading" />
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
        <div
          className={`banner ${actionNotice.type}`}
          role={actionNotice.type === "error" ? "alert" : "status"}
        >
          <p>{actionNotice.text}</p>
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
          {/* Assignment is parent-only: only a top-level asset can be assigned; child assets inherit access from it. */}
          {isAdministrator && asset.parent_asset_id == null && (
            <AssetSupervisors assetId={asset.id} />
          )}
        </div>

        <div className="asset-links">
          <button
            className="link-btn"
            onClick={() => setModal("settings")}
            disabled={!isAdministrator}
            title={!isAdministrator ? "Administrator access required to manage assets." : undefined}
          >
            <GearIcon size={17} /> Asset settings
          </button>

          <button
            className="link-btn danger-link"
            onClick={deleteAsset}
            disabled={deletingAsset || !isAdministrator}
            title={!isAdministrator ? "Administrator access required to manage assets." : "Review dependencies and permanently delete this asset"}
          >
            {deletingAsset ? "Deleting asset…" : "Delete asset"}
          </button>
          <button
            className="link-btn"
            onClick={() => setAssetActive(!asset.is_active)}
            disabled={!isAdministrator}
            title={!isAdministrator ? "Administrator access required to manage assets." : asset.is_active ? "Stop monitoring and keep all records" : "Resume monitoring"}
          >
            {asset.is_active ? "Deactivate asset" : "Reactivate asset"}
          </button>
          <button
          type="button"
          className="link-btn"
          disabled={isSupervisor || isOperator}
          title={
            isSupervisor || isOperator
            ? "Supervisors and Operators cannot manage variables."
            : "View configured variables; only Administrators can change them."
          }
          onClick={() => {
            if (isSupervisor || isOperator) return;
            setModal("variables");
            }}
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

      {tab === "status" && detailRuleId !== null && (() => {
        const detailRule = rules.find((item) => item.id === detailRuleId);
        return (
          <section className="rule-detail-page" aria-label="Rule status details">
            <BackButton label="Current status" onClick={closeRuleStatusPage} />
            {!detailRule && !rulesLoaded && (
              <div className="rule-loading-spinner" role="status" aria-label="Loading rule">
                <span className="rule-loading-ring" aria-hidden="true" />
              </div>
            )}
            {!detailRule && rulesLoaded && !loadError && (
              <p className="muted">This rule was not found on this asset. It may have been deleted.</p>
            )}
            {detailRule && (
              <RuleStatusDetail
                key={detailRule.id}
                ruleId={detailRule.id}
                refreshToken={statusRefresh}
                onEditParameter={(parameter) => setParameterEdit({ ruleId: detailRule.id, parameterId: parameter.id })}
              />
            )}
          </section>
        );
      })()}

      {tab === "status" && detailRuleId === null && (
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
                onClick={() => selectRuleList("activated")}
              >
                Activated <span>({nAct})</span>
              </button>

              <button
                className={
                  list === "not_activated" ? "active" : ""
                }
                onClick={() => selectRuleList("not_activated")}
              >
                Not activated <span>({nNot})</span>
              </button>
            </div>

            <button
              className="icon-outline sm logbook-action-menu-trigger"
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

            <div className="dropdown" data-menu-open={sortMenu}>
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
                <FloatingMenu role="menu">
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
                </FloatingMenu>
              )}
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={!canManageRules}
              title={
                isSupervisor
                  ? "Supervisors can assign predefined monitoring rules only."
                  : !canManageRules
                    ? "You do not have permission to manage monitoring rules."
                    : "Add rule"
              }
              onClick={() => {
                if (!canManageRules) return;
                setModal("addRuleOptions");
              }}
            >
              <PlusCircle size={17} /> Add Rule
            </button>

            <div className="dropdown" data-menu-open={menu}>
              <button
                className="icon-outline sm logbook-action-menu-trigger"
                onClick={() => setMenu(!menu)}
                title="Rule actions"
                aria-label="Rule actions"
                aria-haspopup="menu"
                aria-expanded={menu}
              >
                <DotsIcon size={17} />
              </button>
                {menu && (
                  <FloatingMenu align="right" role="menu">
                      <button
                      type="button"
                      className="rule-bulk-menu-item"
                      disabled={bulkSaving || !canManageRules}
                      title={!canManageRules ? "Only Administrators and Supervisors can activate rules." : undefined}
                      role="menuitem"
                      onClick={activateAll}
                      >
                        <Power size={16} aria-hidden="true" />
                        <span>{bulkSaving ? "Updating rules…" : "Activate all rules"}</span>
                      </button>
                        <button
                        type="button"
                        className="rule-bulk-menu-item"
                        disabled={bulkSaving || !canChangeRuleLifecycle}
                        title={!canChangeRuleLifecycle ? "Only Administrators can change monitoring rule states." : undefined}
                      role="menuitem"
                        onClick={() => bulk("not_activated")}
                        >
                          <PowerOff size={16} aria-hidden="true" />
                          <span>Deactivate all rules</span>
                        </button>
                        </FloatingMenu>
                      )}
                    </div>
                    </div>

          {shown.length === 0 && list === "activated" ? (
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
                // Every rule, whatever its type or parameter count, is one compact parent card that opens its detail page.
                const open = () => openRuleStatusPage(rule.id);
                return (
                  <article
                    key={rule.id}
                    className={`rule-row rule-card rule-card-clickable ${rule.status || "unknown"}${ruleActionMenuId === rule.id ? " rule-card-menu-open" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open status details for ${rule.name}`}
                    onClick={(event) => {
                      // The action menu renders in a portal; its clicks still bubble here through React.
                      if (!event.currentTarget.contains(event.target)) return;
                      if (event.target.closest(".rule-card-actions")) return;
                      open();
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        open();
                      }
                    }}
                  >
                    <span className={"sev " + rule.status} />

                    <div className="rule-name rule-card-main">
                      <strong>{rule.name}</strong>
                      {rule.component_identifier && (
                        <span className="label-chip rule-component-chip" title="Component identifier">
                          {rule.component_identifier}
                        </span>
                      )}
                      {rule.labels?.length > 0 && (
                        <span className="labels-chips asset-rule-labels">
                          {rule.labels.map((label) => (
                            <span className="label-chip" key={label}>{label}</span>
                          ))}
                        </span>
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
                        <span>Parameters</span>
                        <b>{parameterSummary(rule)}</b>
                      </div>
                    </div>

                    <div className="rule-card-actions">
                      <div
                        className="dropdown rule-actions-menu"
                        data-menu-open={ruleActionMenuId === rule.id}
                      >
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
                        {ruleActionMenuId === rule.id && renderRuleMenu(rule)}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          <CurrentMaintenanceCards
            key={assetId}
            assetId={assetId}
            assetName={asset?.name}
            refreshKey={maintenanceRefreshKey}
            onChanged={refreshMaintenanceData}
            onActionNotification={notifyAction}
            onCompletedRecordsCount={setCompletedMaintenanceCount}
            showCompleted={list === "not_activated"}
            navigationState={assetNavigationState}
          />
        </>
      )}

{tab === "logbook" && (
  <>
    <MaintenancePanel
      key={assetId}
      assetId={assetId}
      assetName={asset?.name}
      scheduleId={scheduleId}
      progressRefreshKey={scheduleProgressKey}
      recordsRefreshKey={maintenanceRecordsKey}
      onChanged={refreshMaintenanceData}
      onActionNotification={notifyAction}
      navigationState={assetNavigationState}
    />

    {/* Keep the asset logbook below the panel, but leave the routed schedule detail page focused. */}
    {!scheduleId && (
<div className="panel maintenance-log-notes-panel">
  <div className="panel-head maintenance-log-notes-head">
    <div>
      <h2>Maintenance Logbook</h2>
      <span className="muted">
        {filteredLogs.length} maintenance entries
      </span>
    </div>
  {isAdministrator && selectedMaintenanceLogIds.length > 0 && (
    <div className="logbook-bulk-actions">
      <button
        type="button"
        className="btn-outline logbook-bulk-delete"
        onClick={deleteSelectedMaintenanceLogs}
        disabled={bulkDeletingMaintenanceLogs || deletingLogId !== null}
      >
        {bulkDeletingMaintenanceLogs
          ? "Deleting…"
          : `Delete Selected (${selectedMaintenanceLogIds.length})`}
      </button>
      <button
        type="button"
        className="btn-outline"
        onClick={() => setSelectedMaintenanceLogIds([])}
        disabled={bulkDeletingMaintenanceLogs}
      >
        Clear selection
      </button>
    </div>
  )}
  <button
    type="button"
    className="icon-outline sm export-icon"
      title={exporting ? "Preparing Excel export" : "Export filtered maintenance logbook entries to Excel"}
      aria-label="Export maintenance logbook entries to Excel"
      disabled={filteredLogs.length === 0 || exporting}
      onClick={() =>
        exportExcel({
          headers: ["Date and time", "Entry", "Entry type", "Technician", "Checklist", "Actual process values"],
          rows: filteredLogs.map((entry) => [
            entry.time || entry.created_at
              ? formatTime(entry.time || entry.created_at)
              : "",
            entry.text || entry.title || entry.summary || "",
            entry.maintenance_type || "Note",
            entry.assigned_technician || "",
            checklistText(entry.checklist),
            actualValuesText(entry.actual_values),
          ]),
          sheetName: "Maintenance logbook",
          fileName: `${assetFileName}-maintenance-logbook-${exportFileDate}.xlsx`,
          confirmMessage: `Download ${filteredLogs.length} filtered maintenance logbook entries as an Excel file?`,
        })
      }
    >
      <Download size={17} aria-hidden="true" />
    </button>
  </div>
  {exportError && <p className="notice error" role="alert">{exportError}</p>}

  <div className="maintenance-log-filters" aria-label="Filter maintenance logbook">
    <label>
      <span>Entry type</span>
      <select
        value={maintenanceTypeFilter}
        onChange={(event) => setMaintenanceTypeFilter(event.target.value)}
      >
        <option value="">All types</option>
        {maintenanceTypes.map((type) => (
          <option key={type} value={type}>
            {type.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </label>

    <label>
      <span>From</span>
      <input
        type="datetime-local"
        value={maintenanceStartDateTime}
        onChange={(event) => setMaintenanceStartDateTime(event.target.value)}
      />
    </label>

    <label>
      <span>To</span>
      <input
        type="datetime-local"
        value={maintenanceEndDateTime}
        onChange={(event) => setMaintenanceEndDateTime(event.target.value)}
      />
    </label>

    <button
      type="button"
      className="btn-outline"
      onClick={() => {
        setMaintenanceTypeFilter("");
        setMaintenanceStartDateTime("");
        setMaintenanceEndDateTime("");
      }}
      disabled={
        !maintenanceTypeFilter &&
        !maintenanceStartDateTime &&
        !maintenanceEndDateTime
      }
    >
      Clear filters
    </button>
    <span className="maintenance-log-filter-count">
      Showing {filteredLogs.length} of {logs.length} entries
    </span>
  </div>

  {filteredLogs.length === 0 ? (
    <EmptyState
      art={false}
      title={logs.length === 0 ? "No maintenance entries" : "No entries match these filters"}
      lines={logs.length === 0 ? ["Maintenance records and notes will appear here."] : []}
    />
  ) : (
    <div className="maintenance-table-wrap">
      <table className="table maintenance-notes-table">
        <thead>
          <tr>
            {isAdministrator && (
              <th className="logbook-select-col">
                <input
                  type="checkbox"
                  aria-label="Select all filtered maintenance logbook records"
                  checked={
                    filteredLogs.length > 0 &&
                    filteredLogs.every((entry) =>
                      selectedMaintenanceLogIds.includes(entry.id)
                    )
                  }
                  onChange={(event) =>
                    setSelectedMaintenanceLogIds(
                      event.target.checked
                        ? filteredLogs.map((entry) => entry.id)
                        : []
                    )
                  }
                  disabled={bulkDeletingMaintenanceLogs || deletingLogId !== null}
                />
              </th>
            )}
            <th className="col-time">Date and time</th>
            <th>Entry</th>
            <th>Entry type</th>
            <th>Technician</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody>
          {filteredLogs.map((entry) => {
            const timestamp = entry.time || entry.created_at;

            return (
              <tr key={entry.id}>
                {isAdministrator && (
                  <td className="logbook-select-col">
                    <input
                      type="checkbox"
                      aria-label={`Select maintenance logbook record ${entry.id}: ${entry.title || entry.summary || entry.id}`}
                      checked={selectedMaintenanceLogIds.includes(entry.id)}
                      onChange={(event) =>
                        setSelectedMaintenanceLogIds((current) =>
                          event.target.checked
                            ? [...new Set([...current, entry.id])]
                            : current.filter((id) => id !== entry.id)
                        )
                      }
                      disabled={bulkDeletingMaintenanceLogs || deletingLogId !== null}
                    />
                  </td>
                )}
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
                  {entry.assigned_technician || "—"}
                </td>

                <td>
                  <div className="maintenance-log-actions">
                    <button
                      type="button"
                      className="icon-outline sm"
                      aria-label={`Maintenance logbook actions for ${entry.title || entry.summary || entry.id}`}
                      aria-haspopup="menu"
                      aria-expanded={ruleActionMenuId === `maintenance-log-${entry.id}`}
                      onClick={() => {
                        const menuId = `maintenance-log-${entry.id}`;
                        setRuleActionMenuId((current) =>
                          current === menuId ? null : menuId
                        );
                      }}
                      disabled={
                        deletingLogId !== null || bulkDeletingMaintenanceLogs
                      }
                    >
                      <DotsIcon size={17} />
                    </button>
                    {ruleActionMenuId === `maintenance-log-${entry.id}` && (
                      <FloatingMenu role="menu">
                        <button
                          type="button"
                          className="rule-action-menu-item rule-action-menu-item--view"
                          role="menuitem"
                          onClick={() => {
                            setRuleActionMenuId(null);
                            setSelectedEntry(entry);
                            setModal("view");
                          }}
                        >
                          <Eye size={16} aria-hidden="true" />
                          <span>View</span>
                        </button>
                        {isAdministrator && (
                          <button
                            type="button"
                            className="rule-action-menu-item rule-action-menu-item--delete"
                            role="menuitem"
                            title="Permanently delete maintenance log entry"
                            onClick={() => {
                              setRuleActionMenuId(null);
                              deleteLogEntry(entry);
                            }}
                            disabled={
                              deletingLogId !== null ||
                              bulkDeletingMaintenanceLogs
                            }
                          >
                            <Trash2 size={16} aria-hidden="true" />
                            <span>Delete</span>
                          </button>
                        )}
                      </FloatingMenu>
                    )}
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
    )}
  </>
)}


      

{/* Event Log */}
{tab === "events" && (
  <div className="event-log-section">
    <div className="event-log-heading">
      <div>
        <h2>Event log</h2>
        <span className="muted">{filteredEvents.length} events</span>
      </div>
      {isAdministrator && selectedEventIds.length > 0 && (
        <div className="logbook-bulk-actions">
          <button
            type="button"
            className="btn-outline logbook-bulk-delete"
            onClick={deleteSelectedEvents}
            disabled={bulkDeletingEvents || deletingEventId !== null}
          >
            {bulkDeletingEvents
              ? "Deleting…"
              : `Delete Selected (${selectedEventIds.length})`}
          </button>
          <button
            type="button"
            className="btn-outline"
            onClick={() => setSelectedEventIds([])}
            disabled={bulkDeletingEvents}
          >
            Clear selection
          </button>
        </div>
      )}
      <button
        type="button"
        className="icon-outline sm export-icon"
        title={exporting ? "Preparing Excel export" : "Export filtered events to Excel"}
        aria-label="Export event log to Excel"
        disabled={filteredEvents.length === 0 || exporting}
        onClick={() =>
          exportExcel({
            headers: ["Date and time", "Event", "Details", "Asset", "Assigned rule", "Component"],
            rows: filteredEvents.map((event) => [
              event.time || event.occurred_at
                ? new Date(event.time || event.occurred_at).toLocaleString()
                : "",
              eventActionLabel(event.event_type),
              [event.text || event.message || "", eventAuditSummary(event)]
                .filter(Boolean)
                .join(" · "),
              event.asset_name ||
                (event.asset_id != null ? `Asset ${event.asset_id}` : "System"),
              event.rule_name ||
                event.assigned_rule ||
                event.rule?.name ||
                (event.event_type === "maintenance_completed"
                  ? "Maintenance"
                  : event.rule_id != null
                    ? `Rule #${event.rule_id}`
                    : "Not assigned"),
              event.component_identifier || "",
            ]),
            sheetName: "Event log",
            fileName: `${assetFileName}-event-log-${exportFileDate}.xlsx`,
            confirmMessage: `Download ${filteredEvents.length} filtered events as an Excel file?`,
          })
        }
      >
        <Download size={17} aria-hidden="true" />
      </button>
      {["csv", "json"].map((format) => (
        <button
          key={format}
          type="button"
          className="icon-outline sm export-icon export-format"
          title={`Export filtered events as ${format.toUpperCase()}`}
          aria-label={`Export event log as ${format.toUpperCase()}`}
          disabled={exporting}
          onClick={() => exportEventsFile(format)}
        >
          {format.toUpperCase()}
        </button>
      ))}
    </div>
    {exportError && <p className="notice error" role="alert">{exportError}</p>}
    {eventDeleteError && (
      <div className="event-log-error" role="alert">
        {eventDeleteError}
      </div>
    )}
    <div className="event-log-filters" aria-label="Filter event log">
      <label>
        <span>Event</span>
        <select
          value={eventTypeFilter}
          onChange={(event) => setEventTypeFilter(event.target.value)}
        >
          <option value="">All events</option>
          {eventTypes.map((eventType) => (
            <option key={eventType} value={eventType}>
              {eventActionLabel(eventType)}
            </option>
          ))}
        </select>
      </label>

      {eventComponents.length > 0 && (
        <label>
          <span>Component</span>
          <select
            value={eventComponentFilter}
            onChange={(event) => setEventComponentFilter(event.target.value)}
          >
            <option value="">All components</option>
            {eventComponents.map((component) => (
              <option key={component} value={component}>{component}</option>
            ))}
          </select>
        </label>
      )}

      <label>
        <span>From</span>
        <input
          type="datetime-local"
          value={eventStartDateTime}
          onChange={(event) => setEventStartDateTime(event.target.value)}
        />
      </label>

      <label>
        <span>To</span>
        <input
          type="datetime-local"
          value={eventEndDateTime}
          onChange={(event) => setEventEndDateTime(event.target.value)}
        />
      </label>

      <button
        type="button"
        className="btn-outline"
        onClick={() => {
          setEventTypeFilter("");
          setEventComponentFilter("");
          setEventStartDateTime("");
          setEventEndDateTime("");
        }}
        disabled={
          !eventTypeFilter &&
          !eventComponentFilter &&
          !eventStartDateTime &&
          !eventEndDateTime
        }
      >
        Clear filters
      </button>
      <span className="event-filter-count">
        Showing {filteredEvents.length} of {events.length} events
      </span>
    </div>

    <div className="table-responsive">
      <table
        className={`data-table event-log-table${isAdministrator ? " event-log-table--selectable" : ""}`}
      >
        <thead>
          <tr>
            {isAdministrator && (
              <th className="logbook-select-col">
                <input
                  type="checkbox"
                  aria-label="Select all filtered event log records"
                  checked={
                    filteredEvents.length > 0 &&
                    filteredEvents.every((event) =>
                      selectedEventIds.includes(event.id)
                    )
                  }
                  onChange={(event) =>
                    setSelectedEventIds(
                      event.target.checked
                        ? filteredEvents.map((item) => item.id)
                        : []
                    )
                  }
                  disabled={bulkDeletingEvents || deletingEventId !== null}
                />
              </th>
            )}
            <th className="event-col-time">Date &amp; Time</th>
            <th className="event-col-event">Event</th>
            <th className="event-col-asset">Asset</th>
            <th className="event-col-rule">Assigned Rule</th>
            <th className="event-col-actions">Actions</th>
          </tr>
        </thead>

        <tbody>
          {filteredEvents.length === 0 ? (
            <tr>
              <td colSpan={isAdministrator ? 6 : 5} className="empty-state">
                {events.length === 0
                  ? "No events found."
                  : "No events match these filters."}
              </td>
            </tr>
          ) : (
            filteredEvents.map((event) => {
              const assignedRule =
                event.rule_name ||
                event.assigned_rule ||
                event.rule?.name ||
                (event.event_type === "maintenance_completed"
                  ? "Maintenance"
                  : null) ||
                (event.rule_id != null
                  ? `Rule #${event.rule_id}`
                  : "Not assigned");

              const eventTime = (event.time || event.occurred_at)
                ? new Date(event.time || event.occurred_at).toLocaleString()
                : "—";

              return (
                <tr key={event.id} className={`event-tone-${eventTone(event.event_type)}`}>
                  {isAdministrator && (
                    <td className="logbook-select-col">
                      <input
                        type="checkbox"
                        aria-label={`Select event ${event.id}: ${eventActionLabel(event.event_type)}`}
                        checked={selectedEventIds.includes(event.id)}
                        onChange={(inputEvent) =>
                          setSelectedEventIds((current) =>
                            inputEvent.target.checked
                              ? [...new Set([...current, event.id])]
                              : current.filter((id) => id !== event.id)
                          )
                        }
                        disabled={bulkDeletingEvents || deletingEventId !== null}
                      />
                    </td>
                  )}
                  <td className="event-col-time">{eventTime}</td>

                  <td className="event-col-event">
                    <strong>{eventActionLabel(event.event_type)}</strong>
                    <div>{event.text || event.message || "—"}</div>
                    {eventAuditSummary(event) && (
                      <small className="muted">{eventAuditSummary(event)}</small>
                    )}
                  </td>

                  <td className="event-col-asset">
                    {event.asset_name ||
                      (event.asset_id != null ? `Asset ${event.asset_id}` : "System")}
                  </td>

                  <td className="event-col-rule">
                    {assignedRule}
                    {event.component_identifier && (
                      <span className="event-component" title="Component identifier">{event.component_identifier}</span>
                    )}
                  </td>

                  <td className="event-col-actions">
                    <div className="event-row-actions">
                      <button
                        type="button"
                        className="icon-outline sm"
                        aria-label={`Event log actions for ${eventActionLabel(event.event_type)}`}
                        aria-haspopup="menu"
                        aria-expanded={ruleActionMenuId === `event-log-${event.id}`}
                        onClick={() => {
                          const menuId = `event-log-${event.id}`;
                          setRuleActionMenuId((current) =>
                            current === menuId ? null : menuId
                          );
                        }}
                      >
                        <DotsIcon size={17} />
                      </button>
                      {ruleActionMenuId === `event-log-${event.id}` && (
                        <FloatingMenu align="right" role="menu">
                          <button
                            type="button"
                            className="rule-action-menu-item rule-action-menu-item--view"
                            role="menuitem"
                            onClick={() => {
                              setRuleActionMenuId(null);
                              setSelectedEvent(event);
                              setShowEventDetails(true);
                            }}
                          >
                            <Eye size={16} aria-hidden="true" />
                            <span>View</span>
                          </button>
                          {isAdministrator && (
                            <button
                              type="button"
                              className="rule-action-menu-item rule-action-menu-item--delete"
                              role="menuitem"
                              title="Permanently delete event"
                              aria-label={`Permanently delete ${eventActionLabel(event.event_type)} event`}
                              disabled={
                                deletingEventId !== null || bulkDeletingEvents
                              }
                              onClick={() => {
                                setRuleActionMenuId(null);
                                deleteEvent(event);
                              }}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                              <span>Delete</span>
                            </button>
                          )}
                        </FloatingMenu>
                      )}
                    </div>
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
  <Modal
    title={maintenanceEventRecordId > 0 ? "Maintenance details" : "Event Details"}
    onClose={() => {
      setShowEventDetails(false);
      setSelectedEvent(null);
    }}
    >
        <div className="event-details-content">
          {maintenanceEventError && (
            <p className="event-log-error" role="alert">{maintenanceEventError}</p>
          )}
        {maintenanceEventLoading ? (
          <LoadingIndicator compact message="Loading maintenance details" />
        ) : maintenanceEventRecord ? (
          <MaintenanceDetails record={maintenanceEventRecord} />
        ) : (
          <>
        <p>
          <strong>Date &amp; Time:</strong>{" "}
          {(selectedEvent.time || selectedEvent.occurred_at)
            ? new Date(selectedEvent.time || selectedEvent.occurred_at).toLocaleString()
            : "—"}
        </p>

        <p>
          <strong>Action:</strong>{" "}
          {eventActionLabel(selectedEvent.event_type)}
        </p>

        <p>
          <strong>Event details:</strong>{" "}
          {selectedEvent.text || selectedEvent.message || "—"}
        </p>
        {selectedEvent.metadata?.acknowledged_by && (
          <>
            <p>
              <strong>Acknowledged by:</strong>{" "}
              {selectedEvent.metadata.acknowledged_by}
            </p>
            <p>
              <strong>Acknowledged at:</strong>{" "}
              {selectedEvent.metadata.acknowledged_at
                ? formatTime(selectedEvent.metadata.acknowledged_at)
                : (selectedEvent.time || selectedEvent.occurred_at)
                  ? formatTime(selectedEvent.time || selectedEvent.occurred_at)
                  : "—"}
            </p>
          </>
        )}
        {selectedEvent.metadata?.completed_by && (
          <>
            <p>
              <strong>Completed by:</strong>{" "}
              {selectedEvent.metadata.completed_by}
            </p>
            <p>
              <strong>Completed at:</strong>{" "}
              {selectedEvent.metadata.completed_at
                ? formatTime(selectedEvent.metadata.completed_at)
                : (selectedEvent.time || selectedEvent.occurred_at)
                  ? formatTime(selectedEvent.time || selectedEvent.occurred_at)
                  : "—"}
            </p>
            <p><strong>Result:</strong> Rule successfully completed.</p>
          </>
        )}

        <p>
          <strong>Asset:</strong>{" "}
          {selectedEvent.asset_name ||
            (selectedEvent.asset_id != null
              ? `Asset ${selectedEvent.asset_id}`
              : "System")}
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
          </>
        )}
        <div className="event-details-actions">
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              setShowEventDetails(false);
              setSelectedEvent(null);
            }}
          >
            Close
          </button>
        </div>
      </div>
  </Modal>
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
        disabled={isSupervisor}
        title={isSupervisor ? "Only Administrators can create monitoring rules." : undefined}
        onClick={() => setModal("ruleTypeOptions")}
      >
        <strong>Create A Rule</strong>
        <small>Create an Interval Based or Parameter Threshold rule.</small>
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

      {/* Keep collection assignment alongside the existing asset-targeted rule assignment workflow. */}
      <button
        type="button"
        className="rule-type-option"
        onClick={() => {
          setModal(null);
          setShowRuleCollections(true);
        }}
      >
        <strong>Assign Rule Collections</strong>
        <small>Assign the reusable rules in one or more collections to this asset.</small>
      </button>

      <button
        type="button"
        className="rule-type-option"
        disabled={isSupervisor}
        title={isSupervisor ? "Only Administrators can copy monitoring rules." : undefined}
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
    title="Create A Rule"
    onClose={() => setModal(null)}
  >
    <RuleCategoryOptions
      onSelect={(category) => {
        setModal(null);
        const state = {
          from: captureNavigationOrigin(location, assetNavigationState),
        };
        navigate(
          category === "interval"
            ? legacyRulePath(assetId, "interval")
            : `/assets/${assetId}/monitoring-rules/new/parameter_threshold`,
          { state }
        );
      }}
    />
  </Modal>
)}

{parameterEdit !== null && (
  <ParameterEditDialog
    ruleId={parameterEdit.ruleId}
    parameterId={parameterEdit.parameterId}
    alwaysSelect={Boolean(parameterEdit.alwaysSelect)}
    assetId={assetId}
    assetName={asset?.name}
    ruleName={rules.find((item) => item.id === parameterEdit.ruleId)?.name}
    ruleInfo={rules.find((item) => item.id === parameterEdit.ruleId)?.parameters}
    onClose={() => setParameterEdit(null)}
    onSaved={() => {
      setParameterEdit(null);
      setStatusRefresh((value) => value + 1);
      refreshAll();
      setActionNotice("Parameter saved.");
    }}
  />
)}

{notificationRuleId !== null && rules.some((item) => item.id === notificationRuleId) && (
  <NotificationSettingsDialog
    rule={rules.find((item) => item.id === notificationRuleId)}
    onClose={() => setNotificationRuleId(null)}
    onSaved={() => {
      setNotificationRuleId(null);
      refreshAll();
      setActionNotice("Notification settings saved.");
    }}
  />
)}

{componentRuleId !== null && rules.some((item) => item.id === componentRuleId) && (
  <ComponentIdentifierDialog
    rule={rules.find((item) => item.id === componentRuleId)}
    onClose={() => setComponentRuleId(null)}
    onSaved={() => {
      setComponentRuleId(null);
      setStatusRefresh((value) => value + 1);
      refreshAll();
      setActionNotice("Component identifier saved.");
    }}
  />
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
    title="Maintenance details"
    onClose={() => {
      setModal(null);
      setSelectedEntry(null);
    }}
    wide
  >
    <MaintenanceDetails record={selectedEntry} />

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
    runtimeVariableIds={runtimeVariableIds}
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


      {modal === "log" && (
        <CreateModal
          title="New logbook entry"
          submitLabel="Add entry"
          fields={LOG_FIELDS}
          onSubmit={addLog}
          disabled={!canManageLogbook}
          intro={!canManageLogbook ? "You do not have permission to add logbook entries." : undefined}
          onClose={() => setModal(null)}
        />
      )}

      {modal === "settings" && (
        <CreateModal
          title="Asset settings"
          submitLabel="Save changes"
          onSubmit={saveAsset}
          disabled={!isAdministrator}
          intro={!isAdministrator ? "Administrator access required to change asset settings." : undefined}
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
              label: "Status",
              type: "select",
              default: String(asset.is_active),
              options: [
                ["true", "Active"],
                ["false", "Inactive"],
              ],
              hint:
                "Inactive assets stop monitoring but keep all variables, rules, alerts and history.",
            },
          ]}
        />
      )}

      {(modal === "addVariable" || modal === "editVariable") && (
        <CreateModal
          title={editingVariable ? "Edit variable" : "Add variable"}
          submitLabel={editingVariable ? "Save variable" : "Add variable"}
          fields={VARIABLE_FIELDS}
          initialValues={editingVariable ? { ...editingVariable, is_active: String(editingVariable.is_active) } : {}}
          onSubmit={editingVariable ? updateVariable : addVariable}
          disabled={!isAdministrator}
          intro={!isAdministrator ? "Administrator access required to manage variables and OPC UA mappings." : undefined}
          onClose={() => {
            setEditingVariable(null);
            setModal("variables");
          }}
        />
      )}

      {showDeleteAsset && (
        <AssetDeletionDialog
          asset={asset}
          onClose={() => setShowDeleteAsset(false)}
          onDeactivate={async () => {
            setShowDeleteAsset(false);
            await setAssetActive(false);
          }}
          onDeleted={async () => {
            setShowDeleteAsset(false);
            await reload();
            navigate("/assets", { replace: true });
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
            <table className="table variables-table">
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
                    <td><span className={"badge " + (variable.is_active ? "ok" : "unknown")}>{variable.is_active ? "Active" : "Inactive"}</span></td>
                    <td className="variable-actions-cell">
                      <div className="variable-row-actions">
                        <button
                          type="button"
                          className="icon-outline variable-action-icon"
                          onClick={() => {
                            setEditingVariable(variable);
                            setModal("editVariable");
                          }}
                          disabled={deletingVariableId !== null || !isAdministrator}
                          title="Edit variable"
                          aria-label="Edit variable"
                        >
                          <Pencil size={16} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="btn-outline"
                          onClick={() => toggleVariableActive(variable)}
                          disabled={!isAdministrator || togglingVariableId !== null || deletingVariableId !== null}
                          title={variable.is_active ? "Deactivate: stop monitoring, keep all data" : "Reactivate: resume after a fresh reading"}
                        >
                          {variable.is_active ? "Deactivate" : "Reactivate"}
                        </button>
                        <button
                          type="button"
                          className="icon-outline variable-action-icon variable-action-delete"
                          onClick={() => deleteVariable(variable)}
                          disabled={!isAdministrator || deletingVariableId !== null}
                          title="Delete variable"
                          aria-label="Delete variable"
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
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
              disabled={deletingVariableId !== null || !isAdministrator}
              title={!isAdministrator ? "Administrator access required to manage variables." : undefined}
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
          navigationState={assetNavigationState}
          onClose={() => setShowPredefinedRules(false)}
          onAssigned={async (result) => {
            setShowPredefinedRules(false);
            // A Supervisor's assignment starts Not Activated: show it there for review.
            setList(isSupervisor ? "not_activated" : "activated");
            await refreshAll();
            const assigned = result.created?.length || 0;
            const existing = result.already_assigned?.length || 0;
            setActionNotice(
              `${assigned} predefined rule(s) assigned` +
                (isSupervisor
                  ? ". They are Not Activated: review the thresholds, then activate them."
                  : " and activated.") +
                (existing ? ` ${existing} rule(s) were already assigned.` : "")
            );
          }}
        />
      )}

      {/* Collection assignment reuses the same asset target, template mapping, and role workflow. */}
      {showRuleCollections && (
        <RuleCollectionAssignmentModal
          assetId={assetId}
          onClose={() => setShowRuleCollections(false)}
          onAssigned={async (result) => {
            setShowRuleCollections(false);
            setList(isSupervisor ? "not_activated" : "activated");
            await refreshAll();
            const created = result.created?.length || 0;
            const existing = result.already_assigned?.length || 0;
            setActionNotice(
              `${created} rule(s) assigned from ${result.collectionCount} collection(s)` +
                (isSupervisor
                  ? ". They are Not Activated: review the thresholds, then activate them."
                  : ".") +
                (existing ? ` ${existing} rule(s) were already assigned.` : "")
            );
          }}
          onUnassigned={async (collection, result) => {
            await refreshAll();
            setActionNotice(
              `${result.removed} rule(s) from "${collection.name}" were unassigned.`
            );
          }}
        />
      )}
    </div>
  );
}