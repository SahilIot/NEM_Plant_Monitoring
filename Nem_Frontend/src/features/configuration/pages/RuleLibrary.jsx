import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  Copy,
  Eye,
  Layers,
  Pencil,
  Plus,
  Search,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../../../services/api.js";
import { auditUser, formatAuditDate, formatAuditTime } from "../../../utils/format.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import {
  captureNavigationOrigin,
  consumeNavigationFlash,
  returnToNavigationOrigin,
} from "../../../utils/navigation.js";
import {
  EmptyState,
  LoadingIndicator,
  Modal,
  useConfirmation,
} from "../../../components/common/UI.jsx";
import LabelsField from "../../../components/common/LabelsField.jsx";
import {
  VISIBILITY_LABELS,
  VisibilityBadge,
  VisibilityModal,
} from "./RuleVisibility.jsx";
import { ruleCategoryLabel } from "../../rules/ruleCategories.js";
import "./RuleLibrary.css";
import CopyRuleModal from "./CopyRuleModal.jsx";
import "./CopyRuleModal.css";
import { useLiveRefresh } from "../../../services/useLiveRefresh.js";

function formatInterval(seconds) {
  for (const [unit, divisor] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ]) {
    if (seconds % divisor === 0) {
      const value = seconds / divisor;
      return `${value} ${unit}${value === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function templateSummary(template) {
  const parameters = template.parameters || {};
  if (template.rule_type === "multi_parameter") {
    const defs = parameters.parameter_defs || [];
    const names = defs.map((def) => def.name).join(", ");
    return `${defs.length} parameter${defs.length === 1 ? "" : "s"}${names ? ` · ${names}` : ""}`;
  }
  if (template.rule_type === "parameter_threshold" && parameters.temperature_rule === true) {
    const unit = parameters.unit || "°C";
    return `Temperature · warning at ${parameters.warning_threshold ?? "—"} ${unit} · alert at ${parameters.alert_threshold ?? "—"} ${unit}`;
  }
  if (
    template.rule_type === "parameter_threshold" &&
    template.required_variable_types?.includes("boolean") &&
    parameters.expected_value === true &&
    parameters.evaluation_mode !== "state"
  ) {
    return "Always-ON signal · Edit and set running-time thresholds";
  }
  if (
    template.rule_type === "runtime_duration" &&
    Array.isArray(parameters.warning_thresholds_seconds) &&
    parameters.alert_threshold_seconds != null
  ) {
    return `Running Boolean · warnings at ${formatInterval(parameters.warning_thresholds_seconds[0])} / ${formatInterval(parameters.warning_thresholds_seconds[1])} · alert at ${formatInterval(parameters.alert_threshold_seconds)}`;
  }
  if (
    template.rule_type === "boolean_count_threshold" &&
    Array.isArray(parameters.warning_thresholds) &&
    parameters.warning_thresholds.length === 2 &&
    parameters.alert_threshold != null
  ) {
    return `Cycle count · warnings at ${parameters.warning_thresholds[0]} / ${parameters.warning_thresholds[1]} · alert at ${parameters.alert_threshold}`;
  }
  if (
    template.rule_type === "parameter_threshold" &&
    typeof parameters.expected_value === "boolean" &&
    parameters.evaluation_mode === "state"
  ) {
    return `Boolean signal ${template.operator === "!=" || template.operator === "ne" ? "is not" : "is"} ${parameters.expected_value ? "ON" : "OFF"}`;
  }
  if (template.rule_type === "parameter_threshold" && template.threshold != null) {
    return `Value ${template.operator || ""} ${template.threshold}`.trim();
  }
  if (template.required_variable_types?.length) {
    return `Requires ${template.required_variable_types.join(" / ")} variable${template.variable_key ? ` · prefers ${template.variable_key}` : ""}`;
  }
  if (
    template.rule_type === "duration" &&
    template.parameters?.condition === "interval_elapsed"
  ) {
    return `Every ${formatInterval(parameters.interval_seconds)}`;
  }
  return "Asset-level configuration";
}

// User-facing rule type: Interval Based or Parameter Threshold. The stored backend type is unchanged.
export const displayType = (rule) =>
  ruleCategoryLabel(rule) ||
  rule.rule_type?.replaceAll("_", " ") ||
  "Monitoring rule";

// Monitoring category, derived only from the rule types the system implements.
// Only two categories are exposed anywhere: Interval Based and Parameter Threshold.
export const ruleKind = (rule) => displayType(rule);

const DAY_MS = 24 * 60 * 60 * 1000;

// Read-only details of a shared rule. Audit values are the shared rule's own
// (not those of any asset-specific rule created from it).
function formatHistoryValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (value && Array.isArray(value.parameter_defs)) {
    const names = value.parameter_defs.map((item) => item.name).filter(Boolean).join(", ");
    return `${value.parameter_defs.length} parameter(s)${names ? `: ${names}` : ""}`;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).replaceAll("_", " ");
}

export function RuleViewModal({ template, onClose, onManageVisibility }) {
  const [history, setHistory] = useState(null);
  const [assignments, setAssignments] = useState(null);
  const [visibleTo, setVisibleTo] = useState(null);
  useEffect(() => {
    let alive = true;
    if (onManageVisibility && template.visibility_type === "specific_supervisors") {
      api.get(`/rule-templates/${template.id}/visibility`)
        .then((detail) => alive && setVisibleTo((detail.supervisors || []).map((item) => item.username)))
        .catch(() => alive && setVisibleTo([]));
    }
    api.get(`/rule-templates/${template.id}/history`)
      .then((result) => alive && setHistory(Array.isArray(result) ? result : []))
      .catch(() => alive && setHistory([]));
    api.get(`/rule-templates/${template.id}/assignments`)
      .then((result) => alive && setAssignments(result))
      .catch(() => alive && setAssignments({ assets: [], total: null }));
    return () => {
      alive = false;
    };
  }, [template.id]);
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const rows = [
    ["Rule name", template.name],
    ["Description", template.description || "No description provided."],
    ["Rule type", displayType(template)],
    ["Conditions and thresholds", templateSummary(template)],
    ["Severity", template.severity],
    ["Availability", template.is_enabled ? "Available" : "Disabled"],
    ["Visibility", VISIBILITY_LABELS[template.visibility_type] || VISIBILITY_LABELS.admin_only],
    visibleTo ? ["Supervisors with access", visibleTo.length ? visibleTo.join(", ") : "None"] : null,
    template.required_variable_types?.length
      ? ["Required variable", `${template.required_variable_types.join(" / ")}${template.variable_key ? ` · prefers ${template.variable_key}` : ""}`]
      : null,
    template.evaluation_interval_seconds
      ? ["Evaluation interval", formatInterval(template.evaluation_interval_seconds)]
      : null,
    template.stale_after_seconds
      ? ["Stale after", formatInterval(template.stale_after_seconds)]
      : null,
    template.labels?.length ? ["Labels", template.labels.join(", ")] : null,
    ["Created by", auditUser(template.created_by)],
    ["Created on", formatAuditTime(template.created_at)],
    ["Last updated by", auditUser(template.updated_by)],
    ["Last updated on", template.updated_by ? formatAuditTime(template.updated_at) : "Unknown"],
  ].filter(Boolean);

  return (
    <div className="rule-library-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="rule-library-modal" role="dialog" aria-modal="true" aria-labelledby="rule-view-title">
        <header>
          <div><h2 id="rule-view-title">{template.name}</h2><p>Shared rule details (read-only)</p></div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={19} /></button>
        </header>
        <dl className="rule-view-grid">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <section className="rule-view-section">
          <h3>Assigned assets{assignments?.total != null ? ` (${assignments.total})` : ""}</h3>
          {assignments === null ? (
            <small className="muted">Loading…</small>
          ) : assignments.assets.length === 0 ? (
            <small className="muted">Not assigned to any asset you can access.</small>
          ) : (
            <ul>
              {assignments.assets.map((item) => (
                <li key={item.rule_id}>{item.asset_name} <small className="muted">· {String(item.state).replaceAll("_", " ")}</small></li>
              ))}
            </ul>
          )}
        </section>
        <section className="rule-view-section">
          <h3>Change history</h3>
          {history === null ? (
            <small className="muted">Loading…</small>
          ) : history.length === 0 ? (
            <small className="muted">No changes recorded yet.</small>
          ) : (
            <ul>
              {history.map((entry, index) => (
                <li key={`${entry.type}-${entry.at}-${index}`}>
                  {entry.type === "visibility" && <small className="muted">[Visibility] </small>}
                  <strong>{String(entry.field).replaceAll("_", " ")}</strong>
                  {": "}{formatHistoryValue(entry.previous)} → {formatHistoryValue(entry.new)}
                  <small className="muted"> · {auditUser(entry.by)} · {formatAuditTime(entry.at)}{entry.comment ? ` · ${entry.comment}` : ""}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
        <footer>
          {onManageVisibility && (
            <button className="btn-outline" onClick={onManageVisibility}><Eye size={15} /> Change visibility</button>
          )}
          <button className="btn-primary" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  );
}

export default function RuleLibrary() {
 const { user } = useAuth();
 const isAdministrator = user?.role === "Administrator";
 const isSupervisor = user?.role === "Supervisor";


 const canCreateRules = isAdministrator;
 const canEditRules =
 isAdministrator || isSupervisor;

  const confirm = useConfirmation();
  const navigate = useNavigate();
  const location = useLocation();
  const [copying, setCopying] = useState(null);

  const [templates, setTemplates] = useState(null);
  const [ruleRequests, setRuleRequests] = useState([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [reviewingId, setReviewingId] = useState(null);
  const [requestStatus, setRequestStatus] = useState(
    ["pending", "approved", "declined"].includes(
      location.state?.ruleLibraryRequestStatus
    )
      ? location.state.ruleLibraryRequestStatus
      : "pending"
  );
  const [suggestionChoiceOpen, setSuggestionChoiceOpen] = useState(false);
  const [search, setSearch] = useState(
    location.state?.ruleLibrarySearch || ""
  );
  const [status, setStatus] = useState(
    ["all", "true", "false"].includes(location.state?.ruleLibraryStatus)
      ? location.state.ruleLibraryStatus
      : "all"
  );
  const [typeFilter, setTypeFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [sort, setSort] = useState("newest");
  const [labelIds, setLabelIds] = useState([]);
  const labelsRevision = 0;
  const templateLoadGeneration = useRef(0);
  const labelFilterQuery = labelIds
    .map((id) => `label_ids=${encodeURIComponent(id)}`)
    .join("&");
  // Rule type chosen on the New Rule page, used to preset the create form.
  const [visibilityTarget, setVisibilityTarget] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState({ text: "", error: false });
  const load = useCallback(async () => {
  const generation = ++templateLoadGeneration.current;

  const result = await api.get(
    `/rule-templates${labelFilterQuery ? `?${labelFilterQuery}` : ""}`
  );

  if (generation === templateLoadGeneration.current) {
    const libraryTemplates = (Array.isArray(result) ? result : []).filter(
      (template) => template.collection_id == null
    );

    setTemplates(libraryTemplates);
  }
}, [labelFilterQuery]);


const loadPendingRequests = async (filterStatus = requestStatus) => {
  if (!isAdministrator) return;

  setRequestsLoading(true);

  try {
    const result = await api.get(
      `/rule-template-requests?status=${filterStatus}`
    );

    setRuleRequests(Array.isArray(result) ? result : []);
  } catch (error) {
    setMessage({
      text:
        error.message ||
        "Could not load pending rule suggestions.",
      error: true,
    });
  } finally {
    setRequestsLoading(false);
  }
};

useEffect(() => {
  const flash = consumeNavigationFlash(location);
  if (flash?.text) {
    setMessage({
      text: flash.text,
      error: Boolean(flash.error),
    });
  }
  if (flash?.state) {
    if (typeof flash.state.ruleLibrarySearch === "string") {
      setSearch(flash.state.ruleLibrarySearch);
    }
    if (
      ["all", "true", "false"].includes(flash.state.ruleLibraryStatus)
    ) {
      setStatus(flash.state.ruleLibraryStatus);
    }
    if (
      ["pending", "approved", "declined"].includes(
        flash.state.ruleLibraryRequestStatus
      )
    ) {
      setRequestStatus(flash.state.ruleLibraryRequestStatus);
    }
  }

  let shouldClearTransientState = false;
  const retainedState = { ...(location.state || {}) };
  if (
    retainedState.maintenanceSuggestionSubmitted ||
    retainedState.createdNotice
  ) {
    setMessage({
      text:
        retainedState.createdNotice ||
        "Maintenance suggestion submitted for Administrator review.",
      error: false,
    });
    delete retainedState.maintenanceSuggestionSubmitted;
    delete retainedState.createdNotice;
    shouldClearTransientState = true;
  }


  if (shouldClearTransientState) {
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
  canCreateRules,
]);

useEffect(() => {
  loadPendingRequests(requestStatus);
}, [requestStatus, isAdministrator]);

  useEffect(() => {
    load().catch((error) =>
      setMessage({
        text: error.message || "Could not load the monitoring rule library.",
        error: true,
      })
    );
    return () => {
      templateLoadGeneration.current += 1;
    };
  }, [load]);

  // Shared rules change from other tabs and users: refetch the library when they do.
  useLiveRefresh(load, { tables: ["nem_monitoring_rule_templates"], events: ["rule_template."] });
  useLiveRefresh(() => loadPendingRequests(requestStatus), { tables: ["nem_monitoring_rule_template_requests"], enabled: isAdministrator });

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const created = (template) => (template.created_at ? Date.parse(template.created_at) || 0 : 0);
    const sorters = {
      newest: (a, b) => created(b) - created(a) || b.id - a.id,
      oldest: (a, b) => created(a) - created(b) || a.id - b.id,
      "name-asc": (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      "name-desc": (a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: "base" }),
    };
    return (templates || [])
      .filter((template) => {
        const matchesText = !query || `${template.name} ${template.description || ""} ${template.rule_type}`.toLowerCase().includes(query);
        const matchesStatus = status === "all" || String(template.is_enabled) === status;
        const matchesType = typeFilter === "all" || displayType(template) === typeFilter;
        const matchesKind = kindFilter === "all" || ruleKind(template) === kindFilter;
        return matchesText && matchesStatus && matchesType && matchesKind;
      })
      .sort(sorters[sort] || sorters.newest);
  }, [templates, search, status, typeFilter, kindFilter, sort]);

  // Overview figures, all computed from the loaded library rules.
  const stats = useMemo(() => {
    const rows = templates || [];
    const kinds = new Map();
    const types = new Map();
    rows.forEach((template) => {
      kinds.set(ruleKind(template), (kinds.get(ruleKind(template)) || 0) + 1);
      types.set(displayType(template), (types.get(displayType(template)) || 0) + 1);
    });
    const since = Date.now() - 30 * DAY_MS;
    return {
      total: rows.length,
      available: rows.filter((template) => template.is_enabled).length,
      disabled: rows.filter((template) => !template.is_enabled).length,
      recent: rows.filter((template) => template.created_at && Date.parse(template.created_at) >= since).length,
      kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]),
      types: [...types.keys()].sort(),
    };
  }, [templates]);

  const hasFilters = Boolean(search.trim() || status !== "all" || typeFilter !== "all" || kindFilter !== "all" || labelIds.length);
  const clearFilters = () => {
    setSearch(""); setStatus("all"); setTypeFilter("all"); setKindFilter("all"); setLabelIds([]);
  };

const reviewRequest = async (request, action) => {
  if (!isAdministrator || reviewingId !== null) return;

  const requestId = request.id;

  setReviewingId(requestId);
  setMessage({ text: "", error: false });

  try {
    await api.post(
      `/rule-template-requests/${requestId}/${action}`,
      {}
    );

    setMessage({
      text:
        action === "approve"
          ? request.suggestion_type === "maintenance"
            ? `Maintenance suggestion "${request.name}" approved and scheduled.`
            : `Suggestion "${request.name}" approved and added to the rule library.`
          : `Suggestion "${request.name}" declined.`,
      error: false,
    });

    await Promise.all([
      load(),
      loadPendingRequests(),
    ]);
  } catch (error) {
    setMessage({
      text:
        error.message ||
        `Could not ${action} this suggestion.`,
      error: true,
    });
  } finally {
    setReviewingId(null);
  }
};

  const remove = async (template) => {
    if (
      !(await confirm(
        `Delete the reusable rule “${template.name}”? Assigned asset rules will not be changed.`,
        {
          title: "Delete reusable rule",
          confirmLabel: "Delete",
          destructive: true,
        }
      ))
    ) return;
    setBusyId(template.id);
    setMessage({ text: "", error: false });
    try {
      await api.del(`/rule-templates/${template.id}`);
      setMessage({ text: "Rule deleted.", error: false });
      await load();
    } catch (error) {
      setMessage({ text: error.message || "Could not delete this rule.", error: true });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="rule-library-page">
      <button
        className="link-btn"
        onClick={() =>
          returnToNavigationOrigin(
            navigate,
            location.state?.from,
            "/configuration"
          )
        }
      >
        ‹ Back
      </button>
      <div className="rule-library-heading">
        <div>
          <h1 className="page-title">Monitoring Rule Library</h1>
          <p className="muted">
            Reusable monitoring rules, ready to assign to assets. Rules that belong to a collection are managed in the Rule Collection Library.
            </p>
            </div>
<div className="rule-library-heading-actions">
  <button type="button" className="btn-outline" onClick={() => navigate("/configuration/collections")}>
    <Layers size={17} />
    Rule collections
  </button>
  <button
    type="button"
    className="btn-primary"
    disabled={!isAdministrator}
    title={
      isAdministrator
        ? "Create new rule"
        : "Only Administrators can create rules directly."
    }
    onClick={() => {
      if (!isAdministrator) return;
      // New rules start on the full-page rule-type selection. The existing modal is
      // still reachable from there ("Other rule types") and for editing/suggestions.
      navigate("/configuration/rules/new", {
        state: {
          from: captureNavigationOrigin(location, {
            ...location.state,
            ruleLibrarySearch: search,
            ruleLibraryStatus: status,
            ruleLibraryRequestStatus: requestStatus,
          }),
        },
      });
    }}
  >
    <Plus size={17} />
    New rule
  </button>

  {isSupervisor && (
    <button
      type="button"
      className="btn-primary"
      onClick={() => {
        setSuggestionChoiceOpen(true);
      }}
    >
      <Plus size={17} />
      Suggest new rule
    </button>
  )}
</div>
                  </div>

      {message.text && (<p className={"notice" + (message.error ? " error" : "")}role={message.error ? "alert" : "status"}>{message.text}</p>)}
      
{isAdministrator && (
  <section className="rule-library-panel pending-suggestions">
    <div className="rule-library-tools">
      <div>
        <h2>Suggestions</h2>
        <p className="muted">
          Review monitoring-rule and maintenance suggestions from Supervisors.
        </p>
      </div>

      <select
        aria-label="Filter suggestions by review status"
        value={requestStatus}
        onChange={(event) => setRequestStatus(event.target.value)}
        disabled={requestsLoading || reviewingId !== null}
      >
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
        <option value="declined">Declined</option>
      </select>
      <button
        type="button"
        className="icon-outline"
        onClick={() => loadPendingRequests(requestStatus)}
        disabled={requestsLoading || reviewingId !== null}
        title="Refresh suggestions"
        aria-label="Refresh suggestions"
      >
        <RefreshCw size={17} aria-hidden="true" />
      </button>
    </div>

    {requestsLoading && ruleRequests.length === 0 ? (
      <LoadingIndicator message="Loading suggestions" />
    ) : ruleRequests.length === 0 ? (
      <EmptyState
        art={false}
        title={`No ${requestStatus} suggestions`}
        lines={[
          "Suggestions submitted by Supervisors will appear here.",
        ]}
      />
    ) : (
      <div className="rule-library-list">
        {ruleRequests.map((request) => (
          <article
            className="rule-library-card"
            key={request.id}
          >
            <div className="rule-library-card-icon">
              <Activity size={19} />
            </div>

            <div className="rule-library-card-main">
              <div className="rule-library-card-title">
                <h2>{request.name}</h2>
                <span className={`rule-library-status ${request.status === "approved" ? "available" : "disabled"}`}>
                  {request.status === "pending"
                    ? "Pending"
                    : request.status[0].toUpperCase() + request.status.slice(1)}
                </span>
                <span className="rule-library-status">
                  {request.suggestion_type === "maintenance"
                    ? "Maintenance Suggestion"
                    : "Monitoring Rule Suggestion"}
                </span>
              </div>

              <p>
                {request.description ||
                  "No description provided."}
              </p>

              {request.suggestion_type === "maintenance" ? (
                <div className="rule-maintenance-suggestion-details">
                  <p><strong>Asset:</strong> {request.maintenance_asset_name || `Asset ${request.maintenance_details?.asset_id || "—"}`}</p>
                  <p><strong>Type / priority:</strong> {request.maintenance_details?.maintenance_type || "—"} · {request.maintenance_details?.priority || "—"}</p>
                  <p><strong>Assigned technician:</strong> {request.maintenance_details?.assigned_technician || "Unassigned"}</p>
                  <p><strong>Schedule start:</strong> {request.maintenance_details?.schedule_start_date || "—"}</p>
                  <p><strong>First due:</strong> {request.maintenance_details?.first_due_date || "—"}</p>
                  <p><strong>Recurrence:</strong> {request.maintenance_details?.recurrence_enabled
                    ? `Every ${request.maintenance_details.recurrence_interval} ${request.maintenance_details.recurrence_unit}`
                    : "Disabled"}</p>
                  {request.maintenance_details?.instruction_document_ids?.length > 0 && (
                    <p><strong>Instruction documents:</strong> {request.maintenance_details.instruction_document_ids.join(", ")}</p>
                  )}
                  {request.maintenance_details?.description && (
                    <p><strong>Work details:</strong> {request.maintenance_details.description}</p>
                  )}
                </div>
              ) : (
                <>
                  <small>
                    {displayType(request)} · {templateSummary(request)}
                  </small>
                  <p><strong>Severity:</strong> {request.severity}</p>
                  {request.variable_key && (
                    <p><strong>Preferred variable:</strong> {request.variable_key}</p>
                  )}
                </>
              )}

              {request.created_at && (
                <small>
                  Submitted:{" "}
                  {new Date(
                    request.created_at
                  ).toLocaleString()}
                </small>
              )}
              {request.requested_by_name && (
                <small>Submitted by: {request.requested_by_name}</small>
              )}
              {request.reviewed_at && (
                <small>
                  Reviewed by {request.reviewed_by_name || `user ${request.reviewed_by}`} on{" "}
                  {new Date(request.reviewed_at).toLocaleString()}
                </small>
              )}
            </div>

            {request.status === "pending" && <div className="rule-library-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() =>
                  reviewRequest(request, "approve")
                }
                disabled={reviewingId !== null}
              >
                {reviewingId === request.id
                  ? "Processing…"
                  : request.suggestion_type === "maintenance"
                    ? "Approve and create schedule"
                    : "Approve"}
              </button>

              <button
                type="button"
                className="btn-outline danger"
                onClick={() =>
                  reviewRequest(request, "decline")
                }
                disabled={reviewingId !== null}
              >
                Decline
              </button>
            </div>}
          </article>
        ))}
      </div>
    )}
  </section>
)}

      {templates !== null && templates.length > 0 && (
        <div className="rl-stats" aria-label="Library overview">
          <div className="rl-stat"><b>{stats.total}</b><span>Library rules</span></div>
          <div className="rl-stat good"><b>{stats.available}</b><span>Available</span></div>
          <div className="rl-stat"><b>{stats.disabled}</b><span>Disabled</span></div>
          <div className="rl-stat"><b>{stats.recent}</b><span>Added in last 30 days</span></div>
          <div className="rl-stat wide">
            <span>By category</span>
            <div className="rl-chips">
              {stats.kinds.map(([kind, count]) => (
                <button key={kind} type="button" className={`rl-chip${kindFilter === kind ? " on" : ""}`}
                  onClick={() => setKindFilter(kindFilter === kind ? "all" : kind)}>{kind} · {count}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      <section className="rule-library-panel">
        <div className="rule-library-tools rl-tools">
          <label className="rule-library-search"><Search size={17} /><input aria-label="Search rules" placeholder="Search by name or description…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <select aria-label="Filter by rule type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            <option value="all">All rule types</option>
            {stats.types.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          <select aria-label="Filter rule availability" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="true">Available</option>
            <option value="false">Disabled</option>
          </select>
          <select aria-label="Sort rules" value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name-asc">Name A–Z</option>
            <option value="name-desc">Name Z–A</option>
          </select>
          <LabelsField
            mode="filter"
            value={labelIds}
            onChange={setLabelIds}
            refreshKey={labelsRevision}
          />
        </div>
        {templates === null ? <LoadingIndicator className="loading" message="Loading rules" /> : visible.length === 0 ? (
          <div className="rl-empty">
            <EmptyState art={false} title={templates.length === 0 && !hasFilters ? "The rule library is empty" : "No rules match"} lines={[templates.length === 0 && !hasFilters ? "Create a reusable rule here. Asset-specific rules and rules inside collections do not appear in this library." : "Nothing matches the current search and filters."]} />
            {hasFilters && <button type="button" className="btn-outline" onClick={clearFilters}>Clear filters</button>}
          </div>
        ) : (
          <>
            <div className="rl-table-wrap">
              <table className="rl-table" aria-label="Monitoring rules">
                <thead>
                  <tr><th>Rule</th><th>Category</th><th>Configuration</th><th>Variable</th><th>Status</th><th>Created</th><th><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody>
                  {visible.map((template) => (
                    <tr key={template.id}>
                      <td className="rl-name">
                        <button type="button" className="rl-link" onClick={() => setViewing(template)}>{template.name}</button>
                        <div className="rl-desc">{template.description || "No description provided."}</div>
                        {template.labels?.length > 0 && (
                          <span className="labels-chips rule-library-labels">
                            {template.labels.map((label) => <span className="label-chip" key={label}>{label}</span>)}
                          </span>
                        )}
                      </td>
                      <td>{displayType(template)}</td>
                      <td className="rl-config">{templateSummary(template)}</td>
                      <td>{template.required_variable_types?.length ? template.required_variable_types.join(" / ") : "—"}{template.variable_key ? <div className="rl-desc">prefers {template.variable_key}</div> : null}</td>
                      <td>
                        <span className={`rule-library-status ${template.is_enabled ? "available" : "disabled"}`}>{template.is_enabled ? "Available" : "Disabled"}</span>
                        <div><VisibilityBadge type={template.visibility_type} /></div>
                      </td>
                      <td className="rl-date">{formatAuditDate(template.created_at)}<div className="rl-desc">{auditUser(template.created_by)}</div></td>
                      <td>
                        <div className="rule-library-actions rl-actions">
                          <button type="button" className="btn-outline" onClick={() => setViewing(template)} title="View details" aria-label={`View ${template.name}`}><Eye size={15} /></button>
                          <button type="button" className="btn-outline" onClick={() => setCopying(template)} disabled={!canCreateRules} title={!canCreateRules ? "Administrator access required to copy reusable rules." : "Duplicate this reusable rule"} aria-label={`Duplicate ${template.name}`}><Copy size={15} /></button>
                          <button type="button" className="btn-outline" onClick={() => navigate(`/configuration/rules/${template.id}/edit`, { state: { from: captureNavigationOrigin(location, { ...location.state, ruleLibrarySearch: search, ruleLibraryStatus: status, ruleLibraryRequestStatus: requestStatus }) } })} disabled={!canEditRules} title="Edit rule" aria-label={`Edit ${template.name}`}><Pencil size={15} /></button>
                          <button type="button" className="btn-outline danger" onClick={() => remove(template)} disabled={busyId === template.id || !isAdministrator} title={!isAdministrator ? "Administrator access required to delete reusable rules." : "Delete rule"} aria-label={`Delete ${template.name}`}>{busyId === template.id ? "…" : <Trash2 size={15} />}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rl-count">Showing {visible.length} of {templates.length} rule{templates.length === 1 ? "" : "s"}</p>
          </>
        )}
      </section>

{suggestionChoiceOpen && (
  <Modal
    title="Suggest a new rule"
    onClose={() => setSuggestionChoiceOpen(false)}
  >
    <p className="muted">
      Choose what you want to suggest for Administrator review.
    </p>
    <div className="rule-suggestion-choice-list">
      <button
        type="button"
        className="btn-outline"
        onClick={() => {
          setSuggestionChoiceOpen(false);
          navigate("/configuration/rules/new", {
            state: {
              suggest: true,
              from: captureNavigationOrigin(location, {
                ...location.state,
                ruleLibrarySearch: search,
                ruleLibraryStatus: status,
                ruleLibraryRequestStatus: requestStatus,
              }),
            },
          });
        }}
      >
        <Activity size={17} />
        New Monitoring Rule
      </button>
      <button
        type="button"
        className="btn-outline"
        onClick={() => {
          setSuggestionChoiceOpen(false);
          navigate("/maintenance/suggest", {
            state: {
              from: captureNavigationOrigin(location, {
                ...location.state,
                ruleLibrarySearch: search,
                ruleLibraryStatus: status,
                ruleLibraryRequestStatus: requestStatus,
              }),
            },
          });
        }}
      >
        <Plus size={17} />
        New Maintenance Rule
      </button>
    </div>
  </Modal>
)}

{viewing && (
  <RuleViewModal
    template={viewing}
    onClose={() => setViewing(null)}
    onManageVisibility={
      isAdministrator
        ? () => {
            setVisibilityTarget(viewing);
            setViewing(null);
          }
        : undefined
    }
  />
)}

{visibilityTarget && (
  <VisibilityModal
    template={visibilityTarget}
    onClose={() => setVisibilityTarget(null)}
    onSaved={async () => {
      const name = visibilityTarget.name;
      setVisibilityTarget(null);
      setMessage({ text: `Visibility updated for "${name}".`, error: false });
      await load();
    }}
  />
)}

      {copying && (
  <CopyRuleModal
    template={copying}
    existingTemplates={templates || []}
    onClose={() => setCopying(null)}
    onComplete={async () => {
      setCopying(null);

      setMessage({
        text: "Rule copied successfully and added to the Monitoring Rule Library.",
        error: false,
      });

      await load();
    }}
  />
)}
</main>
);
}
