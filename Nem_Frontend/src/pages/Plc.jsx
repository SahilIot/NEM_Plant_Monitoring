import React, { useEffect, useState } from "react";
import { api } from "../api.js";

export default function Plc() {
  const [assets, setAssets] = useState([]);
  const [variables, setVariables] = useState([]);
  const [assetId, setAssetId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [sourceId, setSourceId] = useState("opcua");
  const [connection, setConnection] = useState({ state: "untested", message: "" });
  const [reading, setReading] = useState("");
  const [readError, setReadError] = useState(false);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    api.get("/assets?is_active=true&limit=200").then((items) => {
      setAssets(items);
      if (items.length) setAssetId(String(items[0].id));
    }).catch((error) => setConnection({ state: "error", message: error.message }));
  }, []);

  useEffect(() => {
    if (!assetId) {
      setVariables([]);
      return;
    }
    api.get(`/assets/${assetId}/variables?is_active=true&limit=200`)
      .then(setVariables)
      .catch((error) => {
        setVariables([]);
        setReading(`Could not load variables: ${error.message}`);
        setReadError(true);
      });
  }, [assetId]);

  const testConnection = async () => {
    setBusy("test");
    setConnection({ state: "testing", message: "Testing secure OPC UA connection…" });
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
    setReading("Reading this NodeId once…");
    setReadError(false);
    try {
      const result = await api.post("/plc/read", {
        node_id: nodeId.trim(),
        asset_id: Number(assetId),
        variable_id: Number(event.currentTarget.elements.variable_id.value),
        source_id: sourceId.trim() || "opcua",
      });
      const recordedAt = result.reading?.recorded_at
        ? new Date(result.reading.recorded_at).toLocaleString()
        : "time unavailable";
      setReading(`Read and ingested: ${JSON.stringify(result.value)} · ${recordedAt}`);
    } catch (error) {
      setReading(`PLC read failed: ${error.message}`);
      setReadError(true);
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <div className="page-head"><h1>PLC / OPC UA</h1></div>
      <p className="muted">Read PLC values securely. Connection settings and certificates stay on the backend.</p>
      <section className="panel-white plc-panel">
        <h2>Secure connection</h2>
        <p className="muted">Uses the configured OPC UA endpoint, trusted server certificate, and signed/encrypted channel. This client is read-only.</p>
        <button className="btn-primary" disabled={busy !== ""} onClick={testConnection}>
          {busy === "test" ? "Testing…" : "Test secure connection"}
        </button>
        {connection.message && <p className={`notice ${connection.state === "error" ? "error" : ""}`} role="status">{connection.message}</p>}
      </section>

      <section className="panel-white plc-panel">
        <h2>Read and ingest one value</h2>
        <p className="muted">Each submission reads once, saves a reading, and evaluates matching monitoring rules. It does not start polling.</p>
        <form className="form" onSubmit={readNode}>
          <label className="field">PLC NodeId
            <input required maxLength={512} value={nodeId} onChange={(event) => setNodeId(event.target.value)}
              placeholder="ns=3;s=Machine1.Motor.RotationCount" />
          </label>
          <label className="field">Asset
            <select required value={assetId} onChange={(event) => setAssetId(event.target.value)}>
              {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · {asset.asset_type}</option>)}
            </select>
          </label>
          <label className="field">Variable
            <select required name="variable_id" disabled={!variables.length}>
              {variables.map((variable) => <option key={variable.id} value={variable.id}>
                {variable.name} · {variable.data_type}{variable.unit ? ` (${variable.unit})` : ""}
              </option>)}
            </select>
          </label>
          <label className="field">Source label
            <input maxLength={200} value={sourceId} onChange={(event) => setSourceId(event.target.value)} />
          </label>
          <button className="btn-primary" type="submit" disabled={busy !== "" || !assets.length || !variables.length}>
            {busy === "read" ? "Reading…" : "Read node and ingest"}
          </button>
        </form>
        {reading && <p className={`notice ${readError ? "error" : ""}`} role="status">{reading}</p>}
      </section>
    </div>
  );
}
