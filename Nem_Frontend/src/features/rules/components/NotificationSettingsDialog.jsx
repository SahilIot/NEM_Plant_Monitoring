import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { api } from "../../../services/api.js";
import "./IntervalRuleWizard.css";
import "./ParameterEditDialog.css";
import "./NotificationSettingsDialog.css";

export const MAX_NOTIFICATION_MESSAGE = 500;
const SEVERITIES = [
  { key: "warning", label: "Warning" },
  { key: "alert", label: "Alert" },
];

// Settings of a rule that predates the feature: both severities on, default message.
const withDefaults = (stored) =>
  Object.fromEntries(
    SEVERITIES.map(({ key }) => [
      key,
      { enabled: stored?.[key]?.enabled !== false, message: stored?.[key]?.message || "" },
    ])
  );

/** Email notification settings of one rule: Warning/Alert on-off and an optional custom message. */
export default function NotificationSettingsDialog({ rule, onClose, onSaved }) {
  const [form, setForm] = useState(() => withDefaults(rule.notifications));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  const change = (key, patch) => setForm((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  const problems = SEVERITIES.filter(({ key }) => form[key].message.trim().length > MAX_NOTIFICATION_MESSAGE).map(
    ({ label }) => `${label} message can be at most ${MAX_NOTIFICATION_MESSAGE} characters.`
  );

  const save = async (event) => {
    event.preventDefault();
    if (submitting.current || problems.length) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      // An empty or whitespace-only message is sent as null: the default message is used.
      const notifications = Object.fromEntries(
        SEVERITIES.map(({ key }) => [key, { enabled: form[key].enabled, message: form[key].message.trim() || null }])
      );
      const saved = await api.post(`/rules/${rule.id}/notification-settings`, { notifications });
      onSaved?.(saved.notifications);
    } catch (caught) {
      setError(caught?.message || "Could not save the notification settings.");
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-bg" onClick={saving ? undefined : onClose}>
      <div className="modal pe-modal" role="dialog" aria-modal="true" aria-labelledby="ns-title" onClick={(event) => event.stopPropagation()}>
        <header className="pe-head">
          <div className="pe-head-text">
            <h3 id="ns-title">Notification settings</h3>
            <p>{rule.name}</p>
          </div>
          <button type="button" className="icon-outline" aria-label="Close" onClick={onClose} disabled={saving}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <form id="ns-form" className="pe-body" onSubmit={save} noValidate>
          {SEVERITIES.map(({ key, label }) => {
            const length = form[key].message.trim().length;
            return (
              <section className="pe-section" key={key}>
                <h4>{label} email</h4>
                <label className="ns-switch">
                  <input
                    type="checkbox"
                    checked={form[key].enabled}
                    onChange={(event) => change(key, { enabled: event.target.checked })}
                    disabled={saving}
                  />
                  <span>Send {label} emails for this rule</span>
                </label>
                <div className="form-group form-group-wide">
                  <label htmlFor={`ns-${key}`}>
                    Custom message<span className="optional-label">(optional)</span>
                  </label>
                  <textarea
                    id={`ns-${key}`}
                    className="ns-message"
                    rows={3}
                    value={form[key].message}
                    onChange={(event) => change(key, { message: event.target.value })}
                    placeholder="Leave empty to use the default message"
                    disabled={saving}
                    aria-describedby={`ns-${key}-help`}
                  />
                  <small id={`ns-${key}-help`}>
                    Replaces the details line of the {label} email. {length}/{MAX_NOTIFICATION_MESSAGE}
                  </small>
                </div>
              </section>
            );
          })}
          <p className="pe-note">
            These settings only control emails. The rule, its alerts and the recipients are not changed, and
            maintenance-ready emails are always sent.
          </p>
          {problems.length > 0 && (
            <ul className="pe-problems" role="alert">
              {problems.map((message) => <li key={message}>{message}</li>)}
            </ul>
          )}
          {error && <p className="pe-error" role="alert">{error}</p>}
        </form>
        <footer className="pe-foot">
          <button type="button" className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="ns-form" className="btn-primary" disabled={saving || problems.length > 0}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
