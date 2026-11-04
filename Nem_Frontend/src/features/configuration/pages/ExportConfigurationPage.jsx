import React, { useState } from "react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";

export default function ExportConfigurationPage() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canExport = user?.role === "Administrator";

  const exportConfiguration = async () => {
    if (!canExport || busy) return;

    setBusy(true);
    setError("");

    try {
      // The server builds the portable package (rules, collections, maintenance definitions).
      const data = await api.get("/config-transfer/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `nem-configuration-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || "Configuration export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <button type="button" className="link-btn" onClick={() => window.history.back()}>
        ‹ Back
      </button>

      <h1 className="page-title">Export configuration</h1>

      <div className="panel">
        <p>
          Export monitoring rules, rule collections and maintenance rules as a JSON file that can be
          imported into another NEM installation. Runtime counters, alerts, events, completed maintenance
          and user accounts are not included.
        </p>

        {!canExport && (
          <p className="notice" role="status">
            Only Administrators can export configuration.
          </p>
        )}

        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        <button type="button" className="btn-primary" disabled={!canExport || busy} onClick={exportConfiguration}>
          {busy ? "Exporting..." : "Export JSON"}
        </button>
      </div>
    </div>
  );
}
