import React from "react";
import CopyRulesModal from "../../components/CopyRulesModal.jsx";
import { CreateModal } from "../../../../components/common/UI.jsx";
import { LOG_FIELDS, VARIABLE_FIELDS } from "./constants.js";

export default function AssetFormModals({ ctx }) {
  const {
    addLog,
    addRule,
    addVariable,
    asset,
    assetId,
    assets,
    availableVariables,
    canManageLogbook,
    canManageRules,
    cycleVariableIds,
    editingVariable,
    isAdministrator,
    modal,
    monitoringRuleFormFields,
    monitoringRuleSelection,
    refreshAll,
    runtimeVariableIds,
    saveAsset,
    setActionNotice,
    setEditingVariable,
    setModal,
    setMonitoringRuleSelection,
    updateVariable,
  } = ctx;
  return (
    <>
      {modal === "copyRules" && (
        <CopyRulesModal
          assetId={assetId}
          assets={assets}
          cycleVariableIds={cycleVariableIds}
          runtimeVariableIds={runtimeVariableIds}
          onClose={() => setModal(null)}
          onCopied={async (result) => {
            setModal(null);
            await refreshAll();
            setActionNotice(
              `${result.created.length} rule(s) copied to this asset and created inactive.` +
                (result.already_copied?.length
                  ? ` ${result.already_copied.length} matching rule(s) were already present.`
                  : ""),
            );
          }}
        />
      )}

      {modal === "add" && (
        <CreateModal
          title={monitoringRuleSelection?.title || "Create monitoring rule"}
          submitLabel={
            monitoringRuleSelection?.ruleId ? "Save rule" : "Create rule"
          }
          intro={
            !canManageRules
              ? "You do not have permission to create or edit monitoring rules."
              : availableVariables.length
                ? undefined
                : "This asset has no active variables yet. Add one under Variables, then come back to create a rule."
          }
          fields={monitoringRuleFormFields}
          initialValues={monitoringRuleSelection?.initialValues}
          onSubmit={addRule}
          disabled={!canManageRules}
          onClose={() => {
            setModal(null);
            setMonitoringRuleSelection(null);
          }}
        />
      )}

      {modal === "log" && (
        <CreateModal
          title="New logbook entry"
          submitLabel="Add entry"
          fields={LOG_FIELDS}
          onSubmit={addLog}
          disabled={!canManageLogbook}
          intro={
            !canManageLogbook
              ? "You do not have permission to add logbook entries."
              : undefined
          }
          onClose={() => setModal(null)}
        />
      )}

      {modal === "settings" && (
        <CreateModal
          title="Asset settings"
          submitLabel="Save changes"
          onSubmit={saveAsset}
          disabled={!isAdministrator}
          intro={
            !isAdministrator
              ? "Administrator access required to change asset settings."
              : undefined
          }
          onClose={() => setModal(null)}
          fields={[
            {
              key: "name",
              label: "Name",
              required: true,
              default: asset.name,
            },
            {
              key: "asset_type",
              label: "Type",
              required: true,
              default: asset.asset_type,
            },
            {
              key: "description",
              label: "Description",
              type: "textarea",
              default: asset.description || "",
            },
            {
              key: "is_active",
              label: "Monitoring",
              type: "select",
              default: String(asset.is_active),
              options: [
                ["true", "Enabled"],
                ["false", "Disabled"],
              ],
              hint: "Disabled assets stay in the hierarchy but are greyed out.",
            },
          ]}
        />
      )}

      {(modal === "addVariable" || modal === "editVariable") && (
        <CreateModal
          title={editingVariable ? "Edit variable" : "Add variable"}
          submitLabel={editingVariable ? "Save variable" : "Add variable"}
          fields={VARIABLE_FIELDS}
          initialValues={editingVariable || {}}
          onSubmit={editingVariable ? updateVariable : addVariable}
          disabled={!isAdministrator}
          intro={
            !isAdministrator
              ? "Administrator access required to manage variables and OPC UA mappings."
              : undefined
          }
          onClose={() => {
            setEditingVariable(null);
            setModal("variables");
          }}
        />
      )}
    </>
  );
}
