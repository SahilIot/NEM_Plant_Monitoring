import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { formatDuration, timeAgo } from "../format.js";


const Svg = ({ children, size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IconChip = (p) => <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></Svg>;
const IconPulse = (p) => <Svg {...p}><path d="M3 12h4l2.5-7 5 14 2.5-7h4" /></Svg>;
const IconShield = (p) => <Svg {...p}><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" /><path d="M9 12l2.2 2.2L15.5 10" /></Svg>;
const IconDownload = (p) => <Svg {...p}><path d="M12 3v12M7 10l5 5 5-5M4 20h16" /></Svg>;
const IconEmpty = (p) => <Svg size={34} {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M8 15h3" /></Svg>;
const Spinner = () => <span className="spin" aria-hidden="true" />;



function useAppTheme(ref) {
  const [light, setLight] = useState(false);
  useEffect(() => {
    const parse = (value) => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(",").map((x) => parseFloat(x));
      return p.length === 4 && p[3] === 0 ? null : p;
    };
    const detect = () => {
      let el = ref.current ? ref.current.parentElement : null;
      while (el) {
        const rgb = parse(getComputedStyle(el).backgroundColor);
        if (rgb) {
          setLight(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 140);
          return;
        }
        el = el.parentElement;
      }
      setLight(!window.matchMedia("(prefers-color-scheme: dark)").matches);
    };
    const detectSoon = () => {
      detect();
      window.setTimeout(detect, 150);
      window.setTimeout(detect, 600); // theme transition ke baad
    };
    detect();
    const observer = new MutationObserver((records) => {
      if (ref.current && records.every((r) => ref.current.contains(r.target))) return;
      detectSoon();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ["class", "data-theme", "data-mode", "style"],
    });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener && media.addEventListener("change", detectSoon);
    window.addEventListener("storage", detectSoon);
    return () => {
      observer.disconnect();
      media.removeEventListener && media.removeEventListener("change", detectSoon);
      window.removeEventListener("storage", detectSoon);
    };
  }, [ref]);
  return light;
}

const percent = (value, limit) => (limit ? Math.min(100, Math.round((value / limit) * 100)) : null);
const barTone = (pct) => (pct >= 100 ? " bad" : pct >= 80 ? " warn" : "");

export default function Plc() {
  const rootRef = useRef(null);
  const light = useAppTheme(rootRef);
  const [assets, setAssets] = useState([]);
  const [variables, setVariables] = useState([]);
  const [assetId, setAssetId] = useState("");
  const [variableId, setVariableId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [sourceId, setSourceId] = useState("opcua");
  const [connection, setConnection] = useState({ state: "untested", message: "" });
  const [reading, setReading] = useState("");
  const [readError, setReadError] = useState(false);
  const [busy, setBusy] = useState("");
  const [monitoring, setMonitoring] = useState(null);
  const [monitoringLoading, setMonitoringLoading] = useState(true);
  const [monitoringError, setMonitoringError] = useState("");

  useEffect(() => {
    let active = true;
    const loadStatus = async () => {
      try {
        const result = await api.get("/plc/status");
        if (!active) return;
        setMonitoring(result);
        setMonitoringError("");
      } catch (error) {
        if (active) setMonitoringError(error.message);
      } finally {
        if (active) setMonitoringLoading(false);
      }
    };
    loadStatus();
    const interval = window.setInterval(loadStatus, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    api
      .getAll("/assets?is_active=true")
      .then((items) => {
        setAssets(items);
        if (items.length) setAssetId(String(items[0].id));
      })
      .catch((error) => setConnection({ state: "error", message: error.message }));
  }, []);

  useEffect(() => {
    let alive = true;
    setVariableId("");
    if (!assetId) {
      setVariables([]);
      return undefined;
    }
    api
      .getAll(`/assets/${assetId}/variables?is_active=true`)
      .then((items) => {
        if (!alive) return;
        setVariables(items);
        if (items.length) setVariableId(String(items[0].id));
      })
      .catch((error) => {
        if (!alive) return;
        setVariables([]);
        setReading(`Could not load variables: ${error.message}`);
        setReadError(true);
      });
    return () => {
      alive = false;
    };
  }, [assetId]);

  const testConnection = async () => {
    setBusy("test");
    setConnection({ state: "testing", message: "Testing secure OPC UA connectionÔÇª" });
    try {
      const result = await api.get("/plc/test");
      setConnection({
        state: "connected",
        message: `Connection succeeded. Server time: ${result.server_time || "available"}.`,
      });
    } catch (error) {
      setConnection({ state: "error", message: error.message });
    } finally {
      setBusy("");
    }
  };

  const readNode = async (event) => {
    event.preventDefault();
    setBusy("read");
    setReading("Reading this NodeId onceÔÇª");
    setReadError(false);
    try {
      const result = await api.post("/plc/read", {
        node_id: nodeId.trim(),
        asset_id: Number(assetId),
        variable_id: Number(variableId),
        source_id: sourceId.trim() || "opcua",
      });
      const recordedAt = result.reading?.recorded_at
        ? new Date(result.reading.recorded_at).toLocaleString()
        : "time unavailable";
      setReading(`Read and saved: ${JSON.stringify(result.value)} at ${recordedAt}`);
    } catch (error) {
      setReading(`PLC read failed: ${error.message}`);
      setReadError(true);
    } finally {
      setBusy("");
    }
  };

  const conn = monitoring?.connection;
  const connText = !conn
    ? ""
    : conn.state === "disabled"
      ? "Continuous monitoring is not configured. Set OPCUA_MACHINE_MAPPINGS on the backend."
      : conn.connected
        ? "OPC UA subscription connected."
        : conn.state === "connecting"
          ? "Connecting to the OPC UA subscriptionÔÇª"
          : conn.state === "standby"
            ? "This backend instance is waiting for the active collector."
            : `OPC UA subscription disconnected${conn.last_error ? `: ${conn.last_error}` : "."}`;

  
  const pill = !conn
    ? { tone: "", text: monitoringError ? "Status unavailable" : "CheckingÔÇª" }
    : conn.connected
      ? { tone: "ok", text: "Live" }
      : conn.state === "disabled"
        ? { tone: "", text: "Not configured" }
        : conn.state === "connecting" || conn.state === "standby"
          ? { tone: "warn", text: conn.state === "standby" ? "Standby" : "Connecting" }
          : { tone: "bad", text: "Disconnected" };

  const readOk = reading.startsWith("Read and saved");

  return (
    <div ref={rootRef} className={"plc-page" + (light ? " plc-light" : "")}>
      {/*header*/}
      <div className="page-head plc-hero">
        <div className="plc-hero-icon"><IconChip size={26} /></div>
        <div className="plc-hero-text">
          <h1 className="page-title">PLC / OPC UA</h1>
          <p className="muted lede">Monitor PLC values securely. Connection settings and certificates stay on the backend.</p>
        </div>
        <span className={"pill " + pill.tone} role="status"><i />{pill.text}</span>
      </div>

      {/*continuous monitoring*/}
      <section className="panel plc-panel wide">
        <div className="panel-head">
          <span className="panel-icon"><IconPulse /></span>
          <div>
            <h2>Continuous machine monitoring</h2>
            <p className="muted">Live status, cycles and running time of every mapped machine.</p>
          </div>
        </div>

        {monitoringLoading && <p className="loading-line" role="status"><Spinner /> Loading PLC monitoring statusÔÇª</p>}
        {monitoringError && <p className="notice error" role="alert">Could not refresh PLC status: {monitoringError}</p>}

        {!monitoringLoading && monitoring && (
          <>
            <p className={"link-line " + (conn?.connected ? "up" : conn?.state === "disabled" ? "wait" : "down")} role="status">
              <i />{connText}
            </p>
            {conn?.stale && conn?.configured && (
              <p className="notice error" role="status">PLC data is stale, or no valid subscription notification has been received.</p>
            )}

            {monitoring.machines.length === 0 ? (
              <div className="empty-box">
                <IconEmpty />
                <strong>No machines yet</strong>
                <span>No machine NodeId mappings are configured.</span>
              </div>
            ) : (
              <div className="machine-cards">
                {monitoring.machines.map((machine) => {
                  const cyclePct = percent(machine.cycle_count, machine.cycle_limit);
                  const runPct = percent(machine.running_seconds, machine.runtime_limit_seconds);
                  return (
                    <article className={"machine-card status-" + machine.status} key={machine.asset_id}>
                      <header>
                        <h3>{machine.asset_name || `Asset ${machine.asset_id}`}</h3>
                        <span className={"machine-state " + machine.status}>
                          <i className={"lamp " + (machine.status === "running" ? "ok" : machine.status === "stopped" ? "off" : "warning")} />
                          <span className="cap">{machine.status}</span>
                          {machine.stale && <em>stale data</em>}
                        </span>
                      </header>

                      <div className="machine-figs">
                        <div className="machine-fig">
                          <span>Cycles</span>
                          <b>{machine.cycle_count}{machine.cycle_limit ? <small> / {machine.cycle_limit}</small> : null}</b>
                          {cyclePct !== null && <div className={"bar" + barTone(cyclePct)}><span style={{ width: cyclePct + "%" }} /></div>}
                        </div>
                        <div className="machine-fig">
                          <span>Running time</span>
                          <b>
                            {formatDuration(machine.running_seconds)}
                            {machine.runtime_limit_seconds ? <small> / {formatDuration(machine.runtime_limit_seconds)}</small> : null}
                          </b>
                          {runPct !== null && <div className={"bar" + barTone(runPct)}><span style={{ width: runPct + "%" }} /></div>}
                        </div>
                      </div>

                      <p className="muted">
                        Last signal: {machine.last_seen_at ? `${timeAgo(machine.last_seen_at)} (${new Date(machine.last_seen_at).toLocaleString()})` : "not received"}
                      </p>

                      {machine.alerts?.length > 0 && (
                        <div role="status" className="machine-alerts">
                          <strong>Active alerts</strong>
                          {machine.alerts.map((alert) => (
                            <p className={"notice " + (alert.severity === "alert" ? "error" : "warn")} key={alert.id}>
                              {alert.title}: {alert.message}
                            </p>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>

      {/*connection + read, side by side*/}
      <div className="plc-grid">
        <section className="panel plc-panel">
          <div className="panel-head">
            <span className="panel-icon"><IconShield /></span>
            <div>
              <h2>Secure connection</h2>
              <p className="muted">Uses the configured OPC UA endpoint, trusted server certificate, and signed and encrypted channel. This client is read-only.</p>
            </div>
          </div>
          <button className="btn-primary" disabled={busy !== ""} onClick={testConnection}>
            {busy === "test" ? <><Spinner /> TestingÔÇª</> : "Test secure connection"}
          </button>
          {connection.message && (
            <p className={"notice" + (connection.state === "error" ? " error" : connection.state === "connected" ? " success" : "")} role="status">
              {connection.message}
            </p>
          )}
        </section>

        <section className="panel plc-panel">
          <div className="panel-head">
            <span className="panel-icon"><IconDownload /></span>
            <div>
              <h2>Read and save one value</h2>
              <p className="muted">Each submission reads once, saves a reading, and evaluates matching monitoring rules. It does not start another collector.</p>
            </div>
          </div>

          <form className="form" onSubmit={readNode}>
            <label className="field span-2">PLC NodeId
              <input className="mono" required maxLength={512} value={nodeId} onChange={(event) => setNodeId(event.target.value)} placeholder="ns=3;s=Machine1.Motor.RotationCount" />
            </label>
            <label className="field">Asset
              <select required value={assetId} onChange={(event) => setAssetId(event.target.value)}>
                {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} ({asset.asset_type})</option>)}
              </select>
            </label>
            <label className="field">Variable
              <select required value={variableId} onChange={(event) => setVariableId(event.target.value)} disabled={!variables.length}>
                {!variables.length && <option value="">No variables for this asset</option>}
                {variables.map((variable) => (
                  <option key={variable.id} value={variable.id}>
                    {variable.name}, {variable.data_type}{variable.unit ? ` (${variable.unit})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field span-2">Source label
              <input maxLength={200} value={sourceId} onChange={(event) => setSourceId(event.target.value)} />
            </label>
            <div className="span-2">
              <button className="btn-primary" type="submit" disabled={busy !== "" || !assets.length || !variables.length}>
                {busy === "read" ? <><Spinner /> ReadingÔÇª</> : "Read node and save"}
              </button>
            </div>
          </form>

          {reading && (
            <p className={"notice" + (readError ? " error" : readOk ? " success" : "")} role="status">{reading}</p>
          )}
        </section>
      </div>
    </div>
  );
}
