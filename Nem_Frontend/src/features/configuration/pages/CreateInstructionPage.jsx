import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Upload, X } from "lucide-react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { BackIcon } from "../../../components/common/Icons.jsx";
import LabelsField from "../../../components/common/LabelsField.jsx";
import {
  DOCUMENT_CATEGORIES,
  MAX_INSTRUCTION_CHARS,
  fileTypeLabel,
  formatBytes,
  validateFiles,
} from "../../../utils/documents.js";
import "./Documents.css";

// Creates an instruction (text content). An attachment is optional: with no file the
// instruction is saved as text only; with files it is saved together with them.
export default function CreateInstructionPage() {
  const { user } = useAuth();
  const canCreate = user?.role === "Administrator" || user?.role === "Supervisor";
  const nav = useNavigate();
  const fileInput = useRef(null);

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState(DOCUMENT_CATEGORIES[0]);
  const [assetId, setAssetId] = useState("");
  const [content, setContent] = useState("");
  const [labels, setLabels] = useState([]);
  const [files, setFiles] = useState([]);
  const [problems, setProblems] = useState([]);
  const [assets, setAssets] = useState([]);
  const [fieldErrors, setFieldErrors] = useState({});
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

  const submit = async (event) => {
    event.preventDefault();
    if (!canCreate || busy) return;
    setError("");
    const errors = {};
    if (!title.trim()) errors.title = "Title is required.";
    if (!kind) errors.kind = "Category is required.";
    if (!content.trim()) errors.content = "Instruction content is required.";
    else if (content.length > MAX_INSTRUCTION_CHARS) errors.content = `Instruction content is limited to ${MAX_INSTRUCTION_CHARS.toLocaleString()} characters.`;
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;

    setBusy(true);
    try {
      if (files.length) {
        const form = new FormData();
        form.append("title", title.trim());
        form.append("kind", kind);
        form.append("description", content.trim());
        form.append("entry_type", "instruction");
        form.append("labels", JSON.stringify(labels));
        if (assetId) form.append("asset_id", assetId);
        files.forEach((file) => form.append("files", file));
        setProgress(0);
        await api.upload("/documents/with-files", form, { onProgress: setProgress });
      } else {
        await api.post("/documents", {
          title: title.trim(),
          kind,
          description: content.trim(),
          entry_type: "instruction",
          labels,
          asset_id: assetId ? Number(assetId) : null,
        });
      }
      nav("/configuration/documents", {
        state: { notice: `Instruction "${title.trim()}" was created.` },
      });
    } catch (err) {
      setError(err?.message || "Could not create the instruction.");
      setProgress(null);
      setBusy(false);
    }
  };

  return (
    <div className="docs-page docs-form-page">
      <button type="button" className="link-btn" onClick={() => nav("/configuration/documents")}>
        <BackIcon size={14} /> Back to instructions &amp; documents
      </button>

      <div className="docs-head">
        <div>
          <h1 className="page-title">Create New Instruction</h1>
          <p>Write an instruction for operators. Attaching a file is optional.</p>
        </div>
      </div>

      <form className="docs-form-card" onSubmit={submit} noValidate>
        {!canCreate && (
          <p className="notice" role="status">Only Administrators and Supervisors can create instructions.</p>
        )}
        <fieldset disabled={!canCreate || busy}>
          <div className="docs-form-grid">
            <div className="field full">
              <label htmlFor="instruction-title">Title <span className="req">*</span></label>
              <input
                id="instruction-title"
                autoFocus
                value={title}
                maxLength={200}
                placeholder="e.g. Start-up checks for the mixer"
                aria-invalid={Boolean(fieldErrors.title)}
                onChange={(event) => setTitle(event.target.value)}
              />
              {fieldErrors.title && <small className="field-error" role="alert">{fieldErrors.title}</small>}
            </div>

            <div className="field">
              <label htmlFor="instruction-kind">Category <span className="req">*</span></label>
              <select id="instruction-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
                {DOCUMENT_CATEGORIES.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              {fieldErrors.kind && <small className="field-error" role="alert">{fieldErrors.kind}</small>}
            </div>

            <div className="field">
              <label htmlFor="instruction-asset">Machine / asset</label>
              <select id="instruction-asset" value={assetId} onChange={(event) => setAssetId(event.target.value)}>
                <option value="">General (no specific asset)</option>
                {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select>
            </div>

            <div className="field full">
              <label htmlFor="instruction-content">Instruction content <span className="req">*</span></label>
              <textarea
                id="instruction-content"
                rows={9}
                value={content}
                placeholder="Describe the steps or guidance operators should follow."
                aria-invalid={Boolean(fieldErrors.content)}
                onChange={(event) => setContent(event.target.value)}
              />
              <div className="docs-char-count">{content.length.toLocaleString()} / {MAX_INSTRUCTION_CHARS.toLocaleString()}</div>
              {fieldErrors.content && <small className="field-error" role="alert">{fieldErrors.content}</small>}
            </div>

            <div className="field full">
              <label htmlFor="instruction-labels">Labels</label>
              <LabelsField id="instruction-labels" value={labels} onChange={setLabels} />
            </div>

            <div className="field full">
              <label htmlFor="instruction-files">Attachment <span className="docs-muted">(optional)</span></label>
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
                <Upload size={22} aria-hidden="true" />
                <strong>Drop a supporting file here, or leave empty</strong>
                <small>PDF, DOC, DOCX or TXT · up to 10 files · 10 MB each · 24 MB total</small>
                <button type="button" className="btn-outline" style={{ marginTop: 6 }} onClick={() => fileInput.current?.click()}>
                  Browse files
                </button>
                <input
                  id="instruction-files"
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
                      <button
                        type="button"
                        className="docs-icon-btn"
                        aria-label={`Remove ${file.name}`}
                        onClick={() => { setFiles((current) => current.filter((_, position) => position !== index)); setProblems([]); }}
                      >
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
            <p className="docs-progress-text">{progress < 100 ? `Uploading… ${progress}%` : "Saving instruction…"}</p>
          </>
        )}

        {error && <p className="notice error" role="alert">{error}</p>}

        <div className="docs-form-footer">
          <span className="docs-muted" style={{ fontSize: 12 }}><span style={{ color: "var(--alert)" }}>*</span> Required</span>
          <div className="docs-form-actions">
            <button type="button" className="btn-outline" disabled={busy} onClick={() => nav("/configuration/documents")}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy || !canCreate}>
              {busy ? "Saving..." : "Create instruction"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
