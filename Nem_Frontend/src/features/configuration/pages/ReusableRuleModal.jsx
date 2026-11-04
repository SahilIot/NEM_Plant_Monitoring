
import React, { useState } from "react";
import { api } from "../../../services/api.js";
import { CreateModal, useConfirmation } from "../../../components/common/UI.jsx";
import {
  SHARED_RULE_WARNING,
  VISIBILITY_CHANGE_WARNING,
  saveVisibility,
  useSupervisorChoices,
  visibilityChanged,
  visibilityFields,
  visibilityInitial,
  visibilityPayload,
} from "./RuleVisibility.jsx";
import { useAuth } from "../../auth/AuthContext.jsx";
import {
  FIELDS,
  initialTemplate,
  templatePayload,
} from "./RuleLibrary.jsx";

export default function ReusableRuleModal({
  collection,
  template = null,
  onClose,
  onCreated,
  onUpdated,
}) {
  const [saving, setSaving] = useState(false);
  const confirm = useConfirmation();
  const isEditing = Boolean(template);
  const { user } = useAuth();
  const isAdministrator = user?.role === "Administrator";
  const supervisorChoices = useSupervisorChoices(isAdministrator);

  const save = async (values) => {
    if (saving) return;

    const changesVisibility = isEditing && isAdministrator && visibilityChanged(template, values);
    if (isEditing) {
      if (changesVisibility && values.visibility_type === "specific_supervisors" && !(values.visibility_supervisor_ids || []).length) {
        throw new Error("Select at least one Supervisor.");
      }
      const proceed = await confirm(
        changesVisibility ? `${SHARED_RULE_WARNING}\n\n${VISIBILITY_CHANGE_WARNING}` : SHARED_RULE_WARNING,
        { title: changesVisibility ? "Shared rule and access" : "Shared rule", confirmLabel: "Continue" }
      );
      if (!proceed) return;
    }

    setSaving(true);

    try {
      const payload = {
        ...templatePayload(values),
        collection_id: collection.id,
      };

      if (isEditing) {
        const result = await api.put(
          `/rule-templates/${template.id}`,
          payload
        );

        if (changesVisibility) {
          try {
            await saveVisibility(template, values);
          } catch (err) {
            throw new Error(`The rule was saved, but its visibility could not be changed: ${err.message}`);
          }
        }

        await onUpdated?.(result, collection);
      } else {
        const result = await api.post("/rule-templates", {
          ...payload,
          ...visibilityPayload(values),
        });

        await onCreated?.(result, collection);
      }

      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <CreateModal
      title={isEditing ? "Edit reusable rule" : "Create reusable rule"}
      intro={
        isEditing
          ? `Update reusable rule in "${collection.name}".`
          : `Add a reusable rule to "${collection.name}" (${collection.ruleCount || 0} of 5 rules). It can then be assigned to assets.`
      }
      fields={isEditing && !isAdministrator ? FIELDS : [...FIELDS, ...visibilityFields(supervisorChoices)]}
      initialValues={
        isEditing && isAdministrator
          ? { ...initialTemplate(template), ...visibilityInitial(template) }
          : initialTemplate(template)
      }
      submitLabel={
        saving
          ? isEditing
            ? "Saving..."
            : "Creating..."
          : isEditing
            ? "Save changes"
            : "Create rule"
      }
      onSubmit={save}
      onClose={onClose}
    />
  );
}
