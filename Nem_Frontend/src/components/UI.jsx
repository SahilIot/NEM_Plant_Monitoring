import React, { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyArt } from "./Icons.jsx";

export const EmptyState = ({ title, lines = [] }) => (
  <div className="empty">
    <EmptyArt />
    {title && <div className="empty-title">{title}</div>}
    {lines.map((l, i) => <div key={i} className="empty-line">{l}</div>)}
  </div>
);

export const CardLink = ({ to, icon: Icon, title, desc }) => (
  <Link to={to} className="cardlink">
    <div className="cardlink-ico"><Icon size={56} strokeWidth={1.3} /></div>
    <div className="cardlink-txt">
      <div className="cardlink-title">{title}</div>
      <div className="cardlink-desc">{desc}</div>
    </div>
  </Link>
);

export const Modal = ({ title, onClose, children, wide }) => (
  <div className="modal-bg" onClick={onClose}>
    <div className={"modal" + (wide ? " wide" : "")} onClick={(e) => e.stopPropagation()}>
      <h3>{title}</h3>
      {children}
    </div>
  </div>
);


export function CreateModal({ title, fields, onSubmit, onClose, submitLabel = "Create" }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.key, f.default ?? ""])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key, value) => setValues({ ...values, [key]: value });

  const submit = async (e) => {
    e.preventDefault();
    for (const f of fields) {
      if (f.required && !String(values[f.key]).trim()) return setError(`${f.label} is required.`);
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
        {fields.map((f, i) => (
          <div className="field" key={f.key}>
            <label htmlFor={"f-" + f.key}>{f.label}{f.required && <span className="req"> *</span>}</label>
            {f.type === "textarea" ? (
              <textarea id={"f-" + f.key} rows={3} placeholder={f.placeholder} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} />
            ) : f.type === "select" ? (
              <select id={"f-" + f.key} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)}>
                {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ) : (
              <input id={"f-" + f.key} autoFocus={i === 0} placeholder={f.placeholder} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} />
            )}
          </div>
        ))}
        {error && <p className="notice error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}