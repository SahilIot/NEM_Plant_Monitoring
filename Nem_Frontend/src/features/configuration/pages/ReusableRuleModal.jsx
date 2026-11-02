
import React, { useState } from "react";
import { api } from "../../../services/api.js";
import { CreateModal } from "../../../components/common/UI.jsx";
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
  const isEditing = Boolean(template);

  const save = async (values) => {
    if (saving) return;

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

        await onUpdated?.(result, collection);
      } else {
        const result = await api.post("/rule-templates", payload);

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
      fields={FIELDS}
      initialValues={initialTemplate(template)}
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
