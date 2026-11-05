import { getAuthToken } from "../services/api.js";

const API_BASE = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/+$/, "");

export const DOCUMENT_CATEGORIES = [
  "Operating Instructions",
  "Machine Manuals",
  "Maintenance Procedures",
  "Troubleshooting Guides",
  "Safety Instructions",
  "Technical Documents",
];

export const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx", ".txt"];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_INSTRUCTION_CHARS = 10000;

export const STATUS_LABELS = {
  available: "Available",
  no_file: "No file",
  no_attachment: "No attachment",
  missing: "File missing",
};

export function fileExtension(name) {
  const match = /\.([^.\\/]+)$/.exec(String(name || ""));
  return match ? `.${match[1].toLowerCase()}` : "";
}

export function fileTypeLabel(name) {
  const extension = fileExtension(name);
  return extension ? extension.slice(1).toUpperCase() : "FILE";
}

export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDocumentDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

// Client-side mirror of the server checks, so problems are shown before the upload starts.
export function validateFiles(candidates, existing = []) {
  const accepted = [...existing];
  const problems = [];
  let total = existing.reduce((sum, file) => sum + file.size, 0);
  for (const file of candidates) {
    if (!ALLOWED_EXTENSIONS.includes(fileExtension(file.name))) {
      problems.push(`${file.name}: unsupported type. Allowed: PDF, DOC, DOCX, TXT.`);
    } else if (file.size === 0) {
      problems.push(`${file.name}: the file is empty.`);
    } else if (file.size > MAX_FILE_BYTES) {
      problems.push(`${file.name}: larger than 10 MB.`);
    } else if (accepted.length >= MAX_FILES) {
      problems.push(`${file.name}: no more than ${MAX_FILES} files per document.`);
    } else if (total + file.size > MAX_TOTAL_BYTES) {
      problems.push(`${file.name}: combined size would exceed 24 MB.`);
    } else if (accepted.some((item) => item.name === file.name && item.size === file.size)) {
      problems.push(`${file.name}: already selected.`);
    } else {
      accepted.push(file);
      total += file.size;
    }
  }
  return { files: accepted, problems };
}

async function fetchFileBlob(documentId, fileId, action) {
  const token = getAuthToken();
  let response;
  try {
    response = await fetch(`${API_BASE}/documents/${documentId}/files/${fileId}/${action}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new Error("Cannot reach the backend. Check that the API server is running.");
  }
  if (!response.ok) {
    let message = `Could not load the file (${response.status}).`;
    const text = await response.text();
    if (text) {
      try {
        message = JSON.parse(text).detail || message;
      } catch {
        message = text;
      }
    }
    throw new Error(message);
  }
  return response.blob();
}

export const fetchPreviewBlob = (documentId, fileId) => fetchFileBlob(documentId, fileId, "view");

// Downloads need the bearer token, so the file is fetched and saved through a temporary link.
export async function downloadDocumentFile(documentId, file) {
  const blob = await fetchFileBlob(documentId, file.id, "download");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
