import React, { useEffect, useState } from "react";
import { Eye, X } from "lucide-react";
import { api } from "../../../services/api.js";
import { LoadingIndicator } from "../../../components/common/UI.jsx";

export const VISIBILITY_LABELS = {
  admin_only: "Admin Only",
  specific_supervisors: "Specific Supervisors",
};

const VISIBILITY_HELP = {
  admin_only: "Only Administrators can see and manage this shared rule.",
  specific_supervisors: "Only the Supervisors you select (and Administrators) can see and manage it.",
};

export const SHARED_RULE_WARNING =
  "This is a shared rule. Changing this configuration will affect all assets and users using this rule. Do you want to continue?";

/** Active Supervisors an Administrator may grant visibility to (null while loading). */
export function useSupervisorChoices(enabled = true) {
  const [choices, setChoices] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    api
      .get("/rule-visibility/supervisors")
      .then((list) => alive && setChoices(Array.isArray(list) ? list : []))
      .catch(() => alive && setChoices([]));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return choices;
}

/** Create-form fields: an explicit choice (no default) plus the Supervisor picker. */
export function visibilityFields(supervisorChoices) {
  const specific = { key: "visibility_type", equals: "specific_supervisors" };
  return [
    {
      key: "visibility_type",
      label: "Visibility",
      type: "select",
      required: true,
      placeholder: "Select who can see this rule",
      options: Object.entries(VISIBILITY_LABELS),
      hint: "Admin Only: only Administrators. Specific Supervisors: Administrators and the Supervisors you select.",
    },
    {
      key: "visibility_supervisor_ids",
      label: "Supervisors",
      type: "supervisors",
      choices: supervisorChoices || [],
      showWhen: specific,
      requiredWhen: specific,
    },
  ];
}

/** Stand-alone explicit visibility chooser for forms that are not built from CreateModal fields. */
export function VisibilityPicker({ id, type, onType, ids, onIds, choices, disabled }) {
  return (
    <div>
      <select id={id} value={type} onChange={(event) => onType(event.target.value)} disabled={disabled} required>
        <option value="" disabled>Select who can see this rule</option>
        {Object.entries(VISIBILITY_LABELS).map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
      {type === "specific_supervisors" && (
        <div className="rule-visibility-supervisors">
          {(choices || []).length === 0 ? (
            <small>There are no active Supervisors.</small>
          ) : (
            choices.map((person) => (
              <label key={person.id} className="rule-visibility-option">
                <input
                  type="checkbox"
                  checked={ids.includes(person.id)}
                  disabled={disabled}
                  onChange={() =>
                    onIds(ids.includes(person.id) ? ids.filter((item) => item !== person.id) : [...ids, person.id])
                  }
                />
                <span>{person.username}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export const VISIBILITY_CHANGE_WARNING =
  "You are changing who can access this rule. The change applies to the shared rule itself, so it affects access for every asset that uses it, not only the one currently shown. Thresholds, activation state and assignments are not changed.";

const sortedIds = (list) => [...(list || [])].map(Number).sort((a, b) => a - b);

/** True when the form's visibility differs from the stored one (Administrator edit forms). */
export function visibilityChanged(template, values) {
  if (!values.visibility_type) return false;
  if (values.visibility_type !== (template.visibility_type || "admin_only")) return true;
  return (
    values.visibility_type === "specific_supervisors" &&
    JSON.stringify(sortedIds(values.visibility_supervisor_ids)) !==
      JSON.stringify(sortedIds(template.visibility_supervisor_ids))
  );
}

/** Edit-form initial values for the visibility fields. */
export function visibilityInitial(template) {
  return {
    visibility_type: template?.visibility_type || "admin_only",
    visibility_supervisor_ids: sortedIds(template?.visibility_supervisor_ids),
  };
}

/** Persist a visibility change through the existing Administrator endpoint. */
export async function saveVisibility(template, values) {
  await api.put(`/rule-templates/${template.id}/visibility`, {
    visibility_type: values.visibility_type,
    supervisor_ids:
      values.visibility_type === "specific_supervisors"
        ? sortedIds(values.visibility_supervisor_ids)
        : [],
  });
}

export function visibilityPayload(values) {
  return {
    visibility_type: values.visibility_type,
    visibility_supervisor_ids:
      values.visibility_type === "specific_supervisors"
        ? (values.visibility_supervisor_ids || []).map(Number)
        : [],
  };
}

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
