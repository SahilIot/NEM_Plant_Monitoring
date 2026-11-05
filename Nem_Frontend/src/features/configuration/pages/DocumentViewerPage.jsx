import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Download, ExternalLink, FileText } from "lucide-react";
import { api } from "../../../services/api.js";
import { BackIcon } from "../../../components/common/Icons.jsx";
import { LoadingIndicator } from "../../../components/common/UI.jsx";
import { auditUser } from "../../../utils/format.js";
import {
  STATUS_LABELS,
  downloadDocumentFile,
  fetchPreviewBlob,
  fileTypeLabel,
  formatBytes,
  formatDocumentDate,
} from "../../../utils/documents.js";
import "./Documents.css";

export default function DocumentViewerPage() {
  const { documentId, fileId } = useParams();
  const nav = useNavigate();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewLoading, setPreviewLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let active = true;
    setDoc(null);
    setError("");
    api.get("/documents")
      .then((documents) => {
        if (!active) return;
        const found = (Array.isArray(documents) ? documents : []).find((item) => String(item.id) === documentId);
        if (found) setDoc(found);
        else setError("This document was not found or is no longer available.");
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || "Could not load document details.");
      });
    return () => { active = false; };
  }, [documentId]);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setPreviewUrl("");
    setPreviewError("");
    setPreviewLoading(true);
    fetchPreviewBlob(documentId, fileId)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch((loadError) => {
        if (active) setPreviewError(loadError.message || "Could not load the preview.");
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId, fileId]);

  const file = doc?.files.find((item) => String(item.id) === fileId);

  const download = async () => {
    if (!doc || !file) return;
    setDownloading(true);
    try {
      await downloadDocumentFile(doc.id, file);
    } catch (downloadError) {
      setPreviewError(downloadError.message || "Download failed.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="docs-page">
      <button type="button" className="link-btn" onClick={() => nav("/configuration/documents")}>
        <BackIcon size={14} /> Back to documents
      </button>

      <div className="docs-head">
        <div>
          <h1 className="page-title">{doc?.title || "Document"}</h1>
          {file && <p>{file.name}</p>}
        </div>
      </div>

      {error && <p className="docs-banner error" role="alert">{error}</p>}

      <div className="docs-viewer">
        <div className="docs-preview">
          {previewLoading ? (
            <div className="docs-preview-state"><LoadingIndicator message="Loading preview" /></div>
          ) : previewError ? (
            <div className="docs-preview-state" role="alert">
              <div>
                <FileText size={28} aria-hidden="true" />
                <p>{previewError}</p>
                <p className="docs-muted">You can still download the file.</p>
              </div>
            </div>
          ) : (
            <iframe title={file?.name || "Document preview"} src={previewUrl} />
          )}
        </div>

        <aside className="docs-side">
          <div className="docs-side-card">
            <div className="docs-side-actions">
              <button type="button" className="btn-primary" disabled={!file || downloading} onClick={download}>
                <Download size={16} aria-hidden="true" /> {downloading ? "Downloading..." : "Download"}
              </button>
              <button type="button" className="btn-outline" disabled={!previewUrl} onClick={() => window.open(previewUrl, "_blank", "noopener")}>
                <ExternalLink size={16} aria-hidden="true" /> Open in new tab
              </button>
            </div>
          </div>

          {doc && (
            <div className="docs-side-card">
              <h2>Document information</h2>
              <dl>
                <div><dt>Category</dt><dd>{doc.kind}</dd></div>
                <div><dt>Machine / asset</dt><dd>{doc.asset_name || "General (no specific asset)"}</dd></div>
                {doc.description && <div><dt>Description</dt><dd>{doc.description}</dd></div>}
                {file && <div><dt>File</dt><dd>{fileTypeLabel(file.name)} · {formatBytes(file.size_bytes)}</dd></div>}
                <div><dt>Uploaded</dt><dd>{formatDocumentDate(doc.created_at)} by {auditUser(doc.created_by)}</dd></div>
                <div><dt>Status</dt><dd><span className={`docs-status ${doc.status}`}>{STATUS_LABELS[doc.status] || doc.status}</span></dd></div>
                {doc.labels.length > 0 && (
                  <div><dt>Labels</dt><dd className="docs-chips">{doc.labels.map((label) => <span className="label-chip" key={label}>{label}</span>)}</dd></div>
                )}
              </dl>
            </div>
          )}

          {doc && doc.files.length > 1 && (
            <div className="docs-side-card">
              <h2>Files in this document</h2>
              <div className="docs-filelinks">
                {doc.files.map((item) => (
                  <Link
                    key={item.id}
                    className={`docs-filelink${String(item.id) === fileId ? " active" : ""}`}
                    to={`/configuration/documents/${doc.id}/files/${item.id}/view`}
                    replace
                  >
                    <span className="docs-badge">{fileTypeLabel(item.name)}</span>
                    <span className="name" title={item.name}>{item.name}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
