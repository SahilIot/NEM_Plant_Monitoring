
import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { formatDuration, timeAgo } from "../format.js";

export default function Plc() {
  const [assets, setAssets] = useState([]);
  const [variables, setVariables] = useState([]);
  const [assetId, setAssetId] = useState("");
  const [variableId, setVariableId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [sourceId, setSourceId] = useState("opcua");

  const [connection, setConnection] = useState({
    state: "untested",
    message: "",
  });

  const [reading, setReading] = useState("");
  const [readError, setReadError] = useState(false);
  const [busy, setBusy] = useState("");

  const [monitoring, setMonitoring] = useState(null);
  const [monitoringLoading, setMonitoringLoading] = useState(true);
  const [monitoringError, setMonitoringError] = useState("");

  const [latestReadings, setLatestReadings] = useState([]);
  const [latestError, setLatestError] = useState("");
  const [latestLoading, setLatestLoading] = useState(true);

  // Refresh the latest readings saved in the backend database.
  useEffect(() => {
    let active = true;
    let requestRunning = false;

    const loadLatestReadings = async () => {
      if (requestRunning) return;
      requestRunning = true;

      try {
        const result = await api.getAll("/readings/latest?limit=100");

        if (!active) return;

        const items = Array.isArray(result) ? result : [];
        const newestByVariable = new Map();

        for (const item of items) {
          const key = `${item.asset_id}:${item.variable_id}`;
          const previous = newestByVariable.get(key);

          if (
            !previous ||
            new Date(item.recorded_at).getTime() >
              new Date(previous.recorded_at).getTime()
          ) {
            newestByVariable.set(key, item);
          }
        }

        const newest = [...newestByVariable.values()].sort(
          (a, b) =>
            new Date(b.recorded_at).getTime() -
            new Date(a.recorded_at).getTime()
        );

        setLatestReadings(newest);
        setLatestError("");
      } catch (error) {
        if (active) {
          setLatestError(error.message || "Could not load latest readings.");
        }
      } finally {
        requestRunning = false;
        if (active) setLatestLoading(false);
      }
    };

    loadLatestReadings();
    const timer = window.setInterval(loadLatestReadings, 2000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  // Refresh continuous machine monitoring status.
  useEffect(() => {
    let active = true;

    const loadStatus = async () => {
      try {
        const result = await api.get("/plc/status");

        if (!active) return;

        setMonitoring(result);
        setMonitoringError("");
      } catch (error) {
        if (active) {
          setMonitoringError(error.message || "Could not load PLC status.");
        }
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

  // Load active assets.
  useEffect(() => {
    let active = true;

    api
      .getAll("/assets?is_active=true")
      .then((items) => {
        if (!active) return;

        setAssets(items);

        if (items.length) {
          setAssetId(String(items[0].id));
        }
      })
      .catch((error) => {
        if (active) {
          setConnection({
            state: "error",
            message: error.message || "Could not load assets.",
          });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  // Load variables whenever the selected asset changes.
  useEffect(() => {
    let active = true;

    setVariableId("");

    if (!assetId) {
      setVariables([]);
      return undefined;
    }

    api
      .getAll(`/assets/${assetId}/variables?is_active=true`)
      .then((items) => {
        if (!active) return;

        setVariables(items);

        if (items.length) {
          setVariableId(String(items[0].id));
        }
      })
      .catch((error) => {
        if (!active) return;

        setVariables([]);
        setReading(`Could not load variables: ${error.message}`);
        setReadError(true);
      });

    return () => {
      active = false;
    };
  }, [assetId]);

  const testConnection = async () => {
    setBusy("test");
    setConnection({
      state: "testing",
      message: "Testing secure OPC UA connection…",
    });

    try {
      const result = await api.get("/plc/test");

      setConnection({
        state: "connected",
        message: `Connection succeeded. Server time: ${
          result.server_time || "available"
        }.`,
      });
    } catch (error) {
      setConnection({
        state: "error",
        message: error.message || "OPC UA connection test failed.",
      });
    } finally {
      setBusy("");
    }
  };

  const readNode = async (event) => {
    event.preventDefault();

    setBusy("read");
    setReading("Reading this NodeId once…");
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

      setReading(
        `Read and saved: ${JSON.stringify(result.value)} at ${recordedAt}`
      );

      // Refresh the readings panel immediately after a successful read.
      try {
        const items = await api.getAll("/readings/latest?limit=100");
        const newestByVariable = new Map();

        for (const item of Array.isArray(items) ? items : []) {
          const key = `${item.asset_id}:${item.variable_id}`;
          const previous = newestByVariable.get(key);

          if (
            !previous ||
            new Date(item.recorded_at).getTime() >
              new Date(previous.recorded_at).getTime()
          ) {
            newestByVariable.set(key, item);
          }
        }

        setLatestReadings(
          [...newestByVariable.values()].sort(
            (a, b) =>
              new Date(b.recorded_at).getTime() -
              new Date(a.recorded_at).getTime()
          )
        );

        setLatestError("");
      } catch {
        // The regular polling effect will try again.
      }
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
          ? "Connecting to the OPC UA subscription…"
          : conn.state === "standby"
            ? "This backend instance is waiting for the active collector."
            : `OPC UA subscription disconnected${
                conn.last_error ? `: ${conn.last_error}` : "."
              }`;

  const formatValue = (value) => {
    if (value === null || value === undefined) return "—";

    if (typeof value === "object") {
      return JSON.stringify(value);
    }

    return String(value);
  };

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return "—";

    const date = new Date(timestamp);

    return Number.isNaN(date.getTime())
      ? "Invalid time"
      : date.toLocaleString();
  };

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">PLC / OPC UA</h1>
      </div>

      <p className="muted lede">
        Monitor PLC values securely. Connection settings and certificates stay
        on the backend.
      </p>

      {/* Latest saved readings */}
      <section className="panel plc-panel wide">
        <h2>Latest PLC readings</h2>

        <p className="muted">
          Latest values saved in the backend database. This panel refreshes
          automatically every 2 seconds.
        </p>

        {latestLoading && (
          <p className="muted" role="status">
            Loading latest readings…
          </p>
        )}

        {latestError && (
          <p className="notice error" role="alert">
            Could not load latest readings: {latestError}
          </p>
        )}

        {!latestLoading && !latestError && latestReadings.length === 0 && (
          <p className="muted">
            No readings have been saved yet. Use “Read node and save” to test
            a node, or configure continuous subscriptions in the backend.
          </p>
        )}

        {latestReadings.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset ID</th>
                  <th>Variable ID</th>
                  <th>Value</th>
                  <th>Source</th>
                  <th>Last updated</th>
                  <th>NodeId</th>
                </tr>
              </thead>

              <tbody>
                {latestReadings.map((item) => (
                  <tr key={`${item.asset_id}-${item.variable_id}`}>
                    <td>{item.asset_id}</td>
                    <td>{item.variable_id}</td>
                    <td>
                      <strong>{formatValue(item.value)}</strong>
                    </td>
                    <td>{item.source_id || "—"}</td>
                    <td>
                      <span title={formatTimestamp(item.recorded_at)}>
                        {item.recorded_at
                          ? timeAgo(item.recorded_at)
                          : "—"}
                      </span>
                      <br />
                      <small>{formatTimestamp(item.recorded_at)}</small>
                    </td>
                    <td>
                      <code>
                        {item.metadata?.node_id || "Not recorded"}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Existing continuous machine monitoring */}
      <section className="panel plc-panel wide">
        <h2>Continuous machine monitoring</h2>

        {monitoringLoading && (
          <p className="muted" role="status">
            Loading PLC monitoring status…
          </p>
        )}

        {monitoringError && (
          <p className="notice error" role="alert">
            Could not refresh PLC status: {monitoringError}
          </p>
        )}

        {!monitoringLoading && monitoring && (
          <>
            {conn && (
              <p
                className={
                  "link-line " +
                  (conn.connected
                    ? "up"
                    : conn.state === "disabled"
                      ? "wait"
                      : "down")
                }
                role="status"
              >
                <i />
                {connText}
              </p>
            )}

            {conn?.stale && conn?.configured && (
              <p className="notice error" role="status">
                PLC data is stale, or no valid subscription notification has
                been received.
              </p>
            )}

            {!monitoring.machines?.length ? (
              <p className="muted">
                No machine NodeId mappings are configured.
              </p>
            ) : (
              <div className="machine-cards">
                {monitoring.machines.map((machine) => (
                  <article className="machine-card" key={machine.asset_id}>
                    <header>
                      <h3>{machine.asset_name || `Asset ${machine.asset_id}`}</h3>

                      <span className={"machine-state " + machine.status}>
                        <i
                          className={
                            "lamp " +
                            (machine.status === "running"
                              ? "ok"
                              : machine.status === "stopped"
                                ? "off"
                                : "warning")
                          }
                        />
                        <span className="cap">{machine.status}</span>
                        {machine.stale && <em>stale data</em>}
                      </span>
                    </header>

                    <div className="machine-figs">
                      <div className="machine-fig">
                        <span>Cycles</span>
                        <b>
                          {machine.cycle_count}
                          {machine.cycle_limit ? (
                            <small> / {machine.cycle_limit}</small>
                          ) : null}
                        </b>
                      </div>

                      <div className="machine-fig">
                        <span>Running time</span>
                        <b>
                          {formatDuration(machine.running_seconds)}
                          {machine.runtime_limit_seconds ? (
                            <small>
                              {" "}
                              / {formatDuration(machine.runtime_limit_seconds)}
                            </small>
                          ) : null}
                        </b>
                      </div>
                    </div>

                    <p className="muted">
                      Last signal:{" "}
                      {machine.last_seen_at
                        ? `${timeAgo(machine.last_seen_at)} (${formatTimestamp(
                            machine.last_seen_at
                          )})`
                        : "not received"}
                    </p>

                    {machine.alerts?.length > 0 && (
                      <div role="status" className="machine-alerts">
                        <strong>Active alerts</strong>

                        {machine.alerts.map((alert) => (
                          <p
                            className={
                              "notice " +
                              (alert.severity === "alert" ? "error" : "warn")
                            }
                            key={alert.id}
                          >
                            {alert.title}: {alert.message}
                          </p>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* Existing secure connection test */}
      <section className="panel plc-panel">
        <h2>Secure connection</h2>

        <p className="muted">
          Uses the configured OPC UA endpoint, trusted server certificate, and
          signed and encrypted channel. This client is read-only.
        </p>

        <button
          className="btn-primary"
          disabled={busy !== ""}
          onClick={testConnection}
        >
          {busy === "test" ? "Testing…" : "Test secure connection"}
        </button>

        {connection.message && (
          <p
            className={
              "notice" + (connection.state === "error" ? " error" : "")
            }
            role="status"
          >
            {connection.message}
          </p>
        )}
      </section>

      {/* Existing one-time read */}
      <section className="panel plc-panel">
        <h2>Read and save one value</h2>

        <p className="muted">
          Each submission reads once, saves a reading, and evaluates matching
          monitoring rules. It does not start another collector.
        </p>

        <form className="form" onSubmit={readNode}>
          <label className="field">
            PLC NodeId
            <input
              required
              maxLength={512}
              value={nodeId}
              onChange={(event) => setNodeId(event.target.value)}
              placeholder='ns=3;s="OPC Lab DB"."DoughTemp"'
            />
          </label>

          <label className="field">
            Asset
            <select
              required
              value={assetId}
              onChange={(event) => setAssetId(event.target.value)}
            >
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name} ({asset.asset_type})
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Variable
            <select
              required
              value={variableId}
              onChange={(event) => setVariableId(event.target.value)}
              disabled={!variables.length}
            >
              {variables.map((variable) => (
                <option key={variable.id} value={variable.id}>
                  {variable.name}, {variable.data_type}
                  {variable.unit ? ` (${variable.unit})` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Source label
            <input
              maxLength={200}
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            />
          </label>

          <div>
            <button
              className="btn-primary"
              type="submit"
              disabled={
                busy !== "" ||
                !assets.length ||
                !variables.length ||
                !nodeId.trim()
              }
            >
              {busy === "read" ? "Reading…" : "Read node and save"}
            </button>
          </div>
        </form>

        {reading && (
          <p
            className={"notice" + (readError ? " error" : "")}
            role="status"
          >
            {reading}
          </p>
        )}
      </section>
    </div>
  );
}
