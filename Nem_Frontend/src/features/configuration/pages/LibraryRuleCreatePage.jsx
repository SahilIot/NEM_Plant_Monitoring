import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import {
  rememberNavigationOrigin,
  returnToNavigationOrigin,
} from "../../../utils/navigation.js";
import { useConfirmation } from "../../../components/common/UI.jsx";
import LabelsField from "../../../components/common/LabelsField.jsx";
import {
  RuleField,
  RuleFormSection,
  UnitInput,
} from "../../rules/components/RuleFormParts.jsx";
import { FIELDS, templatePayload } from "./RuleLibrary.jsx";
import {
  VisibilityPicker,
  useSupervisorChoices,
  visibilityFields,
  visibilityPayload,
} from "./RuleVisibility.jsx";
import { COLLECTIONS_PATH, LIBRARY_PATH } from "./RuleTypeSelectPage.jsx";
import { MAX_COLLECTION_RULES } from "./collectionLimits.js";
import "../../rules/pages/RuleCreatePage.css";
import "./NewRuleWorkflow.css";

// Each page only chooses which existing reusable-rule type it creates; the values are
// then turned into the payload by the library's own templatePayload().
const KINDS = {
  "motor-running": {
    title: "Create Motor Running rule",
    description:
      "Running time accumulates while the selected Boolean signal is ON and is checked against the thresholds.",
    overrides: { rule_type: "interval_based" },
    thresholds: ["runtime_warning_hours", "runtime_warning_2_hours", "runtime_alert_hours"],
    unit: "hours",
    submitLabel: "Create Motor Running rule",
  },
  "cycle-clock": {
    title: "Create Cycle Clock rule",
    description:
      "Each complete OFF-to-ON cycle increments the counter and is checked against the warning and alert thresholds.",
    overrides: {
      rule_type: "parameter_threshold",
      variable_type: "boolean",
      boolean_behavior: "cycle_count",
    },
    thresholds: ["cycle_warning_threshold_1", "cycle_warning_threshold_2", "cycle_alert_threshold"],
    unit: "cycles",
    submitLabel: "Create Cycle Clock rule",
  },
};

const THRESHOLD_HINTS = [
  "Raises the first warning when this value is reached.",
  "Must be greater than the first warning.",
  "Must be greater than the higher warning.",
];

const fieldDef = (key) => FIELDS.find((field) => field.key === key) || {};

function initialValues(kind) {
  const values = Object.fromEntries(
    FIELDS.map((field) => [
      field.key,
      field.type === "labels" || field.type === "supervisors"
        ? []
        : field.default !== undefined && field.default !== null
          ? String(field.default)
          : "",
    ])
  );
  return {
    ...values,
    ...KINDS[kind].overrides,
    visibility_type: "",
    visibility_supervisor_ids: [],
  };
}

export default function LibraryRuleCreatePage() {
  const { kind } = useParams();
  const config = KINDS[kind];
  const { user } = useAuth();
  const canCreateRules = user?.role === "Administrator";
  const navigate = useNavigate();
  const location = useLocation();
  const confirm = useConfirmation();
  const from = location.state?.from;
  // Set when the rule is being added from inside a Rule Collection.
  const collection = location.state?.collection || null;
  const homePath = collection ? COLLECTIONS_PATH : LIBRARY_PATH;
  // Draft mode: the collection is still being created, so nothing is saved here. The rule is
  // handed back to the collection form and is created together with the collection.
  const draftMode = Boolean(collection?.draft);
  const collectionDraft = from?.state?.collectionDraft;
  // Visibility is not asked for here while a collection is being created, so no Supervisor list is needed.
  const supervisorChoices = useSupervisorChoices(canCreateRules && !draftMode);

  const baseline = useMemo(() => (config ? initialValues(kind) : {}), [config, kind]);
  const [values, setValues] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const saved = useRef(false);
  const dirty = !saved.current && JSON.stringify(values) !== JSON.stringify(baseline);

  useEffect(() => {
    rememberNavigationOrigin(from);
  }, [from]);

  // Warn before the browser tab is closed or reloaded with unsaved input.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!config) {
    return (
      <div className="rule-create-page">
        <div className="rule-create-container">
          <p className="notice" role="alert">Unknown rule type.</p>
          <button
            type="button"
            className="btn-outline rule-back-btn"
            onClick={() => navigate(homePath, { replace: true })}
          >
            ← Back to {collection ? "Collection" : "Rule Library"}
          </button>
        </div>
      </div>
    );
  }

  const confirmLeave = async () =>
    !dirty ||
    (await confirm(
      "You have unsaved changes. If you leave now, the information you entered will be lost.",
      {
        title: "Discard changes?",
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
        destructive: true,
      }
    ));

  const backToLibrary = async () => {
    if (saving || !(await confirmLeave())) return;
    saved.current = true;
    returnToNavigationOrigin(navigate, from, homePath);
  };

  const changeType = async () => {
    if (saving || !(await confirmLeave())) return;
    saved.current = true;
    navigate(`${LIBRARY_PATH}/new`, { replace: true, state: { from, collection } });
  };

  const update = (event) => {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
    setError("");
  };

  const requiredKeys = [
    "name",
    ...(kind === "motor-running" ? ["runtime_variable_type"] : []),
    ...config.thresholds,
    "severity",
    "is_enabled",
    ...(draftMode ? [] : ["visibility_type"]),
  ];

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canCreateRules || submitting.current) return;

    const labelFor = (key) =>
      key === "visibility_type" ? "Visibility" : fieldDef(key).label;
    for (const key of requiredKeys) {
      if (!String(values[key] ?? "").trim()) {
        setError(`${labelFor(key)} is required.`);
        return;
      }
    }
    if (
      !draftMode &&
      values.visibility_type === "specific_supervisors" &&
      !(values.visibility_supervisor_ids || []).length
    ) {
      setError("Supervisors is required.");
      return;
    }

    // Same normalisation the reusable-rule form applies: numeric fields become numbers.
    const normalized = { ...values };
    for (const field of FIELDS) {
      if (field.type === "number" && String(values[field.key] ?? "").trim() !== "") {
        const number = Number(values[field.key]);
        if (!Number.isFinite(number)) {
          setError(`${field.label} must be a valid number.`);
          return;
        }
        normalized[field.key] = number;
      }
    }

    if (draftMode) {
      const used = (collectionDraft?.rules?.length || 0) + (collectionDraft?.existing?.length || 0);
      if (used >= MAX_COLLECTION_RULES) {
        setError(`A collection holds at most ${MAX_COLLECTION_RULES} rules.`);
        return;
      }
      submitting.current = true;
      saved.current = true;
      const draftRule = templatePayload(normalized);
      delete draftRule.collection_id;
      const nextOrigin = {
        ...from,
        state: {
          ...(from?.state || {}),
          collectionDraft: { ...collectionDraft, rules: [...(collectionDraft?.rules || []), draftRule] },
        },
      };
      returnToNavigationOrigin(navigate, nextOrigin, homePath, {
        notice: { text: `“${draftRule.name}” added. It is saved when you create the collection.` },
      });
      return;
    }

    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      // One request creates the template already attached to the collection (or to none), so a
      // failed creation can never leave a rule attached.
      const payload = { ...templatePayload(normalized), collection_id: collection?.id ?? null };
      await api.post("/rule-templates", { ...payload, ...visibilityPayload(normalized) });
      saved.current = true;
      returnToNavigationOrigin(navigate, from, homePath, {
        notice: {
          text: collection
            ? `Rule created and added to “${collection.name}”.`
            : "Rule created successfully.",
        },
      });
    } catch (requestError) {
      setError(String(requestError?.message || requestError));
      submitting.current = false;
      setSaving(false);
    }
  };

  const disabled = saving || !canCreateRules;
  const visibilityHint = visibilityFields([])[0].hint;

  return (
    <div className={`rule-create-page rule-create-page-library rule-create-page-${kind}`}>
      <div className="rule-create-container">
        <button type="button" className="btn-outline rule-back-btn" onClick={backToLibrary}>
          {draftMode ? "← Back to collection form" : collection ? "← Back to Collection" : "← Back to Rule Library"}
        </button>

        <div className="page-head rule-page-head">
          <span className="rule-create-kicker">NEW RULE</span>
          <h1 className="page-title rule-page-title">{config.title}</h1>
          <p className="rule-page-description">{config.description}</p>
          <p className="muted rule-page-subtitle">
            <span>Saved to</span>
            <strong>{draftMode ? "New collection (saved when you create it)" : collection ? `${collection.name} collection` : "Monitoring Rule Library"}</strong>
          </p>
          <button type="button" className="rule-type-link rule-change-type" onClick={changeType}>
            Change rule type
          </button>
        </div>

        <section className="rule-create-card">
          <div className="rule-create-form">
            {error && <p role="alert" className="error-message">{error}</p>}
            <form onSubmit={handleSubmit}>
              {!canCreateRules && (
                <p className="notice" role="status">
                  Only Administrators can create reusable monitoring rules.
                </p>
              )}

              <RuleFormSection
                title="Basic information"
                description="Name the rule and add context for the operators who will review it."
              >
                <RuleField id="rule-name" label={`${fieldDef("name").label} *`} wide>
                  <input
                    id="rule-name"
                    name="name"
                    value={values.name}
                    onChange={update}
                    placeholder={kind === "cycle-clock" ? "e.g. Rotation count limit" : "e.g. Machine running time"}
                    required
                    disabled={disabled}
                  />
                </RuleField>
                <div className="form-group form-group-description">
                  <label htmlFor="rule-description">
                    {fieldDef("description").label} <span className="optional-label">Optional</span>
                  </label>
                  <textarea
                    id="rule-description"
                    name="description"
                    rows={3}
                    value={values.description}
                    onChange={update}
                    placeholder="Add context for operators who will review this rule."
                    disabled={disabled}
                  />
                </div>
                <RuleField id="rule-labels" label={fieldDef("labels").label} optional wide>
                  <LabelsField
                    id="rule-labels"
                    value={values.labels}
                    onChange={(labels) => setValues((current) => ({ ...current, labels }))}
                    disabled={disabled}
                  />
                </RuleField>
              </RuleFormSection>

              <RuleFormSection
                title={kind === "cycle-clock" ? "Cycle signal" : "Running signal"}
                description={
                  kind === "cycle-clock"
                    ? "The Boolean signal that switches OFF then ON once per machine cycle. The signal is chosen on each asset when the rule is assigned; a preferred variable key only suggests a mapping."
                    : "The signal that indicates the machine is running. The signal is chosen on each asset when the rule is assigned; a preferred variable key only suggests a mapping."
                }
              >
                <RuleField
                  id="variable-key"
                  label={fieldDef("variable_key").label}
                  hint={fieldDef("variable_key").hint}
                  wide
                >
                  <input
                    id="variable-key"
                    name="variable_key"
                    value={values.variable_key}
                    onChange={update}
                    placeholder={fieldDef("variable_key").placeholder}
                    disabled={disabled}
                  />
                </RuleField>
                {kind === "motor-running" && (
                  <RuleField
                    id="runtime-variable-type"
                    label={`${fieldDef("runtime_variable_type").label} *`}
                    hint={fieldDef("runtime_variable_type").hint}
                    wide
                  >
                    <select
                      id="runtime-variable-type"
                      name="runtime_variable_type"
                      value={values.runtime_variable_type}
                      onChange={update}
                      required
                      disabled={disabled}
                    >
                      {fieldDef("runtime_variable_type").options.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </RuleField>
                )}
              </RuleFormSection>

              <RuleFormSection
                title={kind === "cycle-clock" ? "Cycle-count thresholds" : "Running-time thresholds"}
                description={
                  kind === "cycle-clock"
                    ? "Cycle counts must be whole numbers in increasing order: first warning, then higher warning, then alert."
                    : "Running time is entered in hours and must be positive and strictly increasing: first warning, then higher warning, then alert."
                }
              >
                {config.thresholds.map((key, index) => {
                  const field = fieldDef(key);
                  return (
                    <RuleField
                      key={key}
                      id={`threshold-${key}`}
                      label={`${field.label} *`}
                      hint={THRESHOLD_HINTS[index]}
                      threshold
                    >
                      <UnitInput unit={config.unit}>
                        <input
                          id={`threshold-${key}`}
                          name={key}
                          type="number"
                          step="any"
                          value={values[key]}
                          onChange={update}
                          placeholder={field.placeholder}
                          required
                          disabled={disabled}
                        />
                      </UnitInput>
                    </RuleField>
                  );
                })}
              </RuleFormSection>

              <RuleFormSection
                title="Availability and severity"
                description="Choose how the rule is raised and whether it can be assigned to assets."
              >
                <RuleField id="rule-severity" label={`${fieldDef("severity").label} *`}>
                  <select
                    id="rule-severity"
                    name="severity"
                    value={values.severity}
                    onChange={update}
                    required
                    disabled={disabled}
                  >
                    {fieldDef("severity").options.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </RuleField>
                <RuleField id="rule-status" label={`${fieldDef("is_enabled").label} *`}>
                  <select
                    id="rule-status"
                    name="is_enabled"
                    value={values.is_enabled}
                    onChange={update}
                    required
                    disabled={disabled}
                  >
                    {fieldDef("is_enabled").options.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </RuleField>
              </RuleFormSection>

              {!draftMode && <RuleFormSection title="Visibility" description={visibilityHint}>
                <div className="form-group form-group-wide">
                  <label htmlFor="rule-visibility">Visibility *</label>
                  <VisibilityPicker
                    id="rule-visibility"
                    type={values.visibility_type}
                    onType={(visibility_type) => {
                      setValues((current) => ({ ...current, visibility_type }));
                      setError("");
                    }}
                    ids={values.visibility_supervisor_ids}
                    onIds={(visibility_supervisor_ids) =>
                      setValues((current) => ({ ...current, visibility_supervisor_ids }))
                    }
                    choices={supervisorChoices || []}
                    disabled={disabled}
                  />
                </div>
              </RuleFormSection>}

              <div className="form-actions rule-form-actions">
                <button type="button" className="btn-outline" onClick={backToLibrary} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={disabled}>
                  {saving ? "Saving…" : draftMode ? "Add rule to collection" : config.submitLabel}
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
