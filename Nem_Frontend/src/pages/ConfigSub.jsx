import React from "react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { CreateModal, EmptyState } from "../components/UI.jsx";
import { BackIcon, PlusCircle } from "../components/Icons.jsx";

const DOC_TYPES = [["Instruction", "Instruction"], ["Manual", "Manual"], ["Checklist", "Checklist"], ["Other", "Other"]];


const CRUD = {
  rules: {
    title: "Monitoring Rules", endpoint: "rules", button: "Create rule", noun: "Rule",
    cols: [["name", "Name"], ["description", "Description"], ["asset_name", "Machine"], ["severity", "Severity"], ["state", "State"]],
  },
  collections: {
    title: "Monitoring Rule collections", endpoint: "collections", button: "Create collection", noun: "Collection",
    cols: [["name", "Name"], ["description", "Description"]],
  },
  documents: {
    title: "Instructions and documents", endpoint: "documents", button: "Create document", noun: "Document",
    cols: [["title", "Title"], ["kind", "Type"], ["description", "Description"]],
  },
};


function fieldsFor(sub, variables) {
  if (sub === "rules")
    return [
      { key: "name", label: "Rule name", required: true, placeholder: "e.g. Motor temperature limit" },
      { key: "description", label: "Description", type: "textarea", placeholder: "What should this rule watch?" },
      { key: "variable_id", label: "Numeric variable", type: "select", required: true,
        options: variables.map((variable) => [variable.id, `${variable.asset_name} · ${variable.name}`]) },
      { key: "operator", label: "Condition", type: "select",
        options: [[">=", "Greater than or equal"], [">", "Greater than"], ["<=", "Less than or equal"], ["<", "Less than"], ["==", "Equal"], ["!=", "Not equal"]], default: ">=" },
      { key: "threshold", label: "Threshold", type: "number", required: true },
      { key: "severity", label: "Severity", type: "select",
        options: [["warning", "Warning"], ["alert", "Alert"]], default: "warning" },
    ];
  if (sub === "collections")
    return [
      { key: "name", label: "Collection name", required: true, placeholder: "e.g. Mixer machines" },
      { key: "description", label: "Description", type: "textarea" },
    ];
  return [
    { key: "title", label: "Title", required: true, placeholder: "e.g. Mixer inspection steps" },
    { key: "kind", label: "Type", type: "select", options: DOC_TYPES, default: "Instruction" },
    { key: "description", label: "Description", type: "textarea" },
  ];
}

function cell(key, value) {
  if (value === undefined || value === null || value === "") return <span className="muted">-</span>;
  if (key === "severity") return <span className={"badge " + value}>{value}</span>;
  if (key === "state") return String(value).replace("_", " ");
  return value;
}

function ImportPage() {
  const [msg, setMsg] = useState("");
  const onFile = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const res = await api.post("/import", data);
      setMsg(`Imported ${res.rules} rule(s) and ${res.collections} collection(s).`);
    } catch (error) {
      setMsg(`Import failed: ${error.message || "Check the JSON structure and rule targets."}`);
    }
  };
  return (
    <div className="panel-white">
      <p className="muted">Select a JSON file containing monitoring rules and rule collections.</p>
      <input type="file" accept=".json,application/json" onChange={onFile} />
      {msg && <p className="notice">{msg}</p>}
    </div>
  );
}

export default function ConfigSub() {
  const { sub } = useParams();
  const nav = useNavigate();
  const cfg = CRUD[sub];
  const [rows, setRows] = useState([]);
  const [variables, setVariables] = useState([]);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    if (!cfg) return;
    if (sub === "rules") {
      const [rules, currentAssets, statuses] = await Promise.all([
        api.get("/rules?limit=200"),
        api.get("/assets?limit=200"),
        api.get("/monitoring/status?limit=500"),
      ]);
      const assetNames = new Map(currentAssets.map((asset) => [asset.id, asset.name]));
      const stateByRule = new Map(statuses.map((state) => [state.rule_id, state.status]));
      setRows(rules.map((rule) => ({
        ...rule,
        asset_name: assetNames.get(rule.target_asset_id) || "—",
        state: rule.is_enabled ? "activated" : "not_activated",
        status: stateByRule.get(rule.id) === "normal" ? "ok" : stateByRule.get(rule.id) || "unknown",
      })));
      return;
    }
    setRows(await api.get(`/${cfg.endpoint}`));
  }, [cfg, sub]);

  useEffect(() => {
    setOpen(false); setMsg(""); setRows([]);
    load().catch((error) => setMsg(error.message));
    if (sub === "rules") {
      api.get("/assets?limit=200").then(async (items) => {
        const perAsset = await Promise.all(items.map((asset) => api.get(`/assets/${asset.id}/variables?is_active=true&limit=200`)));
        setVariables(perAsset.flat().filter((variable) => ["integer", "number"].includes(variable.data_type))
          .map((variable) => ({ ...variable, asset_name: items.find((asset) => asset.id === variable.asset_id)?.name || `Asset ${variable.asset_id}` })));
      }).catch((error) => setMsg(error.message));
    }
  }, [sub, load]);

  const create = async (values) => {
    if (sub === "rules") {
      const variable = variables.find((item) => item.id === Number(values.variable_id));
      if (!variable) throw new Error("Select an active numeric variable.");
      const threshold = Number(values.threshold);
      if (!Number.isFinite(threshold)) throw new Error("Enter a valid numeric threshold.");
      await api.post("/rules", {
        name: values.name,
        description: values.description || null,
        target_asset_id: variable.asset_id,
        variable_id: variable.id,
        rule_type: "parameter_threshold",
        operator: values.operator,
        threshold,
        severity: values.severity,
      });
    } else {
      await api.post(`/${cfg.endpoint}`, values);
    }
    setOpen(false);
    setMsg(`${cfg.noun} created.`);
    await load();
  };

  const remove = async (r) => {
    if (!window.confirm("Delete this item?")) return;
    await api.del(`/${cfg.endpoint}/${r.id}`);
    setMsg("");
    load();
  };

  return (
    <div>
      <button className="link-btn" onClick={() => nav("/configuration")}><BackIcon size={14} /> Back</button>
      <div className="page-head">
        <h1>{cfg ? cfg.title : "Import configuration"}</h1>
        {cfg && <button className="btn-primary" onClick={() => setOpen(true)}><PlusCircle size={18} /> {cfg.button}</button>}
      </div>

      {!cfg ? <ImportPage /> : (
        <div className="panel-white">
          {msg && <p className="notice flush">{msg}</p>}
          {rows.length === 0 ? (
            <EmptyState title="Nothing here yet" lines={[`Press "${cfg.button}" to add the first one.`]} />
          ) : (
            <table className="table">
              <thead><tr>{cfg.cols.map(([, l]) => <th key={l}>{l}</th>)}<th /></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  {cfg.cols.map(([k]) => <td key={k}>{cell(k, r[k])}</td>)}
                  <td className="right"><button className="btn-danger" onClick={() => remove(r)}>Delete</button></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}

      {open && cfg && (
        <CreateModal title={cfg.button} submitLabel={cfg.button} fields={fieldsFor(sub, variables)} onSubmit={create} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}