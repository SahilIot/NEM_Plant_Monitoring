import React, { useState } from "react";
import { Copy, X } from "lucide-react";
import { api } from "../../../services/api.js";
import "./CopyRuleModal.css";

export default function CopyRuleModal({
  template,
  existingTemplates,
  onClose,
  onComplete,
}) {
  const [name, setName] = useState(template.name || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();

    if (saving) return;

    const newName = name.trim();

    if (!newName) {
      setError("Rule name is required.");
      return;
    }

    if (newName.toLowerCase() === template.name.trim().toLowerCase()) {
      setError("Name change is required to copy this rule.");
      return;
    }

    const duplicate = existingTemplates.some(
      (item) =>
        item.name.trim().toLowerCase() === newName.toLowerCase()
    );

    if (duplicate) {
      setError("A rule with this name already exists. Please choose another name.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const payload = {
        name: newName,
        description: template.description || null,
        labels: template.labels || [],
        rule_type: template.rule_type,
        required_variable_types: template.required_variable_types || null,
        variable_key: template.variable_key || null,
        operator: template.operator || null,
        threshold: template.threshold ?? null,
        parameters: template.parameters || null,
        severity: template.severity,
        is_enabled: template.is_enabled,
        evaluation_interval_seconds:
          template.evaluation_interval_seconds ?? null,
        stale_after_seconds: template.stale_after_seconds ?? null,
        collection_id: null,
      };

      const result = await api.post("/rule-templates", payload);

      await onComplete?.(result);
      onClose();
    } catch (err) {
      setError(
        err.message ||
          "Could not copy this rule. Please try another name."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="copy-rule-backdrop"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !saving && onClose()
      }
    >
      <section
        className="copy-rule-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-rule-title"
      >
        <header className="copy-rule-header">
          <div>
            <h2 id="copy-rule-title">
              <Copy size={19} />
              Copy monitoring rule
            </h2>
            <p>
              Create a new reusable rule using the original rule's settings.
            </p>
          </div>

          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </header>

        <form onSubmit={submit}>
          <div className="copy-rule-body">
            <div className="copy-rule-original">
              <span>Original rule</span>
              <strong>{template.name}</strong>
            </div>

            <div className="copy-rule-field">
              <label htmlFor="copy-rule-name">
                New rule name <span>*</span>
              </label>

              <input
                id="copy-rule-name"
                type="text"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError("");
                }}
                placeholder="Enter a different rule name"
                maxLength={200}
                disabled={saving}
                autoFocus
              />

              <small>
                Changing the name is required to create a copy.
              </small>
            </div>

            {error && (
              <p className="copy-rule-error" role="alert">
                {error}
              </p>
            )}
          </div>

          <footer className="copy-rule-footer">
            <button
              type="button"
              className="btn-outline"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="btn-primary"
              disabled={saving}
            >
              <Copy size={16} />
              {saving ? "Copying..." : "Copy rule"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}