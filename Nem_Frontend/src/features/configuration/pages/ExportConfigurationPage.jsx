import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Download, RefreshCw } from "lucide-react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { BackIcon } from "../../../components/common/Icons.jsx";
import { LoadingIndicator } from "../../../components/common/UI.jsx";
import "./ConfigTransfer.css";

// Only what the backend can export and import again.
const CATEGORY_DEFS = [
  {
    key: "monitoring_rules",
    title: "Monitoring rules",
    short: "rules",
    desc: "Shared monitoring rules that are not part of a collection, with labels and visibility.",
    count: (c) => c.monitoring_rules,
  },
  {
    key: "collection_rules",
    title: "Rule collections",
    short: "collections",
    desc: "Collections together with every rule they contain.",
    count: (c) => c.collection_rules,
    related: (c) => `${c.collection_rule_members} member rule${c.collection_rule_members === 1 ? "" : "s"} included`,
  },
  {
    key: "maintenance_rules",
    title: "Maintenance rules",
    short: "maintenance",
    desc: "Recurring maintenance definitions (active and paused). Occurrences and history are not included.",
    count: (c) => c.maintenance_rules,
  },
];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function ExportConfigurationPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const canExport = user?.role === "Administrator";

  const [summary, setSummary] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState([]);
  const [assetIds, setAssetIds] = useState([]); // empty = all assets
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);

  const load = () => {
    setLoadError("");
    setSummary(null);
    api.get("/config-transfer/export/summary")
      .then((data) => {
        setSummary(data);
        setSelected(CATEGORY_DEFS.filter((def) => def.count(data.counts) > 0).map((def) => def.key));
      })
      .catch((error) => setLoadError(error.message || "Could not load the export summary."));
  };

  useEffect(() => { if (canExport) load(); }, [canExport]);

  const counts = summary?.counts;
  const maintenanceAssets = summary?.maintenance_assets || [];
  const maintenanceCount = useMemo(() => {
    if (!counts) return 0;
    if (!assetIds.length) return counts.maintenance_rules;
    return maintenanceAssets.filter((asset) => assetIds.includes(asset.id)).reduce((sum, asset) => sum + asset.maintenance_rules, 0);
  }, [counts, assetIds, maintenanceAssets]);

  const countFor = (def) => (def.key === "maintenance_rules" ? maintenanceCount : def.count(counts));
  const chosen = CATEGORY_DEFS.filter((def) => selected.includes(def.key));
  const totalRecords = counts ? chosen.reduce((sum, def) => sum + countFor(def), 0) : 0;
  const allSelected = counts && CATEGORY_DEFS.every((def) => def.count(counts) === 0 || selected.includes(def.key)) && !assetIds.length;

  const toggle = (key) => setSelected((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));
  const toggleAsset = (id) => setAssetIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const clearSelection = () => { setSelected([]); setAssetIds([]); setBanner(null); };
  const selectAll = () => {
    setSelected(CATEGORY_DEFS.filter((def) => def.count(counts) > 0).map((def) => def.key));
    setAssetIds([]);
  };

  const fileName = () => {
    const date = new Date().toISOString().slice(0, 10);
    const everything = CATEGORY_DEFS.every((def) => def.count(counts) === 0 || selected.includes(def.key));
    if (everything && !assetIds.length) return `nem-configuration-export-${date}.json`;
    return `nem-configuration-export-${chosen.map((def) => def.short).join("-")}-${date}.json`;
  };

  const download = async () => {
    if (!canExport || busy || !selected.length || totalRecords === 0) return;
    setBusy(true);
    setBanner(null);
    try {
      const query = new URLSearchParams({ categories: selected.join(",") });
      if (selected.includes("maintenance_rules") && assetIds.length) query.set("asset_ids", assetIds.join(","));
      const data = await api.get(`/config-transfer/export?${query.toString()}`);
      const name = fileName();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const exported = Object.values(data.contents || {}).reduce((sum, items) => sum + items.length, 0);
      setBanner({ text: `Exported ${plural(exported, "record", "records")} to ${name}.`, error: false });
    } catch (error) {
      setBanner({ text: error.message || "Configuration export failed.", error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="xfer-page">
      <button type="button" className="link-btn" onClick={() => nav("/configuration")}>
        <BackIcon size={14} /> Back
      </button>

      <div className="xfer-head">
        <h1 className="page-title">Export configuration</h1>
        <p>Create a portable JSON file of reusable configuration that can be imported into this or another NEM installation.</p>
      </div>

      {!canExport && <p className="notice" role="status">Only Administrators can export configuration.</p>}

      {banner && (
        <p className={`notice${banner.error ? " error" : ""}`} role={banner.error ? "alert" : "status"}>{banner.text}</p>
      )}

      {canExport && loadError && (
        <div className="xfer-card" role="alert">
          <h2>The export summary could not be loaded</h2>
          <p>{loadError}</p>
          <button type="button" className="btn-outline" onClick={load}><RefreshCw size={15} aria-hidden="true" /> Try again</button>
        </div>
      )}

      {canExport && !loadError && !summary && <LoadingIndicator message="Loading export summary" />}

      {canExport && summary && (
        <div className="xfer-layout">
          <div>
            <div className="xfer-card">
              <h2>1. Choose what to export</h2>
              <div className="xfer-cats">
                {CATEGORY_DEFS.map((def) => {
                  const total = def.count(counts);
                  const on = selected.includes(def.key);
                  return (
                    <label key={def.key} className={`xfer-cat${on ? " on" : ""}${total === 0 ? " disabled" : ""}`}>
                      <input type="checkbox" checked={on} disabled={total === 0 || busy} onChange={() => toggle(def.key)} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="title">{def.title}</div>
                        <div className="desc">{def.desc}</div>
                        {def.related && on && total > 0 && <div className="desc">Also included: {def.related(counts)}.</div>}
                      </div>
                      <span className="count">{total === 0 ? "Nothing to export" : plural(total, "record", "records")}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {selected.includes("maintenance_rules") && maintenanceAssets.length > 0 && (
              <div className="xfer-card">
                <h2>2. Limit maintenance rules by asset <span className="xfer-muted">(optional)</span></h2>
                <p>Leave everything unticked to export maintenance rules for all assets. Assets are referenced by name, type and parent, so they can be matched on import.</p>
                <div className="xfer-assets" role="group" aria-label="Assets">
                  {maintenanceAssets.map((asset) => (
                    <label key={asset.id}>
                      <input type="checkbox" checked={assetIds.includes(asset.id)} disabled={busy} onChange={() => toggleAsset(asset.id)} />
                      <span>{asset.name} <span className="xfer-muted">({asset.asset_type}) · {plural(asset.maintenance_rules, "rule", "rules")}</span></span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="xfer-card">
              <h2>File format</h2>
              <div className="xfer-chips"><span className="xfer-chip">JSON</span></div>
              <p style={{ marginTop: 8 }}>
                JSON is the only format NEM can both generate and import again, so it is the only one offered.
                Runtime counters, alerts, events, completed maintenance, user accounts and credentials are never included.
              </p>
            </div>

            <div className="xfer-card">
              <h2>Need a full database backup?</h2>
              <p style={{ marginBottom: 0 }}>
                Backup and restore are a separate operation under <Link to="/settings/backup">Settings → Backup and restore</Link>.
                A configuration export cannot restore your data.
              </p>
            </div>
          </div>

          <aside className="xfer-card xfer-side" aria-label="Export preview">
            <h2>Export preview</h2>
            <dl>
              <div><dt>Categories</dt><dd>{chosen.length ? chosen.map((def) => def.title).join(", ") : "None selected"}</dd></div>
              <div><dt>Records</dt><dd>{plural(totalRecords, "record", "records")}</dd></div>
              {selected.includes("collection_rules") && counts.collection_rules > 0 && (
                <div><dt>Related records</dt><dd>{plural(counts.collection_rule_members, "rule", "rules")} inside collections</dd></div>
              )}
              {selected.includes("maintenance_rules") && (
                <div><dt>Assets</dt><dd>{assetIds.length ? maintenanceAssets.filter((a) => assetIds.includes(a.id)).map((a) => a.name).join(", ") : "All assets"}</dd></div>
              )}
              <div><dt>Format</dt><dd>JSON (format version {summary.format_version})</dd></div>
              {chosen.length > 0 && <div><dt>File name</dt><dd>{fileName()}</dd></div>}
            </dl>
            {busy && <div className="xfer-bar" role="progressbar" aria-label="Exporting"><span /></div>}
            <div className="xfer-actions">
              {allSelected ? (
                <button type="button" className="btn-outline" disabled={busy || !selected.length} onClick={clearSelection}>Clear selection</button>
              ) : (
                <button type="button" className="btn-outline" disabled={busy} onClick={selected.length ? clearSelection : selectAll}>
                  {selected.length ? "Clear selection" : "Select all"}
                </button>
              )}
              <button type="button" className="btn-primary" disabled={busy || !selected.length || totalRecords === 0} onClick={download}>
                <Download size={16} aria-hidden="true" /> {busy ? "Exporting..." : "Export and download"}
              </button>
            </div>
            {!selected.length && <p className="xfer-muted" style={{ marginTop: 8 }}>Select at least one category.</p>}
          </aside>
        </div>
      )}
    </div>
  );
}
