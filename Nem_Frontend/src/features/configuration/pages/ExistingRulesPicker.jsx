import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { api } from "../../../services/api.js";
import { LoadingIndicator, Modal } from "../../../components/common/UI.jsx";
import { displayType, ruleKind, templateSummary } from "./RuleLibrary.jsx";
import { MAX_COLLECTION_RULES } from "./collectionLimits.js";
import "./RuleLibrary.css";
import "./AddRuleWorkflow.css";


// The fields the backend's update endpoint expects. Labels are left out on purpose so they stay untouched.
const updatePayload = (template, collectionId) => ({
  name: template.name,
  description: template.description ?? null,
  collection_id: collectionId,
  rule_type: template.rule_type,
  required_variable_types: template.required_variable_types ?? null,
  variable_key: template.variable_key ?? null,
  operator: template.operator ?? null,
  threshold: template.threshold ?? null,
  parameters: template.parameters ?? null,
  severity: template.severity,
  is_enabled: template.is_enabled,
  evaluation_interval_seconds: template.evaluation_interval_seconds ?? null,
  stale_after_seconds: template.stale_after_seconds ?? null,
});

/** Moves one standalone library rule into a collection (re-reading it first so nothing is overwritten). */
async function moveTemplateToCollection(id, collectionId) {
  const fresh = await api.get(`/rule-templates/${id}`);
  if (fresh.collection_id != null) throw new Error("it already belongs to a collection");
  await api.put(`/rule-templates/${id}`, updatePayload(fresh, collectionId));
  return fresh;
}

/**
 * Select reusable rules from the Monitoring Rule Library and add them to a collection.
 * A rule belongs to at most one collection, so adding moves it out of the standalone library.
 */
// With `deferred`, nothing is moved: the chosen rules are handed to `onSelect` instead (used while a
// collection is still being created). `stagedRules` are rules already chosen that way.
export default function ExistingRulesPicker({ collection, onClose, onDone, deferred = false, onSelect, stagedRules = [] }) {
  const [templates, setTemplates] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [selected, setSelected] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  useEffect(() => {
    let active = true;
    api.get("/rule-templates")
      .then((rows) => { if (active) setTemplates(Array.isArray(rows) ? rows : []); })
      .catch((err) => { if (active) setLoadError(err.message || "Could not load the rule library."); });
    return () => { active = false; };
  }, []);

  const stagedIds = useMemo(() => new Set(stagedRules.map((item) => item.id)), [stagedRules]);
  const members = useMemo(
    () => (templates || []).filter((item) =>
      (collection.id != null && item.collection_id === collection.id) || (item.collection_id == null && stagedIds.has(item.id))),
    [templates, collection.id, stagedIds]
  );
  const available = useMemo(
    () => (templates || []).filter((item) => item.collection_id == null && !stagedIds.has(item.id)),
    [templates, stagedIds]
  );
  const slots = Math.max(0, MAX_COLLECTION_RULES - Math.max(collection.ruleCount || 0, collection.id != null ? members.length : 0));
  const kinds = useMemo(() => [...new Set(available.map((item) => ruleKind(item)))].sort(), [available]);

  const matches = (item) => {
    const needle = search.trim().toLowerCase();
    return (kind === "all" || ruleKind(item) === kind)
      && (!needle
        || item.name.toLowerCase().includes(needle)
        || (item.description || "").toLowerCase().includes(needle)
        || displayType(item).toLowerCase().includes(needle)
        || ruleKind(item).toLowerCase().includes(needle));
  };
  const visibleAvailable = available.filter(matches).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const visibleMembers = members.filter(matches);

  const toggle = (id) => {
    setError("");
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < slots) next.add(id);
      return next;
    });
  };

  const add = async () => {
    if (submitting.current || selected.size === 0) return;
    if (deferred) {
      onSelect(available.filter((item) => selected.has(item.id)));
      return;
    }
    submitting.current = true;
    setSaving(true);
    setError("");
    const added = [];
    const failed = [];
    for (const id of selected) {
      const name = available.find((item) => item.id === id)?.name || `Rule ${id}`;
      try {
        // Re-reads the rule first so a rule that was moved or changed meanwhile is never overwritten.
        await moveTemplateToCollection(id, collection.id);
        added.push(name);
      } catch (err) {
        failed.push(`${name}: ${err.message || "could not be added"}`);
      }
    }
    submitting.current = false;
    setSaving(false);
    if (failed.length === 0 || added.length > 0) {
      onDone({ added, failed });
      return;
    }
    setError(failed.join(" "));
  };

  const full = slots === 0;

  return (
    <Modal title={`Select existing rules for “${collection.name}”`} onClose={saving ? () => {} : onClose} wide>
      <p className="muted add-rule-intro">
        Choose reusable rules from the Monitoring Rule Library. A rule belongs to one collection, so a rule you add moves out of the
        standalone library{deferred ? " when the collection is created" : ""}. {full ? "This collection is full." : `You can add up to ${slots} more.`}
      </p>

      <div className="add-rule-tools">
        <label className="rule-library-search">
          <Search size={17} />
          <input aria-label="Search rules" placeholder="Search by name, description or type…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <select aria-label="Filter by rule category" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">All rule categories</option>
          {kinds.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>

      {loadError ? (
        <p className="notice error" role="alert">{loadError}</p>
      ) : templates === null ? (
        <LoadingIndicator className="loading" message="Loading rules" />
      ) : (
        <div className="add-rule-list" role="group" aria-label="Rules in the library">
          {visibleMembers.map((rule) => (
            <div className="add-rule-row is-member" key={rule.id}>
              <input type="checkbox" checked disabled aria-label={`${rule.name} is already in this collection`} />
              <div className="main">
                <strong>{rule.name} <span className="add-rule-badge">{stagedIds.has(rule.id) ? "Already selected" : "Already in this collection"}</span></strong>
                <small>{displayType(rule)} · {ruleKind(rule)} · {rule.is_enabled ? "Available" : "Disabled"}</small>
                <small>{templateSummary(rule)}</small>
              </div>
            </div>
          ))}
          {visibleAvailable.map((rule) => {
            const on = selected.has(rule.id);
            const blocked = !on && selected.size >= slots;
            return (
              <label className={"add-rule-row" + (on ? " is-selected" : "") + (blocked ? " is-blocked" : "")} key={rule.id}>
                <input type="checkbox" checked={on} disabled={blocked || saving} onChange={() => toggle(rule.id)} />
                <div className="main">
                  <strong>{rule.name}</strong>
                  <small>{displayType(rule)} · {ruleKind(rule)} · {rule.is_enabled ? "Available" : "Disabled"}</small>
                  <small>{templateSummary(rule)}</small>
                  {rule.description && <small>{rule.description}</small>}
                </div>
              </label>
            );
          })}
          {visibleAvailable.length === 0 && visibleMembers.length === 0 && (
            <p className="muted add-rule-empty">
              {available.length === 0 && members.length === 0
                ? "The Monitoring Rule Library has no standalone rules to add."
                : "No rules match the search and filter."}
            </p>
          )}
        </div>
      )}
      <p className="muted add-rule-note">Rules that already belong to other collections are not listed.</p>

      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="modal-actions">
        <span className="add-rule-count">{selected.size} selected</span>
        <button type="button" className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="btn-primary" onClick={add} disabled={saving || selected.size === 0}>
          {saving ? "Adding…" : selected.size ? `${deferred ? "Select" : "Add"} ${selected.size} ${selected.size === 1 ? "rule" : "rules"}` : deferred ? "Select rules" : "Add rules"}
        </button>
      </div>
    </Modal>
  );
}
