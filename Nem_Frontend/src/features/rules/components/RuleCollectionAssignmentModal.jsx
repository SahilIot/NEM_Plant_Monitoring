import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  CircleAlert,
  Layers,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { LoadingIndicator, useConfirmation } from "../../../components/common/UI.jsx";
import LabelsField from "../../../components/common/LabelsField.jsx";
import {
  collectionAssignmentStatus,
  matchesRuleFilters,
  ruleConditionSummary,
} from "../rulePresentation.js";
import "./RuleCollectionAssignmentModal.css";

export default function RuleCollectionAssignmentModal({
  assetId,
  onClose,
  onAssigned,
  onUnassigned,
}) {
  const { user } = useAuth();
  const confirm = useConfirmation();
  // Match the existing template-assignment permissions and keep destructive removal Administrator-only.
  const canAssign = ["Administrator", "Supervisor"].includes(user?.role);
  const isAdministrator = user?.role === "Administrator";
  const [collections, setCollections] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [assetRules, setAssetRules] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [variableMappings, setVariableMappings] = useState({});
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState("all");
  const [labelIds, setLabelIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState("");

  // Combine collection membership with the asset-specific APIs used by predefined-rule assignment.
  const load = useCallback(async (isActive = () => true) => {
    setLoading(true);
    setError("");
    try {
      // Reuse existing collection, asset rule, and target-specific template APIs.
      const [collectionRows, templateRows, ruleRows] = await Promise.all([
        api.get("/collections"),
        api.get(`/assets/${assetId}/rules/predefined`),
        api.get(`/assets/${assetId}/rules`),
      ]);
      if (!isActive()) return;
      setCollections(Array.isArray(collectionRows) ? collectionRows : []);
      setTemplates(Array.isArray(templateRows) ? templateRows : []);
      setAssetRules(Array.isArray(ruleRows) ? ruleRows : []);
    } catch (loadError) {
      if (isActive()) {
        setError(loadError.message || "Could not load rule collections for this asset.");
      }
    } finally {
      if (isActive()) setLoading(false);
    }
  }, [assetId]);

  // Ignore responses from a prior asset or a closed modal.
  useEffect(() => {
    let active = true;
    load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  // Join saved asset assignments back to their source templates for collection status display.
  const templateById = useMemo(
    () => new Map(templates.map((template) => [template.id, template])),
    [templates]
  );
  const assignedByTemplate = useMemo(
    () =>
      new Map(
        assetRules
          .filter((rule) => rule.source_template_id != null)
          .map((rule) => [rule.source_template_id, rule])
      ),
    [assetRules]
  );

  // Calculate collection status from assigned, eligible, and unavailable member rules.
  const collectionDetails = useMemo(
    () =>
      collections
        .map((collection) => {
          const members = (collection.rules || [])
            .map((item) => templateById.get(item.id))
            .filter(Boolean);
          const assignedCount = members.filter((item) =>
            assignedByTemplate.has(item.id)
          ).length;
          const eligible = members.filter(
            (item) => !assignedByTemplate.has(item.id) && !item.unavailable_reason
          );
          const unavailableCount = members.filter(
            (item) => !assignedByTemplate.has(item.id) && item.unavailable_reason
          ).length;
          return {
            ...collection,
            members,
            assignedCount,
            eligible,
            unavailableCount,
            status: collectionAssignmentStatus(
              members.length,
              assignedCount,
              eligible.length
            ),
          };
        })
        .filter((collection) => collection.members.length > 0),
    [collections, templateById, assignedByTemplate]
  );

  // Apply the same all-selected-labels and severity matching rules as Assign Monitoring Rules.
  const visibleCollections = useMemo(() => {
    const query = search.trim().toLowerCase();
    return collectionDetails
      .map((collection) => {
        const matchingMembers = collection.members.filter((rule) => {
          return matchesRuleFilters(rule, severity, labelIds);
        });
        const matchesSearch =
          !query ||
          `${collection.name} ${collection.description || ""} ${collection.members
            .map((item) => `${item.name || ""} ${item.description || ""} ${item.rule_type || ""}`)
            .join(" ")}`
            .toLowerCase()
            .includes(query);
        return { ...collection, matchingMembers, matchesSearch };
      })
      .filter((collection) => collection.matchesSearch && collection.matchingMembers.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [collectionDetails, search, severity, labelIds]);

  // Keep assignment contents independent of search and member filters; selecting a collection assigns its eligible rules.
  const selectedTemplates = useMemo(() => {
    const ids = new Set();
    collectionDetails
      .filter((collection) => selected.has(collection.id))
      .forEach((collection) =>
        collection.eligible.forEach((template) => ids.add(template.id))
      );
    return [...ids].map((id) => templateById.get(id)).filter(Boolean);
  }, [collectionDetails, selected, templateById]);

  const mappingsComplete = selectedTemplates.every(
    (template) =>
      !template.variable_mapping_required || Boolean(variableMappings[template.id])
  );

  // Enforce the existing assignment endpoint's batch limit before accepting a new selection.
  const toggleCollection = (collection) => {
    setReviewing(false);
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(collection.id)) {
        next.delete(collection.id);
        return next;
      }
      const currentCount = collectionDetails
        .filter((item) => next.has(item.id))
        .reduce((sum, item) => sum + item.eligible.length, 0);
      if (currentCount + collection.eligible.length > 100) {
        setError("Select collections containing no more than 100 assignable rules.");
        return previous;
      }
      next.add(collection.id);
      setError("");
      return next;
    });
  };

  // Submit only eligible templates through the existing asset assignment API.
  const assign = async () => {
    if (!selectedTemplates.length || saving || !canAssign) return;
    setSaving(true);
    setError("");
    try {
      const result = await api.post(`/assets/${assetId}/rules/assign`, {
        rule_ids: selectedTemplates.map((template) => template.id),
        variable_mappings: Object.fromEntries(
          selectedTemplates
            .filter((template) => variableMappings[template.id])
            .map((template) => [
              template.id,
              Number(variableMappings[template.id]),
            ])
        ),
      });
      await onAssigned?.({
        ...result,
        collectionCount: selected.size,
        selectedRuleCount: selectedTemplates.length,
      });
      onClose();
    } catch (assignError) {
      setError(assignError.message || "Could not assign the selected collections.");
    } finally {
      setSaving(false);
    }
  };

  // Administrator unassignment follows existing rule-deletion safeguards and confirmation UX.
  const unassign = async (collection) => {
    if (!isAdministrator || saving) return;
    const assignedRules = collection.members
      .map((template) => assignedByTemplate.get(template.id))
      .filter(Boolean);
    if (!assignedRules.length) return;

    const confirmed = await confirm(
      `Unassign "${collection.name}" from this asset? Its ${assignedRules.length} assigned rule(s), alerts, and evaluation history will be removed. Rules must be deactivated first.`,
      {
        title: "Unassign rule collection",
        confirmLabel: "Unassign collection",
        destructive: true,
      }
    );
    if (!confirmed) return;

    setSaving(true);
    setError("");
    try {
      const result = await api.del(
        `/assets/${assetId}/rule-collections/${collection.id}`
      );
      await load();
      await onUnassigned?.(collection, result);
    } catch (unassignError) {
      const message = unassignError.message || "Could not unassign this collection.";
      await load();
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="rca-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        className="rca-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rca-title"
      >
        <header className="rca-header">
          <h2 id="rca-title"><Layers size={20} /> Assign Rule Collections</h2>
          <button
            type="button"
            className="rca-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </header>

        <div className="rca-toolbar">
          <div className="rca-search">
            <Search size={17} aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search collections…"
              aria-label="Search collections"
            />
          </div>
          <select
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
            aria-label="Filter by severity"
          >
            <option value="all">All severities</option>
            <option value="warning">Warning</option>
            <option value="alert">Alert</option>
          </select>
          <div className="rca-label-filter">
            <LabelsField
              mode="filter"
              value={labelIds}
              onChange={setLabelIds}
            />
          </div>
          <span>{selected.size} selected</span>
        </div>

        {error && <p className="rca-error" role="alert">{error}</p>}

        <div className="rca-list">
          {loading ? (
            <LoadingIndicator compact message="Loading rule collections" />
          ) : visibleCollections.length === 0 ? (
            <p className="rca-empty">
              {collections.length
                ? "No rule collections with visible rules match the current search and filters."
                : "No rule collections are available."}
            </p>
          ) : (
            // Show complete member metadata while keeping selection at the collection level.
            visibleCollections.map((collection) => {
              const assigned = collection.assignedCount > 0;
              const disabled =
                saving ||
                !canAssign ||
                (collection.eligible.length === 0 && !selected.has(collection.id));
              return (
                <article className="rca-collection" key={collection.id}>
                  <label className="rca-select">
                    <input
                      type="checkbox"
                      checked={selected.has(collection.id)}
                      disabled={disabled}
                      onChange={() => toggleCollection(collection)}
                    />
                    <span className="rca-collection-copy">
                      <strong>{collection.name}</strong>
                      {collection.description && <small>{collection.description}</small>}
                      <small>
                        {collection.members.length} rule(s)
                        {collection.assignedCount
                          ? ` · ${collection.assignedCount} already assigned`
                          : ""}
                        {collection.unavailableCount
                          ? ` · ${collection.unavailableCount} unavailable`
                          : ""}
                      </small>
                    </span>
                  </label>
                  <span
                    className={`rca-status rca-status-${collection.status
                      .toLowerCase()
                      .replaceAll(" ", "-")}`}
                  >
                    {collection.status}
                  </span>
                  {isAdministrator && assigned && (
                    <button
                      type="button"
                      className="btn-outline rca-unassign"
                      onClick={() => unassign(collection)}
                      disabled={saving}
                      title="Remove this collection's rules from the asset"
                    >
                      <Trash2 size={15} /> Unassign
                    </button>
                  )}
                  {selected.has(collection.id) && (
                    <div className="rca-members">
                      {collection.members.map((template) => {
                        const existing = assignedByTemplate.get(template.id);
                        const severityValue = (template.severity || "warning").toLowerCase();
                        const labelNames = (template.labels || [])
                          .map((label) => (
                            typeof label === "string" ? label : label?.name
                          ))
                          .filter(Boolean);
                        return (
                          <div className="rca-member" key={template.id}>
                            <Activity size={16} aria-hidden="true" />
                            <div className="rca-member-copy">
                              <strong>{template.name}</strong>
                              <small>
                                {template.description ||
                                  (template.rule_type || "Monitoring rule").replaceAll("_", " ")}
                              </small>
                              <small className="rca-condition">
                                Condition / thresholds: {ruleConditionSummary(template)}
                              </small>
                              {labelNames.length > 0 && (
                                <div className="rca-member-labels">
                                  {labelNames.map((name, index) => (
                                    <span
                                      className="rca-member-label"
                                      key={`${template.id}-${name}-${index}`}
                                    >
                                      {name}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {existing ? (
                                <small className="rca-member-state">
                                  Assigned · {existing.state || existing.lifecycle_status}
                                </small>
                              ) : template.unavailable_reason ? (
                                <small className="rca-member-error">
                                  {template.unavailable_reason}
                                </small>
                              ) : template.variable_mapping_required ? (
                                <select
                                  aria-label={`Variable mapping for ${template.name}`}
                                  value={variableMappings[template.id] || ""}
                                  disabled={saving}
                                  onChange={(event) =>
                                    setVariableMappings((previous) => ({
                                      ...previous,
                                      [template.id]: event.target.value,
                                    }))
                                  }
                                >
                                  <option value="">Choose variable</option>
                                  {(template.compatible_variables || []).map((variable) => (
                                    <option value={variable.id} key={variable.id}>
                                      {variable.name} · {variable.key} ({variable.data_type})
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <small>Ready to assign</small>
                              )}
                            </div>
                            <span className={`rca-member-severity rca-severity-${severityValue}`}>
                              {severityValue === "alert"
                                ? <CircleAlert size={14} />
                                : <AlertTriangle size={14} />}
                              {template.severity || "warning"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>

        <footer className="rca-footer">
          <span>
            Filters show collections with matching member rules. Selecting a collection assigns all eligible rules in it. Supervisors’ assignments are saved Not Activated for review.
          </span>
          <div>
            {reviewing && (
              <button
                type="button"
                className="btn-outline"
                onClick={() => setReviewing(false)}
                disabled={saving}
              >
                Back
              </button>
            )}
            <button
              type="button"
              className="btn-primary"
              onClick={() => (reviewing ? assign() : setReviewing(true))}
              disabled={
                saving ||
                loading ||
                !canAssign ||
                selectedTemplates.length === 0 ||
                !mappingsComplete
              }
            >
              {!saving && <Check size={16} />}
              {saving
                ? "Saving…"
                : reviewing
                  ? `Confirm assignment (${selectedTemplates.length} rules)`
                  : `Review assignment${selected.size ? ` (${selected.size})` : ""}`}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
