
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../../services/api.js";
import "./CreateInstructionPage.css";

export default function CreateInstructionPage() {
  const nav = useNavigate();

  const [name, setName] = useState("");
  const [labels, setLabels] = useState([]);
  const [labelInput, setLabelInput] = useState("");
  const [duration, setDuration] = useState("30");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function addLabel() {
    const label = labelInput.trim();

    if (!label) return;

    if (label.length < 2 || label.length > 50) {
      setError("Label must contain 2–50 characters.");
      return;
    }

    if (labels.length >= 10) {
      setError("Maximum 10 labels are allowed.");
      return;
    }

    if (
      labels.some(
        (item) => item.toLowerCase() === label.toLowerCase()
      )
    ) {
      setError("This label already exists.");
      return;
    }

    setLabels((current) => [...current, label]);
    setLabelInput("");
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
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

    setBusy(true);

    try {
      await api.post("/instructions", {
        name: cleanName,
        labels,
        duration_minutes: minutes,
        text: cleanText,
      });

      nav("/configuration/instructions");
    } catch (err) {
      setError(
        err.message || "Unable to create instruction."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="create-instruction-page">
      <button
        type="button"
        className="link-btn"
        onClick={() => nav("/configuration/documents")}
      >
        ← Back to Instructions and documents
      </button>

      <header className="instruction-page-heading">
        <h1 className="page-title">
          Create New Instruction
        </h1>

        <p>
          Define the task instructions and expected duration.
        </p>
      </header>

      <form
        className="panel instruction-form"
        onSubmit={submit}
      >
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        <div className="instruction-field">
          <label htmlFor="instruction-name">
            Name *
          </label>

          <input
            id="instruction-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={50}
            required
            placeholder="Enter instruction name"
          />
        </div>

        <div className="instruction-field">
          <label htmlFor="instruction-label">
            Labels
          </label>

          <div className="instruction-label-entry">
            <input
              id="instruction-label"
              value={labelInput}
              maxLength={50}
              placeholder="Enter a label"
              onChange={(e) =>
                setLabelInput(e.target.value)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addLabel();
                }
              }}
            />

            <button
              type="button"
              className="btn-secondary"
              onClick={addLabel}
              disabled={labels.length >= 10}
            >
              Add
            </button>
          </div>

          <div className="instruction-label-list">
            {labels.map((label) => (
              <span
                className="instruction-label-chip"
                key={label}
              >
                {label}

                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  onClick={() =>
                    setLabels((current) =>
                      current.filter(
                        (item) => item !== label
                      )
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          <small>{labels.length}/10 labels</small>
        </div>

        <div className="instruction-field">
          <label htmlFor="instruction-duration">
            Duration in minutes *
          </label>

          <input
            id="instruction-duration"
            type="number"
            min="1"
            step="1"
            required
            value={duration}
            onChange={(e) =>
              setDuration(e.target.value)
            }
          />
        </div>

        <div className="instruction-field">
          <label htmlFor="instruction-text">
            Instructions Text *
          </label>

          <textarea
            id="instruction-text"
            rows={8}
            maxLength={10000}
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write the instructions here..."
          />

          <small>
            {text.length}/10,000 characters
          </small>
        </div>

        <div className="instruction-form-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              nav("/configuration/documents")
            }
          >
            Cancel
          </button>

          <button
            type="submit"
            className="btn-primary"
            disabled={busy}
          >
            {busy ? "Submitting..." : "Submit"}
          </button>
        </div>
      </form>
    </div>
  );
}
