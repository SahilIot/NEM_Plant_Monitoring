import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import { conditionText } from "../../../utils/format.js";
import { CreateModal, EmptyState } from "../../../components/common/UI.jsx";
import { BackIcon, PlusCircle } from "../../../components/common/Icons.jsx";

const DOC_TYPES = [["Instruction", "Instruction"], ["Manual", "Manual"], ["Checklist", "Checklist"], ["Other", "Other"]];

const CRUD = {
  rules: {
    title: "Monitoring rules", endpoint: "rules", button: "Create rule", noun: "Rule",
    cols: [["name", "Name"], ["asset_name", "Machine"], ["condition", "Condition"], ["severity", "Severity"], ["state", "State"]],
  },
  collections: {
    title: "Rule collections", endpoint: "collections", button: "Create collection", noun: "Collection",
    cols: [["name", "Name"], ["description", "Description"]],
  },
  documents: {
    title: "Instructions and documents", endpoint: "documents", button: "Create document", noun: "Document",
    cols: [["title", "Title"], ["kind", "Type"], ["description", "Description"], ["files", "Attachments"]],
  },
};

function fieldsFor(sub, variables) {
  if (sub === "rules") {
    return [
      { key: "name", label: "Rule name", required: true, placeholder: "e.g. Motor temperature limit" },
      { key: "description", label: "Description", type: "textarea", placeholder: "What should this rule watch?" },
      {
        key: "variable_id", label: "Numeric variable", type: "select", required: true,
        options: variables.map((v) => [v.id, `${v.asset_name}: ${v.name}`]),
      },
      {
        key: "operator", label: "Trigger when value is", type: "select", default: ">=",
        options: [[">=", "Greater than or equal to"], [">", "Greater than"], ["<=", "Less than or equal to"], ["<", "Less than"], ["==", "Equal to"], ["!=", "Not equal to"]],
      },
      { key: "threshold", label: "Threshold", type: "number", required: true },
      { key: "severity", label: "Severity", type: "select", default: "warning", options: [["warning", "Warning"], ["alert", "Alert"]] },
    ];
  }
  if (sub === "collections") {
    return [
      { key: "name", label: "Collection name", required: true, placeholder: "e.g. Mixer machines" },
      { key: "description", label: "Description", type: "textarea" },
    ];
  }
  return [
    { key: "title", label: "Title", required: true, placeholder: "e.g. Mixer inspection steps" },
    { key: "kind", label: "Type", type: "select", options: DOC_TYPES, default: "Instruction" },
    { key: "description", label: "Description", type: "textarea" },
    { key: "files", label: "Attach files (optional)", type: "files", hint: "PDF, DOC, DOCX or TXT. Up to 10 files; 10 MB each." },
  ];
}

function cell(key, row, variableNames) {
  if (key === "condition") {
    const text = conditionText(row, variableNames.get(row.variable_id));
    return text || <span className="muted">-</span>;
  }
  if (key === "files") {
    const files = row.files || [];
    if (!files.length) return <span className="muted">No files</span>;
    return <span>{files.map((file, i) => <React.Fragment key={file.id}>{i > 0 ? ", " : ""}<a href={file.download_url} target="_blank" rel="noreferrer">{file.name}</a></React.Fragment>)}</span>;
  }
  const value = row[key];
  if (value === undefined || value === null || value === "") return <span className="muted">-</span>;
  if (key === "severity") return <span className={"badge " + value}>{value}</span>;
  if (key === "state") return <span className={"state-text " + value}>{String(value).replace("_", " ")}</span>;
  return value;
}

function ImportPage() {
  const [msg, setMsg] = useState({ text: "", error: false });
  const onFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const res = await api.post("/import", data);
      setMsg({ text: `Imported ${res.rules} rule(s) and ${res.collections} new collection(s).`, error: false });
    } catch (error) {
      const text = error instanceof SyntaxError ? "That file is not valid JSON." : error.message;
      setMsg({ text: `Import failed: ${text}`, error: true });
    } finally {
      e.target.value = "";
    }
  };
  return (
    <div className="panel">
      <p className="muted">
        Choose a JSON file with a <code>collections</code> list (name, description) and a <code>rules</code> list.
        Each rule needs the same fields as a rule created in the app, including its asset and variable IDs.
      </p>
      <input type="file" accept=".json,application/json" onChange={onFile} />
      {msg.text && <p className={"notice" + (msg.error ? " error" : "")} role="status">{msg.text}</p>}
    </div>
  );
}

export default function ConfigSub() {
  const { sub } = useParams();
  const nav = useNavigate();
  const cfg = CRUD[sub];
  const [rows, setRows] = useState(null);
  const [variables, setVariables] = useState([]);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState({ text: "", error: false });

  const load = useCallback(async () => {
    if (!cfg) return;
    if (sub === "rules") {
      const [rules, currentAssets, statuses] = await Promise.all([
        api.getAll("/rules"),
        api.getAll("/assets"),
        api.getAll("/monitoring/status", 500),
      ]);
      const assetNames = new Map(currentAssets.map((asset) => [asset.id, asset.name]));
      const stateByRule = new Map(statuses.map((state) => [state.rule_id, state.status]));
      setRows(
        rules.map((rule) => ({
          ...rule,
          asset_name: assetNames.get(rule.target_asset_id) || "â€”",
          state: rule.is_enabled ? "activated" : "not_activated",
          status: stateByRule.get(rule.id) === "normal" ? "ok" : stateByRule.get(rule.id) || "unknown",
        }))
      );
      return;
    }
    const items = await api.get(`/${cfg.endpoint}`);
    setRows(Array.isArray(items) ? items : []);
  }, [cfg, sub]);

  useEffect(() => {
    setOpen(false);
    setMsg({ text: "", error: false });
    setRows(null);
    load().catch((error) => {
      setRows([]);
      setMsg({ text: error.message, error: true });
    });
    if (sub === "rules") {
      api
        .getAll("/assets")
        .then(async (items) => {
          const perAsset = await Promise.all(
            items.map((asset) => api.getAll(`/assets/${asset.id}/variables?is_active=true`))
          );
          const names = new Map(items.map((asset) => [asset.id, asset.name]));
          setVariables(
            perAsset
              .flat()
              .map((variable) => ({ ...variable, asset_name: names.get(variable.asset_id) || `Asset ${variable.asset_id}` }))
          );
        })
        .catch((error) => setMsg({ text: error.message, error: true }));
    }
  }, [sub, load]);

  const numericVariables = variables.filter((variable) => ["integer", "number"].includes(variable.data_type));
  const variableNames = new Map(variables.map((variable) => [variable.id, variable.name]));

  const create = async (values) => {
    if (sub === "rules") {
      const variable = numericVariables.find((item) => item.id === Number(values.variable_id));
      if (!variable) throw new Error("Select an active numeric variable. Add one on an asset first if the list is empty.");
      const threshold = Number(values.threshold);
      if (!Number.isFinite(threshold)) throw new Error("Enter a valid numeric threshold.");
      await api.post("/rules", {
        name: values.name.trim(),
        description: values.description?.trim() || null,
        target_asset_id: variable.asset_id,
        variable_id: variable.id,
        rule_type: "parameter_threshold",
        operator: values.operator,
        threshold,
        severity: values.severity,
      });
    } else if (sub === "documents") {
      const files = values.files || [];
      if (files.length) {
        const form = new FormData();
        form.append("title", values.title);
        form.append("kind", values.kind);
        form.append("description", values.description || "");
        files.forEach((file) => form.append("files", file));
        await api.postForm("/documents/with-files", form);
      } else {
        await api.post("/documents", { title: values.title, kind: values.kind, description: values.description || null });
      }
    } else {
      await api.post(`/${cfg.endpoint}`, values);
    }
    setOpen(false);
    setMsg({ text: `${cfg.noun} created.`, error: false });
    await load();
  };

  const remove = async (row) => {
    if (!window.confirm("Delete this item?")) return;
    try {
      await api.del(`/${cfg.endpoint}/${row.id}`);
      setMsg({ text: `${cfg.noun} deleted.`, error: false });
      await load();
    } catch (error) {
      // e.g. 409: a rule that has alert history can only be disabled, not deleted.
      setMsg({ text: error.message, error: true });
    }
  };

  return (
    <div>
      <button className="link-btn" onClick={() => nav("/configuration")}><BackIcon size={14} /> Back</button>
      <div className="page-head">
        <h1 className="page-title">{cfg ? cfg.title : "Import configuration"}</h1>
        {cfg && (
          <button className="btn-primary" onClick={() => setOpen(true)}>
            <PlusCircle size={17} /> {cfg.button}
          </button>
        )}
      </div>

      {!cfg ? (
        <ImportPage />
      ) : (
        <div className="panel">
          {msg.text && <p className={"notice flush" + (msg.error ? " error" : "")} role="status">{msg.text}</p>}
          {rows === null ? (
            <div className="loading" role="status">Loadingâ€¦</div>
          ) : rows.length === 0 ? (
            <EmptyState art={false} title="Nothing here yet" lines={[`Select â€œ${cfg.button}â€ to add the first one.`]} />
          ) : (
            <table className="table">
              <thead>
                <tr>{cfg.cols.map(([, label]) => <th key={label}>{label}</th>)}<th /></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    {cfg.cols.map(([key]) => <td key={key}>{cell(key, row, variableNames)}</td>)}
                    <td className="right"><button className="btn-danger" onClick={() => remove(row)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {open && cfg && (
        <CreateModal
          title={cfg.button}
          submitLabel={cfg.button}
          intro={sub === "rules" && numericVariables.length === 0 ? "No active numeric variables exist yet. Add one from an assetâ€™s Variables panel first." : undefined}
          fields={fieldsFor(sub, numericVariables)}
          onSubmit={create}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

