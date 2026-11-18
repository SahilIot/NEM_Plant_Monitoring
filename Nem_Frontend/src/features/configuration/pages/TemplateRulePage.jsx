import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import { rememberNavigationOrigin, returnToNavigationOrigin } from "../../../utils/navigation.js";
import { LoadingIndicator, useConfirmation } from "../../../components/common/UI.jsx";
import ParameterRuleWizard from "../../rules/components/ParameterRuleWizard.jsx";
import { buildTemplateParameters, newParameter, valuesFromTemplate } from "../../rules/components/parameterRules.js";
import {
  VisibilityPicker, saveVisibility, useSupervisorChoices, visibilityChanged, visibilityFields, visibilityInitial, visibilityPayload,
} from "./RuleVisibility.jsx";
import { COLLECTIONS_PATH, LIBRARY_PATH } from "./RuleTypeSelectPage.jsx";
import { MAX_COLLECTION_RULES } from "./collectionLimits.js";
import "../../rules/pages/RuleCreatePage.css";
import "./NewRuleWorkflow.css";

// The one reusable-rule (template) configuration page. It hosts the same parameter wizard as an asset rule, in template
// mode: the parameters are saved as definitions, and a variable is chosen for each when the rule is assigned to an asset.
//   /configuration/rules/new/:kind       create (kind: interval | parameter), in the library, a collection or a collection draft
//   /configuration/rules/:templateId/edit edit an existing reusable rule
// Reusable rules created before the parameter system (cycle count, running time) are edited here as one parameter and are
// saved back in their original storage, so their assignments, evaluation and history are unchanged.

const COPY = {
  parameter_threshold: {
    title: "Parameter Threshold rule",
    description: "Monitor one or more signals in a single reusable rule. Each parameter has its own aggregation and limits; the variable is chosen when the rule is assigned to an asset.",
  },
  interval_based: {
    title: "Interval Based rule",
    description: "Track machine usage and get a Due and an Overdue status when maintenance is needed. One rule can follow several intervals; the variables are chosen when the rule is assigned.",
  },
};

const HOUR = 3600;
const text = (value) => (value === null || value === undefined ? "" : String(value));

// Legacy reusable rules that can be shown and edited as a single interval parameter.
function legacyValues(template) {
  const p = template.parameters || {};
  const counter = template.rule_type === "boolean_count_threshold";
  const usage = template.rule_type === "runtime_duration" && Array.isArray(p.warning_thresholds_seconds);
  if (!counter && !usage) return null;
  const parameter = {
    ...newParameter("interval_based", 1),
    name: p.parameter_name || (counter ? "Cycle count" : "Running time"),
    variableKey: template.variable_key || "",
    intervalParameter: counter ? "counter" : "usage",
    aggregation: counter ? "counter" : "timer",
    due: counter ? text(p.warning_thresholds?.[0]) : text(p.warning_thresholds_seconds[0] / HOUR),
    overdue: counter ? text(p.alert_threshold) : text(p.alert_threshold_seconds / HOUR),
  };
  return {
    name: template.name, periodAmount: "1", periodUnit: "hours", comment: template.description || "",
    instructions: p.maintenance_instructions || "", link: p.reference_link || "", documentIds: [],
    labels: template.labels || [], parameters: [parameter],
  };
}

// Writes an edited legacy parameter back into the template's own fields. The middle warning stays unless it no longer fits.
function legacyPayload(template, values) {
  const parameter = values.parameters[0];
  const p = { ...(template.parameters || {}) };
  const counter = template.rule_type === "boolean_count_threshold";
  const middleFor = (existing, due, overdue) => {
    if (due < existing && existing < overdue) return existing;
    if (!(due < overdue - 1)) throw new Error("Overdue must be at least two units above Due.");
    return overdue - 1;
  };
  if (counter) {
    const due = Number(parameter.due), overdue = Number(parameter.overdue);
    if (due !== p.warning_thresholds[0] || overdue !== p.alert_threshold) {
      p.warning_thresholds = [due, middleFor(p.warning_thresholds[1], due, overdue)];
      p.alert_threshold = overdue;
    }
  } else {
    const due = Math.round(Number(parameter.due) * HOUR), overdue = Math.round(Number(parameter.overdue) * HOUR);
    if (due !== Math.round(p.warning_thresholds_seconds[0]) || overdue !== Math.round(p.alert_threshold_seconds)) {
      p.warning_thresholds_seconds = [due, middleFor(p.warning_thresholds_seconds[1], due, overdue)];
      p.alert_threshold_seconds = overdue;
    }
  }
  const name = parameter.name.trim();
  const defaultName = counter ? "Cycle count" : "Running time";
  if (name !== defaultName || p.parameter_name) p.parameter_name = name;
  if (values.link.trim()) p.reference_link = values.link.trim(); else delete p.reference_link;
  if (values.instructions.trim()) p.maintenance_instructions = values.instructions.trim(); else delete p.maintenance_instructions;
  return { ...templateFields(template, values), parameters: p, variable_key: parameter.variableKey.trim() || null };
}

const templateFields = (template, values) => ({
  name: values.name.trim(), description: values.comment.trim() || null, labels: values.labels || [],
  rule_type: template.rule_type, required_variable_types: template.required_variable_types ?? null,
  variable_key: template.variable_key ?? null, operator: template.operator ?? null, threshold: template.threshold ?? null,
  severity: template.severity, is_enabled: template.is_enabled, collection_id: template.collection_id ?? null,
  evaluation_interval_seconds: template.evaluation_interval_seconds ?? null, stale_after_seconds: template.stale_after_seconds ?? null,
});

export default function TemplateRulePage() {
  const { kind, templateId } = useParams();
  const editing = Boolean(templateId);
  const { user } = useAuth();
  const isAdmin = user?.role === "Administrator";
  const navigate = useNavigate();
  const location = useLocation();
  // A Supervisor suggests a rule for Administrator review instead of creating it.
  const suggest = !editing && Boolean(location.state?.suggest) && user?.role === "Supervisor";
  const canEdit = editing ? isAdmin || user?.role === "Supervisor" : isAdmin || suggest;
  const confirm = useConfirmation();
  const from = location.state?.from;
  const collection = location.state?.collection || null;
  const homePath = editing ? (from?.pathname || LIBRARY_PATH) : collection ? COLLECTIONS_PATH : LIBRARY_PATH;
  const draftMode = !editing && Boolean(collection?.draft);
  const collectionDraft = from?.state?.collectionDraft;
  const supervisorChoices = useSupervisorChoices(isAdmin && !draftMode);
  const [visibility, setVisibility] = useState({ visibility_type: "", visibility_supervisor_ids: [] });
  const [template, setTemplate] = useState(null);
  const [loadError, setLoadError] = useState("");
  const submitting = useRef(false);
  const saved = useRef(false);

  const category = editing ? (template?.parameters?.category || "interval_based") : kind === "parameter" ? "parameter_threshold" : "interval_based";
  const legacy = editing && template && template.rule_type !== "multi_parameter" ? legacyValues(template) : null;
  const unsupported = editing && template && template.rule_type !== "multi_parameter" && !legacy;

  useEffect(() => { rememberNavigationOrigin(from); }, [from]);
  useEffect(() => {
    if (!editing) return undefined;
    let alive = true;
    api.get(`/rule-templates/${templateId}`).then((row) => { if (!alive) return; setTemplate(row); setVisibility(visibilityInitial(row)); }).catch((error) => alive && setLoadError(error.message || "Could not load this rule."));
    return () => { alive = false; };
  }, [editing, templateId]);

  const initialValues = useMemo(() => {
    if (!editing) {
      return { name: "", periodAmount: "1", periodUnit: "hours", parameters: [], comment: "", instructions: "", link: "", documentIds: [], labels: [] };
    }
    if (!template) return null;
    return template.rule_type === "multi_parameter" ? valuesFromTemplate(template) : legacyValues(template);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, template]);

  const leave = (options) => { saved.current = true; returnToNavigationOrigin(navigate, options?.origin || from, homePath, options?.notice ? { notice: options.notice } : undefined); };
  const cancel = async () => {
    if (!saved.current && !(await confirm("Leave without saving? Your changes will be lost.", { title: "Discard changes?", confirmLabel: "Discard", cancelLabel: "Keep editing", destructive: true }))) return;
    leave();
  };

  const visibilityProblem = !draftMode && !suggest && isAdmin
    ? (!visibility.visibility_type ? "Choose who can see this rule."
      : visibility.visibility_type === "specific_supervisors" && !visibility.visibility_supervisor_ids.length ? "Select at least one Supervisor." : "")
    : "";

  const submit = async (values) => {
    if (!canEdit || submitting.current) return;
    submitting.current = true;
    try {
      if (editing) {
        const body = legacy ? legacyPayload(template, values) : {
          ...templateFields(template, values), rule_type: "multi_parameter", required_variable_types: null, variable_key: null,
          parameters: buildTemplateParameters(values, category),
        };
        if (!(await confirm("This reusable rule is shared. Saving updates every asset that uses it; their progress and history are kept.", { title: "Update shared rule?", confirmLabel: "Save changes", cancelLabel: "Cancel" }))) {
          submitting.current = false;
          return;
        }
        if (isAdmin && visibilityProblem) { submitting.current = false; throw new Error(visibilityProblem); }
        await api.put(`/rule-templates/${template.id}`, body);
        if (isAdmin && visibilityChanged(template, visibility)) {
          try { await saveVisibility(template, visibility); } catch (error) {
            saved.current = true;
            throw new Error(`The rule was saved, but its visibility could not be changed: ${error.message}`);
          }
        }
        leave({ notice: { text: `Rule “${body.name}” updated.` } });
        return;
      }
      const body = {
        name: values.name.trim(), description: values.comment.trim() || null, labels: values.labels || [],
        rule_type: "multi_parameter", severity: "alert", is_enabled: true,
        parameters: buildTemplateParameters(values, category),
      };
      if (suggest) {
        await api.post("/rule-template-requests", body);
        leave({ notice: { text: `“${body.name}” was sent to the Administrators for review.` } });
        return;
      }
      if (draftMode) {
        const used = (collectionDraft?.rules?.length || 0) + (collectionDraft?.existing?.length || 0);
        if (used >= MAX_COLLECTION_RULES) throw new Error(`A collection holds at most ${MAX_COLLECTION_RULES} rules.`);
        saved.current = true;
        const origin = { ...from, state: { ...(from?.state || {}), collectionDraft: { ...collectionDraft, rules: [...(collectionDraft?.rules || []), body] } } };
        returnToNavigationOrigin(navigate, origin, homePath, { notice: { text: `“${body.name}” added. It is saved when you create the collection.` } });
        return;
      }
      // One request creates the template already attached to the collection (or to none).
      await api.post("/rule-templates", { ...body, collection_id: collection?.id ?? null, ...visibilityPayload(visibility) });
      leave({ notice: { text: collection ? `Rule created and added to “${collection.name}”.` : "Rule created successfully." } });
    } catch (error) {
      submitting.current = false;
      throw error;
    }
  };

  const copy = COPY[category];
  const back = editing ? "← Back" : draftMode ? "← Back to collection form" : collection ? "← Back to Collection" : "← Back to Rule Library";
  const head = (
    <>
      <button type="button" className="btn-outline rule-back-btn" onClick={cancel}>{back}</button>
      <div className="page-head rule-page-head">
        <span className="rule-create-kicker">{editing ? "EDIT REUSABLE RULE" : suggest ? "SUGGEST A RULE" : "NEW RULE"}</span>
        <h1 className="page-title rule-page-title">{editing ? (template?.name || "Reusable rule") : `Create ${copy.title}`}</h1>
        <p className="rule-page-description">{editing ? "Change this rule's parameters. Assigned asset rules keep their progress, alerts and history." : copy.description}</p>
        {!editing && <p className="muted rule-page-subtitle"><span>Saved to</span><strong>{suggest ? "Administrator review (not added until approved)" : draftMode ? "New collection (saved when you create it)" : collection ? `${collection.name} collection` : "Monitoring Rule Library"}</strong></p>}
      </div>
    </>
  );

  if (editing && !template && !loadError) return <LoadingIndicator className="loading" message="Loading rule" />;
  return (
    <div className="rule-create-page">
      <div className="rule-create-container">
        {head}
        {loadError && <p className="notice" role="alert">{loadError}</p>}
        {unsupported && <p className="notice" role="status">This reusable rule type ({template.rule_type}) cannot be edited as a parameter yet. It keeps working unchanged on the assets that use it.</p>}
        {initialValues && !unsupported && (
          <section className="rule-create-card">
            <ParameterRuleWizard
              category={category}
              templateMode
              variables={[]}
              initialValues={initialValues}
              canEdit={canEdit}
              singleParameter={Boolean(legacy)}
              limitsOnly={editing && !isAdmin && user?.role === "Supervisor"}
              submitLabel={editing ? "Save changes" : suggest ? "Send suggestion" : draftMode ? "Add rule to collection" : "Create rule"}
              savingLabel="Saving…"
              onSubmit={submit}
              onCancel={cancel}
              extraProblem={visibilityProblem}
              reviewExtra={!draftMode && !suggest && isAdmin && (
                <div className="form-group form-group-wide">
                  <label htmlFor="rule-visibility">Visibility *</label>
                  <small>{visibilityFields([])[0].hint}</small>
                  <VisibilityPicker id="rule-visibility" type={visibility.visibility_type}
                    onType={(visibility_type) => setVisibility((current) => ({ ...current, visibility_type }))}
                    ids={visibility.visibility_supervisor_ids}
                    onIds={(visibility_supervisor_ids) => setVisibility((current) => ({ ...current, visibility_supervisor_ids }))}
                    choices={supervisorChoices || []} disabled={!canEdit} />
                </div>
              )}
              topNotice={!canEdit
                ? <p className="notice" role="status">Only Administrators can create reusable monitoring rules.</p>
                : editing && !isAdmin && <p className="notice" role="status">As a Supervisor you can change the Due and Overdue values only. Everything else is shown for reference.</p>}
            />
          </section>
        )}
      </div>
    </div>
  );
}
