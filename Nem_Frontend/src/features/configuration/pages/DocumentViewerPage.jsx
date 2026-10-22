import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";

const API_BASE = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/+$/, "");

export default function DocumentViewerPage() {
  const { documentId, fileId } = useParams();
  const [fileName, setFileName] = useState("Document preview");
  const [error, setError] = useState("");
  const previewUrl = `${API_BASE}/documents/${documentId}/files/${fileId}/view`;

  useEffect(() => {
    let active = true;
    api.get("/documents")
      .then((documents) => {
        const file = (Array.isArray(documents) ? documents : [])
          .find((document) => String(document.id) === documentId)
          ?.files?.find((item) => String(item.id) === fileId);
        if (active && file) setFileName(file.name);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || "Could not load document details.");
      });
    return () => {
      active = false;
    };
  }, [documentId, fileId]);

  return (
    <section className="panel" style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Link className="btn-outline" to="/configuration/documents">
          Back to documents
        </Link>
        <h1 className="page-title" style={{ margin: 0 }}>{fileName}</h1>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      <iframe
        title={fileName}
        src={previewUrl}
        style={{
          width: "100%",
          height: "min(75vh, 900px)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          background: "white",
        }}
      />
    </section>
  );
}
