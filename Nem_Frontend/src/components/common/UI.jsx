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


const initialValue = (field) => {
  if (field.type === "files") return [];
  if (field.default !== undefined && field.default !== null) return String(field.default);
  if (field.type === "select") return "";
  return "";
};

export function CreateModal({ title, fields, onSubmit, onClose, submitLabel = "Create", intro }) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(fields.map((f) => [f.key, initialValue(f)]))
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isVisible = (field) =>
    !field.showWhen ||
    values[field.showWhen.key] === field.showWhen.equals;
  const isRequired = (field) =>
    Boolean(
      field.required ||
        (field.requiredWhen &&
          values[field.requiredWhen.key] === field.requiredWhen.equals)
    );

  
  useEffect(() => {
    setValues((current) => {
      let changed = Object.keys(current).length !== fields.length;
      const next = Object.fromEntries(
        fields.map((field) => {
          const hasValue = Object.hasOwn(current, field.key);
          let value = hasValue ? current[field.key] : initialValue(field);

          if (
            field.type === "select" &&
            value !== "" &&
            field.options &&
            !field.options.some(([option]) => String(option) === String(value))
          ) {
            value = initialValue(field);
          }

          if (!hasValue || value !== current[field.key]) changed = true;
          return [field.key, value];
        })
      );
      return changed ? next : current;
    });
  }, [fields]);

  const set = (key, value) => setValues((current) => ({ ...current, [key]: value }));

  const submit = async (e) => {
    e.preventDefault();
    for (const f of fields) {
      if (
        isVisible(f) &&
        isRequired(f) &&
        !(f.type === "files" ? (Array.isArray(values[f.key]) && values[f.key].length > 0) : String(values[f.key] ?? "").trim())
      ) {
        return setError(`${f.label} is required.`);
      }
    }
    setBusy(true);
    setError("");
    try {
      const normalized = {};
      for (const field of fields) {
        const value = values[field.key] ?? (field.type === "files" ? [] : "");
        if (field.type === "files") {
          normalized[field.key] = value;
        } else if (field.type === "number" && String(value).trim() !== "") {
          const number = Number(value);
          if (!Number.isFinite(number)) {
            setError(`${field.label} must be a valid number.`);
            setBusy(false);
            return;
          }
          normalized[field.key] = number;
        } else {
          normalized[field.key] = value;
        }
      }
      await onSubmit(normalized);
    } catch (err) {
      setError(String(err.message || err));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={submit}>
        {intro && <p className="muted modal-intro">{intro}</p>}
        {fields.filter(isVisible).map((f, i) => (
          <div className="field" key={f.key}>
            <label htmlFor={"f-" + f.key}>
              {f.label}
              {isRequired(f) && <span className="req"> *</span>}
            </label>
            {f.type === "files" ? (
              <>
                <input id={"f-" + f.key} type="file" multiple accept={f.accept || ".pdf,.doc,.docx,.txt"} disabled={busy} onChange={(e) => set(f.key, Array.from(e.target.files || []))} />
                {Array.isArray(values[f.key]) && values[f.key].length > 0 && <ul className="hint">{values[f.key].map((file) => <li key={`${file.name}-${file.size}`}>{file.name} ({(file.size / 1024).toFixed(1)} KB)</li>)}</ul>}
                {f.hint && <span className="hint">{f.hint}</span>}
              </>
            ) : f.type === "textarea" ? (
              <textarea id={"f-" + f.key} rows={3} placeholder={f.placeholder} value={values[f.key] ?? ""} disabled={busy} onChange={(e) => set(f.key, e.target.value)} />
            ) : f.type === "select" ? (
              <select
                id={"f-" + f.key}
                value={values[f.key] ?? ""}
                required={isRequired(f)}
                disabled={Boolean(f.disabled || busy)}
                onChange={(e) => {
                  set(f.key, e.target.value);
                  setError("");
                  if (f.onChange) f.onChange(e.target.value, values, setValues);
                }}
              >
                <option value="" disabled={Boolean(f.required)}>
                  {f.placeholder || `Select ${f.label.toLowerCase()}`}
                </option>
                {f.options.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
              </select>
            ) : (
              <input id={"f-" + f.key} type={f.type || "text"} step={f.type === "number" ? "any" : undefined} autoFocus={i === 0} required={isRequired(f)} disabled={busy} placeholder={f.placeholder} value={f.type === "files" ? undefined : (values[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />
            )}
            {f.hint && <span className="hint">{f.hint}</span>}
          </div>
        ))}
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-outline" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
