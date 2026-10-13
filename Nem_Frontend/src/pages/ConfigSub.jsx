import React from "react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { CreateModal, EmptyState } from "../components/UI.jsx";
import { BackIcon, PlusCircle } from "../components/Icons.jsx";

const SEVERITY = [["warning", "Warning"], ["alert", "Alert"]];
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


function fieldsFor(sub, assets) {
  if (sub === "rules")
    return [
      { key: "name", label: "Rule name", required: true, placeholder: "e.g. Motor temperature limit" },
      { key: "description", label: "Description", type: "textarea", placeholder: "What should this rule watch?" },
      { key: "asset_id", label: "Machine", type: "select", options: [["", "- No machine yet -"], ...assets.map((a) => [a.id, a.name])] },
      { key: "severity", label: "Severity", type: "select", options: SEVERITY, default: "warning" },
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
    } catch {
      setMsg("Import failed. Use a JSON file like {\"rules\":[{\"name\":\"...\"}],\"collections\":[]}");
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
  const [assets, setAssets] = useState([]);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    if (cfg) api.get(`/${cfg.endpoint}`).then(setRows).catch(() => setRows([]));
  }, [cfg]);

  useEffect(() => {
    setOpen(false); setMsg(""); setRows([]);
    load();
    if (sub === "rules") api.get("/assets").then(setAssets).catch(() => {});
  }, [sub, load]);

 const create = async (values) => {
  const b = await api.post("/backups", values);
  setOpen(false); setMsg(`Backup ${b.name} created.`); load();
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
        <CreateModal title={cfg.button} submitLabel={cfg.button} fields={fieldsFor(sub, assets)} onSubmit={create} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}