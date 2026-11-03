
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Upload,
  FileText,
  X,
  Clock3,
  ClipboardList,
  Paperclip,
} from "lucide-react";

import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import LabelsField from "../../../components/common/LabelsField.jsx";
import "./CreateInstructionPage.css";

const MAX_FILES = 10;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx", ".txt"];

export default function CreateInstructionPage() {
  const { user } = useAuth();
  const nav = useNavigate();

  const canManageInstructions =
    user?.role === "Administrator" ||
    user?.role === "Supervisor";

  const [name, setName] = useState("");
  const [labels, setLabels] = useState([]);
  const [duration, setDuration] = useState("30");
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function handleFileChange(event) {
    const selectedFiles = Array.from(event.target.files || []);
    setError("");

    if (selectedFiles.length > MAX_FILES) {
      setError("You can attach up to 10 documents.");
      event.target.value = "";
      return;
    }

    const invalidFile = selectedFiles.find((file) => {
      const extension = `.${file.name.split(".").pop().toLowerCase()}`;

      return (
        !ALLOWED_EXTENSIONS.includes(extension) ||
        file.size > MAX_FILE_SIZE
      );
    });

    if (invalidFile) {
      const extension = `.${invalidFile.name.split(".").pop().toLowerCase()}`;

      setError(
        !ALLOWED_EXTENSIONS.includes(extension)
          ? "Only PDF, DOC, DOCX and TXT documents are allowed."
          : `${invalidFile.name} exceeds the 10 MB file size limit.`
      );

      event.target.value = "";
      return;
    }

    setFiles(selectedFiles);
    event.target.value = "";
  }

  function removeFile(index) {
    setFiles((previous) =>
      previous.filter((_, fileIndex) => fileIndex !== index)
    );
    setError("");
  }

  async function submit(event) {
    event.preventDefault();

    if (!canManageInstructions || busy) return;

    setError("");

    const cleanName = name.trim();
    const cleanText = text.trim();
    const minutes = Number(duration);

    if (cleanName.length < 2 || cleanName.length > 50) {
      setError("Name must contain 2–50 characters.");
      return;
    }

    if (!Number.isInteger(minutes) || minutes < 1) {
      setError("Duration must be at least 1 minute.");
      return;
    }

    if (!cleanText || cleanText.length > 10000) {
      setError(
        "Instruction text is required and limited to 10,000 characters."
      );
      return;
    }

    if (files.length > MAX_FILES) {
      setError("You can attach up to 10 documents.");
      return;
    }

    if (files.some((file) => file.size > MAX_FILE_SIZE)) {
      setError("Each document must be 10 MB or smaller.");
      return;
    }

    setBusy(true);

    try {
      if (files.length > 0) {
        const form = new FormData();
        form.append("title", cleanName);
        form.append("kind", "Instruction");
        form.append("description", cleanText);
        form.append("labels", JSON.stringify(labels));
        form.append("duration_minutes", String(minutes));
        files.forEach((file) => {
          form.append("files", file);
        });
        
        await api.postForm("/documents/with-files", form);
      } else {
        await api.post("/documents", {
          title: cleanName,
          kind: "Instruction",
          description: cleanText,
          labels,
        });
      }

  nav("/configuration/documents", {
    state: { documentCreated: true },
  });
} catch (err) {
  setError(err.message || "Unable to create instruction.");
} finally {
  setBusy(false);
}
  }

  return (
    <div className="create-instruction-page">
      <button
        type="button"
        className="link-btn instruction-back-btn"
        onClick={() => nav("/configuration/documents")}
      >
        ‹ Back to Instructions and documents
      </button>

      <header className="instruction-page-heading">
        <div className="instruction-heading-icon">
          <ClipboardList size={23} />
        </div>

        <div>
          <h1 className="page-title">Create New Instruction</h1>
          <p>
            Define the task details, expected duration and supporting documents.
          </p>
        </div>
      </header>

      <form
        className="panel instruction-form"
        onSubmit={submit}
      >
        {!canManageInstructions && (
          <p className="notice" role="status">
            Only Administrators and Supervisors can create instructions.
          </p>
        )}

        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        <fieldset
          disabled={!canManageInstructions || busy}
          className="instruction-form-fields"
        >
          {/* Instruction Name */}
          <div className="instruction-field">
            <label htmlFor="instruction-name">
              Instruction Name <span className="required">*</span>
            </label>

            <input
              id="instruction-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={2}
              maxLength={50}
              required
              placeholder="e.g. Motor Inspection and Lubrication"
            />

            <small>
              Enter a clear and descriptive name for this task.
              {` ${name.length}/50 characters`}
            </small>
          </div>

          {/* Labels */}
          <div className="instruction-field">
            <label htmlFor="instruction-label">
              Labels <span className="optional">(Optional)</span>
            </label>

            <LabelsField
              id="instruction-label"
              value={labels}
              onChange={setLabels}
              disabled={!canManageInstructions || busy}
            />

            <small>
              Add relevant labels to organize and identify instructions easily.
              Maximum 10 labels.
            </small>
          </div>

          {/* Duration */}
          <div className="instruction-field">
            <label htmlFor="instruction-duration">
              Expected Duration <span className="required">*</span>
            </label>

            <div className="instruction-duration-control">
              <Clock3 size={18} />

              <input
                id="instruction-duration"
                type="number"
                min="1"
                step="1"
                required
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
                placeholder="Enter duration"
              />

              <span>Minutes</span>
            </div>

            <small>
              Estimated time required to complete this task.
            </small>
          </div>

          {/* Instructions Text */}
          <div className="instruction-field">
            <div className="instruction-field-heading">
              <label htmlFor="instruction-text">
                Instructions Text <span className="required">*</span>
              </label>

              <span className="instruction-character-count">
                {text.length.toLocaleString("en-IN")}/10,000
              </span>
            </div>

            <textarea
              id="instruction-text"
              rows={2}
              maxLength={10000}
              required
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={
                "Describe the task step by step.\n\nInclude required tools, safety precautions, inspection steps and completion criteria..."
              }
            />

            <small>
              Provide clear instructions so technicians can perform the task
              correctly and safely.
            </small>
          </div>

          {/* Supporting Documents */}
          <div className="instruction-field">
            <label htmlFor="instruction-documents">
              Attach Supporting Documents{" "}
            </label>

            <label
              className="instruction-upload-area"
              htmlFor="instruction-documents"
            >
              <div className="instruction-upload-icon">
                <Upload size={23} />
              </div>

              <strong>Click to upload documents</strong>

              <span>
                Choose PDF, DOC, DOCX or TXT files
              </span>

              <small>
                Maximum 10 documents · 10 MB per document
              </small>
            </label>

            <input
              id="instruction-documents"
              className="instruction-file-input"
              type="file"
              accept=".pdf,.doc,.docx,.txt"
              multiple
              onChange={handleFileChange}
              disabled={busy}
            />

            {files.length > 0 && (
              <div className="instruction-selected-files">
                <div className="instruction-files-heading">
                  <span>
                    <Paperclip size={15} />
                    Selected Documents
                  </span>
                  <small>{files.length}/10</small>
                </div>

                {files.map((file, index) => (
                  <div
                    className="instruction-file-item"
                    key={`${file.name}-${file.lastModified}`}
                  >
                    <FileText size={19} />

                    <div className="instruction-file-info">
                      <strong>{file.name}</strong>
                      <small>
                        {(file.size / (1024 * 1024)).toFixed(2)} MB
                      </small>
                    </div>

                    <button
                      type="button"
                      className="instruction-remove-file"
                      onClick={() => removeFile(index)}
                      aria-label={`Remove ${file.name}`}
                    >
                      <X size={17} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </fieldset>

        {/* Form Actions */}
        <div className="instruction-form-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => nav("/configuration/documents")}
          >
            Cancel
          </button>

          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !canManageInstructions}
            title={
              !canManageInstructions
                ? "Only Administrators and Supervisors can create instructions."
                : undefined
            }
          >
            {busy ? "Submitting..." : "Create Instruction"}
          </button>
        </div>
      </form>
    </div>
  );
}
