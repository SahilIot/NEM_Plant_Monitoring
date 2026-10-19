import React, { useCallback, useEffect, useRef, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { api } from "../api.js";
import { REFRESH_MS } from "../config.js";
import { conditionText, formatDuration, formatTime, formatValue, timeAgo } from "../format.js";
import { CreateModal, EmptyState, Modal, StatusBadge } from "../components/UI.jsx";
import {
  GearIcon,
  AssetIcon,
  ExternalIcon,
  FilterIcon,
  RefreshIcon,
  PlusCircle,
  DotsIcon,
  ChevronDown,
} from "../components/Icons.jsx";

const ORDER = { alert: 0, warning: 1, ok: 2 };
const HEALTH_LABEL = { alert: "Alert active", warning: "Warning active", ok: "No active alerts", off: "Disabled" };

const ruleFields = (variables) => [
  { key: "name", label: "Rule name", required: true, placeholder: "e.g. Motor temperature limit" },
  { key: "description", label: "Description", type: "textarea", placeholder: "What should this rule watch?" },
  {
    key: "variable_id",
    label: "Numeric variable",
    type: "select",
    required: true,
    options: variables.map((v) => [v.id, `${v.name}${v.unit ? ` (${v.unit})` : ""}`]),
  },
  {
    key: "operator",
    label: "Trigger when value is",
    type: "select",
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
  { key: "threshold", label: "Threshold", type: "number", required: true, placeholder: "e.g. 900" },
  {
    key: "severity",
    label: "Severity",
    type: "select",
    default: "warning",
    options: [["warning", "Warning"], ["alert", "Alert"]],
  },
];

const LOG_FIELDS = [
  { key: "text", label: "Entry", type: "textarea", required: true, placeholder: "What was done or noticed?" },
];

const VARIABLE_FIELDS = [
  { key: "name", label: "Name", required: true, placeholder: "e.g. Rotation count" },
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
  { key: "unit", label: "Unit", placeholder: "e.g. °C, rpm, cycles" },
  {
    key: "node_id",
    label: "PLC OPC UA Node ID",
    placeholder: "e.g. ns=3;s=Machine.CycleCount",
    hint: "Enter the actual Node ID from your PLC's OPC UA server.",
  },
];

export default function AssetDetail() {
  const { id } = useParams();
  const { assets, assetsLoaded, reload, refreshStatus } = useOutletContext();
  const assetId = Number(id);
  const asset = assets.find((a) => a.id === assetId);

  const [tab, setTab] = useState("status");
  const [list, setList] = useState("activated");
  const [rules, setRules] = useState([]);
  const [variables, setVariables] = useState([]);
  const [readings, setReadings] = useState([]);
  const [ruleStates, setRuleStates] = useState(new Map());
  const [varNames, setVarNames] = useState(new Map());
  const [machine, setMachine] = useState(null);
  const [children, setChildren] = useState(false);
  const [sort, setSort] = useState("severity");
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const [menu, setMenu] = useState(false);
  const [sortMenu, setSortMenu] = useState(false);
  const [modal, setModal] = useState(null);
  const [logs, setLogs] = useState([]);
  const [events, setEvents] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [, setTick] = useState(0);
  const seq = useRef(0);

  
  const loadLive = useCallback(async () => {
    const mine = ++seq.current;
    const [r, rd, st, plc] = await Promise.allSettled([
      api.get(`/assets/${assetId}/rules?include_children=${children}`),
      api.get(`/readings/assets/${assetId}/latest`),
      api.getAll("/monitoring/status", 500),
      api.get("/plc/status"),
    ]);
    if (mine !== seq.current) return; // the user already moved to another asset
    if (r.status === "fulfilled") {
      setRules(Array.isArray(r.value) ? r.value : []);
      setLoadError("");
    } else {
      setRules([]);
      setLoadError(r.reason.message);
    }
    if (rd.status === "fulfilled") setReadings(Array.isArray(rd.value) ? rd.value : []);
    if (st.status === "fulfilled") setRuleStates(new Map(st.value.map((s) => [s.rule_id, s])));
    if (plc.status === "fulfilled") {
      setMachine(plc.value?.machines?.find((m) => m.asset_id === assetId) || null);
    } else {
      setMachine(null);
    }
  }, [assetId, children]);

  const loadVariables = useCallback(async () => {
    try {
      const items = await api.getAll(`/assets/${assetId}/variables?is_active=true`);
      setVariables(items);
      setVarNames((prev) => {
        const next = new Map(prev);
        items.forEach((v) => next.set(v.id, v.name));
        return next;
      });
    } catch {
      setVariables([]);
    }
  }, [assetId]);

  const loadLogs = useCallback(() => {
    api
      .get(`/assets/${assetId}/logbook`)
      .then((items) => setLogs(Array.isArray(items) ? items : []))
      .catch((error) => setLoadError(error.message));
  }, [assetId]);

  useEffect(() => {
    setTab("status");
    setList("activated");
    setFilter("");
    setReadings([]);
    setMachine(null);
    setLogs([]);
    setEvents([]);
    loadVariables();
    loadLogs();
  }, [assetId, loadVariables, loadLogs]);

  useEffect(() => {
    loadLive();
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        loadLive();
        setTick((n) => n + 1);
      }
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadLive]);

  useEffect(() => {
    if (tab !== "events") return;
    api
      .get(`/assets/${assetId}/events`)
      .then((items) => setEvents(Array.isArray(items) ? items : []))
      .catch((error) => setLoadError(error.message));
  }, [tab, assetId]);


  useEffect(() => {
    const missing = [...new Set(rules.map((r) => r.variable_id).filter((v) => v != null && !varNames.has(v)))];
    if (!missing.length) return;
    Promise.allSettled(missing.map((vid) => api.get(`/variables/${vid}`))).then((results) => {
      setVarNames((prev) => {
        const next = new Map(prev);
        results.forEach((res, i) => {
          next.set(missing[i], res.status === "fulfilled" ? res.value.name : "Value");
        });
        return next;
      });
    });
  }, [rules, varNames]);

  const numericVariables = variables.filter((v) => ["integer", "number"].includes(v.data_type));
  const readingByVariable = new Map(readings.map((r) => [r.variable_id, r]));

  const isAct = (rule) => rule.state === "activated";
  const nAct = rules.filter(isAct).length;
  const nNot = rules.length - nAct;

  let shown = rules
    .filter((rule) => (list === "activated" ? isAct(rule) : !isAct(rule)))
    .filter((rule) => (rule.name || "").toLowerCase().includes(filter.toLowerCase()));
  shown = [...shown].sort((a, b) =>
    sort === "name"
      ? (a.name || "").localeCompare(b.name || "")
      : (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3)
  );

  const refreshAll = async () => {
    await Promise.all([loadLive(), refreshStatus?.()]);
  };

  const setState = async (rule, state) => {
    try {
      await api.patch(`/rules/${rule.id}`, { is_enabled: state === "activated" });
      await refreshAll();
    } catch (error) {
      setLoadError(error.message);
    }
  };

  const remove = async (rule) => {
    if (!window.confirm(`Delete the rule “${rule.name}”?`)) return;
    try {
      await api.del(`/rules/${rule.id}`);
      await refreshAll();
    } catch (error) {
      setLoadError(error.message);
    }
  };

  const addRule = async (values) => {
    if (!numericVariables.length) {
      throw new Error("Add an active numeric variable to this asset before creating a threshold rule.");
    }
    const threshold = Number(values.threshold);
    if (!Number.isFinite(threshold)) throw new Error("Enter a valid numeric threshold.");
    await api.post(`/assets/${assetId}/rules`, {
      name: values.name.trim(),
      description: values.description?.trim() || null,
      target_asset_id: assetId,
      variable_id: Number(values.variable_id),
      rule_type: "parameter_threshold",
      operator: values.operator,
      threshold,
      severity: values.severity,
    });
    setModal(null);
    setList("activated");
    await refreshAll();
  };

  const bulk = async (state) => {
    try {
      await api.post(`/assets/${assetId}/rules/bulk`, { state });
      setMenu(false);
      await refreshAll();
    } catch (error) {
      setLoadError(error.message);
    }
  };

  const addLog = async (values) => {
    if (!values.text?.trim()) throw new Error("Enter a logbook entry.");
    await api.post(`/assets/${assetId}/logbook`, { text: values.text.trim() });
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
    node_id: values.node_id?.trim() || null,
  });

  setModal("variables");
  await loadVariables();
};

  if (!asset) {
    return assetsLoaded
      ? <div className="panel"><EmptyState title="This asset was not found" lines={["It may have been removed. Pick another asset from the panel."]} /></div>
      : <div className="loading" role="status">Loading…</div>;
  }

  const health = asset.health || "ok";

  return (
    <div className="asset-page">
      {loadError && (
        <div className="banner error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn-outline" onClick={() => { setLoadError(""); refreshAll(); }}>
            Dismiss and retry
          </button>
        </div>
      )}

      <div className="asset-head">
        <div>
          <h1 className="page-title">{asset.name}</h1>
          <div className="asset-sub">
            <span className={"health-chip " + health}><i className={"lamp " + health} />{HEALTH_LABEL[health]}</span>
            <span className="muted">{asset.asset_type}</span>
            {asset.description && <span className="muted">{asset.description}</span>}
          </div>
        </div>

        <div className="asset-links">
          <button className="link-btn" onClick={() => setModal("settings")}><GearIcon size={17} /> Asset settings</button>
          <button className="link-btn" onClick={() => setModal("variables")}><AssetIcon size={17} /> Variables</button>
          <button className="icon-outline" title="Open in new tab" aria-label="Open in new tab" onClick={() => window.open(window.location.href, "_blank")}>
            <ExternalIcon size={18} />
          </button>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {[["status", "Current status"], ["logbook", "Maintenance logbook"], ["events", "Event log"]].map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "status" && (
        <>
          {machine && (
            <section className="machine-strip" aria-label="Machine runtime">
              <div className={"machine-state " + machine.status}>
                <i className={"lamp " + (machine.status === "running" ? "ok" : machine.status === "stopped" ? "off" : "warning")} />
                <span className="cap">{machine.status}</span>
                {machine.stale && <em>stale data</em>}
              </div>
              <div className="machine-fig">
                <span>Cycles</span>
                <b>{machine.cycle_count}{machine.cycle_limit ? <small> / {machine.cycle_limit}</small> : null}</b>
              </div>
              <div className="machine-fig">
                <span>Rotation direction</span>
                <b>
                  {["clockwise", "cw"].includes(
                    String(machine.rotation_direction || "").toLowerCase()
                  )
                  ? "↻ Clockwise"
                  : ["counterclockwise", "counter-clockwise", "ccw"].includes(
                    String(machine.rotation_direction || "").toLowerCase()
                  )
                  ? "↺ Counterclockwise"
                  : "Unknown"}
                  </b>
                  </div>
              <div className="machine-fig">
                <span>Running time</span>
                <b>
                  {formatDuration(machine.running_seconds)}
                  {machine.runtime_limit_seconds ? <small> / {formatDuration(machine.runtime_limit_seconds)}</small> : null}
                </b>
              </div>
              <div className="machine-fig">
                <span>Last signal</span>
                <b className="plain">{machine.last_seen_at ? timeAgo(machine.last_seen_at) : "Not received"}</b>
              </div>
            </section>
          )}

          <section className="panel values-panel">
            <div className="panel-head">
              <h2>Live values</h2>
              <span className="muted">Latest reading for each active variable</span>
            </div>
            {variables.length === 0 ? (
              <p className="muted">
                No variables are configured yet.{" "}
                <button className="link-btn inline" onClick={() => setModal("variables")}>Add a variable</button> to start recording readings.
              </p>
            ) : (
              <div className="values-grid">
                {variables.map((variable) => {
                  const reading = readingByVariable.get(variable.id);
                  return (
                    <div className={"value-cell" + (reading ? "" : " no-data")} key={variable.id}>
                      <span className="value-name">{variable.name}</span>
                      <span className="value-num">
                        {reading ? formatValue(reading.value) : "No data"}
                        {reading && variable.unit ? <small>{variable.unit}</small> : null}
                      </span>
                      <span className="value-age" title={reading ? new Date(reading.recorded_at).toLocaleString() : ""}>
                        {reading ? timeAgo(reading.recorded_at) : "Waiting for first reading"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <div className="toolbar">
            <button className={"icon-outline sm" + (showFilter ? " on" : "")} onClick={() => setShowFilter(!showFilter)} title="Filter rules" aria-label="Filter rules">
              <FilterIcon size={17} />
            </button>
            {showFilter && (
              <input className="mini-input" placeholder="Filter rules" aria-label="Filter rules" value={filter} onChange={(e) => setFilter(e.target.value)} />
            )}

            <div className="segment">
              <button className={list === "activated" ? "active" : ""} onClick={() => setList("activated")}>
                Activated <span>({nAct})</span>
              </button>
              <button className={list === "not_activated" ? "active" : ""} onClick={() => setList("not_activated")}>
                Not activated <span>({nNot})</span>
              </button>
            </div>

            <button className="icon-outline sm" onClick={refreshAll} title="Refresh" aria-label="Refresh">
              <RefreshIcon size={17} />
            </button>

            <label className="switch-label">
              <input type="checkbox" className="sr-only" checked={children} onChange={() => setChildren(!children)} />
              <span className={"switch" + (children ? " on" : "")} aria-hidden="true"><i /></span>
              Include child assets
            </label>

            <div className="spacer" />

            <div className="dropdown">
              <button className="link-btn" onClick={() => setSortMenu(!sortMenu)} aria-haspopup="menu" aria-expanded={sortMenu}>
                Sort by {sort === "name" ? "name" : "severity"} <ChevronDown size={14} />
              </button>
              {sortMenu && (
                <div className="menu" role="menu">
                  <div role="menuitem" onClick={() => { setSort("severity"); setSortMenu(false); }}>Severity</div>
                  <div role="menuitem" onClick={() => { setSort("name"); setSortMenu(false); }}>Name</div>
                </div>
              )}
            </div>

            <button className="btn-primary" onClick={() => setModal("add")}>
              <PlusCircle size={17} /> Add rule
            </button>

            <div className="dropdown">
              <button className="icon-outline sm" onClick={() => setMenu(!menu)} title="Rule actions" aria-label="Rule actions" aria-haspopup="menu" aria-expanded={menu}>
                <DotsIcon size={17} />
              </button>
              {menu && (
                <div className="menu right" role="menu">
                  <div role="menuitem" onClick={() => bulk("activated")}>Activate all rules</div>
                  <div role="menuitem" onClick={() => bulk("not_activated")}>Deactivate all rules</div>
                </div>
              )}
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="panel">
              <EmptyState
                art={false}
                title={list === "activated" ? "No activated rules" : "No rules are switched off"}
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
                const condition = conditionText(rule, varNames.get(rule.variable_id));
                return (
                  <div key={rule.id} className="rule-row">
                    <span className={"sev " + rule.status} />
                    <div className="rule-name">
                      {rule.name}
                      <small>
                        {condition || rule.rule_type.replace("_", " ")}
                        {rule.asset_id !== assetId && rule.asset_name ? `, on ${rule.asset_name}` : ""}
                      </small>
                      {rule.description && <small>{rule.description}</small>}
                    </div>
                    {isAct(rule) && state && state.latest_value !== null && state.latest_value !== undefined && (
                      <span className="rule-now" title={state.message}>
                        Now <b>{formatValue(state.latest_value)}</b>
                      </span>
                    )}
                    <StatusBadge status={rule.status} />
                    {isAct(rule) ? (
                      <button className="btn-outline" onClick={() => setState(rule, "not_activated")}>Deactivate</button>
                    ) : (
                      <button className="btn-outline" onClick={() => setState(rule, "activated")}>Activate</button>
                    )}
                    <button className="btn-danger" onClick={() => remove(rule)}>Delete</button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "logbook" && (
        <div className="panel">
          <div className="panel-head">
            <span className="muted">{logs.length} {logs.length === 1 ? "entry" : "entries"}</span>
            <button className="btn-primary" onClick={() => setModal("log")}><PlusCircle size={17} /> Add entry</button>
          </div>
          {logs.length === 0 ? (
            <EmptyState art={false} title="No logbook entries" lines={["Record inspections, repairs and observations here."]} />
          ) : (
            <table className="table">
              <thead><tr><th className="col-time">Time</th><th>Entry</th></tr></thead>
              <tbody>
                {logs.map((entry) => (
                  <tr key={entry.id}><td className="col-time">{formatTime(entry.time)}</td><td>{entry.text}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "events" && (
        <div className="panel">
          {events.length === 0 ? (
            <EmptyState art={false} title="No events yet" lines={["Alerts, acknowledgements and rule changes for this asset are recorded here."]} />
          ) : (
            <table className="table">
              <thead><tr><th className="col-time">Time</th><th>Event</th></tr></thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}><td className="col-time">{formatTime(event.time)}</td><td>{event.text}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {modal === "add" && (
        <CreateModal
          title="Add rule"
          submitLabel="Add rule"
          intro={numericVariables.length ? undefined : "This asset has no numeric variables yet. Add one under Variables, then come back to create a threshold rule."}
          fields={ruleFields(numericVariables)}
          onSubmit={addRule}
          onClose={() => setModal(null)}
        />
      )}

      {modal === "log" && (
        <CreateModal title="New logbook entry" submitLabel="Add entry" fields={LOG_FIELDS} onSubmit={addLog} onClose={() => setModal(null)} />
      )}

      {modal === "settings" && (
        <CreateModal
          title="Asset settings"
          submitLabel="Save changes"
          onSubmit={saveAsset}
          onClose={() => setModal(null)}
          fields={[
            { key: "name", label: "Name", required: true, default: asset.name },
            { key: "asset_type", label: "Type", required: true, default: asset.asset_type },
            { key: "description", label: "Description", type: "textarea", default: asset.description || "" },
            {
              key: "is_active",
              label: "Monitoring",
              type: "select",
              default: String(asset.is_active),
              options: [["true", "Enabled"], ["false", "Disabled"]],
              hint: "Disabled assets stay in the hierarchy but are greyed out.",
            },
          ]}
        />
      )}

      {modal === "addVariable" && (
        <CreateModal title="Add variable" submitLabel="Add variable" fields={VARIABLE_FIELDS} onSubmit={addVariable} onClose={() => setModal("variables")} />
      )}

      {modal === "variables" && (
        <Modal title="Variables" onClose={() => setModal(null)}>
          {variables.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Key</th>
                  <th>Type</th>
                  <th>Unit</th>
                  <th>PLC Node ID</th>
                  </tr>
                  </thead>
              <tbody>
                {variables.map((variable) => (
                  <tr key={variable.id}>
                    <td>{variable.name}</td>
                    <td>{variable.key}</td>
                    <td>{variable.data_type}</td>
                    <td>{variable.unit || "—"}</td>
                    <td>{variable.node_id || "Not configured"}</td>
                    </tr>
                  ))}
                  </tbody>
            </table>
          ) : (
            <p className="muted">No active variables are configured for this asset.</p>
          )}
          <div className="modal-actions">
            <button className="btn-outline" onClick={() => setModal("addVariable")}>Add variable</button>
            <button className="btn-primary" onClick={() => setModal(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
