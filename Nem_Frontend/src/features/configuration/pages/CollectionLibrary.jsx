import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, Layers, Pencil, Plus, PlusCircle, RefreshCw, Search, Trash2 } from "lucide-react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { BackIcon } from "../../../components/common/Icons.jsx";
import { EmptyState, LoadingIndicator, Modal, useConfirmation } from "../../../components/common/UI.jsx";
import LabelsField from "../../../components/common/LabelsField.jsx";
import RuleCollectionCreateModal from "./RuleCollectionCreateModal.jsx";
import ReusableRuleModal from "./ReusableRuleModal.jsx";
import { RuleViewModal, displayType, ruleKind, templateSummary } from "./RuleLibrary.jsx";
import "./RuleLibrary.css";

const MAX_RULES = 5; // enforced by the backend as well

const labelName = (label) => (typeof label === "string" ? label : label?.name);

/** Rule Collection Library. A collection owns its rules; the rules themselves live in rule templates. */
export default function CollectionLibrary() {
  const { user } = useAuth();
  const canManage = user?.role === "Administrator"; // same rule as before: collections are managed by Administrators
  const confirm = useConfirmation();
  const nav = useNavigate();

  const [collections, setCollections] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState({ text: "", error: false });
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [sort, setSort] = useState("name-asc");
  const [labelIds, setLabelIds] = useState([]);
  const [labelsRevision, setLabelsRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editingCollection, setEditingCollection] = useState(null);
  const [viewingId, setViewingId] = useState(null);
  const [viewingRule, setViewingRule] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [addingTo, setAddingTo] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const generation = useRef(0);
  const labelQuery = labelIds.map((id) => `label_ids=${encodeURIComponent(id)}`).join("&");

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoadError("");
    try {
      const [rows, allTemplates] = await Promise.all([
        api.get(`/collections${labelQuery ? `?${labelQuery}` : ""}`),
        api.get("/rule-templates"),
      ]);
      if (current !== generation.current) return;
      setCollections(Array.isArray(rows) ? rows : []);
      setTemplates((Array.isArray(allTemplates) ? allTemplates : []).filter((item) => item.collection_id != null));
    } catch (error) {
      if (current === generation.current) setLoadError(error.message || "Could not load collections.");
    }
  }, [labelQuery]);

  useEffect(() => { load(); }, [load]);

  const rulesByCollection = useMemo(() => {
    const map = new Map();
    templates.forEach((template) => {
      const key = String(template.collection_id);
      map.set(key, [...(map.get(key) || []), template]);
    });
    return map;
  }, [templates]);

  const rulesOf = (collection) => rulesByCollection.get(String(collection.id)) || [];

  const kindsOf = (collection) => {
    const counts = new Map();
    rulesOf(collection).forEach((rule) => counts.set(ruleKind(rule), (counts.get(ruleKind(rule)) || 0) + 1));
    return [...counts.entries()];
  };

  const allKinds = useMemo(
    () => [...new Set(templates.map((template) => ruleKind(template)))].sort(),
    [templates]
  );

  const stats = useMemo(() => {
    const total = collections?.length ?? 0;
    const rules = (collections || []).reduce((sum, item) => sum + (item.rule_count || 0), 0);
    return { total, rules, average: total ? rules / total : 0, empty: (collections || []).filter((item) => !item.rule_count).length };
  }, [collections]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const sorters = {
      "name-asc": (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      "name-desc": (a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: "base" }),
      "rules-desc": (a, b) => (b.rule_count || 0) - (a.rule_count || 0) || a.name.localeCompare(b.name),
      newest: (a, b) => b.id - a.id,
      oldest: (a, b) => a.id - b.id,
    };
    return (collections || [])
      .filter((item) => kindFilter === "all" || rulesOf(item).some((rule) => ruleKind(rule) === kindFilter))
      .filter((item) => !needle
        || item.name.toLowerCase().includes(needle)
        || (item.description || "").toLowerCase().includes(needle)
        || rulesOf(item).some((rule) => rule.name.toLowerCase().includes(needle)))
      .sort(sorters[sort] || sorters["name-asc"]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections, rulesByCollection, search, kindFilter, sort]);

  const hasFilters = Boolean(search.trim() || kindFilter !== "all" || labelIds.length);
  const clearFilters = () => { setSearch(""); setKindFilter("all"); setLabelIds([]); };

  const refresh = async (text) => {
    setLabelsRevision((revision) => revision + 1);
    try {
      await load();
      if (text) setMessage({ text, error: false });
    } catch {
      setMessage({ text: `${text || "Saved"}, but the list could not be refreshed.`, error: true });
    }
  };

  const remove = async (collection) => {
    if (!canManage) return;
    const members = rulesOf(collection);
    const ok = await confirm(
      `Delete collection “${collection.name}” and the ${members.length} rule${members.length === 1 ? "" : "s"} inside it? ` +
        "Rules assigned to assets keep running as assets rules, but the collection's own rule definitions are removed. This cannot be undone.",
      { title: "Delete collection and its rules", confirmLabel: "Delete", destructive: true }
    );
    if (!ok) return;
    setBusyId(collection.id);
    setMessage({ text: "", error: false });
    try {
      // Same sequence the library has always used: the collection's own rules first, then the collection.
      for (const rule of members) await api.del(`/rule-templates/${rule.id}`);
      await api.del(`/collections/${collection.id}`);
      if (viewingId === collection.id) setViewingId(null);
      await refresh(`Collection “${collection.name}” and its ${members.length} rule${members.length === 1 ? "" : "s"} deleted.`);
    } catch (error) {
      setMessage({ text: error.message || "Could not delete the collection.", error: true });
      await load().catch(() => {});
    } finally {
      setBusyId(null);
    }
  };

  const viewing = viewingId == null ? null : (collections || []).find((item) => item.id === viewingId) || null;
  const averageText = stats.average ? stats.average.toFixed(1) : "0";

  return (
    <main className="rule-library-page">
      <button type="button" className="link-btn" onClick={() => nav("/configuration")}>
        <BackIcon size={14} /> Back
      </button>

      <div className="rule-library-heading">
        <div>
          <h1 className="page-title">Rule Collection Library</h1>
          <p className="muted">
            Collections group related monitoring rules for a type of machine. Each collection holds up to {MAX_RULES} rules of its own.
          </p>
        </div>
        <div className="rule-library-heading-actions">
          <button type="button" className="btn-outline" onClick={() => nav("/configuration/rules")}>
            <Layers size={17} /> Monitoring rule library
          </button>
          <button type="button" className="btn-primary" disabled={!canManage}
            title={canManage ? "Create a collection" : "Only Administrators can create collections."}
            onClick={() => { setEditingCollection(null); setCreating(true); }}>
            <Plus size={17} /> Create collection
          </button>
        </div>
      </div>

      {message.text && (
        <p className={"notice" + (message.error ? " error" : "")} role={message.error ? "alert" : "status"}>{message.text}</p>
      )}

      {collections !== null && collections.length > 0 && (
        <div className="rl-stats" aria-label="Collection overview">
          <div className="rl-stat"><b>{stats.total}</b><span>Collections</span></div>
          <div className="rl-stat"><b>{stats.rules}</b><span>Rules across collections</span></div>
          <div className="rl-stat"><b>{averageText}</b><span>Average rules per collection</span></div>
          <div className="rl-stat"><b>{stats.empty}</b><span>Empty collections</span></div>
        </div>
      )}

      <section className="rule-library-panel">
        <div className="rule-library-tools rl-tools">
          <label className="rule-library-search">
            <Search size={17} />
            <input aria-label="Search collections" placeholder="Search by collection, description or rule name…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <select aria-label="Filter by rule category" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
            <option value="all">All rule categories</option>
            {allKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </select>
          <select aria-label="Sort collections" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="name-asc">Name A–Z</option>
            <option value="name-desc">Name Z–A</option>
            <option value="rules-desc">Most rules</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
          <LabelsField mode="filter" value={labelIds} onChange={setLabelIds} refreshKey={labelsRevision} />
        </div>

        {loadError && collections === null ? (
          <div className="rl-empty" role="alert">
            <EmptyState art={false} title="Collections could not be loaded" lines={[loadError]} />
            <button type="button" className="btn-outline" onClick={load}><RefreshCw size={15} aria-hidden="true" /> Try again</button>
          </div>
        ) : collections === null ? (
          <LoadingIndicator className="loading" message="Loading collections" />
        ) : visible.length === 0 ? (
          <div className="rl-empty">
            <EmptyState
              art={false}
              title={collections.length === 0 && !hasFilters ? "No collections yet" : "No collections match"}
              lines={[collections.length === 0 && !hasFilters
                ? (canManage ? "Create a collection to group the monitoring rules a type of machine needs." : "Collections created by Administrators will appear here.")
                : "Nothing matches the current search and filters."]}
            />
            {hasFilters && <button type="button" className="btn-outline" onClick={clearFilters}>Clear filters</button>}
            {!hasFilters && canManage && collections.length === 0 && (
              <button type="button" className="btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> Create collection</button>
            )}
          </div>
        ) : (
          <div className="rl-cols">
            {visible.map((collection) => {
              const kinds = kindsOf(collection);
              const full = (collection.rule_count || 0) >= MAX_RULES;
              return (
                <article className="rl-card" key={collection.id}>
                  <h2>{collection.name}</h2>
                  <p>{collection.description || "No description provided."}</p>
                  {collection.labels?.length > 0 && (
                    <span className="labels-chips rule-library-labels">
                      {collection.labels.map((label) => <span className="label-chip" key={labelName(label)}>{labelName(label)}</span>)}
                    </span>
                  )}
                  <div className="rl-chips" aria-label="Rule categories">
                    {kinds.length === 0
                      ? <span className="rl-desc">No rules yet</span>
                      : kinds.map(([kind, count]) => <span className="rl-chip" key={kind}>{kind} · {count}</span>)}
                  </div>
                  <div className="rl-card-foot">
                    <span className="rl-desc">{collection.rule_count || 0} of {MAX_RULES} rules</span>
                    <div className="rule-library-actions rl-actions">
                      <button type="button" className="btn-outline" title="View collection contents" aria-label={`View ${collection.name}`} onClick={() => setViewingId(collection.id)}><Eye size={15} /></button>
                      <button type="button" className="btn-outline" disabled={!canManage || full}
                        title={!canManage ? "Administrator access required." : full ? `A collection holds at most ${MAX_RULES} rules.` : "Add a rule to this collection"}
                        aria-label={`Add rule to ${collection.name}`}
                        onClick={() => setAddingTo({ id: collection.id, name: collection.name, ruleCount: collection.rule_count || 0 })}><PlusCircle size={15} /></button>
                      <button type="button" className="btn-outline" disabled={!canManage} title="Edit collection details" aria-label={`Edit ${collection.name}`}
                        onClick={() => { setEditingCollection(collection); setCreating(true); }}><Pencil size={15} /></button>
                      <button type="button" className="btn-outline danger" disabled={!canManage || busyId === collection.id}
                        title={canManage ? "Delete collection" : "Administrator access required."} aria-label={`Delete ${collection.name}`}
                        onClick={() => remove(collection)}>{busyId === collection.id ? "…" : <Trash2 size={15} />}</button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {collections !== null && visible.length > 0 && (
          <p className="rl-count">Showing {visible.length} of {collections.length} collection{collections.length === 1 ? "" : "s"}</p>
        )}
      </section>

      {viewing && (
        <Modal title={viewing.name} onClose={() => setViewingId(null)} wide>
          <p className="muted" style={{ marginTop: 0 }}>{viewing.description || "No description provided."}</p>
          {viewing.labels?.length > 0 && (
            <span className="labels-chips rule-library-labels">
              {viewing.labels.map((label) => <span className="label-chip" key={labelName(label)}>{labelName(label)}</span>)}
            </span>
          )}
          <h4 style={{ margin: "12px 0 6px" }}>Rules in this collection ({rulesOf(viewing).length} of {MAX_RULES})</h4>
          {rulesOf(viewing).length === 0 ? (
            <p className="muted">This collection has no rules you can see yet.</p>
          ) : (
            <div className="rl-rule-list">
              {rulesOf(viewing).map((rule) => (
                <div className="rl-rule-row" key={rule.id}>
                  <div className="main">
                    <strong>{rule.name}</strong>
                    <small>{displayType(rule)} · {ruleKind(rule)} · {rule.is_enabled ? "Available" : "Disabled"}</small>
                    <small>{templateSummary(rule)}</small>
                    {rule.description && <small>{rule.description}</small>}
                  </div>
                  <div className="rule-library-actions rl-actions">
                    <button type="button" className="btn-outline" aria-label={`View ${rule.name}`} title="View rule details (including assigned assets)" onClick={() => setViewingRule(rule)}><Eye size={15} /></button>
                    {canManage && (
                      <button type="button" className="btn-outline" aria-label={`Edit ${rule.name}`} title="Edit rule" onClick={() => setEditingRule({ collection: viewing, rule })}><Pencil size={15} /></button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-outline" onClick={() => nav("/configuration/rules")}>Open rule library</button>
            {canManage && (
              <>
                <button type="button" className="btn-outline" disabled={(viewing.rule_count || 0) >= MAX_RULES}
                  onClick={() => { setAddingTo({ id: viewing.id, name: viewing.name, ruleCount: viewing.rule_count || 0 }); setViewingId(null); }}>Add rule</button>
                <button type="button" className="btn-outline" onClick={() => { setEditingCollection(viewing); setCreating(true); setViewingId(null); }}>Edit details</button>
              </>
            )}
            <button type="button" className="btn-primary" onClick={() => setViewingId(null)}>Close</button>
          </div>
        </Modal>
      )}

      {viewingRule && <RuleViewModal template={viewingRule} onClose={() => setViewingRule(null)} />}

      {creating && (
        <RuleCollectionCreateModal
          collection={editingCollection}
          onClose={() => { setCreating(false); setEditingCollection(null); }}
          onCreate={async (payload) => {
            await api.post("/collections", payload);
            setCreating(false);
            await refresh("Collection and monitoring rules created.");
          }}
          onSave={async (payload) => {
            await api.patch(`/collections/${editingCollection.id}`, payload);
            setCreating(false);
            setEditingCollection(null);
            await refresh("Collection updated.");
          }}
        />
      )}

      {addingTo && (
        <ReusableRuleModal
          collection={addingTo}
          onClose={() => setAddingTo(null)}
          onCreated={async () => {
            setAddingTo(null);
            await refresh("Rule added to the collection.");
          }}
        />
      )}

      {editingRule && (
        <ReusableRuleModal
          collection={editingRule.collection}
          template={editingRule.rule}
          onClose={() => setEditingRule(null)}
          onUpdated={async () => {
            setEditingRule(null);
            await refresh("Rule updated.");
          }}
        />
      )}
    </main>
  );
}
