
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import CopyRulesModal from "../components/CopyRulesModal.jsx";
import PredefinedRulesModal from "../../rules/components/PredefinedRulesModal.jsx";
import { api } from "../../../services/api.js";
import MaintenancePanel from "../components/MaintenancePanel.jsx";
import "./AssetDetail.css";
import {
  formatDuration,
  formatTime,
  formatValue,
} from "../../../utils/format.js";
import {
  MONITORING_RULE_CHOICES,
  buildAssetMonitoringRule,
  monitoringRuleFormSelection,
} from "../rules/monitoringRuleFlow.js";
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
      ? "Select a declared Boolean variable owned by this asset."
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
        ? "Only declared Boolean variables on this asset are available."
        : "Only Boolean variables configured as this asset's OPC UA cycle signal are available."
      : mappingBypassEnabled
        ? "No declared Boolean OPC UA variables are available for this asset."
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
      ? "Select a declared Boolean variable owned by this asset that is true while the machine runs."
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
];

export default function AssetDetail() {
  const { id } = useParams();
  const { assets, assetsLoaded, reload, refreshStatus } =
    useOutletContext();

  const assetId = Number(id);
  const asset = assets.find((a) => a.id === assetId);

  const [tab, setTab] = useState("status");
  const [list, setList] = useState("activated");
  const [rules, setRules] = useState([]);
  const [variables, setVariables] = useState([]);
  const [allVariables, setAllVariables] = useState([]);
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
  const navigate = useNavigate();
  const location = useLocation();

  
  const seq = useRef(0);
  const bulkRequest = useRef(false);
  const permanentDeleteRequest = useRef(false);

  
  const loadLive = useCallback(async () => {
    const mine = ++seq.current;

    try {
      const [r, st, plc] = await Promise.allSettled([
        api.get(
          `/assets/${assetId}/rules?include_children=${children}`
        ),
        api.getAll("/monitoring/status", 500),
        api.get("/plc/status"),
      ]);

      if (mine !== seq.current) return;

      if (r.status === "fulfilled") {
        setRules(Array.isArray(r.value) ? r.value : []);
        setLoadError("");
      } else {
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

      if (plc.status === "fulfilled") {
        const mappings = Array.isArray(plc.value?.mappings)
          ? plc.value.mappings
          : [];
        const bypassEnabled = plc.value?.mapping_bypass_enabled === true;
        setMappingBypassEnabled(bypassEnabled);
        const activeCycleMapping = mappings.find(
          (mapping) =>
            mapping.asset_id === assetId &&
            mapping.role === "cycle_signal" &&
            mapping.mapping_valid
        );
        setCycleVariableIds(
          [
            ...(activeCycleMapping ? [activeCycleMapping.variable_id] : []),
            ...(bypassEnabled
              ? mappings
                  .filter(
                    (mapping) =>
                      mapping.asset_id === assetId &&
                      mapping.mapping_valid &&
                      mapping.role === "declared_variable" &&
                      mapping.data_type === "boolean"
                  )
                  .map((mapping) => mapping.variable_id)
              : []),
          ]
        );
        setRuntimeVariableIds(
          mappings
            .filter(
              (mapping) =>
                mapping.asset_id === assetId &&
                mapping.mapping_valid &&
                mapping.data_type === "boolean" &&
                (mapping.role === "running_signal" ||
                  (bypassEnabled && mapping.role === "declared_variable"))
            )
            .map((mapping) => mapping.variable_id)
        );
      }
    } catch (error) {
      setLoadError(error.message || "Unable to refresh asset monitoring.");
    }
  }, [assetId, children]);

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

  const refreshMaintenanceData = useCallback(async () => {
    await Promise.all([refreshStatus?.(), loadLogs()]);
  }, [loadLogs, refreshStatus]);

  
  useEffect(() => {
    setTab("status");
    setList("activated");
    setFilter("");
    setRules([]);
    setAllVariables([]);
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

  useEffect(() => {
    const notice = location.state?.createdNotice;
    if (!notice) return;
    setActionNotice(notice);
    setTab("logbook");
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);


  useEffect(() => {
    let active = true;
    let timeoutId;

    const poll = async () => {
      await loadLive();
      if (active) {
        timeoutId = window.setTimeout(poll, 1500);
      }
    };

    timeoutId = window.setTimeout(poll, 1500);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [loadLive]);

 
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

  
const filteredLogs = [...logs]
  .filter((entry) => {
    const search = logSearch.trim().toLowerCase();

    const matchesSearch =
      !search ||
      String(entry.text || "").toLowerCase().includes(search) ||
      String(entry.maintenance_type || "unknown")
        .toLowerCase()
        .includes(search);

    const matchesType =
      logTypeFilter === "all" ||
      (entry.maintenance_type || "unknown") === logTypeFilter;

    const rawDate = entry.time || entry.created_at;
    const date = new Date(rawDate);

    const matchesStart =
      !logStartDate ||
      (Number.isFinite(date.getTime()) &&
        date >= new Date(`${logStartDate}T00:00:00`));

    const matchesEnd =
      !logEndDate ||
      (Number.isFinite(date.getTime()) &&
        date <= new Date(`${logEndDate}T23:59:59.999`));

    return (
      matchesSearch &&
      matchesType &&
      matchesStart &&
      matchesEnd
    );
  })
  .sort((a, b) => {
    const dateA =
      new Date(a.time || a.created_at).getTime() || 0;
    const dateB =
      new Date(b.time || b.created_at).getTime() || 0;

    return logSort === "newest"
      ? dateB - dateA
      : dateA - dateB;
  });

 
  const refreshAll = async () => {
    await Promise.all([
      loadLive(),
      refreshStatus?.(),
    ]);
  };

  const setState = async (rule, state) => {
    try {
      await api.patch(`/rules/${rule.id}`, {
        is_enabled: state === "activated",
      });

      await refreshAll();
    } catch (error) {
      setLoadError(error.message);
    }
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
    setMonitoringRuleSelection(monitoringRuleFormSelection(choiceId));
    setModal("add");
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
      unit: values.unit?.trim() || null,
      opcua_node_id: values.opcua_node_id?.trim() || null,
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
              onClick={() => setModal("ruleTypeOptions")}
            >
              <PlusCircle size={17} /> Add rule
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
                        <button
                        type="button"
                        disabled={bulkSaving}
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                          setShowPredefinedRules(true);
                        }}>Assign predefined monitoring rules</button>
                        <button
                        type="button"
                        disabled={bulkSaving}
                        role="menuitem"
                        onClick={() => {
                          setMenu(false);
                          setModal("copyRules");
                        }}
                        >Copy from another asset</button>
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

                const limits = thresholdMetrics(rule);
                const currentValue =
                  state?.latest_value ?? rule.latest_value;
                const formattedCurrentValue =
                  rule.rule_type === "runtime_duration"
                    ? formatDuration(currentValue)
                    : formatValue(currentValue);

                return (
                  <article
                    key={rule.id}
                    className={`rule-row rule-card ${rule.status || "unknown"}`}
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
                    </div>

                    <div className="rule-card-metrics">
                      {currentValue !== null && currentValue !== undefined && (
                        <div className="rule-current-value">
                          <span>{rule.rule_type === "runtime_duration" ? "Running time" : "Now"}</span>
                          <b>{formattedCurrentValue}</b>
                        </div>
                      )}
                      {limits.length > 0 && (
                        <div className="rule-limits">
                          {limits.map((limit) => (
                            <span key={limit.label}>
                              <small>{limit.label}</small>
                              <b>{limit.value}</b>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="rule-card-actions">
                      {isAct(rule) ? (
                        <button
                          className="btn-outline"
                          onClick={() => setState(rule, "not_activated")}
                          disabled={deletingRuleId !== null}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <>
                          <button
                            className="btn-outline"
                            onClick={() => setState(rule, "activated")}
                            disabled={deletingRuleId !== null}
                          >
                            Activate
                          </button>
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
                              </div>
                            )}
                          </div>
                        </>
                      )}
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
          <MaintenancePanel assetId={assetId} onChanged={refreshMaintenanceData} />
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Maintenance log notes</h2>
                <span className="muted">
                  {logs.length} {logs.length === 1 ? "entry" : "entries"}
                </span>
              </div>
              <button
                className="btn-primary"
                onClick={() => setModal("log")}
              >
                <PlusCircle size={17} /> Add note
              </button>
            </div>

            {logs.length === 0 ? (
              <EmptyState
                art={false}
                title="No logbook notes"
                lines={[
                  "Record brief observations separately from maintenance jobs.",
                ]}
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th className="col-time">Time</th>
                    <th>Entry</th>
                  </tr>
                </thead>

                <tbody>
                  {logs.map((entry) => (
                    <tr key={entry.id}>
                      <td className="col-time">
                        {formatTime(entry.time)}
                      </td>
                      <td>{entry.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === "events" && (
        <div className="panel">
          {events.length === 0 ? (
            <EmptyState
              art={false}
              title="No events yet"
              lines={[
                "Alerts, acknowledgements and rule changes for this asset are recorded here.",
              ]}
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th className="col-time">Time</th>
                  <th>Event</th>
                </tr>
              </thead>

              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="col-time">
                      {formatTime(event.time)}
                    </td>
                    <td>{event.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      




{modal === "ruleTypeOptions" && (
  <Modal
    title="Create monitoring rule"
    onClose={() => setModal(null)}
  >
    <div className="rule-type-options">
      {MONITORING_RULE_CHOICES.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="rule-type-option"
          onClick={() => openMonitoringRuleForm(choice.id)}
        >
          <strong>{choice.label}</strong>
          <small>{choice.description}</small>
        </button>
      ))}
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