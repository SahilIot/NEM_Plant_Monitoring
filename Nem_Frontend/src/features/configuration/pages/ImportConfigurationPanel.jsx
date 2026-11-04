import React, { useCallback, useEffect, useState } from "react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { useConfirmation } from "../../../components/common/UI.jsx";

const CATEGORY_LABELS = {
  monitoring_rules: "Monitoring rules",
  collection_rules: "Monitoring rule collections",
  maintenance_rules: "Maintenance rules",
};

const STATUS_LABELS = {
  new: "New",
  renamed: "Renamed",
  duplicate: "Duplicate (skipped)",
  unresolved: "Needs asset (skipped)",
  invalid: "Invalid",
  imported: "Imported",
};

const statusClass = (status) =>
  status === "invalid" ? "alert" : status === "new" || status === "imported" ? "" : "warning";

/** Administrator-only: choose a NEM export, review a server-side preview, then import it. */
export default function ImportConfigurationPanel() {
  const { user } = useAuth();
  const confirm = useConfirmation();
  const isAdministrator = user?.role === "Administrator";

  const [pkg, setPkg] = useState(null);
  const [fileName, setFileName] = useState("");
  const [options, setOptions] = useState({
    on_duplicate: "skip",
    skip_invalid: false,
    asset_mappings: {},
    supervisor_mappings: {},
  });
  const [preview, setPreview] = useState(null);
  const [assets, setAssets] = useState([]);
  const [supervisors, setSupervisors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState({ text: "", error: false });

  useEffect(() => {
    if (!isAdministrator) return;
    api.getAll("/assets").then((list) => setAssets(list || [])).catch(() => {});
    api.get("/rule-visibility/supervisors").then((list) => setSupervisors(list || [])).catch(() => {});
  }, [isAdministrator]);

  const runPreview = useCallback(async (nextPackage, nextOptions) => {
    setBusy(true);
    setMsg({ text: "", error: false });
    try {
      setPreview(await api.post("/config-transfer/preview", { package: nextPackage, ...nextOptions }));
    } catch (error) {
      setPreview(null);
      setMsg({ text: `The file cannot be imported: ${error.message}`, error: true });
    } finally {
      setBusy(false);
    }
  }, []);

  const onFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !isAdministrator) return;
    setResult(null);
    setPreview(null);
    setPkg(null);
    setMsg({ text: "", error: false });
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      setMsg({ text: "That file is not valid JSON. Nothing was imported.", error: true });
      return;
    }
    const fresh = { on_duplicate: "skip", skip_invalid: false, asset_mappings: {}, supervisor_mappings: {} };
    setOptions(fresh);
    setPkg(data);
    setFileName(file.name);
    await runPreview(data, fresh);
  };

  const changeOptions = (patch) => {
    const next = { ...options, ...patch };
    setOptions(next);
    if (pkg) runPreview(pkg, next);
  };

  const mapAsset = (key, value) => {
    const mappings = { ...options.asset_mappings };
    if (value) mappings[key] = Number(value);
    else delete mappings[key];
    changeOptions({ asset_mappings: mappings });
  };

  const mapSupervisor = (username, value) => {
    const mappings = { ...options.supervisor_mappings };
    if (value) mappings[username] = [Number(value)];
    else delete mappings[username];
    changeOptions({ supervisor_mappings: mappings });
  };

  const runImport = async () => {
    if (!preview?.can_import || busy) return;
    const proceed = await confirm(
      `Import ${preview.totals.to_import} item(s) from "${fileName}"? Existing rules are never overwritten. ` +
        "The import is all-or-nothing: if anything fails, nothing is created.",
      { title: "Import configuration", confirmLabel: "Import" }
    );
    if (!proceed) return;
    setBusy(true);
    setMsg({ text: "", error: false });
    try {
      setResult(await api.post("/config-transfer/import", { package: pkg, ...options }));
      setPreview(null);
      setPkg(null);
    } catch (error) {
      setMsg({ text: `Import failed. Nothing was imported. ${error.message}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  if (!isAdministrator) {
    return (
      <div className="panel">
        <p className="notice" role="status">Configuration import is restricted to Administrators.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <p className="muted">
        Choose a JSON file exported from NEM (Export configuration). It is validated and previewed before
        anything is created. Rules are matched by name, never by database id, and existing records are
        never overwritten.
      </p>
      <input type="file" accept=".json,application/json" disabled={busy} onChange={onFile} />

      {busy && <p className="muted" role="status">{result === null && preview ? "Working…" : "Checking the file…"}</p>}
      {msg.text && <p className={"notice" + (msg.error ? " error" : "")} role="alert">{msg.text}</p>}

      {preview && (
        <section aria-label="Import preview">
          <h3>Preview — {fileName}</h3>
          <p className="muted">
            Format {preview.package.format_version}
            {preview.package.exported_at ? `, exported ${preview.package.exported_at}` : ""}. Imported records are
            created by you; the file's origin is informational only.
          </p>
          <table className="table">
            <thead>
              <tr><th>Category</th><th>New</th><th>Renamed</th><th>Duplicates</th><th>Needs asset</th><th>Invalid</th></tr>
            </thead>
            <tbody>
              {Object.entries(preview.counts).map(([category, c]) => (
                <tr key={category}>
                  <td>{CATEGORY_LABELS[category]}</td>
                  <td>{c.new}</td><td>{c.renamed}</td><td>{c.duplicate}</td><td>{c.unresolved}</td><td>{c.invalid}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="field">
            <label htmlFor="import-duplicates">If a rule with the same name already exists</label>
            <select id="import-duplicates" value={options.on_duplicate} disabled={busy}
              onChange={(e) => changeOptions({ on_duplicate: e.target.value })}>
              <option value="skip">Skip it (leave the existing rule unchanged)</option>
              <option value="rename">Import it under a new name</option>
            </select>
          </div>

          {preview.unresolved_assets.length > 0 && (
            <div className="field">
              <strong>Choose destination assets for maintenance rules</strong>
              {preview.unresolved_assets.map((asset) => (
                <label key={asset.key} className="field">
                  {asset.name} ({asset.asset_type}{asset.parent_name ? `, in ${asset.parent_name}` : ""})
                  <select value={options.asset_mappings[asset.key] || ""} disabled={busy}
                    onChange={(e) => mapAsset(asset.key, e.target.value)}>
                    <option value="">Skip these maintenance rules</option>
                    {assets.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.asset_type})</option>)}
                  </select>
                </label>
              ))}
            </div>
          )}

          {preview.unresolved_supervisors.length > 0 && (
            <div className="field">
              <strong>Supervisors not found in this installation</strong>
              <p className="muted">Map each one to a Supervisor here, or the rule falls back to Admin Only.</p>
              {preview.unresolved_supervisors.map((username) => (
                <label key={username} className="field">
                  {username}
                  <select value={options.supervisor_mappings[username]?.[0] || ""} disabled={busy}
                    onChange={(e) => mapSupervisor(username, e.target.value)}>
                    <option value="">Do not assign</option>
                    {supervisors.map((s) => <option key={s.id} value={s.id}>{s.username}</option>)}
                  </select>
                </label>
              ))}
            </div>
          )}

          {preview.totals.invalid > 0 && (
            <label className="rule-visibility-option">
              <input type="checkbox" checked={options.skip_invalid} disabled={busy}
                onChange={(e) => changeOptions({ skip_invalid: e.target.checked })} />
              <span>Skip invalid entries and import the rest (otherwise nothing is imported)</span>
            </label>
          )}

          <ul>
            {preview.items.map((item) => (
              <li key={`${item.category}-${item.ref}`}>
                <span className={`badge ${statusClass(item.status)}`}>{STATUS_LABELS[item.status]}</span>{" "}
                <strong>{item.final_name || item.name || item.ref}</strong>{" "}
                <span className="muted">({CATEGORY_LABELS[item.category]}{item.rule_count != null ? `, ${item.rule_count} rules` : ""})</span>
                {item.note && <div className="muted">{item.note}</div>}
                {item.errors.map((e) => <div key={e} className="notice error">{e}</div>)}
                {item.warnings.map((w) => <div key={w} className="muted">⚠ {w}</div>)}
              </li>
            ))}
          </ul>

          <button type="button" className="btn-primary" disabled={!preview.can_import || busy} onClick={runImport}>
            {busy ? "Importing…" : `Import ${preview.totals.to_import} item(s)`}
          </button>
          {!preview.can_import && (
            <p className="muted">
              {preview.totals.invalid > 0 && !options.skip_invalid
                ? "Fix the invalid entries or choose to skip them to continue."
                : "There is nothing to import."}
            </p>
          )}
        </section>
      )}

      {result && (
        <section aria-label="Import result">
          <p className="notice" role="status">
            Imported {result.summary.imported}. Skipped as duplicates: {result.summary.duplicates}. Needing an
            asset (skipped): {result.summary.unresolved}. Failed: {result.summary.failed}.
          </p>
          <ul>
            {result.items.map((item) => (
              <li key={`${item.category}-${item.ref}`}>
                <span className={`badge ${statusClass(item.status)}`}>{STATUS_LABELS[item.status]}</span>{" "}
                {item.final_name || item.name} <span className="muted">({CATEGORY_LABELS[item.category]})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
