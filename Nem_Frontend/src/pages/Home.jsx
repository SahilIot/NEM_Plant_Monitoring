import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { api } from "../api.js";
import { REFRESH_MS } from "../config.js";
import { formatValue, timeAgo } from "../format.js";
import { EmptyState } from "../components/UI.jsx";
import { CheckIcon } from "../components/Icons.jsx";

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function Tile({ tone, label, value, to, hint }) {
  const nav = useNavigate();
  const lit = value > 0;
  return (
    <button
      type="button"
      className={"tile " + tone + (lit ? " lit" : "")}
      onClick={() => nav(to)}
      title={hint}
    >
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
    </button>
  );
}

export default function Home() {
  const { assets = [], alerts = [], refreshStatus } = useOutletContext();

  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [operator, setOperator] = useState("");
  const [ackError, setAckError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [, setTick] = useState(0);

  const loadSummary = useCallback(async () => {
    try {
      const result = await api.get("/summary");
      if (!result || typeof result !== "object") throw new Error("The dashboard returned an invalid response.");
      setSummary(result);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the dashboard.");
    }
  }, []);

  useEffect(() => {
    loadSummary();
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        loadSummary();
        setTick((n) => n + 1); // keeps "5 min ago" labels current
      }
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadSummary]);

  useEffect(() => {
    api.get("/me").then((me) => setOperator(me?.name || "")).catch(() => {});
  }, []);

  const assetName = useMemo(() => new Map(assets.map((a) => [a.id, a.name])), [assets]);

  const ordered = useMemo(
    () =>
      [...alerts].sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === "alert" ? -1 : 1;
        if (Boolean(a.acknowledged_at) !== Boolean(b.acknowledged_at)) return a.acknowledged_at ? 1 : -1;
        return new Date(b.started_at) - new Date(a.started_at);
      }),
    [alerts]
  );

  const acknowledge = async (alert) => {
    setBusyId(alert.id);
    setAckError("");
    try {
      await api.post(`/alerts/${alert.id}/acknowledge`, operator ? { acknowledged_by: operator } : {});
      await Promise.all([refreshStatus?.(), loadSummary()]);
    } catch (err) {
      setAckError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (!summary && error) {
    return (
      <div className="banner error" role="alert">
        <div>
          <strong>Could not load the overview</strong>
          <p>{error}</p>
        </div>
        <button type="button" className="btn-outline" onClick={loadSummary}>Retry</button>
      </div>
    );
  }
  if (!summary) return <div className="loading" role="status">Loading overview…</div>;

  const rulesAlert = num(summary.rules_alert);
  const rulesWarning = num(summary.rules_warning);
  const assetsAlert = num(summary.assets_alert);
  const assetsWarning = num(summary.assets_warning);
  const monitored = num(summary.monitored_assets);
  const total = num(summary.total_assets);
  const stats = summary.stats ?? {};
  const allClear = rulesAlert + rulesWarning + assetsAlert + assetsWarning === 0 && alerts.length === 0;
  const coverage = total > 0 ? Math.round((monitored / total) * 100) : 0;

  const ruleStats = [
    ["Activated", "activated"],
    ["Suspended", "suspended"],
    ["Finished", "finished"],
    ["Not activated", "not_activated"],
  ];

  return (
    <div className="home">
      <h1 className="page-title">Plant overview</h1>

      {error && <p className="notice error" role="status">Showing the last known values. Refresh failed: {error}</p>}

      <section className="annunciator" aria-label="Current status">
        <Tile tone="alert" label="Rules in alert" value={rulesAlert} to="/rules/alert" hint="Open rules currently in alert status" />
        <Tile tone="warning" label="Rules in warning" value={rulesWarning} to="/rules/warning" hint="Open rules currently in warning status" />
        <Tile tone="alert" label="Assets in alert" value={assetsAlert} to="/rules/alert" hint="Assets with an active alert" />
        <Tile tone="warning" label="Assets in warning" value={assetsWarning} to="/rules/warning" hint="Assets with an active warning" />
      </section>

      <div className="home-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>Needs attention</h2>
            <span className="muted">
              {alerts.length === 0 ? "Nothing open" : `${alerts.length} active ${alerts.length === 1 ? "alert" : "alerts"}`}
            </span>
          </div>

          {ackError && <p className="notice error" role="alert">Could not acknowledge: {ackError}</p>}

          {ordered.length === 0 ? (
            allClear ? (
              <div className="all-clear">
                <span className="all-clear-mark"><CheckIcon size={22} /></span>
                <div>
                  <strong>All machines are within limits</strong>
                  <p className="muted">No rule is in alert or warning. This list updates automatically.</p>
                </div>
              </div>
            ) : (
              <EmptyState art={false} title="No active alerts" lines={["Rule states above may still be changing. Open a rule list to review."]} />
            )
          ) : (
            <ul className="alert-list">
              {ordered.map((alert) => (
                <li key={alert.id} className={"alert-row " + alert.severity}>
                  <i className={"lamp " + alert.severity} aria-hidden="true" />
                  <div className="alert-body">
                    <div className="alert-title">{alert.title}</div>
                    <div className="alert-msg">{alert.message}</div>
                    <div className="alert-meta">
                      <Link to={`/assets/${alert.target_asset_id}`}>
                        {assetName.get(alert.target_asset_id) || `Asset ${alert.target_asset_id}`}
                      </Link>
                      <span title={new Date(alert.started_at).toLocaleString()}>Started {timeAgo(alert.started_at)}</span>
                      {alert.trigger_value !== null && alert.trigger_value !== undefined && (
                        <span>Value {formatValue(alert.trigger_value)}</span>
                      )}
                    </div>
                  </div>
                  {alert.acknowledged_at ? (
                    <span className="ack-done" title={new Date(alert.acknowledged_at).toLocaleString()}>
                      Acknowledged{alert.acknowledged_by ? ` by ${alert.acknowledged_by}` : ""}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn-outline"
                      disabled={busyId === alert.id}
                      onClick={() => acknowledge(alert)}
                    >
                      {busyId === alert.id ? "Saving…" : "Acknowledge"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="side-stack">
          <section className="panel">
            <div className="panel-head"><h2>Monitoring coverage</h2></div>
            <Link to="/assets" className="coverage">
              <span className="coverage-num">{monitored}<small> of {total} assets</small></span>
              <span className="meter" aria-hidden="true"><i style={{ width: `${coverage}%` }} /></span>
              <span className="muted">have active variables being monitored</span>
            </Link>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Rules by state</h2></div>
            <ul className="state-list">
              {ruleStats.map(([label, key]) => (
                <li key={key}>
                  <Link to="/configuration/rules">
                    <span>{label}</span>
                    <b>{num(stats[key])}</b>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
