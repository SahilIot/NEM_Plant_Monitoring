
import React from "react";
import { useCallback, useEffect, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { api } from "../api.js";
import { CreateModal, EmptyState, Modal } from "../components/UI.jsx";
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

// Fields used by the Add Rule form.
const ruleFields = (variables) => [
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
    key: "variable_id",
    label: "Numeric variable",
    type: "select",
    required: true,
    options: variables.map((variable) => [
      variable.id,
      `${variable.name}${variable.unit ? ` (${variable.unit})` : ""}`,
    ]),
  },
  {
    key: "operator",
    label: "Condition",
    type: "select",
    options: [
      [">=", "Greater than or equal"],
      [">", "Greater than"],
      ["<=", "Less than or equal"],
      ["<", "Less than"],
      ["==", "Equal"],
      ["!=", "Not equal"],
    ],
    default: ">=",
  },
  {
    key: "threshold",
    label: "Threshold",
    type: "number",
    required: true,
    placeholder: "e.g. 900",
  },
  {
    key: "severity",
    label: "Severity",
    type: "select",
    options: [
      ["warning", "Warning"],
      ["alert", "Alert"],
    ],
    default: "warning",
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
  const [events, setEvents] = useState([]);
  const [loadError, setLoadError] = useState("");

  // Load rules, logbook entries and numeric variables.
  const load = useCallback(() => {
    api
      .get(`/assets/${id}/rules?include_children=${children}`)
      .then((items) => {
        setRules(Array.isArray(items) ? items : []);
        setLoadError("");
      })
      .catch((error) => {
        setRules([]);
        setLoadError(error.message);
      });

    api
      .get(`/assets/${id}/logbook`)
      .then((items) => setLogs(Array.isArray(items) ? items : []))
      .catch((error) => setLoadError(error.message));

    api
      .get(`/assets/${id}/variables?is_active=true&limit=200`)
      .then((items) => {
        const list = Array.isArray(items) ? items : [];
        setVariables(
          list.filter((item) =>
            ["integer", "number"].includes(item.data_type)
          )
        );
      })
      .catch(() => setVariables([]));
  }, [id, children]);

  useEffect(() => {
    load();
  }, [load]);

  // Load events when the Event Log tab is opened.
  useEffect(() => {
    if (tab !== "events") return;

    api
      .get(`/assets/${id}/events`)
      .then((items) => setEvents(Array.isArray(items) ? items : []))
      .catch((error) => setLoadError(error.message));
  }, [tab, id]);

  // Rule filtering and sorting.
  const isAct = (rule) => rule.state === "activated";

  const nAct = rules.filter(isAct).length;
  const nNot = rules.length - nAct;

  let shown = rules
    .filter((rule) =>
      list === "activated" ? isAct(rule) : !isAct(rule)
    )
    .filter((rule) =>
      (rule.name || "").toLowerCase().includes(filter.toLowerCase())
    );

  shown = [...shown].sort((a, b) =>
    sort === "name"
      ? (a.name || "").localeCompare(b.name || "")
      : (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3)
  );

  // Activate or deactivate a single rule.
  const setState = async (rule, state) => {
    try {
      await api.patch(`/rules/${rule.id}`, {
        is_enabled: state === "activated",
      });
      await load();
    } catch (error) {
      setLoadError(error.message);
    }
  };

  // Delete a rule.
  const remove = async (rule) => {
    try {
      await api.del(`/rules/${rule.id}`);
      await load();
    } catch (error) {
      setLoadError(error.message);
    }
  };

  // Create a threshold monitoring rule.
  const addRule = async (values) => {
    if (!variables.length) {
      throw new Error(
        "Add an active numeric variable to this asset before creating a threshold rule."
      );
    }

    const threshold = Number(values.threshold);

    if (!Number.isFinite(threshold)) {
      throw new Error("Enter a valid numeric threshold.");
    }

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

    setModal(null);
    setList("not_activated");
    await load();
  };

  // Bulk activation/deactivation.
  const bulk = async (state) => {
    try {
      await api.post(`/assets/${id}/rules/bulk`, { state });
      setMenu(false);
      await load();

      if (typeof reload === "function") {
        await reload();
      }
    } catch (error) {
      setLoadError(error.message);
    }
  };

  // Add a maintenance logbook entry.
  const addLog = async (values) => {
    if (!values.text?.trim()) {
      throw new Error("Enter a logbook entry.");
    }

    await api.post(`/assets/${id}/logbook`, {
      text: values.text.trim(),
    });

    setModal(null);
    await load();
  };

  if (!asset) {
    return <div className="loading">Loading…</div>;
  }

  return (
    <div>
      {loadError && (
        <div className="notice error">
          Could not load asset monitoring data: {loadError}
        </div>
      )}

      <div className="asset-head">
        <h1>{asset.name}</h1>

        <div className="asset-links">
          <button
            className="link-btn"
            onClick={() => setModal("settings")}
          >
            <GearIcon size={18} /> Asset settings
          </button>

          <button
            className="link-btn"
            onClick={() => setModal("variables")}
          >
            <AssetIcon size={18} /> Variables
          </button>

          <button
            className="icon-outline"
            title="Open in new tab"
            onClick={() =>
              window.open(window.location.href, "_blank")
            }
          >
            <ExternalIcon size={20} />
          </button>
        </div>
      </div>

      <div className="tabs">
        {[
          ["status", "Current status"],
          ["logbook", "Maintenance logbook"],
          ["events", "Event log"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* CURRENT STATUS TAB */}
      {tab === "status" && (
        <>
          <div className="toolbar">
            <button
              className={"icon-outline sm" + (showFilter ? " on" : "")}
              onClick={() => setShowFilter(!showFilter)}
              title="Filter rules"
            >
              <FilterIcon size={18} />
            </button>

            {showFilter && (
              <input
                className="mini-input"
                placeholder="Filter rules"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            )}

            <div className="segment">
              <button
                className={list === "activated" ? "active" : ""}
                onClick={() => setList("activated")}
              >
                Activated <span>({nAct})</span>
              </button>

              <button
                className={list === "not_activated" ? "active" : ""}
                onClick={() => setList("not_activated")}
              >
                Not activated <span>({nNot})</span>
              </button>
            </div>

            <button
              className="icon-outline sm"
              onClick={load}
              title="Refresh"
            >
              <RefreshIcon size={18} />
            </button>

            <label className="switch-label">
              <span
                className={"switch" + (children ? " on" : "")}
                onClick={() => setChildren(!children)}
              >
                <i />
              </span>
              Child asset rules
            </label>

            <div className="spacer" />

            <div className="dropdown">
              <button
                className="link-btn"
                onClick={() => setSortMenu(!sortMenu)}
              >
                Sort: {sort === "name" ? "Name" : "Severity"}
                <ChevronDown size={14} />
              </button>

              {sortMenu && (
                <div className="menu">
                  <div
                    onClick={() => {
                      setSort("severity");
                      setSortMenu(false);
                    }}
                  >
                    Severity
                  </div>

                  <div
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
              onClick={() => setModal("add")}
            >
              <PlusCircle size={18} /> Add rule
            </button>

            <div className="dropdown">
              <button
                className="icon-outline sm"
                onClick={() => setMenu(!menu)}
                title="Rule actions"
              >
                <DotsIcon size={18} />
              </button>

              {menu && (
                <div className="menu right">
                  <div onClick={() => bulk("activated")}>
                    Activate all
                  </div>
                  <div onClick={() => bulk("not_activated")}>
                    Deactivate all
                  </div>
                </div>
              )}
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="panel-gray">
              <EmptyState
                title={
                  list === "activated"
                    ? "No rules in the 'Activated' rule list"
                    : "No rules in the 'Not activated' rule list"
                }
                lines={[
                  "To get started, click 'Add rule' to assign a new rule to this asset.",
                  "On this parent asset you can enable 'Child asset rules' to see monitoring information of child assets.",
                ]}
              />
            </div>
          ) : (
            <div className="rule-list">
              {shown.map((rule) => (
                <div key={rule.id} className="rule-row">
                  <span className={"sev " + rule.status} />

                  <div className="rule-name">
                    {rule.name}
                    <small>
                      {rule.asset_name || asset.name}
                      {rule.description
                        ? ` · ${rule.description}`
                        : ""}
                    </small>
                  </div>

                  <span className={"badge " + rule.status}>
                    {rule.status}
                  </span>

                  {isAct(rule) ? (
                    <button
                      className="btn-outline"
                      onClick={() =>
                        setState(rule, "not_activated")
                      }
                    >
                      Deactivate
                    </button>
                  ) : (
                    <button
                      className="btn-outline"
                      onClick={() =>
                        setState(rule, "activated")
                      }
                    >
                      Activate
                    </button>
                  )}

                  <button
                    className="btn-danger"
                    onClick={() => remove(rule)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* MAINTENANCE LOGBOOK TAB */}
      {tab === "logbook" && (
        <div className="panel-white">
          <div className="panel-head">
            <span className="muted">
              {logs.length}{" "}
              {logs.length === 1 ? "entry" : "entries"}
            </span>

            <button
              className="btn-primary"
              onClick={() => setModal("log")}
            >
              <PlusCircle size={18} /> Add entry
            </button>
          </div>

          {logs.length === 0 ? (
            <EmptyState title="No logbook entries" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Entry</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.time}</td>
                    <td>{entry.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* EVENT LOG TAB */}
      {tab === "events" && (
        <div className="panel-white">
          {events.length === 0 ? (
            <EmptyState title="No events yet" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{event.time}</td>
                    <td>{event.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ADD RULE MODAL */}
      {modal === "add" && (
        <CreateModal
          title="Add rule"
          submitLabel="Add rule"
          fields={ruleFields(variables)}
          onSubmit={addRule}
          onClose={() => setModal(null)}
        />
      )}

      {/* ADD LOGBOOK ENTRY MODAL */}
      {modal === "log" && (
        <CreateModal
          title="New logbook entry"
          submitLabel="Add entry"
          fields={LOG_FIELDS}
          onSubmit={addLog}
          onClose={() => setModal(null)}
        />
      )}

      {/* ASSET SETTINGS AND VARIABLES MODAL */}
      {(modal === "settings" || modal === "variables") && (
        <Modal
          title={
            modal === "settings" ? "Asset settings" : "Variables"
          }
          onClose={() => setModal(null)}
        >
          {modal === "settings" ? (
            <p className="muted">
              {asset.name} · {asset.asset_type}
              {asset.description ? ` · ${asset.description}` : ""}
            </p>
          ) : variables.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Type</th>
                  <th>Unit</th>
                </tr>
              </thead>
              <tbody>
                {variables.map((variable) => (
                  <tr key={variable.id}>
                    <td>{variable.name}</td>
                    <td>{variable.data_type}</td>
                    <td>{variable.unit || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              No active numeric variables are configured for
              threshold rules.
            </p>
          )}

          <div className="modal-actions">
            <button
              className="btn-primary"
              onClick={() => setModal(null)}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
