import React, { useState } from "react";

function ago(date) {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}
const FRESH_SECONDS = 300;

/** Current value and availability of a variable from its latest reading. */
export function describeReading(reading) {
  if (!reading) return { text: "No reading yet", state: "unavailable" };
  const at = new Date(reading.recorded_at);
  const value = typeof reading.value === "boolean" ? (reading.value ? "ON" : "OFF") : String(reading.value);
  if (Number.isNaN(at.getTime())) return { text: value, state: "unavailable" };
  const stale = (Date.now() - at.getTime()) / 1000 > FRESH_SECONDS;
  return { text: `${value} · ${ago(at)}`, state: stale ? "stale" : "available" };
}

/**
 * Connect Variable: shows the connected variable, or a searchable list of the asset's variables with
 * identifier, data type, asset, current value and availability. `reasonFor(variable)` returns why a
 * variable cannot be used ("" when it can), so unusable rows are listed but disabled with the reason.
 */
export default function VariableSelector({ variables, readings, value, onChange, reasonFor, assetName, disabled, idPrefix, hint }) {
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const selected = variables.find((item) => String(item.id) === String(value)) || null;
  const rows = variables.filter((item) => {
    const text = search.trim().toLowerCase();
    return !text || `${item.name} ${item.key || ""} ${item.opcua_node_id || ""}`.toLowerCase().includes(text);
  });
  const identifier = (variable) => variable.opcua_node_id || variable.key || `#${variable.id}`;

  if (selected && !picking) {
    const info = describeReading(readings?.[selected.id]);
    return (
      <div className="iw-selected" aria-live="polite">
        <div className="iw-selected-head">
          <strong>{selected.name}</strong>
          <span className="iw-chip">Connected</span>
        </div>
        <dl className="iw-details">
          <div><dt>Identifier</dt><dd>{identifier(selected)}</dd></div>
          <div><dt>Data type</dt><dd>{selected.data_type}</dd></div>
          <div><dt>Asset</dt><dd>{assetName}</dd></div>
          <div><dt>Current value</dt><dd>{info.text}{info.state === "stale" ? " (stale)" : ""}</dd></div>
        </dl>
        <div className="iw-selected-actions">
          <button type="button" className="btn-outline" onClick={() => setPicking(true)} disabled={disabled}>Change variable</button>
          <button type="button" className="btn-outline" onClick={() => onChange("")} disabled={disabled}>Disconnect</button>
        </div>
      </div>
    );
  }

  if (!picking && !selected) {
    return (
      <div className="pw-connect">
        <button type="button" className="btn-outline" onClick={() => setPicking(true)} disabled={disabled}>Connect variable</button>
        {hint && <small className="iw-help">{hint}</small>}
      </div>
    );
  }

  return (
    <div className="iw-picker">
      <div className="iw-picker-head">
        <label htmlFor={`${idPrefix}-search`}>Select a variable</label>
        <button type="button" className="btn-outline" onClick={() => setPicking(false)}>Cancel</button>
      </div>
      <input id={`${idPrefix}-search`} type="search" value={search} onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name or identifier" disabled={disabled} />
      <ul className="iw-var-list" role="listbox" aria-label="Available variables">
        {rows.map((item) => {
          const reason = reasonFor(item);
          const info = describeReading(readings?.[item.id]);
          return (
            <li key={item.id} role="option" aria-selected={String(item.id) === String(value)} aria-disabled={Boolean(reason)}>
              <button type="button" className={`iw-var${String(item.id) === String(value) ? " is-selected" : ""}`}
                disabled={Boolean(reason) || disabled} onClick={() => { onChange(String(item.id)); setPicking(false); }}>
                <span className="iw-var-name">{item.name}</span>
                <span className="iw-var-meta">{identifier(item)} · {item.data_type} · {assetName} · {info.text} · {info.state}</span>
                {reason && <span className="iw-var-meta">{reason}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {!rows.length && <p className="iw-help">{variables.length ? "No variable matches your search." : "This asset has no active variables."}</p>}
    </div>
  );
}
