import React from "react";
import { useCallback, useEffect, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { api } from "../api.js";
import { CreateModal, EmptyState, Modal } from "../components/UI.jsx";
import { GearIcon, AssetIcon, ExternalIcon, FilterIcon, RefreshIcon, PlusCircle, DotsIcon, ChevronDown } from "../components/Icons.jsx";

const ORDER = { alert: 0, warning: 1, ok: 2 };

const ruleFields = (variables) => [
  { key: "name", label: "Rule name", required: true, placeholder: "e.g. Motor temperature limit" },
  { key: "description", label: "Description", type: "textarea", placeholder: "What should this rule watch?" },
  { key: "variable_id", label: "Numeric variable", type: "select", required: true,
    options: variables.map((variable) => [variable.id, `${variable.name}${variable.unit ? ` (${variable.unit})` : ""}`]) },
  { key: "operator", label: "Condition", type: "select", options: [[">=", "Greater than or equal"], [">", "Greater than"], ["<=", "Less than or equal"], ["<", "Less than"], ["==", "Equal"], ["!=", "Not equal"]], default: ">=" },
  { key: "threshold", label: "Threshold", type: "number", required: true, placeholder: "e.g. 900" },
  { key: "severity", label: "Severity", type: "select", options: [["warning", "Warning"], ["alert", "Alert"]], default: "warning" },
];
const LOG_FIELDS = [{ key: "text", label: "Entry", type: "textarea", required: true, placeholder: "What was done or noticed?" }];

export default function AssetDetail() {
  const { id } = useParams();
  const { assets, reload } = useOutletContext();
  const asset = assets.find((a) => a.id === Number(id));
  const [tab, setTab] = useState("status");
  const [list, setList] = useState("activated");
  const [rules, setRules] = useState([]);
  const [variables, setVariables] = useState([]);
  const [children, setChildren] = useState(false);
  const [sort, setSort] = useState("severity");
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const [menu, setMenu] = useState(false);
  const [sortMenu, setSortMenu] = useState(false);
  const [modal, setModal] = useState(null);
  const [logs, setLogs] = useState([]);

  const load = useCallback(() => {
    api.get(`/assets/${id}/rules?include_children=${children}`).then((items) => {
      setRules(items);
      setLoadError("");
    }).catch((error) => {
      setRules([]);
      setLoadError(error.message);
    });
    api.get(`/assets/${id}/logbook`).then(setLogs).catch((error) => setLoadError(error.message));
    api.get(`/assets/${id}/variables?is_active=true&limit=200`).then((items) =>
      setVariables(items.filter((item) => ["integer", "number"].includes(item.data_type))),
    ).catch(() => setVariables([]));
  }, [id, children]);
  useEffect(load, [load]);

  const [events, setEvents] = useState([]);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (tab === "events") {
      api.get(`/assets/${id}/events`).then(setEvents).catch((error) => setLoadError(error.message));
    }
  }, [tab, id]);

  const isAct = (r) => r.state === "activated";
  const nAct = rules.filter(isAct).length;
  const nNot = rules.length - nAct;
  let shown = rules.filter((r) => (list === "activated" ? isAct(r) : !isAct(r)))
    .filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()));
  shown = [...shown].sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : ORDER[a.status] - ORDER[b.status]);

  const setState = async (r, state) => {
    await api.patch(`/rules/${r.id}`, { is_enabled: state === "activated" });
    load();
  };
  const remove = async (r) => { await api.del(`/rules/${r.id}`); load(); };
  const addRule = async (values) => {
    if (!variables.length) throw new Error("Add an active numeric variable to this asset before creating a threshold rule.");
    const threshold = Number(values.threshold);
    if (!Number.isFinite(threshold)) throw new Error("Enter a valid numeric threshold.");
    await api.post(`/assets/${id}/rules`, {
      name: values.name,
      description: values.description || null,
      target_asset_id: Number(id),
      variable_id: Number(values.variable_id),
      rule_type: "parameter_threshold",
      operator: values.operator,
      threshold,
      severity: values.severity,
    });
    setModal(null); setList("not_activated"); load();
  };
  const bulk = async (state) => { await api.post(`/assets/${id}/rules/bulk`, { state }); setMenu(false); load(); reload(); };
  const addLog = async (values) => {
    if (!values.text.trim()) return;
    await api.post(`/assets/${id}/logbook`, { text: values.text });
    setModal(null);
    load();
  };

  if (!asset) return <div className="loading">Loading…</div>;

  return (
    <div>
      {loadError && <div className="notice error">Could not load asset monitoring data: {loadError}</div>}
      <div className="asset-head">
        <h1>{asset.name}</h1>
        <div className="asset-links">
          <button className="link-btn" onClick={() => setModal("settings")}><GearIcon size={18} /> Asset settings</button>
          <button className="link-btn" onClick={() => setModal("variables")}><AssetIcon size={18} /> Variables</button>
          <button className="icon-outline" title="Open in new tab" onClick={() => window.open(window.location.href, "_blank")}><ExternalIcon size={20} /></button>
        </div>
      </div>

      <div className="tabs">
        {[["status", "Current status"], ["logbook", "Maintenance logbook"], ["events", "Event log"]].map(([k, l]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === "status" && (
        <>
          <div className="toolbar">
            <button className={"icon-outline sm" + (showFilter ? " on" : "")} onClick={() => setShowFilter(!showFilter)}><FilterIcon size={18} /></button>
            {showFilter && <input className="mini-input" placeholder="Filter rules" value={filter} onChange={(e) => setFilter(e.target.value)} />}
            <div className="segment">
              <button className={list === "activated" ? "active" : ""} onClick={() => setList("activated")}>Activated <span>({nAct})</span></button>
              <button className={list === "not_activated" ? "active" : ""} onClick={() => setList("not_activated")}>Not activated <span>({nNot})</span></button>
            </div>
            <button className="icon-outline sm" onClick={load}><RefreshIcon size={18} /></button>
            <label className="switch-label">
              <span className={"switch" + (children ? " on" : "")} onClick={() => setChildren(!children)}><i /></span>
              Child asset rules
            </label>
            <div className="spacer" />
            <div className="dropdown">
              <button className="link-btn" onClick={() => setSortMenu(!sortMenu)}>Sort: {sort === "name" ? "Name" : "Severity"} <ChevronDown size={14} /></button>
              {sortMenu && <div className="menu">
                <div onClick={() => { setSort("severity"); setSortMenu(false); }}>Severity</div>
                <div onClick={() => { setSort("name"); setSortMenu(false); }}>Name</div>
              </div>}
            </div>
            <button className="btn-primary" onClick={() => setModal("add")}><PlusCircle size={18} /> Add rule</button>
            <div className="dropdown">
              <button className="icon-outline sm" onClick={() => setMenu(!menu)}><DotsIcon size={18} /></button>
              {menu && <div className="menu right">
                <div onClick={() => bulk("activated")}>Activate all</div>
                <div onClick={() => bulk("not_activated")}>Deactivate all</div>
              </div>}
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="panel-gray">
              <EmptyState
                title={list === "activated" ? "No rules in the 'Activated' rule list" : "No rules in the 'Not activated' rule list"}
                lines={["To get started, click 'Add rule' to assign new rule to this asset.",
                  "On this parent asset you can enable 'Child asset rules' to see monitoring information of child assets."]} />
            </div>
          ) : (
            <div className="rule-list">
              {shown.map((r) => (
                <div key={r.id} className="rule-row">
                  <span className={"sev " + r.status} />
                  <div className="rule-name">{r.name}<small>{r.asset_name}</small></div>
                  <div className="rule-name">{r.name}<small>{r.asset_name}{r.description ? " · " + r.description : ""}</small></div>
                  <span className={"badge " + r.status}>{r.status}</span>
                  {isAct(r)
                    ? <button className="btn-outline" onClick={() => setState(r, "not_activated")}>Deactivate</button>
                    : <button className="btn-outline" onClick={() => setState(r, "activated")}>Activate</button>}
                  <button className="btn-danger" onClick={() => remove(r)}>Delete</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "logbook" && (
        <div className="panel-white">
          <div className="panel-head">
            <span className="muted">{logs.length} {logs.length === 1 ? "entry" : "entries"}</span>
            <button className="btn-primary" onClick={() => setModal("log")}><PlusCircle size={18} /> Add entry</button>
</div>
          {logs.length === 0 ? <EmptyState title="No logbook entries" /> :
            <table className="table"><thead><tr><th>Time</th><th>Entry</th></tr></thead>
              <tbody>{logs.map((l) => <tr key={l.id}><td>{l.time}</td><td>{l.text}</td></tr>)}</tbody></table>}
        </div>
      )}

      {tab === "events" && (
        <div className="panel-white">
          {events.length === 0 ? <EmptyState title="No events yet" /> :
            <table className="table"><thead><tr><th>Time</th><th>Event</th></tr></thead>
              <tbody>{events.map((e) => <tr key={e.id}><td>{e.time}</td><td>{e.text}</td></tr>)}</tbody></table>}
        </div>
      )}

      {modal === "add" && (
        <CreateModal title="Add rule" submitLabel="Add rule" fields={RULE_FIELDS} onSubmit={addRule} onClose={() => setModal(null)} />
        )}
        {modal === "log" && (
          <CreateModal title="New logbook entry" submitLabel="Add entry" fields={LOG_FIELDS} onSubmit={addLog} onClose={() => setModal(null)} />
          )}

      {(modal === "settings" || modal === "variables") && (
        <Modal title={modal === "settings" ? "Asset settings" : "Variables"} onClose={() => setModal(null)}>
          {modal === "settings" ? <p className="muted">{asset.name} · {asset.asset_type}{asset.description ? ` · ${asset.description}` : ""}</p> :
            variables.length ? <table className="table"><thead><tr><th>Variable</th><th>Type</th><th>Unit</th></tr></thead><tbody>
              {variables.map((variable) => <tr key={variable.id}><td>{variable.name}</td><td>{variable.data_type}</td><td>{variable.unit || "—"}</td></tr>)}
            </tbody></table> : <p className="muted">No active numeric variables are configured for threshold rules.</p>}
          <div className="modal-actions"><button className="btn-primary" onClick={() => setModal(null)}>Close</button></div>
        </Modal>
      )}
    </div>
  );
}