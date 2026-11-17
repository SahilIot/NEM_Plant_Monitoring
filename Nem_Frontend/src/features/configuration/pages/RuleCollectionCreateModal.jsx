import React, { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "../../../components/common/UI.jsx";
import LabelsField from "../../../components/common/LabelsField.jsx";
import { VISIBILITY_LABELS, useSupervisorChoices } from "./RuleVisibility.jsx";
import AddRuleChooserModal from "./AddRuleChooserModal.jsx";
import { MAX_COLLECTION_RULES } from "./collectionLimits.js";
import ExistingRulesPicker from "./ExistingRulesPicker.jsx";
import { captureNavigationOrigin } from "../../../utils/navigation.js";
import "./AddRuleWorkflow.css";


export default function RuleCollectionCreateModal({
  onClose,
  onCreate,
  onSave,
  collection = null,
  // Set when returning from the full-page Add Rule workflow: the form is restored as it was left.
  initialDraft = null,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [name, setName] = useState(initialDraft?.name ?? collection?.name ?? "");
  const [description, setDescription] = useState(initialDraft?.description ?? collection?.description ?? "");
  const [labels, setLabels] = useState(initialDraft?.labels ?? collection?.labels ?? []);
  // New rules are kept as definitions and created together with the collection.
  const [rules, setRules] = useState(initialDraft?.rules ?? []);
  // Existing library rules are kept as a selection and moved into the collection once it exists.
  const [existing, setExisting] = useState(initialDraft?.existing ?? []);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [visibilityType, setVisibilityType] = useState(initialDraft?.visibilityType ?? "");
  const [supervisorIds, setSupervisorIds] = useState(initialDraft?.supervisorIds ?? []);
  const supervisorChoices = useSupervisorChoices(!collection);
  const total = rules.length + existing.length;
  const submitting = useRef(false); // blocks a second submit before `saving` has re-rendered

  const buildDraft = () => ({ name, description, labels, visibilityType, supervisorIds, rules, existing });

  // Create New Rule opens the full-page workflow; the whole form travels with the navigation
  // and is restored when the user comes back.
  const createNewRule = () => {
    setChooserOpen(false);
    navigate("/configuration/rules/new", {
      state: {
        from: captureNavigationOrigin(location, { ...(location.state || {}), collectionDraft: buildDraft() }),
        collection: { draft: true, name: name.trim() || "New collection", ruleCount: total },
      },
    });
  };

  const save = async (event) => {
    event.preventDefault();
    if (submitting.current) return;
    if (!name.trim()) {
      setError("Collection name is required.");
      return;
    }
    if (!collection && total === 0) {
      setError("Add at least one monitoring rule to the collection.");
      return;
    }
    // Visibility applies to new rules only; existing rules keep the visibility they already have.
    if (!collection && rules.length > 0 && !visibilityType) {
      setError("Choose who can see the rules in this collection.");
      return;
    }
    if (!collection && rules.length > 0 && visibilityType === "specific_supervisors" && supervisorIds.length === 0) {
      setError("Select at least one Supervisor.");
      return;
    }

    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        labels,
      };
      if (collection) {
        await onSave(payload);
      } else {
        // One request creates the collection, its new rules and attaches the existing rules together.
        await onCreate({
          ...payload,
          ...(rules.length > 0 && {
            rules,
            visibility_type: visibilityType,
            visibility_supervisor_ids: visibilityType === "specific_supervisors" ? supervisorIds : [],
          }),
          ...(existing.length > 0 && { existing_template_ids: existing.map((rule) => rule.id) }),
        });
      }
    } catch (requestError) {
      setError(requestError.message || "Could not create the rule collection.");
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      {!chooserOpen && !pickerOpen && (
      <Modal
        title={collection ? "Edit collection" : "Create rule collection"}
        onClose={saving ? undefined : onClose}
        wide
      >
        <form onSubmit={save}>
          <p className="muted modal-intro">
            {collection
              ? "Update the collection details and shared labels."
              : "Name the collection, add labels, then add between one and five reusable monitoring rules."}
          </p>
          <label className="field">
            Collection name <span className="req">*</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              required
              disabled={saving}
              placeholder="e.g. Mixer machine checks"
            />
          </label>
          <label className="field">
            Description
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              disabled={saving}
            />
          </label>

          <div className="field">
            <label htmlFor="collection-labels">Labels</label>
            <LabelsField
              id="collection-labels"
              value={labels}
              onChange={setLabels}
              disabled={saving}
            />
          </div>

          {!collection && rules.length === 0 && existing.length > 0 && (
            <p className="muted hint">Rule visibility is not needed here: the existing rules keep their own visibility.</p>
          )}

          {!collection && rules.length > 0 && (
            <div className="field">
              <label htmlFor="collection-visibility">
                Rule visibility <span className="req">*</span>
              </label>
              <select
                id="collection-visibility"
                value={visibilityType}
                onChange={(event) => setVisibilityType(event.target.value)}
                disabled={saving}
                required
              >
                <option value="" disabled>Select who can see these rules</option>
                {Object.entries(VISIBILITY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <span className="hint">Applies to the new rules created with this collection. Existing rules keep their own visibility.</span>
              {visibilityType === "specific_supervisors" && (
                <div className="rule-visibility-supervisors">
                  {(supervisorChoices || []).length === 0 ? (
                    <span className="hint">There are no active Supervisors.</span>
                  ) : (
                    supervisorChoices.map((person) => (
                      <label key={person.id} className="rule-visibility-option">
                        <input
                          type="checkbox"
                          checked={supervisorIds.includes(person.id)}
                          disabled={saving}
                          onChange={() =>
                            setSupervisorIds((current) =>
                              current.includes(person.id)
                                ? current.filter((id) => id !== person.id)
                                : [...current, person.id]
                            )
                          }
                        />
                        <span>{person.username}</span>
                      </label>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {!collection && <section aria-label="Collection rules">
            <div className="panel-head">
              <h4>Monitoring rules ({total}/{MAX_COLLECTION_RULES})</h4>
              <button
                type="button"
                className="btn-outline"
                onClick={() => setChooserOpen(true)}
                disabled={saving || total >= MAX_COLLECTION_RULES}
              >
                <Plus size={16} /> Add rule
              </button>
            </div>
            {total === 0 ? (
              <p className="muted">No rules added yet.</p>
            ) : (
              <ol>
                {existing.map((rule) => (
                  <li key={`existing-${rule.id}`}>
                    <span>{rule.name} <span className="add-rule-badge">Existing rule</span></span>
                    <button
                      type="button"
                      className="btn-outline"
                      aria-label={`Remove ${rule.name}`}
                      onClick={() => setExisting((current) => current.filter((item) => item.id !== rule.id))}
                      disabled={saving}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
                {rules.map((rule, index) => (
                  <li key={`${rule.name}-${index}`}>
                    <span>{rule.name} <span className="add-rule-badge">New rule</span></span>
                    <button
                      type="button"
                      className="btn-outline"
                      aria-label={`Remove ${rule.name}`}
                      onClick={() =>
                        setRules((current) =>
                          current.filter((_, ruleIndex) => ruleIndex !== index)
                        )
                      }
                      disabled={saving}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>}

          {error && <p className="notice error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-outline" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving
                ? collection ? "Saving…" : "Creating…"
                : collection ? "Save changes" : "Create collection"}
            </button>
          </div>
        </form>
      </Modal>
      )}

      {chooserOpen && (
        <AddRuleChooserModal
          collection={{ name: name.trim() || "New collection", ruleCount: total }}
          onClose={() => setChooserOpen(false)}
          onSelectExisting={() => { setChooserOpen(false); setPickerOpen(true); }}
          onCreateNew={createNewRule}
        />
      )}

      {pickerOpen && (
        <ExistingRulesPicker
          deferred
          collection={{ id: null, name: name.trim() || "New collection", ruleCount: total }}
          stagedRules={existing}
          onClose={() => setPickerOpen(false)}
          onSelect={(chosen) => {
            // Only the id and name are needed until the collection is saved.
            setExisting((current) => [
              ...current,
              ...chosen
                .filter((item) => !current.some((entry) => entry.id === item.id))
                .map(({ id, name }) => ({ id, name })),
            ]);
            setPickerOpen(false);
            setError("");
          }}
        />
      )}
    </>
  );
}
