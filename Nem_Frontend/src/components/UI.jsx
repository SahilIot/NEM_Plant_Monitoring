import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyArt } from "./Icons.jsx";

export const EmptyState = ({ title, lines = [], art = true }) => (
  <div className="empty">
    {art && <EmptyArt />}
    {title && <div className="empty-title">{title}</div>}
    {lines.map((l, i) => <div key={i} className="empty-line">{l}</div>)}
  </div>
);

export const CardLink = ({ to, icon: Icon, title, desc }) => (
  <Link to={to} className="cardlink">
    <div className="cardlink-ico"><Icon size={34} strokeWidth={1.5} /></div>
    <div className="cardlink-txt">
      <div className="cardlink-title">{title}</div>
      <div className="cardlink-desc">{desc}</div>
    </div>
  </Link>
);

const STATUS_LABEL = {
  ok: "Normal",
  normal: "Normal",
  warning: "Warning",
  alert: "Alert",
  unknown: "Not evaluated",
};

export const StatusBadge = ({ status }) => (
  <span className={"badge " + (status === "normal" ? "ok" : status || "unknown")}>
    {STATUS_LABEL[status] || status || "Not evaluated"}
  </span>
);

export const Modal = ({ title, onClose, children, wide }) => {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div
        className={"modal" + (wide ? " wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
};

// A <select> shows its first option even when no value has been chosen, so the
// form state has to start on that option or the visible choice is never submitted.
const initialValue = (field) => {
  if (field.default !== undefined && field.default !== null) return field.default;
  if (field.type === "select" && field.options?.length) return field.options[0][0];
  return "";
};

export function CreateModal({ title, fields, onSubmit, onClose, submitLabel = "Create", intro }) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(fields.map((f) => [f.key, initialValue(f)]))
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key, value) => setValues((current) => ({ ...current, [key]: value }));

  const submit = async (e) => {
    e.preventDefault();
    for (const f of fields) {
      if (f.required && !String(values[f.key] ?? "").trim()) {
        return setError(`${f.label} is required.`);
      }
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit(values);
    } catch (err) {
      setError(String(err.message || err));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={submit}>
        {intro && <p className="muted modal-intro">{intro}</p>}
        {fields.map((f, i) => (
          <div className="field" key={f.key}>
            <label htmlFor={"f-" + f.key}>
              {f.label}
              {f.required && <span className="req"> *</span>}
            </label>
            {f.type === "textarea" ? (
              <textarea id={"f-" + f.key} rows={3} placeholder={f.placeholder} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} />
            ) : f.type === "select" ? (
              <select id={"f-" + f.key} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)}>
                {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ) : (
              <input id={"f-" + f.key} type={f.type || "text"} step={f.type === "number" ? "any" : undefined} autoFocus={i === 0} placeholder={f.placeholder} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} />
            )}
            {f.hint && <span className="hint">{f.hint}</span>}
          </div>
        ))}
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
