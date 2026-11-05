import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Eye, RotateCcw, Trash2, Upload } from "lucide-react";
import { api } from "../../../services/api.js";
import { formatTime } from "../../../utils/format.js";
import { DotsIcon } from "../../../components/common/Icons.jsx";
import {
  EmptyState,
  FloatingMenu,
  LoadingIndicator,
  Modal,
  useConfirmation,
} from "../../../components/common/UI.jsx";
import "./BackupRestore.css";

const formatBytes = (value) => {
  if (value === null || value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
};
const formatCount = (value) => (value === null || value === undefined ? "—" : Number(value).toLocaleString());
const STATUS = {
  ok: { label: "Valid", cls: "" },
  warning: { label: "Warnings", cls: "warning" },
  unreadable: { label: "Unreadable", cls: "alert" },
  file_missing: { label: "File missing", cls: "alert" },
};
const StatusBadge = ({ status }) => {
  const item = STATUS[status] || { label: status || "Unknown", cls: "unknown" };
  return <span className={`badge ${item.cls}`}>{item.label}</span>;
};
const docLabel = (item) => `document ${item.document_id ?? "?"} “${item.original_name || "unnamed"}” (${item.stored_name})`;

function Stat({ label, value, hint, tone }) {
  return (
    <div className={`br-stat${tone ? ` ${tone}` : ""}`}>
      <div className="br-stat-label">{label}</div>
      <div className="br-stat-value">{value}</div>
      {hint && <div className="br-stat-hint">{hint}</div>}
    </div>
  );
}

function DocList({ items, empty = "None" }) {
  if (!items?.length) return <span className="muted">{empty}</span>;
  return (
    <ul className="br-list">
      {items.slice(0, 20).map((item) => <li key={item.stored_name}>{docLabel(item)}</li>)}
      {items.length > 20 && <li className="muted">and {items.length - 20} more</li>}
    </ul>
  );
}

function RowsTable({ rows }) {
  const entries = Object.entries(rows || {}).filter(([, count]) => count > 0);
  if (!entries.length) return <span className="muted">No rows.</span>;
  return (
    <div className="br-scroll">
      <table className="table br-compact">
        <thead><tr><th>Table</th><th className="right">Rows</th></tr></thead>
        <tbody>{entries.map(([name, count]) => <tr key={name}><td>{name}</td><td className="right">{formatCount(count)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- Create */
function CreateBackupModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", note: "" });
  const [phase, setPhase] = useState("form"); // form | working | done
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const submit = async (event) => {
    event.preventDefault();
    if (submitting.current) return; // no duplicate submissions
    submitting.current = true;
    setPhase("working");
    setError("");
    try {
      const created = await api.post("/backups", { name: form.name.trim() || null, note: form.note.trim() || null });
      setResult(created);
      setPhase("done");
      onCreated();
    } catch (err) {
      setError(err.message);
      setPhase("form");
    } finally {
      submitting.current = false;
    }
  };
  const rowTotal = result ? Object.values(result.rows || {}).reduce((a, b) => a + b, 0) : 0;
  return (
    <Modal title="Create backup" wide onClose={phase === "working" ? undefined : onClose}>
      {phase === "done" ? (
        <>
          <p className="notice flush">Backup “{result.name}” was created and saved.</p>
          <div className="br-facts">
            <span><b>{formatCount(Object.keys(result.rows || {}).length)}</b> tables</span>
            <span><b>{formatCount(rowTotal)}</b> rows</span>
            <span><b>{formatCount(result.files)}</b> attachment files</span>
          </div>
          {result.warnings?.length > 0 && (
            <div className="br-callout warn"><b>Attachment warnings</b>{result.warnings.map((w) => <p key={w}>{w}</p>)}</div>
          )}
          <div className="modal-actions"><button type="button" className="btn-primary" onClick={onClose}>Close</button></div>
        </>
      ) : (
        <form onSubmit={submit}>
          <p className="muted modal-intro">One consistent snapshot of the database and the uploaded instruction files. User accounts are not included.</p>
          <div className="field"><label htmlFor="bk-name">Backup name</label>
            <input id="bk-name" value={form.name} maxLength={200} disabled={phase === "working"} placeholder="Leave empty for an automatic name" onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="bk-note">Description (optional)</label>
            <textarea id="bk-note" value={form.note} disabled={phase === "working"} placeholder="Why are you taking this backup?" onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          {phase === "working" && <LoadingIndicator message="Creating backup. This can take a while for large databases" compact />}
          {error && <p className="notice error" role="alert">Could not create the backup: {error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-outline" disabled={phase === "working"} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={phase === "working"}>{phase === "working" ? "Creating…" : "Create backup"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------- Details */
function DetailsModal({ backup, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { api.get(`/backups/${backup.id}`).then(setData).catch((e) => setError(e.message)); }, [backup.id]);
  return (
    <Modal title={`Backup details — ${backup.name}`} wide onClose={onClose}>
      {error && <p className="notice error">Could not load details: {error}</p>}
      {!data && !error && <LoadingIndicator compact />}
      {data && (
        <div className="br-details">
          <dl className="br-meta">
            <dt>Created</dt><dd>{formatTime(data.created)}</dd>
            <dt>Format</dt><dd>version {data.format_version ?? "?"}{data.format_version === 1 ? " (old format)" : ""}</dd>
            <dt>File size</dt><dd>{formatBytes(data.size_bytes)}</dd>
            <dt>Status</dt><dd><StatusBadge status={data.status} /></dd>
            {data.note && (<><dt>Description</dt><dd>{data.note}</dd></>)}
            {data.snapshot && (<><dt>Snapshot</dt><dd>{data.snapshot}</dd></>)}
          </dl>
          <p className="muted br-hint">Structure and manifest were read. Every table and attachment checksum is verified in full when you validate the backup for restore.</p>
          {data.warnings?.map((w) => <div className="br-callout warn" key={w}>{w}</div>)}
          {data.limitations?.map((w) => <div className="br-callout warn" key={w}>{w}</div>)}
          {data.table_rows && (<><h4>Tables ({data.tables}) — {formatCount(data.rows)} rows</h4><RowsTable rows={data.table_rows} /></>)}
          <h4>Attachments ({formatCount(data.attachments)})</h4>
          {data.files?.length > 0 ? (
            <div className="br-scroll">
              <table className="table br-compact"><thead><tr><th>Stored file</th><th className="right">Size</th></tr></thead>
                <tbody>{data.files.map((f) => <tr key={f.stored_name}><td>{f.stored_name}</td><td className="right">{formatBytes(f.size_bytes)}</td></tr>)}</tbody></table>
            </div>
          ) : <p className="muted">No attachment files in this backup.</p>}
          {data.missing_details?.length > 0 && (<><h4>Missing when backed up</h4><DocList items={data.missing_details} /></>)}
          {data.inconsistent_details?.length > 0 && (<><h4>Size differs from database record</h4>
            <ul className="br-list">{data.inconsistent_details.map((d) => <li key={d.stored_name}>{docLabel(d)} — recorded {formatBytes(d.recorded_size)}, found {formatBytes(d.actual_size)}</li>)}</ul></>)}
        </div>
      )}
      <div className="modal-actions"><button type="button" className="btn-outline" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

/* ----------------------------------------------------------- Restore flow */
const STEPS = ["Select", "Validate", "Impact", "Confirm", "Restore", "Result"];

function Steps({ current }) {
  return (
    <ol className="br-steps" aria-label="Restore progress">
      {STEPS.map((label, index) => (
        <li key={label} className={index + 1 === current ? "current" : index + 1 < current ? "done" : ""} aria-current={index + 1 === current ? "step" : undefined}>
          <span>{index + 1}</span>{label}
        </li>
      ))}
    </ol>
  );
}

function Check({ ok, children, warn }) {
  return <li className={ok ? "ok" : warn ? "warn" : "bad"}><span aria-hidden="true">{ok ? "✓" : warn ? "!" : "✕"}</span>{children}</li>;
}

function ImpactView({ preview }) {
  const ext = preview.external || { cascade: [], set_null: [], set_default: [], blockers: [] };
  const att = preview.attachments || { restore: 0, renamed: [], missing: [] };
  const replaced = (preview.tables || []).filter((t) => t.current > 0 || t.restore > 0);
  const destructive = ext.cascade.length > 0 || ext.set_default.length > 0 || ext.set_null.some((i) => i.cleared > 0);
  return (
    <div className="br-impact">
      <h4>Replaced by this backup <span className="muted">(normal behaviour)</span></h4>
      <div className="br-scroll">
        <table className="table br-compact">
          <thead><tr><th>Table</th><th className="right">Now</th><th className="right">After restore</th></tr></thead>
          <tbody>{replaced.map((t) => <tr key={t.table}><td>{t.table}</td><td className="right">{formatCount(t.current)}</td><td className="right">{formatCount(t.restore)}</td></tr>)}</tbody>
        </table>
      </div>
      <h4>Attachments</h4>
      <ul className="br-list">
        <li>{formatCount(att.restore)} attachment file(s) will be restored.</li>
        {att.renamed.length > 0 && <li className="warn-text">{att.renamed.length} will be stored under a new file name because a different file with the same name already exists (the existing file is kept).</li>}
        {att.missing.length > 0 && <li className="warn-text">{att.missing.length} were already missing when the backup was made; those documents will show “File missing”.</li>}
      </ul>
      {att.renamed.length > 0 && <DocList items={att.renamed} />}
      {att.missing.length > 0 && <DocList items={att.missing} />}
      <h4>Outside the backup <span className="muted">(not part of the backup)</span></h4>
      {!destructive && ext.blockers.length === 0 && <p className="muted">No records outside the backup are deleted or changed.</p>}
      {ext.cascade.length > 0 && (
        <div className="br-callout danger"><b>Will be permanently deleted</b>
          <ul className="br-list">{ext.cascade.map((i) => <li key={`${i.table}.${i.column}`}>{formatCount(i.rows)} row(s) in <code>{i.table}</code> (linked through {i.column} to {i.references})</li>)}</ul></div>
      )}
      {ext.set_default.length > 0 && (
        <div className="br-callout danger"><b>Will be reset to the column default</b>
          <ul className="br-list">{ext.set_default.map((i) => <li key={`${i.table}.${i.column}`}>{formatCount(i.rows)} value(s) in <code>{i.table}.{i.column}</code></li>)}</ul></div>
      )}
      {ext.set_null.length > 0 && (
        <div className={`br-callout ${ext.set_null.some((i) => i.cleared > 0) ? "danger" : "info"}`}><b>Links to replaced records</b>
          <ul className="br-list">{ext.set_null.map((i) => <li key={`${i.table}.${i.column}`}><code>{i.table}.{i.column}</code>: {formatCount(i.relinked)} link(s) are kept, {formatCount(i.cleared)} will be cleared (the target is not in the backup)</li>)}</ul></div>
      )}
      {ext.blockers.length > 0 && (
        <div className="br-callout danger"><b>Restore is blocked</b>
          <ul className="br-list">{ext.blockers.map((i) => <li key={`${i.table}.${i.column}`}>{formatCount(i.rows)} row(s) in <code>{i.table}</code> still depend on data this restore replaces.</li>)}</ul></div>
      )}
      {preview.limitations?.map((text) => <div className="br-callout warn" key={text}><b>Old backup format</b><p>{text}</p></div>)}
      {preview.warnings?.length > 0 && <div className="br-callout warn"><b>Other notes</b>{preview.warnings.map((w) => <p key={w}>{w}</p>)}</div>}
    </div>
  );
}

function ResultView({ result }) {
  const partial = result.outcome === "partial";
  const ext = result.external || { cascade: [], set_null: [], set_default: [] };
  return (
    <div className="br-result">
      <div className={`br-callout ${partial ? "warn" : "ok"}`}>
        <b>{partial ? "Database restored — attachment files incomplete" : "Restore complete"}</b>
        <p>The database transaction was committed. {partial
          ? "Some attachment files could not be placed, so this restore is only partially complete (see below)."
          : "All attachment files were placed."}</p>
      </div>
      <div className="br-facts">
        <span><b>{formatCount(Object.values(result.rows || {}).reduce((a, b) => a + b, 0))}</b> rows restored</span>
        <span><b>{formatCount(result.files)}</b> attachments placed</span>
        <span><b>{formatCount(result.renamed?.length)}</b> renamed</span>
        <span><b>{formatCount(result.missing_attachments?.length)}</b> missing</span>
      </div>
      {result.failed_files?.length > 0 && (
        <div className="br-callout danger"><b>Attachment files not placed ({result.failed_files.length})</b>
          <ul className="br-list">{result.failed_files.map((f) => <li key={f.stored_name}>{docLabel(f)} — {f.reason}</li>)}</ul>
          {result.recovery_folder && <p>The files were kept in the recovery folder <code>{result.recovery_folder}</code>. Use “Retry” in the recovery panel on the Backup page after fixing the cause (permissions or a conflicting file).</p>}
        </div>
      )}
      {result.renamed?.length > 0 && (<><h4>Renamed attachments</h4>
        <ul className="br-list">{result.renamed.map((f) => <li key={f.stored_name}>{docLabel(f)} → {f.new_stored_name}</li>)}</ul></>)}
      {result.missing_attachments?.length > 0 && (<><h4>Missing attachments</h4><DocList items={result.missing_attachments} /></>)}
      {(ext.cascade.length > 0 || ext.set_null.length > 0 || ext.set_default.length > 0) && (
        <><h4>Changes outside the backup</h4>
          <ul className="br-list">
            {ext.cascade.map((i) => <li key={`c${i.table}`}>{formatCount(i.rows)} row(s) of {i.table} deleted</li>)}
            {ext.set_null.map((i) => <li key={`n${i.table}${i.column}`}>{i.table}.{i.column}: {formatCount(i.relinked)} kept, {formatCount(i.cleared)} cleared</li>)}
            {ext.set_default.map((i) => <li key={`d${i.table}${i.column}`}>{i.table}.{i.column}: {formatCount(i.rows)} reset to default</li>)}
          </ul></>
      )}
      {result.migration_warnings?.length > 0 && <div className="br-callout warn"><b>Follow-up steps</b>{result.migration_warnings.map((w) => <p key={w}>{w}</p>)}</div>}
      <h4>Rows restored per table</h4>
      <RowsTable rows={result.rows} />
    </div>
  );
}

function RestoreWizard({ backup, onClose, onDone }) {
  const [step, setStep] = useState(1);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const [ack, setAck] = useState({ replace: false, external: false, legacy: false });
  const [typed, setTyped] = useState("");
  const running = useRef(false);

  const validate = useCallback(async () => {
    setStep(2); setPreview(null); setError(""); setAck({ replace: false, external: false, legacy: false }); setTyped("");
    try {
      setPreview(await api.post(`/backups/${backup.id}/restore/preview`));
    } catch (err) {
      setError(err.message);
    }
  }, [backup.id]);

  const run = async () => {
    if (running.current) return; // no duplicate restore submissions
    running.current = true;
    setStep(5); setError(""); setUnknownOutcome(false);
    try {
      setResult(await api.post(`/backups/${backup.id}/restore`, { confirmation_token: preview.confirmation_token }));
      onDone();
    } catch (err) {
      if (err.status === 0) setUnknownOutcome(true);
      setError(err.message);
    } finally {
      running.current = false;
      setStep(6);
    }
  };

  const external = preview?.external;
  const destructiveExternal = Boolean(external && (external.cascade.length || external.set_default.length || external.set_null.some((i) => i.cleared > 0)));
  const legacy = Boolean(preview?.backup?.legacy);
  const confirmReady = ack.replace && (!destructiveExternal || ack.external) && (!legacy || ack.legacy) && typed.trim().toUpperCase() === "RESTORE";
  const busy = step === 5 || (step === 2 && !preview && !error);

  return (
    <Modal title={`Restore backup — ${backup.name}`} wide onClose={busy ? undefined : onClose}>
      <Steps current={step} />
      {step === 1 && (
        <>
          <dl className="br-meta">
            <dt>Backup</dt><dd>{backup.name}</dd>
            <dt>Created</dt><dd>{formatTime(backup.created)}</dd>
            <dt>Format</dt><dd>version {backup.format_version ?? "?"}</dd>
            <dt>Size</dt><dd>{formatBytes(backup.size_bytes)}</dd>
            <dt>Contents</dt><dd>{formatCount(backup.tables)} tables · {formatCount(backup.rows)} rows · {formatCount(backup.attachments)} attachments</dd>
          </dl>
          <p className="muted">Nothing is changed yet. The next step checks the backup completely and shows exactly what a restore would do.</p>
          <div className="modal-actions">
            <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" onClick={validate}>Validate backup</button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          {!preview && !error && <LoadingIndicator message="Validating the backup (checksums, tables, references, attachments)" compact />}
          {error && <div className="br-callout danger"><b>Validation could not run</b><p>{error}</p></div>}
          {preview && (
            <ul className="br-checks">
              <Check ok={preview.valid}>{preview.valid ? "Archive is valid and complete." : "The backup is not valid."}</Check>
              {preview.valid && <Check ok>All required tables are present.</Check>}
              {preview.valid && <Check ok={preview.validation.checksums_verified} warn={!preview.validation.checksums_verified}>{preview.validation.checksums_verified ? `Checksums verified for every table and ${preview.validation.attachments_verified} attachment file(s).` : "Old format: no checksums are available to verify."}</Check>}
              {preview.valid && <Check ok={!preview.validation.legacy_limitations} warn={preview.validation.legacy_limitations}>{preview.validation.legacy_limitations ? "Old backup format: some data is not included (details in the next step)." : "Current backup format."}</Check>}
              {preview.valid && <Check ok={(preview.attachments.missing || []).length === 0} warn>{(preview.attachments.missing || []).length === 0 ? "No missing attachments." : `${preview.attachments.missing.length} attachment(s) were missing when this backup was made.`}</Check>}
              {preview.issues?.map((issue) => <Check key={issue} ok={false}>{issue}</Check>)}
            </ul>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-outline" disabled={!preview && !error} onClick={onClose}>Close</button>
            {preview?.valid && <button type="button" className="btn-primary" onClick={() => setStep(3)}>Preview impact</button>}
            {(error || (preview && !preview.valid)) && <button type="button" className="btn-outline" onClick={validate}>Validate again</button>}
          </div>
        </>
      )}
      {step === 3 && preview && (
        <>
          <ImpactView preview={preview} />
          <div className="modal-actions">
            <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" disabled={!preview.can_restore} onClick={() => setStep(4)}>Continue to confirmation</button>
          </div>
        </>
      )}
      {step === 4 && preview && (
        <>
          <div className="br-callout danger">
            <b><AlertTriangle size={16} aria-hidden="true" /> This replaces your current data</b>
            <p>Restoring “{backup.name}” replaces the current assets, variables, readings, rules, collections, alerts, events, maintenance data and instructions with the contents of this backup. User accounts are not changed. This cannot be undone — create a fresh backup first if you may need the current data.</p>
          </div>
          <label className="br-check"><input type="checkbox" checked={ack.replace} onChange={(e) => setAck({ ...ack, replace: e.target.checked })} /> I understand that the current data in this scope will be replaced.</label>
          {destructiveExternal && (
            <label className="br-check danger-text"><input type="checkbox" checked={ack.external} onChange={(e) => setAck({ ...ack, external: e.target.checked })} />
              I understand that records outside the backup will be permanently deleted or changed as listed in the impact preview
              {external.cascade.length > 0 && <> ({external.cascade.map((i) => `${formatCount(i.rows)} in ${i.table}`).join(", ")})</>}.</label>
          )}
          {legacy && (
            <label className="br-check"><input type="checkbox" checked={ack.legacy} onChange={(e) => setAck({ ...ack, legacy: e.target.checked })} /> I understand that this old-format backup does not contain several tables and no attachment files.</label>
          )}
          <div className="field"><label htmlFor="bk-type">Type RESTORE to continue</label>
            <input id="bk-type" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} /></div>
          <div className="modal-actions">
            <button type="button" className="btn-outline" onClick={() => setStep(3)}>Back</button>
            <button type="button" className="btn-danger" disabled={!confirmReady} onClick={run}><RotateCcw size={16} /> Restore database</button>
          </div>
        </>
      )}
      {step === 5 && (
        <>
          <LoadingIndicator message="Restoring. Keep this window open; monitoring writes wait until the restore finishes" />
          <p className="muted">The restore runs as one database transaction. A result is shown only when the server confirms the outcome.</p>
        </>
      )}
      {step === 6 && (
        <>
          {error && !result && (
            <div className="br-callout danger">
              <b>{unknownOutcome ? "The outcome is unknown" : "Restore did not complete"}</b>
              <p>{error}</p>
              {unknownOutcome && <p>The connection was lost before the server answered. Check the data and the backup list before trying again.</p>}
            </div>
          )}
          {result && <ResultView result={result} />}
          <div className="modal-actions">
            {error && !result && !unknownOutcome && /preview again|changed since|expired|confirmation/i.test(error) && <button type="button" className="btn-outline" onClick={validate}>Run preview again</button>}
            <button type="button" className="btn-primary" onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------- Recovery */
function RecoveryPanel({ recovery, onChanged }) {
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  if (!recovery?.length) return null;
  const retry = async (folder) => {
    setBusy(folder); setNote("");
    try {
      const r = await api.post(`/backups/recovery/${folder}/retry`);
      setNote(r.resolved ? `All files placed (${r.placed}).` : `${r.placed} placed, ${r.remaining.length} still waiting.`);
      onChanged();
    } catch (err) { setNote(`Could not retry: ${err.message}`); } finally { setBusy(""); }
  };
  return (
    <div className="br-callout danger br-recovery" role="alert">
      <b>Incomplete attachment restore</b>
      <p>A restore finished in the database, but these attachment files could not be placed. Fix the cause (folder permissions or a conflicting file), then retry.</p>
      {recovery.map((entry) => (
        <div key={entry.folder} className="br-recovery-item">
          <div className="br-recovery-head"><span>{formatTime(entry.created_at)} · <code>{entry.folder}</code></span>
            <button type="button" className="btn-outline" disabled={busy === entry.folder} onClick={() => retry(entry.folder)}>{busy === entry.folder ? "Retrying…" : "Retry placing files"}</button></div>
          <ul className="br-list">{entry.files.map((f) => <li key={f.stored_name}>{docLabel(f)}{f.reason ? ` — ${f.reason}` : ""}{f.waiting ? "" : " (not in the recovery folder any more)"}</li>)}</ul>
        </div>
      ))}
      {note && <p role="status">{note}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ Page */
export default function BackupRestore() {
  const confirm = useConfirmation();
  const [items, setItems] = useState(null);
  const [storage, setStorage] = useState(null);
  const [message, setMessage] = useState(null); // {tone, text}
  const [dialog, setDialog] = useState(null); // {type, backup}
  const [menuId, setMenuId] = useState(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("newest");
  const [uploadPct, setUploadPct] = useState(null);
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    try {
      const [list, store] = await Promise.all([api.get("/backups"), api.get("/backups/storage").catch(() => null)]);
      setItems(list);
      setStorage(store);
    } catch (err) {
      setItems((current) => current ?? []);
      setMessage({ tone: "error", text: `Could not load backups: ${err.message}` });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (menuId === null) return undefined;
    const close = (event) => { if (!event.target.closest?.("[data-backup-menu]")) setMenuId(null); };
    const key = (event) => { if (event.key === "Escape") setMenuId(null); };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); window.removeEventListener("keydown", key); };
  }, [menuId]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let rows = (items || []).filter((b) => {
      if (needle && !`${b.name} ${b.note || ""}`.toLowerCase().includes(needle)) return false;
      if (filter === "ok") return b.status === "ok";
      if (filter === "warning") return b.status === "warning";
      if (filter === "problem") return b.status === "unreadable" || b.status === "file_missing";
      return true;
    });
    const by = {
      newest: (a, b) => new Date(b.created) - new Date(a.created),
      oldest: (a, b) => new Date(a.created) - new Date(b.created),
      name: (a, b) => a.name.localeCompare(b.name),
      size: (a, b) => (b.size_bytes || 0) - (a.size_bytes || 0),
    }[sort];
    rows = [...rows].sort(by);
    return rows;
  }, [items, query, filter, sort]);

  const latest = items && items.length ? [...items].sort((a, b) => new Date(b.created) - new Date(a.created))[0] : null;
  const attachmentWarnings = (items || []).reduce((n, b) => n + (b.missing_attachments || 0) + (b.inconsistent_attachments || 0), 0);

  const download = async (backup) => {
    try { await api.download(`/backups/${backup.id}/download`, `nem-backup-${backup.id}`); }
    catch (err) { setMessage({ tone: "error", text: `Could not download the backup: ${err.message}` }); }
  };
  const remove = async (backup) => {
    const ok = await confirm(`Delete the backup “${backup.name}”? The backup file is removed from the server and cannot be recovered.`, { title: "Delete backup", confirmLabel: "Delete backup", destructive: true });
    if (!ok) return;
    try { await api.del(`/backups/${backup.id}`); setMessage({ tone: "ok", text: `Backup “${backup.name}” deleted.` }); load(); }
    catch (err) { setMessage({ tone: "error", text: `Could not delete the backup: ${err.message}` }); }
  };
  const upload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || uploadPct !== null) return;
    const form = new FormData();
    form.append("file", file);
    setUploadPct(0);
    try {
      const created = await api.upload("/backups/upload", form, { onProgress: setUploadPct });
      setMessage({ tone: created.status === "ok" ? "ok" : "warn", text: `Backup “${created.name}” uploaded.${created.warnings?.length ? ` Note: ${created.warnings.join(" ")}` : ""} Validate it before restoring.` });
      load();
    } catch (err) { setMessage({ tone: "error", text: `Could not upload the backup: ${err.message}` }); }
    finally { setUploadPct(null); }
  };

  if (items === null) return <LoadingIndicator className="loading" />;

  return (
    <>
      <div className="br-overview">
        <Stat label="Total backups" value={formatCount(items.length)} />
        <Stat label="Latest backup" value={latest ? formatTime(latest.created) : "—"} hint={latest?.name} />
        <Stat label="Latest status" value={latest ? STATUS[latest.status]?.label || latest.status : "—"} tone={latest?.status === "ok" ? "ok" : latest ? "warn" : ""} />
        <Stat label="Storage used" value={formatBytes(storage?.used_bytes)} hint={storage?.orphan_files ? `${storage.orphan_files} file(s) without a history record` : undefined} />
        <Stat label="Attachment warnings" value={formatCount(attachmentWarnings)} tone={attachmentWarnings ? "warn" : ""} />
      </div>

      <RecoveryPanel recovery={storage?.recovery} onChanged={load} />
      {message && <p className={`notice${message.tone === "error" ? " error" : message.tone === "warn" ? " warn" : ""}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}

      <div className="panel-white">
        <div className="br-toolbar">
          <input aria-label="Search backups" placeholder="Search name or description" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select aria-label="Filter by status" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All statuses</option><option value="ok">Valid</option><option value="warning">With warnings</option><option value="problem">Unreadable / missing</option>
          </select>
          <select aria-label="Sort backups" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Name</option><option value="size">Largest first</option>
          </select>
          <span className="br-spacer" />
          <input ref={fileInput} type="file" accept=".zip,.json,application/zip,application/json" hidden onChange={upload} />
          <button type="button" className="btn-outline" disabled={uploadPct !== null} onClick={() => fileInput.current?.click()}><Upload size={16} /> {uploadPct !== null ? `Uploading ${uploadPct}%` : "Upload backup"}</button>
          <button type="button" className="btn-primary" onClick={() => setDialog({ type: "create" })}>Create backup</button>
        </div>

        {items.length === 0 ? <EmptyState title="No backups yet" lines={["Create a backup to protect the current data."]} /> :
          shown.length === 0 ? <p className="muted br-empty">No backups match the current search or filter.</p> : (
            <div className="br-scroll">
              <table className="table br-table">
                <thead><tr><th>Name</th><th>Created</th><th>Format</th><th className="right">Size</th><th className="right">Tables / rows</th><th className="right">Attachments</th><th>Status</th><th /></tr></thead>
                <tbody>{shown.map((b) => (
                  <tr key={b.id}>
                    <td><div className="br-name">{b.name}</div>{b.note && <div className="muted br-note" title={b.note}>{b.note}</div>}</td>
                    <td>{formatTime(b.created)}</td>
                    <td>v{b.format_version ?? "?"}</td>
                    <td className="right">{formatBytes(b.size_bytes)}</td>
                    <td className="right">{b.tables == null ? "—" : `${formatCount(b.tables)} / ${formatCount(b.rows)}`}</td>
                    <td className="right">{formatCount(b.attachments)}{(b.missing_attachments || b.inconsistent_attachments) ? <span className="br-flag" title={b.warnings?.join(" ")}> !</span> : null}</td>
                    <td><StatusBadge status={b.status} />{b.warnings?.length > 0 && <div className="muted br-note" title={b.warnings.join(" ")}>{b.warnings[0]}</div>}</td>
                    <td className="right">
                      <button type="button" className="icon-btn" aria-label={`Actions for ${b.name}`} aria-haspopup="menu" aria-expanded={menuId === b.id} data-backup-menu="" onClick={() => setMenuId(menuId === b.id ? null : b.id)}><DotsIcon size={17} /></button>
                      {menuId === b.id && (
                        <FloatingMenu align="right" role="menu" data-backup-menu="">
                          <button type="button" role="menuitem" onClick={() => { setMenuId(null); setDialog({ type: "details", backup: b }); }}><Eye size={14} /> View details</button>
                          <button type="button" role="menuitem" disabled={b.status === "file_missing"} onClick={() => { setMenuId(null); download(b); }}><Download size={14} /> Download</button>
                          <button type="button" role="menuitem" disabled={b.status === "file_missing" || b.status === "unreadable"} onClick={() => { setMenuId(null); setDialog({ type: "restore", backup: b }); }}><RotateCcw size={14} /> Restore…</button>
                          <button type="button" role="menuitem" className="br-menu-danger" onClick={() => { setMenuId(null); remove(b); }}><Trash2 size={14} /> Delete…</button>
                        </FloatingMenu>
                      )}
                    </td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
      </div>

      {dialog?.type === "create" && <CreateBackupModal onClose={() => setDialog(null)} onCreated={load} />}
      {dialog?.type === "details" && <DetailsModal backup={dialog.backup} onClose={() => setDialog(null)} />}
      {dialog?.type === "restore" && <RestoreWizard backup={dialog.backup} onClose={() => { setDialog(null); load(); }} onDone={load} />}
    </>
  );
}
