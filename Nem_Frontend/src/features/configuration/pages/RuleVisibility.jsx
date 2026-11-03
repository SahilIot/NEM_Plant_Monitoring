import React, { useEffect, useState } from "react";
import { Eye, X } from "lucide-react";
import { api } from "../../../services/api.js";
import { LoadingIndicator } from "../../../components/common/UI.jsx";

export const VISIBILITY_LABELS = {
  admin_only: "Admin only",
  specific_supervisors: "Specific supervisors",
  all_supervisors: "All supervisors",
};

const VISIBILITY_HELP = {
  admin_only: "Only Administrators can see and manage this shared rule.",
  specific_supervisors: "Only the Supervisors you select can see and manage it.",
  all_supervisors: "Every active Supervisor can see and manage it.",
};

function ModalShell({ id, title, subtitle, onClose, busy, children, footer }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, busy]);
  return (
    <div
      className="rule-library-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section className="rule-library-modal" role="dialog" aria-modal="true" aria-labelledby={id}>
        <header>
          <div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            <X size={19} />
          </button>
        </header>
        <div className="rule-visibility-body">{children}</div>
        <footer>{footer}</footer>
      </section>
    </div>
  );
}

export function VisibilityBadge({ type }) {
  return (
    <span className="rule-library-status" title="Who can see and manage this shared rule">
      <Eye size={11} aria-hidden="true" /> {VISIBILITY_LABELS[type] || VISIBILITY_LABELS.admin_only}
    </span>
  );
}

/** Administrator: change a shared rule's visibility directly. */
export function VisibilityModal({ template, onClose, onSaved }) {
  const [type, setType] = useState(template.visibility_type || "admin_only");
  const [supervisors, setSupervisors] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get("/rule-visibility/supervisors"),
      api.get(`/rule-templates/${template.id}/visibility`),
    ])
      .then(([users, detail]) => {
        if (!alive) return;
        setSupervisors(Array.isArray(users) ? users : []);
        setSelected(new Set((detail.supervisors || []).map((item) => item.id)));
        setType(detail.visibility_type);
      })
      .catch((err) => alive && setError(err.message || "Could not load visibility settings."));
    return () => {
      alive = false;
    };
  }, [template.id]);

  const toggle = (id) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.put(`/rule-templates/${template.id}/visibility`, {
        visibility_type: type,
        supervisor_ids: type === "specific_supervisors" ? [...selected] : [],
      });
      await onSaved();
    } catch (err) {
      setError(err.message || "Could not update visibility.");
      setSaving(false);
    }
  };

  const needsSelection = type === "specific_supervisors" && selected.size === 0;
  return (
    <ModalShell
      id="rule-visibility-title"
      title={`Rule visibility — ${template.name}`}
      subtitle="Controls who can see and edit this shared rule. It does not change anyone's asset access."
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn-primary"
            onClick={save}
            disabled={saving || supervisors === null || needsSelection}
          >
            {saving ? "Saving…" : "Save visibility"}
          </button>
        </>
      }
    >
      {error && <p className="notice error" role="alert">{error}</p>}
      <fieldset className="rule-visibility-options" disabled={saving}>
        <legend className="muted">Visibility</legend>
        {Object.keys(VISIBILITY_LABELS).map((key) => (
          <label key={key} className="rule-visibility-option">
            <input
              type="radio"
              name="rule-visibility"
              checked={type === key}
              onChange={() => setType(key)}
            />
            <span>
              <strong>{VISIBILITY_LABELS[key]}</strong>
              <small>{VISIBILITY_HELP[key]}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {type === "specific_supervisors" && (
        <div className="rule-visibility-supervisors">
          <p className="muted">Supervisors who can see and manage this rule</p>
          {supervisors === null ? (
            <LoadingIndicator compact message="Loading supervisors" />
          ) : supervisors.length === 0 ? (
            <p className="muted">There are no active Supervisors.</p>
          ) : (
            supervisors.map((person) => (
              <label key={person.id} className="rule-visibility-option">
                <input
                  type="checkbox"
                  checked={selected.has(person.id)}
                  onChange={() => toggle(person.id)}
                  disabled={saving}
                />
                <span>{person.username}</span>
              </label>
            ))
          )}
          {needsSelection && supervisors?.length > 0 && (
            <small className="rule-library-error">Select at least one Supervisor.</small>
          )}
        </div>
      )}
    </ModalShell>
  );
}
