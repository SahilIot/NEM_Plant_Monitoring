import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../../services/api.js";
import "./PredefinedRulesModal.css";


export default function PredefinedRulesModal({ assetId, onClose, onAssigned }) {
  const [rules, setRules] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.getAll("/rules", 200)
      .then((items) => {
        if (!alive) return;
        // A predefined rule is a rule not assigned to any asset yet.
        setRules((Array.isArray(items) ? items : []).filter((rule) =>
          rule.target_asset_id == null && rule.asset_id == null
        ));
      })
      .catch((err) => alive && setError(err.message || "Could not load predefined rules."))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const visibleRules = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter((rule) => `${rule.name || ""} ${rule.description || ""} ${rule.rule_type || ""}`.toLowerCase().includes(q));
  }, [rules, search]);

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const assign = async () => {
    if (!selected.size) return;
    setSaving(true);
    setError("");
    try {
     
      for (const id of selected) {
        await api.patch(`/rules/${id}`, { target_asset_id: Number(assetId), is_enabled: false });
      }
      await onAssigned?.();
      onClose();
    } catch (err) {
      setError(err.message || "Some rules could not be assigned. Refresh and check the asset before retrying.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="prm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="prm-dialog" role="dialog" aria-modal="true" aria-labelledby="prm-title">
        <header className="prm-header">
          <h2 id="prm-title">Assign Monitoring Rules</h2>
          <button type="button" className="prm-close" onClick={onClose} disabled={saving} aria-label="Close">×</button>
        </header>
        <div className="prm-tools">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search monitoring rules…" aria-label="Search monitoring rules" />
          <span>{selected.size} selected</span>
        </div>
        {error && <div className="prm-error" role="alert">{error}</div>}
        <div className="prm-list">
          {loading ? <p className="prm-empty">Loading rules…</p> : visibleRules.length === 0 ? (
            <p className="prm-empty">{rules.length ? "No rules match your search." : "No unassigned predefined rules found. Create a rule in Configuration first."}</p>
          ) : visibleRules.map((rule) => (
            <label className="prm-rule" key={rule.id}>
              <input type="checkbox" checked={selected.has(rule.id)} onChange={() => toggle(rule.id)} />
              <span className="prm-rule-copy"><strong>{rule.name}</strong><small>{rule.description || (rule.rule_type || "Monitoring rule").replaceAll("_", " ")}</small></span>
              <span className="prm-severity">{rule.severity || "warning"}</span>
            </label>
          ))}
        </div>
        <footer className="prm-footer">
          <span className="prm-note">Assigned rules remain inactive until you activate them.</span>
          <div><button type="button" className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button><button type="button" className="btn-primary" onClick={assign} disabled={saving || loading || selected.size === 0}>{saving ? "Assigning…" : `Assign${selected.size ? ` (${selected.size})` : ""}`}</button></div>
        </footer>
      </section>
    </div>
  );
}
