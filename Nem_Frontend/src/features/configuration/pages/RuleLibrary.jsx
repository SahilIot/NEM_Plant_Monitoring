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
  ["interval", "Interval"],
];

const FIELDS = [
  {
    key: "name",
    label: "Rule name",
    required: true,
    placeholder: "e.g. High motor temperature",
  },
  {
    key: "rule_type",
    label: "Rule type",
    type: "select",
    required: true,
    default: "parameter_threshold",
    options: RULE_TYPES,
  },
  {
    key: "variable_key",
    label: "Preferred variable key (optional)",
    placeholder: "e.g. motor_temperature",
    hint: "Used to suggest a mapping; it does not bind the template to an asset.",
    showWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
  },
  {
    key: "operator",
    label: "Condition",
    type: "select",
    required: true,
    default: ">=",
    options: [
      [">=", "Greater than or equal"],
      [">", "Greater than"],
      ["<=", "Less than or equal"],
      ["<", "Less than"],
      ["==", "Equal"],
      ["!=", "Not equal"],
    ],
    showWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
  },
  {
    key: "threshold",
    label: "Threshold",
    type: "number",
    required: true,
    showWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
  },
  {
    key: "start_time",
    label: "Start time",
    type: "time",
    showWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
  },
  {
    key: "end_time",
    label: "End time",
    type: "time",
    showWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
  },
  {
    key: "due_date",
    label: "Due date",
    type: "date",
    showWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
  },
  {
    key: "interval_value",
    label: "Interval",
    type: "number",
    required: true,
    showWhen: {
      key: "rule_type",
      equals: "interval",
    },
  },
  {
    key: "interval_unit",
    label: "Interval unit",
    type: "select",
    required: true,
    default: "hours",
    options: [
      ["seconds", "Seconds"],
      ["minutes", "Minutes"],
      ["hours", "Hours"],
      ["days", "Days"],
    ],
    showWhen: {
      key: "rule_type",
      equals: "interval",
    },
  },
  {
    key: "severity",
    label: "Severity",
    type: "select",
    required: true,
    default: "warning",
    options: [
      ["warning", "Warning"],
      ["alert", "Alert"],
    ],
  },
  {
    key: "is_enabled",
    label: "Rule status",
    type: "select",
    required: true,
    default: "true",
    options: [
      ["true", "Available"],
      ["false", "Disabled"],
    ],
  },
];

const displayType = (type) =>
  RULE_TYPES.find(([value]) => value === type)?.[1] || type?.replaceAll("_", " ") || "Monitoring rule";

function initialTemplate(template) {
  if (!template) return {};

  const params = template.parameters || {};

  return {
    ...template,
    start_time: params.start_time || "",
    end_time: params.end_time || "",
    due_date: params.due_date || "",
    interval_value: params.interval_value ?? "",
    interval_unit: params.interval_unit || "hours",
    is_enabled: String(template.is_enabled),
  };
}

function templatePayload(values) {
  const type = values.rule_type;

  const isThreshold = type === "parameter_threshold";
  const isInterval = type === "interval";

  return {
    name: values.name,
    description: values.description || null,
    rule_type: type,

    required_variable_types: isThreshold
      ? ["number", "integer"]
      : null,

    variable_key: isThreshold
      ? values.variable_key || null
      : null,

    operator: isThreshold ? values.operator : null,

    threshold: isThreshold
      ? Number(values.threshold)
      : null,

    parameters: isThreshold
      ? {
          start_time: values.start_time || null,
          end_time: values.end_time || null,
          due_date: values.due_date || null,
        }
      : isInterval
        ? {
            interval_value: Number(values.interval_value),
            interval_unit: values.interval_unit,
          }
        : null,

    severity: values.severity,
    is_enabled: values.is_enabled !== "false",
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
          <p className="muted">Rules are independent of assets. Assigning a rule creates a separate, inactive rule for each selected asset.</p>
        </div>
        <button className="btn-primary" onClick={() => { setEditing(null); setModalOpen(true); }}><Plus size={17} /> New Rule</button>
      </div>

      {message.text && <p className={"notice" + (message.error ? " error" : "")} role={message.error ? "alert" : "status"}>{message.text}</p>}

      <section className="rule-library-panel">
        <div className="rule-library-tools">
          <label className="rule-library-search"><Search size={17} /><input aria-label="Search rule templates" placeholder="Search templates…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <select aria-label="Filter template availability" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All Rules</option>
            <option value="true">Available</option>
            <option value="false">Disabled</option>
          </select>
        </div>
        {templates === null ? <div className="loading" role="status">Loading rules..</div> : visible.length === 0 ? (
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
        title={editing ? "Edit reusable rule template" : "Create A rule"}
        intro="Rules contain configuration only. Asset and variable references are selected when assigning the rule."
        fields={FIELDS}
        initialValues={initialTemplate(editing)}
        submitLabel={editing ? "Save template" : "Create A Rule"}
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
