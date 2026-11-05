import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Upload, X } from "lucide-react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { BackIcon } from "../../../components/common/Icons.jsx";
import LabelsField from "../../../components/common/LabelsField.jsx";
import {
  DOCUMENT_CATEGORIES,
  fileTypeLabel,
  formatBytes,
  validateFiles,
} from "../../../utils/documents.js";
import "./Documents.css";

export default function DocumentCreatePage() {
  const { user } = useAuth();
  const canManageDocuments =
    user?.role === "Administrator" || user?.role === "Supervisor";
  const nav = useNavigate();
  const fileInput = useRef(null);

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState(DOCUMENT_CATEGORIES[0]);
  const [assetId, setAssetId] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState([]);
  const [files, setFiles] = useState([]);
  const [problems, setProblems] = useState([]);
  const [assets, setAssets] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.getAll("/assets")
      .then((rows) => { if (active) setAssets(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (active) setAssets([]); });
    return () => { active = false; };
  }, []);

  const addFiles = (list) => {
    const result = validateFiles(Array.from(list || []), files);
    setFiles(result.files);
    setProblems(result.problems);
  };

  const removeFile = (index) => {
    setFiles((current) => current.filter((_, position) => position !== index));
    setProblems([]);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!canManageDocuments || busy) return;
    setError("");
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (!files.length) {
      setError("Attach at least one file.");
      return;
    }

    const form = new FormData();
    form.append("title", title.trim());
    form.append("kind", kind);
    form.append("description", description.trim());
    form.append("labels", JSON.stringify(labels));
    if (assetId) form.append("asset_id", assetId);
    files.forEach((file) => form.append("files", file));

    setBusy(true);
    setProgress(0);
    try {
      await api.upload("/documents/with-files", form, { onProgress: setProgress });
      nav("/configuration/documents", {
        state: { notice: `"${title.trim()}" was uploaded.` },
      });
    } catch (err) {
      setError(err?.message || "Could not upload the document.");
      setProgress(null);
      setBusy(false);
    }
  };

  return (
    <div className="docs-page docs-form-page">
      <button type="button" className="link-btn" onClick={() => nav("/configuration/documents")}>
        <BackIcon size={14} /> Back to documents
      </button>

      <div className="docs-head">
        <div>
          <h1 className="page-title">Upload document</h1>
          <p>Add an instruction, manual or procedure and link it to a machine.</p>
        </div>
      </div>

      <form className="docs-form-card" onSubmit={submit} noValidate>
        {!canManageDocuments && (
          <p className="notice" role="status">Only Administrators and Supervisors can upload documents.</p>
        )}
        <fieldset disabled={!canManageDocuments || busy}>
          <div className="docs-form-grid">
            <div className="field full">
              <label htmlFor="document-title">Title <span className="req">*</span></label>
              <input
                id="document-title"
                autoFocus
                value={title}
                maxLength={200}
                placeholder="e.g. Mixer inspection steps"
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="document-kind">Category <span className="req">*</span></label>
              <select id="document-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
                {DOCUMENT_CATEGORIES.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>

            <div className="field">
              <label htmlFor="document-asset">Machine / asset</label>
              <select id="document-asset" value={assetId} onChange={(event) => setAssetId(event.target.value)}>
                <option value="">General (no specific asset)</option>
                {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select>
            </div>

            <div className="field full">
              <label htmlFor="document-description">Description</label>
              <textarea
                id="document-description"
                rows={2}
                value={description}
                placeholder="What is this document for?"
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <div className="field full">
              <label htmlFor="document-labels">Labels</label>
              <LabelsField id="document-labels" value={labels} onChange={setLabels} />
            </div>

            <div className="field full">
              <label htmlFor="document-files">Files <span className="req">*</span></label>
              <div
                className={`docs-dropzone${dragging ? " dragging" : ""}`}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  addFiles(event.dataTransfer.files);
                }}
              >
                <Upload size={24} aria-hidden="true" />
                <strong>Drag and drop files here</strong>
                <small>PDF, DOC, DOCX or TXT · up to 10 files · 10 MB each · 24 MB total</small>
                <button type="button" className="btn-outline" style={{ marginTop: 6 }} onClick={() => fileInput.current?.click()}>
                  Browse files
                </button>
                <input
                  id="document-files"
                  ref={fileInput}
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.txt"
                  onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }}
                />
              </div>

              {problems.length > 0 && (
                <ul className="docs-problems" role="alert">
                  {problems.map((problem) => <li key={problem}>{problem}</li>)}
                </ul>
              )}

              {files.length > 0 && (
                <ul className="docs-selected" aria-label="Selected files">
                  {files.map((file, index) => (
                    <li key={`${file.name}-${file.size}`}>
                      <FileText size={16} aria-hidden="true" />
                      <span className="docs-badge">{fileTypeLabel(file.name)}</span>
                      <span className="name" title={file.name}>{file.name}</span>
                      <span className="docs-file-size">{formatBytes(file.size)}</span>
                      <button type="button" className="docs-icon-btn" aria-label={`Remove ${file.name}`} disabled={busy} onClick={() => removeFile(index)}>
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </fieldset>

        {progress !== null && (
          <>
            <div className="docs-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <p className="docs-progress-text">{progress < 100 ? `Uploading… ${progress}%` : "Saving document…"}</p>
          </>
        )}

        {error && <p className="notice error" role="alert">{error}</p>}

        <div className="docs-form-footer">
          <span className="docs-muted" style={{ fontSize: 12 }}><span className="req" style={{ color: "var(--alert)" }}>*</span> Required</span>
          <div className="docs-form-actions">
            <button type="button" className="btn-outline" disabled={busy} onClick={() => nav("/configuration/documents")}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy || !canManageDocuments}>
              {busy ? "Uploading..." : "Upload document"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
