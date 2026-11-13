import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Download, FileText, Upload, X } from "lucide-react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import "./ConfigTransfer.css";

const MAX_BYTES = 5 * 1024 * 1024; // matches the server limit for configuration packages

const CATEGORY_LABELS = {
  monitoring_rules: "Monitoring rules",
  collection_rules: "Rule collections",
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

// Asset mapping review. Each row is an exported asset that was not matched automatically. The destination list holds
// active assets of the same type only; assets with exactly the same name are offered first as suggestions. A
// suggestion is only ever applied by the Administrator (select it, or press "Use suggestion").
function AssetMapping({ references, disabled, onMap }) {
  const mappedCount = references.filter((ref) => ref.selected).length;
  return (
    <section className="xfer-map" aria-label="Asset mapping">
      <header className="xfer-map-head">
        <h3>Asset mapping</h3>
        <span className="xfer-muted">{mappedCount} of {references.length} mapped</span>
      </header>
      <ul className="xfer-map-list">
        {references.map((ref) => {
          const suggestions = ref.compatible.filter((a) => a.name_match);
          const others = ref.compatible.filter((a) => !a.name_match);
          const selected = ref.selected;
          const label = (a) => `${a.name}${a.parent_name ? ` — in ${a.parent_name}` : ""}`;
          const selectId = `map-${ref.key}`;
          return (
            <li key={ref.key} className={`xfer-map-item${selected ? " mapped" : ""}`}>
              <div className="xfer-map-src">
                <strong title={ref.name}>{ref.name}</strong>
                <div className="xfer-map-tags">
                  <span className="xfer-chip">{ref.asset_type}</span>
                  <span className="xfer-chip">{ref.records} {ref.records === 1 ? "rule" : "rules"}</span>
                </div>
                {ref.parent_name ? <span className="xfer-muted">in {ref.parent_name}</span> : null}
              </div>
              <div className="xfer-map-dest">
                {ref.compatible.length === 0 ? (
                  <p className="xfer-map-msg err">No {ref.asset_type} asset is available in this installation. These rules stay unresolved and are skipped.</p>
                ) : (
                  <>
                    <div className="xfer-map-row">
                      <select
                        id={selectId}
                        aria-label={`Destination for ${ref.name}`}
                        value={selected ? String(selected.id) : ""}
                        disabled={disabled}
                        onChange={(e) => onMap(ref.key, e.target.value)}
                      >
                        <option value="">Not mapped (skip these rules)</option>
                        {suggestions.length > 0 && (
                          <optgroup label="Suggested — same name">
                            {suggestions.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
                          </optgroup>
                        )}
                        {others.length > 0 && (
                          <optgroup label={`Other ${ref.asset_type} assets`}>
                            {others.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
                          </optgroup>
                        )}
                      </select>
                      {selected && (
                        <button type="button" className="xfer-ghost" disabled={disabled} onClick={() => onMap(ref.key, "")}>Clear</button>
                      )}
                      {!selected && suggestions.length > 0 && (
                        <button type="button" className="xfer-ghost" disabled={disabled} onClick={() => onMap(ref.key, suggestions[0].id)}>Use suggestion</button>
                      )}
                    </div>
                    {selected ? (
                      <p className="xfer-map-msg ok"><Check size={13} aria-hidden="true" /> Confirmed: {selected.name} ({selected.asset_type})</p>
                    ) : suggestions.length > 0 ? (
                      <p className="xfer-map-msg">Suggested match: {suggestions[0].name} — not applied until you choose it.</p>
                    ) : (
                      <p className="xfer-map-msg">No asset with this name. Choose one of the {ref.asset_type} assets if it is the same equipment.</p>
                    )}
                  </>
                )}
                {ref.problem ? <p className="xfer-map-msg err">{ref.problem}</p> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const statusClass = (status) =>
  status === "invalid" ? "alert" : status === "new" || status === "imported" ? "" : "warning";

const FRESH_OPTIONS = { on_duplicate: "skip", skip_invalid: false, asset_mappings: {}, supervisor_mappings: {} };

const formatBytes = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

// Spreadsheet programs run cells that start with = + - @, so neutralise those.
const csvCell = (value) => {
  let text = String(value ?? "").replace(/\r?\n/g, " ");
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

function downloadErrorReport(items, fileName) {
  const rows = items.filter((item) => item.status !== "new" && item.status !== "imported");
  const lines = [["Category", "Reference", "Name", "Status", "Details"].map(csvCell).join(",")];
  rows.forEach((item) => {
    const details = [...(item.errors || []), item.note, ...(item.warnings || [])].filter(Boolean).join(" | ");
    lines.push([CATEGORY_LABELS[item.category], item.ref, item.final_name || item.name, STATUS_LABELS[item.status] || item.status, details].map(csvCell).join(","));
  });
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileName.replace(/\.json$/i, "")}-import-report.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ItemsTable({ items, caption }) {
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const rows = items.filter((item) =>
    (status === "all" || item.status === status) &&
    (!needle || `${item.final_name || ""} ${item.name || ""} ${item.ref}`.toLowerCase().includes(needle)));
  const present = [...new Set(items.map((item) => item.status))];
  return (
    <>
      <div className="xfer-toolbar">
        <input type="search" aria-label="Search records" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option>
          {present.map((value) => <option key={value} value={value}>{STATUS_LABELS[value] || value}</option>)}
        </select>
      </div>
      <div className="xfer-table-wrap">
        <table className="xfer-table" aria-label={caption}>
          <thead><tr><th>Record</th><th>Category</th><th>Status</th><th>Validation</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={4} className="xfer-muted">No records match.</td></tr>}
            {rows.map((item) => (
              <tr key={`${item.category}-${item.ref}`}>
                <td>
                  <strong>{item.final_name || item.name || item.ref}</strong>
                  {item.rule_count != null && <span className="xfer-muted"> · {item.rule_count} rules</span>}
                </td>
                <td>{CATEGORY_LABELS[item.category]}</td>
                <td><span className={`badge ${statusClass(item.status)}`}>{STATUS_LABELS[item.status] || item.status}</span></td>
                <td>
                  {item.errors.map((e) => <div key={e} className="err">{e}</div>)}
                  {item.warnings.map((w) => <div key={w} className="note">⚠ {w}</div>)}
                  {item.note && <div className="note">{item.note}</div>}
                  {!item.errors.length && !item.warnings.length && !item.note && <span className="xfer-muted">Valid</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Administrator-only: choose a NEM export, review a server-side preview, confirm, then import. */
export default function ImportConfigurationPanel() {
  const { user } = useAuth();
  const isAdministrator = user?.role === "Administrator";
  const fileInput = useRef(null);

  const [pkg, setPkg] = useState(null);
  const [file, setFile] = useState(null); // { name, size }
  const [options, setOptions] = useState(FRESH_OPTIONS);
  const [preview, setPreview] = useState(null);
  const [supervisors, setSupervisors] = useState([]);
  const [phase, setPhase] = useState(null); // reading | validating | importing
  const [confirming, setConfirming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState({ text: "", error: false });
  const busy = phase !== null;

  useEffect(() => {
    if (!isAdministrator) return;
    api.get("/rule-visibility/supervisors").then((list) => setSupervisors(list || [])).catch(() => {});
  }, [isAdministrator]);

  const runPreview = useCallback(async (nextPackage, nextOptions) => {
    setPhase("validating");
    setMsg({ text: "", error: false });
    try {
      setPreview(await api.post("/config-transfer/preview", { package: nextPackage, ...nextOptions }));
    } catch (error) {
      setPreview(null);
      setMsg({ text: `The file cannot be imported: ${error.message}`, error: true });
    } finally {
      setPhase(null);
    }
  }, []);

  const reset = () => {
    setPkg(null); setFile(null); setPreview(null); setResult(null); setConfirming(false);
    setOptions(FRESH_OPTIONS); setMsg({ text: "", error: false });
  };

  const loadFile = async (picked) => {
    if (!picked || !isAdministrator) return;
    setResult(null); setPreview(null); setPkg(null); setConfirming(false);
    setMsg({ text: "", error: false });
    if (!/\.json$/i.test(picked.name)) {
      setFile(null);
      setMsg({ text: "Only .json files exported from NEM can be imported.", error: true });
      return;
    }
    if (picked.size === 0) {
      setFile(null);
      setMsg({ text: "The selected file is empty.", error: true });
      return;
    }
    if (picked.size > MAX_BYTES) {
      setFile(null);
      setMsg({ text: `The file is ${formatBytes(picked.size)}. The limit is ${formatBytes(MAX_BYTES)}.`, error: true });
      return;
    }
    setFile({ name: picked.name, size: picked.size });
    setPhase("reading");
    let data;
    try {
      data = JSON.parse(await picked.text());
    } catch {
      setPhase(null);
      setMsg({ text: "That file is not valid JSON. Nothing was imported.", error: true });
      return;
    }
    setOptions(FRESH_OPTIONS);
    setPkg(data);
    await runPreview(data, FRESH_OPTIONS);
  };

  const changeOptions = (patch) => {
    const next = { ...options, ...patch };
    setOptions(next);
    setConfirming(false);
    if (pkg) runPreview(pkg, next);
  };

  const mapAsset = (key, value) => {
    const mappings = { ...options.asset_mappings };
    if (value) mappings[key] = Number(value); else delete mappings[key];
    changeOptions({ asset_mappings: mappings });
  };

  const mapSupervisor = (username, value) => {
    const mappings = { ...options.supervisor_mappings };
    if (value) mappings[username] = [Number(value)]; else delete mappings[username];
    changeOptions({ supervisor_mappings: mappings });
  };

  const runImport = async () => {
    if (!preview?.can_import || busy) return;
    setPhase("importing");
    setMsg({ text: "", error: false });
    try {
      setResult(await api.post("/config-transfer/import", { package: pkg, ...options }));
      setPreview(null); setPkg(null); setConfirming(false);
    } catch (error) {
      setConfirming(false);
      setMsg({ text: `Import failed. Nothing was imported. ${error.message}`, error: true });
    } finally {
      setPhase(null);
    }
  };

  const toImport = useMemo(() => (preview ? preview.items.filter((i) => i.status === "new" || i.status === "renamed") : []), [preview]);
  const step = result ? 3 : preview ? (confirming ? 3 : 2) : 1;

  if (!isAdministrator) {
    return <p className="notice" role="status">Configuration import is restricted to Administrators.</p>;
  }

  const total = preview ? preview.items.length : 0;
  const renamed = preview ? preview.items.filter((i) => i.status === "renamed").length : 0;
  const newCount = preview ? preview.items.filter((i) => i.status === "new").length : 0;
  // Records that already exist, whichever way the Administrator decided to handle them (skipped, or renamed).
  const existingCount = preview ? preview.totals.duplicates + renamed : 0;
  const skippedCount = preview ? preview.totals.duplicates + preview.totals.unresolved : 0;

  return (
    <div>
      <ol className="xfer-steps" aria-label="Import steps">
        {["Select file", "Review and validate", "Confirm and import"].map((label, index) => {
          const number = index + 1;
          return (
            <li key={label} className={step === number ? "active" : step > number ? "done" : ""} aria-current={step === number ? "step" : undefined}>
              <b>{step > number ? "✓" : number}</b>{label}
            </li>
          );
        })}
      </ol>

      {msg.text && <p className={"notice" + (msg.error ? " error" : "")} role={msg.error ? "alert" : "status"}>{msg.text}</p>}

      {!result && (
        <div className="xfer-card">
          <h2>Select a NEM export file</h2>
          <p>Supported content, by category:</p>
          <div className="xfer-chips" style={{ marginBottom: 10 }}>
            {Object.values(CATEGORY_LABELS).map((label) => <span className="xfer-chip" key={label}>{label}</span>)}
          </div>

          {!file ? (
            <div
              className={`xfer-drop${dragging ? " dragging" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); loadFile(e.dataTransfer.files?.[0]); }}
            >
              <Upload size={24} aria-hidden="true" />
              <strong>Drag and drop a JSON file here</strong>
              <small>JSON exported by NEM · up to {formatBytes(MAX_BYTES)}</small>
              <button type="button" className="btn-outline" style={{ marginTop: 6 }} disabled={busy} onClick={() => fileInput.current?.click()}>Browse files</button>
            </div>
          ) : (
            <div className="xfer-file">
              <FileText size={16} aria-hidden="true" />
              <span className="name" title={file.name}>{file.name}</span>
              <span className="size">{formatBytes(file.size)}</span>
              <button type="button" className="btn-outline" disabled={busy} onClick={() => fileInput.current?.click()}>Replace</button>
              <button type="button" className="docs-icon-btn" aria-label="Remove file" disabled={busy} onClick={reset}><X size={14} /></button>
            </div>
          )}
          <input ref={fileInput} type="file" accept=".json,application/json" hidden
            onChange={(e) => { const picked = e.target.files?.[0]; e.target.value = ""; loadFile(picked); }} />

          {busy && (
            <>
              <div className="xfer-bar" role="progressbar" aria-label="Progress"><span /></div>
              <p className="xfer-muted" role="status" style={{ marginTop: 6 }}>
                {phase === "reading" ? "Reading the file…" : phase === "validating" ? "Validating on the server…" : "Importing…"}
              </p>
            </>
          )}
          <p className="xfer-muted" style={{ marginTop: 10, marginBottom: 0 }}>
            Rules are matched by name, never by database id, and existing records are never overwritten. Looking for a full
            database restore? That is a separate operation in <Link to="/settings/backup">Settings → Backup and restore</Link>.
          </p>
        </div>
      )}

      {preview && !result && !confirming && (
        <div className="xfer-card" aria-label="Import preview">
          <h2>Review — {file?.name}</h2>
          <p>
            Format {preview.package.format_version}
            {preview.package.exported_at ? `, exported ${preview.package.exported_at}` : ""}. Imported records are created by
            you; the file's origin is informational only.
          </p>

          <div className="xfer-stats">
            <div className="xfer-stat"><b>{total}</b><span>Records detected</span></div>
            <div className="xfer-stat good"><b>{newCount}</b><span>New</span></div>
            <div className="xfer-stat warn"><b>{renamed}</b><span>Existing (renamed)</span></div>
            <div className="xfer-stat warn"><b>{preview.totals.duplicates}</b><span>Duplicates</span></div>
            <div className="xfer-stat warn"><b>{preview.totals.unresolved}</b><span>Need an asset</span></div>
            <div className={`xfer-stat${preview.totals.invalid ? " bad" : ""}`}><b>{preview.totals.invalid}</b><span>Invalid</span></div>
          </div>

          {existingCount > 0 && (
            <div className="xfer-dup" role="radiogroup" aria-labelledby="import-dup-title">
              <p id="import-dup-title" className="xfer-dup-title">
                Some records already exist in your system. Do you want to import them again?
              </p>
              <p className="xfer-muted">
                {existingCount} existing {existingCount === 1 ? "record was" : "records were"} detected (monitoring rules, rule collections and maintenance rules).
              </p>
              <div className="xfer-dup-choices">
                <label className={`xfer-cat${options.on_duplicate === "skip" ? " on" : ""}`}>
                  <input type="radio" name="import-duplicates" checked={options.on_duplicate === "skip"} disabled={busy} onChange={() => changeOptions({ on_duplicate: "skip" })} />
                  <span>
                    <span className="title">No, Skip Existing</span>
                    <span className="desc" style={{ display: "block" }}>Skip all {existingCount} existing {existingCount === 1 ? "record" : "records"}. Nothing in your system is changed.</span>
                  </span>
                </label>
                <label className={`xfer-cat warn${options.on_duplicate === "rename" ? " on" : ""}`}>
                  <input type="radio" name="import-duplicates" checked={options.on_duplicate === "rename"} disabled={busy} onChange={() => changeOptions({ on_duplicate: "rename" })} />
                  <span>
                    <span className="title">Yes, Import Again</span>
                    <span className="desc" style={{ display: "block" }}>Add them as additional records with automatically generated unique names, for example “Name (imported)”. Existing records are never overwritten or modified.</span>
                  </span>
                </label>
              </div>
              <p className="xfer-dup-summary" role="status">
                With this choice: <strong>{toImport.length}</strong> will be imported
                {options.on_duplicate === "rename" && renamed ? <> (including <strong>{renamed}</strong> under new names)</> : null}
                , <strong>{skippedCount}</strong> will be skipped.
              </p>
            </div>
          )}

          {preview.totals.invalid > 0 && (
            <div className="xfer-fields">
              <label className="rule-visibility-option">
                <input type="checkbox" checked={options.skip_invalid} disabled={busy} onChange={(e) => changeOptions({ skip_invalid: e.target.checked })} />
                <span>Reject invalid records and import the rest</span>
              </label>
            </div>
          )}

          {(preview.asset_references || []).length > 0 && (
            <AssetMapping references={preview.asset_references} disabled={busy} onMap={mapAsset} />
          )}

          {preview.unresolved_supervisors.length > 0 && (
            <>
              <p>Supervisors not found in this installation. Map each one, or the rule falls back to Admin Only.</p>
              <div className="xfer-fields">
                {preview.unresolved_supervisors.map((username) => (
                  <div className="field" key={username}>
                    <label>{username}</label>
                    <select value={options.supervisor_mappings[username]?.[0] || ""} disabled={busy} onChange={(e) => mapSupervisor(username, e.target.value)}>
                      <option value="">Do not assign</option>
                      {supervisors.map((s) => <option key={s.id} value={s.id}>{s.username}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </>
          )}

          <ItemsTable items={preview.items} caption="Records in the file" />

          <div className="xfer-actions">
            {preview.items.some((i) => i.status !== "new") && (
              <button type="button" className="btn-outline grow" onClick={() => downloadErrorReport(preview.items, file?.name || "import")}>
                <Download size={15} aria-hidden="true" /> Download validation report
              </button>
            )}
            <button type="button" className="btn-outline" disabled={busy} onClick={reset}>Cancel</button>
            <button type="button" className="btn-primary" disabled={!preview.can_import || busy} onClick={() => setConfirming(true)}>
              Review {preview.totals.to_import} to import
            </button>
          </div>
          {!preview.can_import && (
            <p className="xfer-muted" style={{ textAlign: "right", marginTop: 6 }}>
              {preview.totals.invalid > 0 && !options.skip_invalid
                ? "Fix the invalid records in the file, or choose to reject them, to continue."
                : "There is nothing to import."}
            </p>
          )}
        </div>
      )}

      {preview && !result && confirming && (
        <div className="xfer-card" aria-label="Confirm import">
          <h2>Confirm import from {file?.name}</h2>
          <ul className="xfer-summary">
            <li><strong>{newCount}</strong> will be created{renamed ? <>, plus <strong>{renamed}</strong> created under a new name</> : null}.</li>
            <li><strong>0</strong> will be updated — existing records are never overwritten.</li>
            <li><strong>{preview.totals.duplicates + preview.totals.unresolved}</strong> will be skipped (duplicates or missing assets).</li>
            <li><strong>{preview.totals.invalid}</strong> {preview.totals.invalid ? "will be rejected and not imported." : "invalid."}</li>
          </ul>
          <ItemsTable items={toImport} caption="Records to be created" />
          <p className="xfer-muted" style={{ marginTop: 10 }}>The import is all-or-nothing: if anything fails, nothing is created.</p>
          <div className="xfer-actions">
            <button type="button" className="btn-outline" disabled={busy} onClick={() => setConfirming(false)}>Back</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={runImport}>
              {busy ? "Importing…" : `Confirm and import ${preview.totals.to_import}`}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="xfer-card" aria-label="Import result">
          <h2>Import complete</h2>
          <div className="xfer-stats">
            <div className="xfer-stat good"><b>{result.summary.imported}</b><span>Imported</span></div>
            <div className="xfer-stat"><b>0</b><span>Updated</span></div>
            <div className="xfer-stat warn"><b>{result.summary.duplicates + result.summary.unresolved}</b><span>Skipped</span></div>
            <div className={`xfer-stat${result.summary.failed ? " bad" : ""}`}><b>{result.summary.failed}</b><span>Failed</span></div>
          </div>
          <ItemsTable items={result.items} caption="Import results" />
          <div className="xfer-actions">
            {result.items.some((i) => i.status !== "imported") && (
              <button type="button" className="btn-outline grow" onClick={() => downloadErrorReport(result.items, file?.name || "import")}>
                <Download size={15} aria-hidden="true" /> Download error report
              </button>
            )}
            <button type="button" className="btn-primary" onClick={reset}>Import another file</button>
          </div>
        </div>
      )}
    </div>
  );
}
