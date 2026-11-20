import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { api } from "../../../services/api.js";
import { MAX_COMPONENT_IDENTIFIER, componentIdentifierProblem, normalizeComponentIdentifier } from "./componentIdentifier.js";
import "./IntervalRuleWizard.css";
import "./ParameterEditDialog.css";

/** Sets or clears the optional component identifier of an assigned rule. */
export default function ComponentIdentifierDialog({ rule, onClose, onSaved }) {
  const [value, setValue] = useState(rule.component_identifier || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const problem = componentIdentifierProblem(value);

  const save = async (event) => {
    event.preventDefault();
    if (submitting.current || problem) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await api.post(`/rules/${rule.id}/component-identifier`, {
        component_identifier: normalizeComponentIdentifier(value),
      });
      onSaved?.(saved.component_identifier);
    } catch (caught) {
      setError(caught?.message || "Could not save the component identifier.");
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-bg" onClick={saving ? undefined : onClose}>
      <div className="modal pe-modal" role="dialog" aria-modal="true" aria-labelledby="ci-title" onClick={(event) => event.stopPropagation()}>
        <header className="pe-head">
          <div className="pe-head-text">
            <h3 id="ci-title">Component identifier</h3>
            <p>{rule.name}</p>
          </div>
          <button type="button" className="icon-outline" aria-label="Close" onClick={onClose} disabled={saving}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <form id="ci-form" className="pe-body" onSubmit={save} noValidate>
          <section className="pe-section">
            <div className="form-group form-group-wide">
              <label htmlFor="ci-input">
                Identifier<span className="optional-label">(optional)</span>
              </label>
              <input
                id="ci-input"
                type="text"
                value={value}
                maxLength={MAX_COMPONENT_IDENTIFIER + 50}
                onChange={(event) => setValue(event.target.value)}
                placeholder="For example P-101"
                disabled={saving}
                autoFocus
                aria-describedby="ci-help"
              />
              <small id="ci-help">
                Tags the component this rule monitors. Shown in the rule details and the event log. Leave empty to remove it.
              </small>
            </div>
          </section>
          {problem && <p className="pe-error" role="alert">{problem}</p>}
          {error && <p className="pe-error" role="alert">{error}</p>}
        </form>
        <footer className="pe-foot">
          <button type="button" className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="ci-form" className="btn-primary" disabled={saving || Boolean(problem)}>
            {saving ? "Saving…" : "Save identifier"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
