import { useRef, useState } from "react";

// All React state and refs used by the asset detail page.
export default function useAssetState(ctx) {
  const { location } = ctx;

  const [tab, setTab] = useState(
    location.state?.activeTab === "logbook" ? "logbook" : "status",
  );

  const [list, setList] = useState("activated");

  const [rules, setRules] = useState([]);

  const [completedMaintenanceCount, setCompletedMaintenanceCount] = useState(0);

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

  const [completionDetails, setCompletionDetails] = useState(null);

  const [completionDetailsError, setCompletionDetailsError] = useState("");

  const [actionNotice, setActionNotice] = useState("");

  const [sortMenu, setSortMenu] = useState(false);

  const [modal, setModal] = useState(null);

  const [monitoringRuleSelection, setMonitoringRuleSelection] = useState(null);

  const [showPredefinedRules, setShowPredefinedRules] = useState(false);

  const [addRuleMenu, setAddRuleMenu] = useState(false);

  const [logs, setLogs] = useState([]);

  const [maintenanceTypeFilter, setMaintenanceTypeFilter] = useState("");

  const [maintenanceStartDateTime, setMaintenanceStartDateTime] = useState("");

  const [maintenanceEndDateTime, setMaintenanceEndDateTime] = useState("");

  const [events, setEvents] = useState([]);

  const [eventTypeFilter, setEventTypeFilter] = useState("");

  const [eventStartDateTime, setEventStartDateTime] = useState("");

  const [eventEndDateTime, setEventEndDateTime] = useState("");

  const [loadError, setLoadError] = useState("");

  const [deletingAsset, setDeletingAsset] = useState(false);

  const [deletingVariableId, setDeletingVariableId] = useState(null);

  const [variableDeleteError, setVariableDeleteError] = useState("");

  const [variableDataSource, setVariableDataSource] = useState("none");

  const [variableConnector, setVariableConnector] = useState("");

  const [selectedEntry, setSelectedEntry] = useState(null);

  const [selectedEvent, setSelectedEvent] = useState(null);

  const [showEventDetails, setShowEventDetails] = useState(false);

  const [deletingEventId, setDeletingEventId] = useState(null);

  const [eventDeleteError, setEventDeleteError] = useState("");

  const [deletingLogId, setDeletingLogId] = useState(null);

  const [exportError, setExportError] = useState("");

  const [exporting, setExporting] = useState(false);

  const seq = useRef(0);

  const ruleListSeq = useRef(0);

  const ruleStatusSeq = useRef(0);

  const plcStatusSeq = useRef(0);

  const bulkRequest = useRef(false);

  const permanentDeleteRequest = useRef(false);

  return {
    tab,
    setTab,
    list,
    setList,
    rules,
    setRules,
    completedMaintenanceCount,
    setCompletedMaintenanceCount,
    variables,
    setVariables,
    allVariables,
    setAllVariables,
    runtimeReadings,
    setRuntimeReadings,
    clockNow,
    setClockNow,
    cycleVariableIds,
    setCycleVariableIds,
    runtimeVariableIds,
    setRuntimeVariableIds,
    mappingBypassEnabled,
    setMappingBypassEnabled,
    editingVariable,
    setEditingVariable,
    ruleStates,
    setRuleStates,
    children,
    setChildren,
    sort,
    setSort,
    filter,
    setFilter,
    showFilter,
    setShowFilter,
    menu,
    setMenu,
    bulkSaving,
    setBulkSaving,
    deletingRuleId,
    setDeletingRuleId,
    ruleActionMenuId,
    setRuleActionMenuId,
    lifecycleAction,
    setLifecycleAction,
    viewRule,
    setViewRule,
    completionDetails,
    setCompletionDetails,
    completionDetailsError,
    setCompletionDetailsError,
    actionNotice,
    setActionNotice,
    sortMenu,
    setSortMenu,
    modal,
    setModal,
    monitoringRuleSelection,
    setMonitoringRuleSelection,
    showPredefinedRules,
    setShowPredefinedRules,
    logs,
    setLogs,
    maintenanceTypeFilter,
    setMaintenanceTypeFilter,
    maintenanceStartDateTime,
    setMaintenanceStartDateTime,
    maintenanceEndDateTime,
    setMaintenanceEndDateTime,
    events,
    setEvents,
    eventTypeFilter,
    setEventTypeFilter,
    eventStartDateTime,
    setEventStartDateTime,
    eventEndDateTime,
    setEventEndDateTime,
    loadError,
    setLoadError,
    deletingAsset,
    setDeletingAsset,
    deletingVariableId,
    setDeletingVariableId,
    variableDeleteError,
    setVariableDeleteError,
    selectedEntry,
    setSelectedEntry,
    selectedEvent,
    setSelectedEvent,
    showEventDetails,
    setShowEventDetails,
    deletingEventId,
    setDeletingEventId,
    eventDeleteError,
    setEventDeleteError,
    deletingLogId,
    setDeletingLogId,
    exportError,
    setExportError,
    exporting,
    setExporting,
    seq,
    ruleListSeq,
    ruleStatusSeq,
    plcStatusSeq,
    bulkRequest,
    permanentDeleteRequest,
  };
}
