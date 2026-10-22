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
  ["parameter_threshold", "Parameter threshold"],
  ["boolean_count_threshold", "Boolean cycle count"],
  ["duration", "Duration condition"],
  ["runtime_duration", "Runtime duration"],
];

const FIELDS = [
  { key: "name", label: "Template name", required: true, placeholder: "e.g. High motor temperature" },
  { key: "description", label: "Description", type: "textarea" },
  { key: "rule_type", label: "Rule type", type: "select", required: true, default: "parameter_threshold", options: RULE_TYPES },
  {
    key: "variable_type",
    label: "Required variable type",
    type: "select",
    default: "number",
    options: [
      ["number", "Number"],
      ["integer", "Integer"],
      ["boolean", "Boolean"],
      ["string", "String"],
    ],
    showWhen: { key: "rule_type", equals: "duration" },
    requiredWhen: { key: "rule_type", equals: "duration" },
    hint: "The target asset needs an active variable with this data type.",
  },
  { key: "variable_key", label: "Preferred variable key (optional)", placeholder: "e.g. motor_temperature", hint: "Used to suggest a mapping; it does not bind the template to an asset.", showWhen: { anyOf: [{ key: "rule_type", equals: "parameter_threshold" }, { key: "rule_type", equals: "duration" }, { key: "rule_type", equals: "boolean_count_threshold" }] } },
  { key: "operator", label: "Condition", type: "select", required: true, default: ">=", options: [[">=", "Greater than or equal"], [">", "Greater than"], ["<=", "Less than or equal"], ["<", "Less than"], ["==", "Equal"], ["!=", "Not equal"]], showWhen: { key: "rule_type", equals: "parameter_threshold" } },
  { key: "threshold", label: "Threshold", type: "number", required: true, showWhen: { key: "rule_type", equals: "parameter_threshold" } },
  { key: "warning_1", label: "First warning cycle count", type: "number", required: true, default: 9000, showWhen: { key: "rule_type", equals: "boolean_count_threshold" } },
  { key: "warning_2", label: "Second warning cycle count", type: "number", required: true, default: 9500, showWhen: { key: "rule_type", equals: "boolean_count_threshold" } },
  { key: "alert_threshold", label: "Alert cycle count", type: "number", required: true, default: 10000, showWhen: { key: "rule_type", equals: "boolean_count_threshold" } },
  { key: "runtime_warning_hours", label: "Warning threshold (hours)", type: "number", required: true, showWhen: { key: "rule_type", equals: "runtime_duration" } },
  { key: "runtime_warning_2_hours", label: "Higher warning threshold (hours)", type: "number", required: true, showWhen: { key: "rule_type", equals: "runtime_duration" } },
  { key: "runtime_alert_hours", label: "Alert threshold (hours)", type: "number", required: true, showWhen: { key: "rule_type", equals: "runtime_duration" } },
  { key: "duration_seconds", label: "Duration (seconds)", type: "number", required: true, showWhen: { key: "rule_type", equals: "duration" } },
  { key: "runtime_duration_seconds", label: "Runtime duration (seconds)", type: "number", required: true, showWhen: { key: "rule_type", equals: "runtime_duration" } },
  { key: "duration_condition", label: "Duration condition", type: "select", default: "equals", options: [["equals", "Value equals"], ["threshold", "Value crosses threshold"]], showWhen: { key: "rule_type", equals: "duration" } },
  { key: "expected_value", label: "Expected value", showWhen: [{ key: "rule_type", equals: "duration" }, { key: "duration_condition", equals: "equals" }], requiredWhen: [{ key: "rule_type", equals: "duration" }, { key: "duration_condition", equals: "equals" }] },
  { key: "duration_operator", label: "Condition", type: "select", default: ">=", options: [[">=", "Greater than or equal"], [">", "Greater than"], ["<=", "Less than or equal"], ["<", "Less than"], ["==", "Equal"], ["!=", "Not equal"]], showWhen: [{ key: "rule_type", equals: "duration" }, { key: "duration_condition", equals: "threshold" }] },
  { key: "duration_threshold", label: "Threshold value", type: "number", required: true, showWhen: [{ key: "rule_type", equals: "duration" }, { key: "duration_condition", equals: "threshold" }] },
  { key: "severity", label: "Severity", type: "select", required: true, default: "warning", options: [["warning", "Warning"], ["alert", "Alert"]] },
  { key: "is_enabled", label: "Template status", type: "select", required: true, default: "true", options: [["true", "Available"], ["false", "Disabled"]] },
  { key: "evaluation_interval_seconds", label: "Evaluation interval (seconds)", type: "number" },
  { key: "stale_after_seconds", label: "Stale reading timeout (seconds)", type: "number" },
];

const displayType = (type) =>
  RULE_TYPES.find(([value]) => value === type)?.[1] || type?.replaceAll("_", " ") || "Monitoring rule";

function initialTemplate(template) {
  if (!template) return {};
  const params = template.parameters || {};
  const required = template.required_variable_types || [];
  const variableType = required.length === 2 && required.includes("number") && required.includes("integer")
    ? "number"
    : required[0] || "number";
  return {
    ...template,
    variable_type: variableType,
    warning_1: params.warning_thresholds?.[0],
    warning_2: params.warning_thresholds?.[1],
    alert_threshold: params.alert_threshold,
    duration_seconds: template.rule_type === "duration" ? params.duration_seconds : undefined,
    runtime_duration_seconds: template.rule_type === "runtime_duration" ? params.duration_seconds : undefined,
    duration_condition: params.condition || "equals",
    expected_value: params.expected_value,
    duration_operator: params.operator || ">=",
    duration_threshold: params.threshold,
    is_enabled: String(template.is_enabled),
  };
}

function templatePayload(values) {
  const type = values.rule_type;
  let required_variable_types = null;
  let parameters = null;
  let operator = null;
  let threshold = null;
  if (type === "parameter_threshold") {
    required_variable_types = values.variable_type === "integer"
      ? ["integer"]
      : ["number", "integer"];
    operator = values.operator;
    threshold = values.threshold;
  } else if (type === "boolean_count_threshold") {
    required_variable_types = ["boolean"];
    parameters = {
      warning_thresholds: [Number(values.warning_1), Number(values.warning_2)],
      alert_threshold: Number(values.alert_threshold),
    };
  } else if (type === "runtime_duration") {
    required_variable_types = ["boolean"];
    parameters = {
      warning_thresholds_seconds: [
        Number(values.runtime_warning_hours) * 3600,
        Number(values.runtime_warning_2_hours) * 3600,
      ],
      alert_threshold_seconds: Number(values.runtime_alert_hours) * 3600,
    };
  } else if (type === "duration") {
    required_variable_types = [values.variable_type];
    parameters = {
      duration_seconds: Number(values.duration_seconds),
      condition: values.duration_condition,
      ...(values.duration_condition === "equals"
        ? {
            expected_value: values.variable_type === "boolean"
              ? values.expected_value === "true"
              : ["number", "integer"].includes(values.variable_type)
                ? Number(values.expected_value)
                : values.expected_value,
          }
        : {
            operator: values.duration_operator,
            threshold: Number(values.duration_threshold),
          }),
    };
  } else if (type === "runtime_duration") {
    parameters = { duration_seconds: Number(values.runtime_duration_seconds) };
  }
  return {
    name: values.name,
    description: values.description || null,
    rule_type: type,
    required_variable_types,
    variable_key: values.variable_key || null,
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
      setError(err.message || "Could not assign this template.");
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
        {review && <p className="rule-library-review" role="status">Assign this template to {selected.size} selected asset(s)? Each new asset rule will be created inactive.</p>}
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
    const payload = templatePayload(values);
    if (editing) await api.put(`/rule-templates/${editing.id}`, payload);
    else await api.post("/rule-templates", payload);
    setModalOpen(false);
    setEditing(null);
    setMessage({ text: `Rule template ${editing ? "updated" : "created"} successfully.`, error: false });
    await load();
  };

  const remove = async (template) => {
    if (!window.confirm(`Delete the reusable template “${template.name}”? Assigned asset rules will not be changed.`)) return;
    setBusyId(template.id);
    setMessage({ text: "", error: false });
    try {
      await api.del(`/rule-templates/${template.id}`);
      setMessage({ text: "Template deleted.", error: false });
      await load();
    } catch (error) {
      setMessage({ text: error.message || "Could not delete this template.", error: true });
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
          <p className="muted">Reusable rule templates are independent of asset rules. Assignments create separate, inactive rules on selected assets.</p>
        </div>
        <button className="btn-primary" onClick={() => { setEditing(null); setModalOpen(true); }}><Plus size={17} /> New template</button>
      </div>

      {message.text && <p className={"notice" + (message.error ? " error" : "")} role={message.error ? "alert" : "status"}>{message.text}</p>}

      <section className="rule-library-panel">
        <div className="rule-library-tools">
          <label className="rule-library-search"><Search size={17} /><input aria-label="Search rule templates" placeholder="Search templates…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <select aria-label="Filter template availability" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All templates</option>
            <option value="true">Available</option>
            <option value="false">Disabled</option>
          </select>
        </div>
        {templates === null ? <div className="loading" role="status">Loading rule templates…</div> : visible.length === 0 ? (
          <EmptyState art={false} title={templates.length === 0 ? "The rule library is empty" : "No templates match"} lines={[templates.length === 0 ? "Create a reusable template here. Asset-specific rules do not appear in this library." : "Try a different search or availability filter."]} />
        ) : (
          <div className="rule-library-list">
            {visible.map((template) => (
              <article className="rule-library-card" key={template.id}>
                <div className="rule-library-card-icon"><Activity size={19} /></div>
                <div className="rule-library-card-main">
                  <div className="rule-library-card-title"><h2>{template.name}</h2><span className={`rule-library-status ${template.is_enabled ? "available" : "disabled"}`}>{template.is_enabled ? "Available" : "Disabled"}</span></div>
                  <p>{template.description || "No description provided."}</p>
                  <small>{displayType(template.rule_type)}{template.required_variable_types?.length ? ` · Requires ${template.required_variable_types.join(" / ")} variable${template.variable_key ? ` · Prefers ${template.variable_key}` : ""}` : " · Asset-level configuration"}</small>
                </div>
                <div className="rule-library-actions">
                  <button className="btn-outline" onClick={() => setAssigning(template)} disabled={!template.is_enabled}><Copy size={15} /> Assign</button>
                  <button className="btn-outline" onClick={() => { setEditing(template); setModalOpen(true); }}><Pencil size={15} /> Edit</button>
                  <button className="btn-outline danger" onClick={() => remove(template)} disabled={busyId === template.id}>{busyId === template.id ? "Deleting…" : <><Trash2 size={15} /> Delete</>}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {modalOpen && <CreateModal
        title={editing ? "Edit reusable rule template" : "Create reusable rule template"}
        intro="Templates contain rule configuration only. Asset and variable references are selected when assigning the template."
        fields={FIELDS}
        initialValues={initialTemplate(editing)}
        submitLabel={editing ? "Save template" : "Create template"}
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
