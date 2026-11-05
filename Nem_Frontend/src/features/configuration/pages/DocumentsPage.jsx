import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ClipboardList,
  Download,
  Eye,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import LabelsField from "../../../components/common/LabelsField.jsx";
import { BackIcon } from "../../../components/common/Icons.jsx";
import { LoadingIndicator, Modal, useConfirmation } from "../../../components/common/UI.jsx";
import { auditUser } from "../../../utils/format.js";
import {
  DOCUMENT_CATEGORIES,
  STATUS_LABELS,
  downloadDocumentFile,
  fileExtension,
  fileTypeLabel,
  formatBytes,
  formatDocumentDate,
  validateFiles,
} from "../../../utils/documents.js";
import "./Documents.css";

const SORTS = [
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
  ["title-asc", "Title A–Z"],
  ["title-desc", "Title Z–A"],
];

const timestamp = (document) => (document.created_at ? Date.parse(document.created_at) || 0 : 0);

function compareDocuments(sort) {
  if (sort === "title-asc") return (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  if (sort === "title-desc") return (a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: "base" });
  if (sort === "oldest") return (a, b) => timestamp(a) - timestamp(b) || a.id - b.id;
  return (a, b) => timestamp(b) - timestamp(a) || b.id - a.id;
}

function InstructionReadModal({ item, onClose, onDownload, busy }) {
  const downloadable = item.files.some((file) => file.available);
  return (
    <Modal title={item.title} onClose={onClose} wide>
      <div className="docs-read">
        <div className="docs-read-meta">
          <span className="docs-pill">{item.kind}</span>
          <span className="docs-muted">{item.asset_name || "General (no specific asset)"}</span>
          <span className={`docs-status ${item.status}`}>{STATUS_LABELS[item.status] || item.status}</span>
        </div>
        <div className="docs-read-body">{item.description || "No instruction content."}</div>
        {item.labels.length > 0 && (
          <div className="docs-chips">{item.labels.map((label) => <span className="label-chip" key={label}>{label}</span>)}</div>
        )}
        <p className="docs-muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
          Created {formatDocumentDate(item.created_at)} by {auditUser(item.created_by)}
        </p>
        {item.files.length > 0 && (
          <div className="docs-edit-files">
            <h4>Attachments ({item.files.length})</h4>
            {item.files.map((file) => (
              <div className="docs-edit-file" key={file.id}>
                <span className="docs-badge">{fileTypeLabel(file.name)}</span>
                <span className="name" title={file.name}>{file.name}</span>
                <span className="docs-file-size">{formatBytes(file.size_bytes)}</span>
                {file.available ? (
                  <Link className="docs-small-btn" to={`/configuration/documents/${item.id}/files/${file.id}/view`}>View</Link>
                ) : <span className="docs-status missing">Missing</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="modal-actions">
        {downloadable && (
          <button type="button" className="btn-outline" disabled={busy} onClick={() => onDownload(item)}>
            <Download size={15} aria-hidden="true" /> Download
          </button>
        )}
        <button type="button" className="btn-primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function EditDocumentModal({ document: initial, assets, onClose, onChanged, confirm }) {
  const [current, setCurrent] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [kind, setKind] = useState(initial.kind);
  const [description, setDescription] = useState(initial.description || "");
  const [assetId, setAssetId] = useState(initial.asset_id ? String(initial.asset_id) : "");
  const [labels, setLabels] = useState(initial.labels || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [fileError, setFileError] = useState("");
  const replaceTarget = useRef(null);
  const replaceInput = useRef(null);
  const addInput = useRef(null);

  const isInstruction = initial.entry_type === "instruction";
  const categories = DOCUMENT_CATEGORIES.includes(initial.kind)
    ? DOCUMENT_CATEGORIES
    : [initial.kind, ...DOCUMENT_CATEGORIES];

  const save = async (event) => {
    event.preventDefault();
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (isInstruction && !description.trim()) {
      setError("Instruction content is required.");
      return;
    }
    if (isInstruction && description.length > 10000) {
      setError("Instruction content is limited to 10,000 characters.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const updated = await api.patch(`/documents/${current.id}`, {
        title: title.trim(),
        kind,
        description: description.trim() || null,
        asset_id: assetId ? Number(assetId) : null,
        labels,
      });
      onChanged(updated, "Document details saved.");
      onClose();
    } catch (saveError) {
      setError(saveError.message || "Could not save the document.");
    } finally {
      setSaving(false);
    }
  };

  const runFileAction = async (action) => {
    setFileBusy(true);
    setFileError("");
    setProgress(0);
    try {
      const updated = await action();
      setCurrent(updated);
      onChanged(updated, null);
    } catch (actionError) {
      setFileError(actionError.message || "The file action failed.");
    } finally {
      setFileBusy(false);
      setProgress(null);
    }
  };

  const pickFile = (event, handler) => {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    const { problems } = validateFiles([picked]);
    if (problems.length) {
      setFileError(problems[0]);
      return;
    }
    handler(picked);
  };

  const replaceFile = (file) =>
    runFileAction(() => {
      const form = new FormData();
      form.append("file", file);
      return api.upload(`/documents/${current.id}/files/${replaceTarget.current}`, form, {
        method: "PUT",
        onProgress: setProgress,
      });
    });

  const addFile = (file) =>
    runFileAction(() => {
      const form = new FormData();
      form.append("file", file);
      return api.upload(`/documents/${current.id}/files`, form, { onProgress: setProgress });
    });

  const removeFile = async (file) => {
    const ok = await confirm(
      `Remove "${file.name}" from this document? The stored file will be deleted.`,
      { title: "Remove file", confirmLabel: "Remove", destructive: true }
    );
    if (!ok) return;
    await runFileAction(async () => {
      await api.del(`/documents/${current.id}/files/${file.id}`);
      const files = current.files.filter((item) => item.id !== file.id);
      return {
        ...current,
        files,
        status: !files.length ? (isInstruction ? "no_attachment" : "no_file") : files.every((item) => item.available) ? "available" : "missing",
      };
    });
  };

  return (
    <Modal title={isInstruction ? "Edit instruction" : "Edit document"} onClose={saving || fileBusy ? () => {} : onClose} wide>
      <form onSubmit={save}>
        <div className="docs-form-grid">
          <div className="field full">
            <label htmlFor="edit-doc-title">Title <span className="req">*</span></label>
            <input id="edit-doc-title" value={title} maxLength={200} disabled={saving} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="edit-doc-kind">Category</label>
            <select id="edit-doc-kind" value={kind} disabled={saving} onChange={(e) => setKind(e.target.value)}>
              {categories.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="edit-doc-asset">Machine / asset</label>
            <select id="edit-doc-asset" value={assetId} disabled={saving} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">General (no specific asset)</option>
              {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
            </select>
          </div>
          <div className="field full">
            <label htmlFor="edit-doc-description">{isInstruction ? "Instruction content" : "Description"}{isInstruction && <span className="req"> *</span>}</label>
            <textarea id="edit-doc-description" rows={isInstruction ? 8 : 3} value={description} disabled={saving} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="field full">
            <label htmlFor="edit-doc-labels">Labels</label>
            <LabelsField id="edit-doc-labels" value={labels} onChange={setLabels} disabled={saving} />
          </div>
        </div>
        {error && <p className="notice error flush" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-outline" disabled={saving || fileBusy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || fileBusy}>{saving ? "Saving..." : "Save details"}</button>
        </div>
      </form>

      <div className="docs-edit-files">
        <h4>Files ({current.files.length})</h4>
        {current.files.length === 0 && <p className="docs-muted" style={{ margin: "0 0 6px", fontSize: 13 }}>{isInstruction ? "No attachment. You can add one if needed." : "This document has no file yet."}</p>}
        {current.files.map((file) => (
          <div className="docs-edit-file" key={file.id}>
            <span className="docs-badge">{fileTypeLabel(file.name)}</span>
            <span className="name" title={file.name}>{file.name}</span>
            <span className="docs-file-size">{formatBytes(file.size_bytes)}</span>
            {!file.available && <span className="docs-status missing">Missing</span>}
            <button type="button" className="docs-small-btn" disabled={fileBusy}
              onClick={() => { replaceTarget.current = file.id; replaceInput.current?.click(); }}>Replace</button>
            <button type="button" className="docs-small-btn danger" disabled={fileBusy} onClick={() => removeFile(file)}>Remove</button>
          </div>
        ))}
        <input ref={replaceInput} type="file" accept=".pdf,.doc,.docx,.txt" onChange={(e) => pickFile(e, replaceFile)} />
        <input ref={addInput} type="file" accept=".pdf,.doc,.docx,.txt" onChange={(e) => pickFile(e, addFile)} />
        <div style={{ marginTop: 8 }}>
          <button type="button" className="docs-small-btn" disabled={fileBusy || current.files.length >= 10} onClick={() => addInput.current?.click()}>
            Add file
          </button>
        </div>
        {progress !== null && (
          <>
            <div className="docs-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div>
            <p className="docs-progress-text">{progress < 100 ? `Uploading… ${progress}%` : "Processing…"}</p>
          </>
        )}
        {fileError && <p className="notice error flush" role="alert" style={{ marginTop: 8 }}>{fileError}</p>}
      </div>
    </Modal>
  );
}

export default function DocumentsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "Administrator";
  const canUpload = isAdmin || user?.role === "Supervisor";
  const confirm = useConfirmation();
  const nav = useNavigate();
  const location = useLocation();

  const [documents, setDocuments] = useState(null);
  const [assets, setAssets] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [banner, setBanner] = useState(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [assetFilter, setAssetFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [entryFilter, setEntryFilter] = useState("all");
  const [reading, setReading] = useState(null);
  const [sort, setSort] = useState("newest");
  const [labelIds, setLabelIds] = useState([]);
  const [labelsRevision, setLabelsRevision] = useState(0);
  const [editing, setEditing] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const generation = useRef(0);
  const labelQuery = labelIds.map((id) => `label_ids=${encodeURIComponent(id)}`).join("&");

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoadError("");
    try {
      const rows = await api.get(`/documents${labelQuery ? `?${labelQuery}` : ""}`);
      if (current === generation.current) setDocuments(Array.isArray(rows) ? rows : []);
    } catch (error) {
      if (current === generation.current) setLoadError(error.message || "Could not load documents.");
    }
  }, [labelQuery]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let active = true;
    api.getAll("/assets")
      .then((rows) => { if (active) setAssets(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (active) setAssets([]); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const state = location.state;
    if (state?.notice || state?.documentCreated) {
      setBanner({ text: state.notice || "Document created.", error: false });
      setLabelsRevision((revision) => revision + 1);
      nav(location.pathname, { replace: true, state: null });
    }
  }, [location, nav]);

  const categories = useMemo(() => {
    const extras = [...new Set((documents || []).map((item) => item.kind))]
      .filter((name) => name && !DOCUMENT_CATEGORIES.includes(name));
    return [...DOCUMENT_CATEGORIES, ...extras];
  }, [documents]);

  const counts = useMemo(() => {
    const result = new Map();
    (documents || []).forEach((item) => result.set(item.kind, (result.get(item.kind) || 0) + 1));
    return result;
  }, [documents]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (documents || [])
      .filter((item) => category === "all" || item.kind === category)
      .filter((item) => assetFilter === "all" || (assetFilter === "none" ? item.asset_id == null : String(item.asset_id) === assetFilter))
      .filter((item) => entryFilter === "all" || item.entry_type === entryFilter)
      .filter((item) => typeFilter === "all" || item.files.some((file) => fileTypeLabel(file.name) === typeFilter))
      .filter((item) => !needle
        || item.title.toLowerCase().includes(needle)
        || (item.description || "").toLowerCase().includes(needle)
        || item.files.some((file) => file.name.toLowerCase().includes(needle)))
      .sort(compareDocuments(sort));
  }, [documents, category, assetFilter, typeFilter, entryFilter, query, sort]);

  const hasFilters = Boolean(query || category !== "all" || assetFilter !== "all" || typeFilter !== "all" || entryFilter !== "all" || labelIds.length);
  const clearFilters = () => {
    setQuery(""); setCategory("all"); setAssetFilter("all"); setTypeFilter("all"); setEntryFilter("all"); setLabelIds([]);
  };

  const applyChange = (updated, message) => {
    setDocuments((rows) => (rows || []).map((row) => (row.id === updated.id ? updated : row)));
    setLabelsRevision((revision) => revision + 1);
    if (message) setBanner({ text: message, error: false });
  };

  const download = async (item) => {
    const files = item.files.filter((file) => file.available);
    if (!files.length) return;
    setBusyId(item.id);
    try {
      for (const file of files) await downloadDocumentFile(item.id, file);
    } catch (error) {
      setBanner({ text: error.message || "Download failed.", error: true });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item) => {
    const ok = await confirm(
      `Delete "${item.title}"? Its ${item.files.length ? `${item.files.length} stored file(s) and ` : ""}details will be permanently removed. Maintenance schedules that reference it will no longer list it.`,
      { title: "Delete document", confirmLabel: "Delete", destructive: true }
    );
    if (!ok) return;
    setBusyId(item.id);
    try {
      await api.del(`/documents/${item.id}`);
      setDocuments((rows) => (rows || []).filter((row) => row.id !== item.id));
      setLabelsRevision((revision) => revision + 1);
      setBanner({ text: `"${item.title}" was deleted.`, error: false });
    } catch (error) {
      setBanner({ text: error.message || "Could not delete the document.", error: true });
    } finally {
      setBusyId(null);
    }
  };

  const viewerPath = (item) => `/configuration/documents/${item.id}/files/${item.files[0]?.id}/view`;
  const total = documents?.length ?? 0;

  return (
    <div className="docs-page">
      <button type="button" className="link-btn" onClick={() => nav("/configuration")}>
        <BackIcon size={14} /> Back
      </button>

      <div className="docs-head">
        <div>
          <h1 className="page-title">Instructions &amp; Documents</h1>
          <p>
            Operating instructions, manuals and procedures for your machines.
            {documents !== null && ` ${total} item${total === 1 ? "" : "s"}.`}
          </p>
        </div>
        {canUpload && (
          <div className="docs-head-actions">
            <button type="button" className="btn-primary" onClick={() => nav("/configuration/instructions/new")}>
              <ClipboardList size={16} aria-hidden="true" /> Create New Instruction
            </button>
            <button type="button" className="btn-outline" onClick={() => nav("/configuration/documents/new")}>
              <Upload size={16} aria-hidden="true" /> Upload document
            </button>
          </div>
        )}
      </div>

      {banner && (
        <div className={`docs-banner ${banner.error ? "error" : "ok"}`} role={banner.error ? "alert" : "status"}>
          <span>{banner.text}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setBanner(null)}><X size={15} /></button>
        </div>
      )}

      <div className="docs-tabs" role="tablist" aria-label="Document categories">
        <button type="button" role="tab" aria-selected={category === "all"} className={`docs-tab${category === "all" ? " active" : ""}`} onClick={() => setCategory("all")}>
          All <span className="docs-tab-count">{total}</span>
        </button>
        {categories.map((name) => (
          <button key={name} type="button" role="tab" aria-selected={category === name} className={`docs-tab${category === name ? " active" : ""}`} onClick={() => setCategory(name)}>
            {name} <span className="docs-tab-count">{counts.get(name) || 0}</span>
          </button>
        ))}
      </div>

      <div className="docs-toolbar">
        <label className="docs-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" aria-label="Search documents by title" placeholder="Search by title, description or file name" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <select aria-label="Filter by machine or asset" value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)}>
          <option value="all">All assets</option>
          <option value="none">General (no asset)</option>
          {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
        </select>
        <select aria-label="Filter by entry type" value={entryFilter} onChange={(e) => setEntryFilter(e.target.value)}>
          <option value="all">Instructions &amp; documents</option>
          <option value="instruction">Instructions only</option>
          <option value="document">Documents only</option>
        </select>
        <select aria-label="Filter by file type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All file types</option>
          {["PDF", "DOC", "DOCX", "TXT"].map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <select aria-label="Sort documents" value={sort} onChange={(e) => setSort(e.target.value)}>
          {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <div className="docs-toolbar-labels">
          <LabelsField mode="filter" value={labelIds} refreshKey={labelsRevision} onChange={setLabelIds} />
        </div>
      </div>

      {loadError && documents === null ? (
        <div className="docs-empty" role="alert">
          <FileText size={30} aria-hidden="true" />
          <h2>Documents could not be loaded</h2>
          <p>{loadError}</p>
          <button type="button" className="btn-outline" onClick={load}><RefreshCw size={15} aria-hidden="true" /> Try again</button>
        </div>
      ) : documents === null ? (
        <LoadingIndicator message="Loading documents" />
      ) : visible.length === 0 ? (
        <div className="docs-empty">
          <FileText size={30} aria-hidden="true" />
          {hasFilters ? (
            <>
              <h2>No matching documents</h2>
              <p>Nothing matches the current search and filters.</p>
              <button type="button" className="btn-outline" onClick={clearFilters}>Clear filters</button>
            </>
          ) : (
            <>
              <h2>No instructions or documents yet</h2>
              <p>{canUpload ? "Write an instruction or upload a manual or procedure so operators can find it here." : "Instructions and documents added by Administrators and Supervisors will appear here."}</p>
              {canUpload && (
                <div className="docs-head-actions">
                  <button type="button" className="btn-primary" onClick={() => nav("/configuration/instructions/new")}>
                    <Plus size={16} aria-hidden="true" /> Create New Instruction
                  </button>
                  <button type="button" className="btn-outline" onClick={() => nav("/configuration/documents/new")}>
                    <Upload size={16} aria-hidden="true" /> Upload document
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <ul className="docs-list" aria-label="Documents">
            <li className="docs-list-head" aria-hidden="true">
              <span>Title</span><span>Category</span><span>Asset</span><span>File</span>
              <span className="docs-col-uploaded">Uploaded</span><span>Status</span><span />
            </li>
            {visible.map((item) => {
              const first = item.files[0];
              const extension = first ? fileExtension(first.name).slice(1) : "";
              const downloadable = item.files.some((file) => file.available);
              const isInstruction = item.entry_type === "instruction";
              return (
                <li className="docs-row" key={item.id}>
                  <div className="docs-cell docs-main">
                    <span className={`docs-icon ${extension}`} aria-hidden="true">{isInstruction ? <ClipboardList size={17} /> : <FileText size={17} />}</span>
                    <div style={{ minWidth: 0 }}>
                      {isInstruction ? (
                        <button type="button" className="docs-title docs-title-btn" onClick={() => setReading(item)}>
                          {item.title}<span className="docs-kind-tag">Instruction</span>
                        </button>
                      ) : first ? <Link className="docs-title" to={viewerPath(item)}>{item.title}</Link> : <span className="docs-title">{item.title}</span>}
                      {item.description && <p className="docs-desc">{item.description}</p>}
                      {item.labels.length > 0 && (
                        <div className="docs-chips">{item.labels.map((label) => <span className="label-chip" key={label}>{label}</span>)}</div>
                      )}
                    </div>
                  </div>
                  <div className="docs-cell"><span className="docs-cell-label">Category</span><span className="docs-pill" title={item.kind}>{item.kind}</span></div>
                  <div className="docs-cell"><span className="docs-cell-label">Asset</span>{item.asset_name || <span className="docs-muted">General</span>}</div>
                  <div className="docs-cell">
                    <span className="docs-cell-label">File</span>
                    {item.files.length === 0 ? <span className="docs-muted">{isInstruction ? "No attachment" : "None"}</span> : (
                      <div className="docs-files">
                        {item.files.slice(0, 2).map((file, index) => (
                          <span className="docs-file" key={file.id} title={file.name}>
                            <span className="docs-badge">{fileTypeLabel(file.name)}</span>
                            {index === 0 && <span className="docs-file-size">{formatBytes(file.size_bytes)}</span>}
                          </span>
                        ))}
                        {item.files.length > 2 && <span className="docs-file-size">+{item.files.length - 2} more</span>}
                      </div>
                    )}
                  </div>
                  <div className="docs-cell docs-col-uploaded">
                    <span className="docs-cell-label">Uploaded</span>
                    <div>{formatDocumentDate(item.created_at)}</div>
                    <div className="docs-muted">by {auditUser(item.created_by)}</div>
                  </div>
                  <div className="docs-cell"><span className="docs-cell-label">Status</span><span className={`docs-status ${item.status}`}>{STATUS_LABELS[item.status] || item.status}</span></div>
                  <div className="docs-cell docs-actions">
                    {isInstruction ? (
                      <button type="button" className="docs-icon-btn" title="Read" aria-label={`Read ${item.title}`} onClick={() => setReading(item)}><Eye size={15} /></button>
                    ) : first ? (
                      <Link className="docs-icon-btn" to={viewerPath(item)} title="View" aria-label={`View ${item.title}`}><Eye size={15} /></Link>
                    ) : (
                      <button type="button" className="docs-icon-btn" disabled aria-label="No file to view"><Eye size={15} /></button>
                    )}
                    <button type="button" className="docs-icon-btn" title="Download" aria-label={`Download ${item.title}`} disabled={!downloadable || busyId === item.id} onClick={() => download(item)}><Download size={15} /></button>
                    {isAdmin && (
                      <>
                        <button type="button" className="docs-icon-btn" title="Edit details and files" aria-label={`Edit ${item.title}`} disabled={busyId === item.id} onClick={() => setEditing(item)}><Pencil size={15} /></button>
                        <button type="button" className="docs-icon-btn danger" title="Delete" aria-label={`Delete ${item.title}`} disabled={busyId === item.id} onClick={() => remove(item)}><Trash2 size={15} /></button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="docs-count">Showing {visible.length} of {total} item{total === 1 ? "" : "s"}</p>
        </>
      )}

      {reading && (
        <InstructionReadModal item={reading} busy={busyId === reading.id} onClose={() => setReading(null)} onDownload={download} />
      )}

      {editing && (
        <EditDocumentModal
          document={editing}
          assets={assets}
          confirm={confirm}
          onClose={() => setEditing(null)}
          onChanged={applyChange}
        />
      )}
    </div>
  );
}
