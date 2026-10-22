import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  Copy,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../../../services/api.js";
import { CreateModal, EmptyState } from "../../../components/common/UI.jsx";
import "./RuleLibrary.css";

const RULE_TYPES = [
  ["interval_based", "Interval based"],
  ["parameter_threshold", "Parameter threshold"],
];

const COMPARISON_OPTIONS = [
  [">=", "Greater than or equal"],
  [">", "Greater than"],
  ["<=", "Less than or equal"],
  ["<", "Less than"],
  ["==", "Equal"],
  ["!=", "Not equal"],
];

const FIELDS = [
  { key: "name", label: "Rule name", required: true, placeholder: "e.g. High motor temperature" },
  { key: "description", label: "Description", type: "textarea" },
  { key: "rule_type", label: "Rule type", type: "select", required: true, default: "interval_based", options: RULE_TYPES },
  {
    key: "variable_type",
    label: "Numeric variable type",
    type: "select",
    default: "number",
    options: [
      ["number", "Number"],
      ["integer", "Integer"],
    ],
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    requiredWhen: { key: "rule_type", equals: "parameter_threshold" },
    hint: "The assigned asset needs an active variable with this data type.",
  },
  { key: "variable_key", label: "Preferred variable key (optional)", placeholder: "e.g. motor_temperature", hint: "Used to suggest a mapping when assigning this rule.", showWhen: { key: "rule_type", equals: "parameter_threshold" } },
  { key: "interval_value", label: "Interval", type: "number", required: true, showWhen: { key: "rule_type", equals: "interval_based" } },
  { key: "interval_unit", label: "Interval unit", type: "select", required: true, default: "hours", options: [["seconds", "Seconds"], ["minutes", "Minutes"], ["hours", "Hours"], ["days", "Days"]], showWhen: { key: "rule_type", equals: "interval_based" } },
  { key: "operator", label: "Condition", type: "select", required: true, default: ">=", options: COMPARISON_OPTIONS, showWhen: { key: "rule_type", equals: "parameter_threshold" } },
  { key: "threshold", label: "Threshold", type: "number", required: true, showWhen: { key: "rule_type", equals: "parameter_threshold" } },
  { key: "severity", label: "Severity", type: "select", required: true, default: "warning", options: [["warning", "Warning"], ["alert", "Alert"]] },
  { key: "is_enabled", label: "Rule status", type: "select", required: true, default: "true", options: [["true", "Available"], ["false", "Disabled"]] },
  { key: "evaluation_interval_seconds", label: "Check interval (seconds)", type: "number", showWhen: { key: "rule_type", equals: "parameter_threshold" } },
  { key: "stale_after_seconds", label: "Stale reading timeout (seconds)", type: "number", showWhen: { key: "rule_type", equals: "parameter_threshold" } },
];

const LEGACY_EDIT_FIELDS = [
  { key: "name", label: "Rule name", required: true },
  { key: "description", label: "Description", type: "textarea" },
  { key: "severity", label: "Severity", type: "select", required: true, options: [["warning", "Warning"], ["alert", "Alert"]] },
  { key: "is_enabled", label: "Rule status", type: "select", required: true, options: [["true", "Available"], ["false", "Disabled"]] },
];

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

const displayType = (rule) =>
  rule.rule_type === "duration" &&
  rule.parameters?.condition === "interval_elapsed"
    ? "Interval based"
    : RULE_TYPES.find(([value]) => value === rule.rule_type)?.[1] ||
      rule.rule_type?.replaceAll("_", " ") ||
      "Monitoring rule";

const supportsCurrentRuleEditor = (rule) =>
  rule.rule_type === "parameter_threshold" ||
  (rule.rule_type === "duration" &&
    rule.parameters?.condition === "interval_elapsed");

function legacyTemplatePayload(values, template) {
  return {
    name: values.name,
    description: values.description || null,
    rule_type: template.rule_type,
    required_variable_types: template.required_variable_types,
    variable_key: template.variable_key,
    operator: template.operator,
    threshold: template.threshold,
    parameters: template.parameters,
    severity: values.severity,
    is_enabled: values.is_enabled !== "false",
    evaluation_interval_seconds: template.evaluation_interval_seconds,
    stale_after_seconds: template.stale_after_seconds,
  };
}

function initialTemplate(template) {
  if (!template) return {};
  const params = template.parameters || {};
  const required = template.required_variable_types || [];
  const variableType = required.length === 2 && required.includes("number") && required.includes("integer")
    ? "number"
    : required[0] || "number";
  const isInterval =
    template.rule_type === "duration" &&
    params.condition === "interval_elapsed";
  const intervalSeconds = params.interval_seconds;
  const intervalUnits = [
    ["days", 86400],
    ["hours", 3600],
    ["minutes", 60],
    ["seconds", 1],
  ];
  const intervalUnit =
    intervalUnits.find(([, seconds]) =>
      Number.isInteger(intervalSeconds / seconds)
    )?.[0] || "seconds";
  return {
    ...template,
    rule_type: isInterval ? "interval_based" : template.rule_type,
    variable_type: variableType,
    interval_value: intervalSeconds
      ? intervalSeconds /
        intervalUnits.find(([unit]) => unit === intervalUnit)[1]
      : "",
    interval_unit: intervalUnit,
    is_enabled: String(template.is_enabled),
  };
}

function templatePayload(values) {
  const isInterval = values.rule_type === "interval_based";
  const type = isInterval ? "duration" : values.rule_type;
  let required_variable_types = null;
  let parameters = null;
  let operator = null;
  let threshold = null;
  let variable_key = null;
  if (isInterval) {
    const unitSeconds = {
      seconds: 1,
      minutes: 60,
      hours: 3600,
      days: 86400,
    };
    const intervalSeconds =
      Number(values.interval_value) * unitSeconds[values.interval_unit];
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error("Interval must be a positive whole number of seconds.");
    }
    parameters = {
      condition: "interval_elapsed",
      interval_seconds: intervalSeconds,
    };
  } else if (type === "parameter_threshold") {
    required_variable_types = values.variable_type === "integer"
      ? ["integer"]
      : ["number", "integer"];
    variable_key = values.variable_key || null;
    operator = values.operator;
    threshold = values.threshold;
  }
  return {
    name: values.name,
    description: values.description || null,
    rule_type: type,
    required_variable_types,
    variable_key,
    operator,
    threshold,
    parameters,
    severity: values.severity,
    is_enabled: values.is_enabled !== "false",
    evaluation_interval_seconds: values.evaluation_interval_seconds || null,
    stale_after_seconds: values.stale_after_seconds || null,
  };
}

function AssignmentModal({ template, onClose, onComplete }) {
  const [assets, setAssets] = useState([]);
  const [variables, setVariables] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [mapping, setMapping] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    let alive = true;
    api.getAll("/assets")
      .then((items) => alive && setAssets(items))
      .catch((err) => alive && setError(err.message || "Could not load assets."))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const chosen = assets.filter((asset) => selected.has(asset.id));
    Promise.all(chosen.map(async (asset) => {
      const result = await api.get(`/assets/${asset.id}/variables?is_active=true`);
      return [asset.id, Array.isArray(result) ? result : []];
    }))
      .then((entries) => {
        if (!alive) return;
        const next = Object.fromEntries(entries);
        setVariables((current) => ({ ...current, ...next }));
        setMapping((current) => {
          const updated = { ...current };
          for (const [assetId, list] of entries) {
            const matches = list.filter((variable) =>
              (template.required_variable_types || []).includes(variable.data_type)
            );
            const preferred = matches.filter((variable) =>
              template.variable_key &&
              variable.key.toLowerCase() === template.variable_key.toLowerCase()
            );
            if (!updated[assetId] && preferred.length === 1) updated[assetId] = String(preferred[0].id);
            else if (!updated[assetId] && matches.length === 1) updated[assetId] = String(matches[0].id);
          }
          return updated;
        });
      })
      .catch((err) => alive && setError(err.message || "Could not load asset variables."))
      .finally(() => {});
    return () => { alive = false; };
  }, [assets, selected, template]);

  const toggleAsset = (assetId) => {
    setReview(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  };

  const submit = async () => {
    if (saving || !selected.size) return;
    setSaving(true);
    setError("");
    try {
      const variable_mappings = {};
      for (const assetId of selected) {
        if (template.required_variable_types?.length) {
          if (!mapping[assetId]) throw new Error("Choose a compatible variable for every selected asset.");
          variable_mappings[assetId] = Number(mapping[assetId]);
        }
      }
      const result = await api.post(`/rule-templates/${template.id}/assign`, {
        asset_ids: [...selected],
        variable_mappings,
      });
      await onComplete(result);
      onClose();
    } catch (err) {
      setError(err.message || "Could not assign this rule.");
      setReview(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rule-library-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section className="rule-library-modal" role="dialog" aria-modal="true" aria-labelledby="template-assign-title">
        <header>
          <div><h2 id="template-assign-title">Assign “{template.name}”</h2><p>Selected rules are added inactive. Existing assignments are left unchanged.</p></div>
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={saving}><X size={19} /></button>
        </header>
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="rule-library-asset-list">
          {loading ? <p className="muted">Loading assets…</p> : assets.length === 0 ? <p className="muted">No assets are available.</p> : assets.map((asset) => {
            const chosen = selected.has(asset.id);
            const compatible = (variables[asset.id] || []).filter((variable) =>
              (template.required_variable_types || []).includes(variable.data_type)
            );
            return (
              <div className="rule-library-asset-option" key={asset.id}>
                <label>
                  <input type="checkbox" checked={chosen} onChange={() => toggleAsset(asset.id)} disabled={saving} />
                  <span>{asset.name}</span>
                </label>
                {chosen && template.required_variable_types?.length > 0 && (
                  <select
                    aria-label={`Variable for ${asset.name}`}
                    value={mapping[asset.id] || ""}
                    onChange={(event) => setMapping((current) => ({ ...current, [asset.id]: event.target.value }))}
                    disabled={saving}
                  >
                    <option value="">Choose compatible variable</option>
                    {compatible.map((variable) => <option key={variable.id} value={variable.id}>{variable.name} · {variable.key} ({variable.data_type})</option>)}
                  </select>
                )}
                {chosen && template.required_variable_types?.length > 0 && compatible.length === 0 && <small className="rule-library-error">No compatible active variable on this asset.</small>}
              </div>
            );
          })}
        </div>
        {review && <p className="rule-library-review" role="status">Assign this rule to {selected.size} selected asset(s)? Each new asset rule will be created inactive.</p>}
        <footer>
          <button className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          {review && <button className="btn-outline" onClick={() => setReview(false)} disabled={saving}>Back</button>}
          <button className="btn-primary" onClick={() => review ? submit() : setReview(true)} disabled={saving || loading || selected.size === 0}>
            {saving ? "Assigning…" : review ? "Confirm assignment" : "Review assignment"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export default function RuleLibrary() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [assigning, setAssigning] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState({ text: "", error: false });
  const load = async () => {
    const result = await api.get("/rule-templates");
    setTemplates(Array.isArray(result) ? result : []);
  };

  useEffect(() => {
    let alive = true;
    api.get("/rule-templates")
      .then((items) => alive && setTemplates(Array.isArray(items) ? items : []))
      .catch((error) => alive && setMessage({ text: error.message || "Could not load the monitoring rule library.", error: true }))
      .finally(() => {});
    return () => { alive = false; };
  }, []);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (templates || []).filter((template) => {
      const matchesText = !query || `${template.name} ${template.description || ""} ${template.rule_type}`.toLowerCase().includes(query);
      const matchesStatus = status === "all" || String(template.is_enabled) === status;
      return matchesText && matchesStatus;
    });
  }, [templates, search, status]);

  const save = async (values) => {
    const payload =
      editing && !supportsCurrentRuleEditor(editing)
        ? legacyTemplatePayload(values, editing)
        : templatePayload(values);
    if (editing) await api.put(`/rule-templates/${editing.id}`, payload);
    else await api.post("/rule-templates", payload);
    setModalOpen(false);
    setEditing(null);
    setMessage({ text: `Rule ${editing ? "updated" : "created"} successfully.`, error: false });
    await load();
  };

  const remove = async (template) => {
    if (!window.confirm(`Delete the reusable rule “${template.name}”? Assigned asset rules will not be changed.`)) return;
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
      <button className="link-btn" onClick={() => navigate("/configuration")}>‹ Back to Configuration</button>
      <div className="rule-library-heading">
        <div>
          <h1 className="page-title">Monitoring Rule Library</h1>
          <p className="muted">Create reusable monitoring rules, then assign them to assets. Assigned rules start inactive.</p>
        </div>
        <button className="btn-primary" onClick={() => { setEditing(null); setModalOpen(true); }}><Plus size={17} /> New rule</button>
      </div>

      {message.text && <p className={"notice" + (message.error ? " error" : "")} role={message.error ? "alert" : "status"}>{message.text}</p>}

      <section className="rule-library-panel">
        <div className="rule-library-tools">
          <label className="rule-library-search"><Search size={17} /><input aria-label="Search rules" placeholder="Search rules…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <select aria-label="Filter rule availability" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All rules</option>
            <option value="true">Available</option>
            <option value="false">Disabled</option>
          </select>
        </div>
        {templates === null ? <div className="loading" role="status">Loading rules…</div> : visible.length === 0 ? (
          <EmptyState art={false} title={templates.length === 0 ? "The rule library is empty" : "No rules match"} lines={[templates.length === 0 ? "Create a reusable rule here. Asset-specific rules do not appear in this library." : "Try a different search or availability filter."]} />
        ) : (
          <div className="rule-library-list">
            {visible.map((template) => (
              <article className="rule-library-card" key={template.id}>
                <div className="rule-library-card-icon"><Activity size={19} /></div>
                <div className="rule-library-card-main">
                  <div className="rule-library-card-title"><h2>{template.name}</h2><span className={`rule-library-status ${template.is_enabled ? "available" : "disabled"}`}>{template.is_enabled ? "Available" : "Disabled"}</span></div>
                  <p>{template.description || "No description provided."}</p>
                  <small>{displayType(template)}{template.required_variable_types?.length ? ` · Requires ${template.required_variable_types.join(" / ")} variable${template.variable_key ? ` · Prefers ${template.variable_key}` : ""}` : template.rule_type === "duration" && template.parameters?.condition === "interval_elapsed" ? ` · Every ${formatInterval(template.parameters.interval_seconds)}` : " · Asset-level configuration"}</small>
                </div>
                <div className="rule-library-actions">
                  <button className="btn-outline" onClick={() => setAssigning(template)} disabled={!template.is_enabled}><Copy size={15} /> Assign rule</button>
                  <button className="btn-outline" onClick={() => { setEditing(template); setModalOpen(true); }}><Pencil size={15} /> Edit</button>
                  <button className="btn-outline danger" onClick={() => remove(template)} disabled={busyId === template.id}>{busyId === template.id ? "Deleting…" : <><Trash2 size={15} /> Delete</>}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {modalOpen && <CreateModal
        title={editing ? "Edit rule" : "Create reusable rule"}
        intro={
          editing && !supportsCurrentRuleEditor(editing)
            ? `${displayType(editing)} is a legacy rule type. Its evaluation settings will be preserved while you edit its name, description, severity, and availability.`
            : "Create a reusable rule, then assign it to one or more assets."
        }
        fields={
          editing && !supportsCurrentRuleEditor(editing)
            ? LEGACY_EDIT_FIELDS
            : FIELDS
        }
        initialValues={initialTemplate(editing)}
        submitLabel={editing ? "Save rule" : "Create rule"}
        onSubmit={save}
        onClose={() => { setModalOpen(false); setEditing(null); }}
      />}
      {assigning && <AssignmentModal
        template={assigning}
        onClose={() => setAssigning(null)}
        onComplete={async (result) => {
          const made = result.created?.length || 0;
          const duplicates = result.already_assigned?.length || 0;
          setMessage({ text: `Assigned to ${made} asset(s); ${duplicates} already had the same rule.`, error: false });
        }}
      />}
    </main>
  );
}
