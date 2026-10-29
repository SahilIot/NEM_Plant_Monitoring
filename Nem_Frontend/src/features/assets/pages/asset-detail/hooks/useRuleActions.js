import { useMemo } from "react";
import { api } from "../../../../../services/api.js";
import { buildRuleThresholdChanges, isBlank } from "../ruleHelpers.js";
import { buildAssetMonitoringRule } from "../../../rules/monitoringRuleFlow.js";

// Rule actions: lifecycle changes, details, archive/delete, add/edit, bulk activate.
export default function useRuleActions(ctx) {
  const {
    loadLive,
    refreshStatus,
    canManageRules,
    lifecycleAction,
    deletingRuleId,
    setDeletingRuleId,
    setLoadError,
    setLifecycleAction,
    setRuleActionMenuId,
    setViewRule,
    setCompletionDetails,
    setCompletionDetailsError,
    confirm,
    isAdministrator,
    permanentDeleteRequest,
    setActionNotice,
    monitoringRuleSelection,
    isSupervisor,
    setModal,
    setMonitoringRuleSelection,
    assetId,
    availableVariables,
    cycleVariableIds,
    runtimeVariableIds,
    setList,
    navigate,
    ruleFormFields,
    bulkRequest,
    bulkSaving,
    rules,
    isAct,
    children,
    setBulkSaving,
    setMenu,
  } = ctx;

  const refreshAll = async () => {
    await Promise.all([loadLive(), refreshStatus?.()]);
  };

  const confirmLifecycleChange = async () => {
    if (!canManageRules || !lifecycleAction || deletingRuleId !== null) return;
    const { rule, action } = lifecycleAction;
    setDeletingRuleId(rule.id);
    setLoadError("");
    try {
      await api.post(`/rules/${rule.id}/${action}`);
      await refreshAll();
      setLifecycleAction(null);
      setRuleActionMenuId(null);
    } catch (error) {
      setLoadError(error.message || `Could not ${action} this rule.`);
    } finally {
      setDeletingRuleId(null);
    }
  };

  const lifecycleStatus = (rule) =>
    rule.lifecycle_status || (rule.is_enabled ? "in_progress" : "deactivated");

  const lifecycleLabel = (rule) => {
    const status = lifecycleStatus(rule);
    if (status === "in_progress") return "Activated · In progress";
    if (status === "suspended") return "Suspended";
    if (status === "completed") return "Completed";
    return "Deactivated";
  };

  const openRuleDetails = async (rule) => {
    setViewRule(rule);
    setCompletionDetails(null);
    setCompletionDetailsError("");

    try {
      const response = await api.get(`/events?rule_id=${rule.id}&limit=100`);
      const ruleEvents = response.items || [];
      const acknowledgement = ruleEvents.find(
        (item) => item.event_type === "alert_acknowledged",
      );
      const completion = ruleEvents.find(
        (item) => item.event_type === "rule_completed",
      );
      setCompletionDetails({
        acknowledged_by:
          completion?.metadata?.acknowledged_by ||
          acknowledgement?.metadata?.acknowledged_by,
        acknowledged_at:
          completion?.metadata?.acknowledged_at ||
          acknowledgement?.metadata?.acknowledged_at ||
          acknowledgement?.occurred_at,
        completed_by: completion?.metadata?.completed_by,
        completed_at:
          completion?.metadata?.completed_at || completion?.occurred_at,
      });
    } catch (error) {
      setCompletionDetailsError(
        error.message || "Could not load completion details.",
      );
    }
  };

  const remove = async (rule) => {
    if (!canManageRules) return;
    if (
      !(await confirm(
        `Archive the rule “${rule.name}”? It will be hidden from the rule list, and its alert and evaluation history will be retained.`,
        {
          title: "Archive rule",
          confirmLabel: "Archive",
          destructive: true,
        },
      ))
    ) {
      return;
    }

    try {
      await api.del(`/rules/${rule.id}`);
      await refreshAll();
    } catch (error) {
      setLoadError(error.message);
    }
  };

  const permanentlyDeleteRule = async (rule) => {
    if (!isAdministrator || permanentDeleteRequest.current) return;
    if (
      !(await confirm(
        `Permanently delete “${rule.name}”? This irreversibly removes the rule, its alerts, and its evaluation history. Maintenance records linked to its alerts must be removed first.`,
        {
          title: "Permanently delete rule",
          confirmLabel: "Delete permanently",
          destructive: true,
        },
      ))
    ) {
      return;
    }

    permanentDeleteRequest.current = true;
    setDeletingRuleId(rule.id);
    setLoadError("");
    setActionNotice("");
    try {
      await api.del(`/rules/${rule.id}/permanent`);
      await refreshAll();
      setActionNotice(`Rule “${rule.name}” was permanently deleted.`);
    } catch (error) {
      setLoadError(error.message || "Could not permanently delete the rule.");
    } finally {
      permanentDeleteRequest.current = false;
      setDeletingRuleId(null);
    }
  };

  const addRule = async (values) => {
    if (!canManageRules) return;

    const editId = monitoringRuleSelection?.ruleId;
    if (editId && isSupervisor) {
      // Supervisors may only change thresholds and intervals; send just those.
      const payload = buildRuleThresholdChanges(
        monitoringRuleSelection?.initialValues?.rule_type,
        values,
        monitoringRuleSelection?.initialValues || {},
      );
      if (Object.keys(payload).length === 0) {
        setModal(null);
        setMonitoringRuleSelection(null);
        setActionNotice("No changes were made to the rule.");
        return;
      }
      await api.patch(`/rules/${editId}`, payload);
    } else {
      const rule = buildAssetMonitoringRule(values, assetId, {
        variables: availableVariables,
        cycleVariableIds,
        runtimeVariableIds,
      });

      if (editId) {
        // Editing must not change activation state or the stale timeout.
        delete rule.is_enabled;
        delete rule.stale_after_seconds;
        if (!isBlank(values.evaluation_interval_seconds)) {
          rule.evaluation_interval_seconds = Number(
            values.evaluation_interval_seconds,
          );
        }
        await api.patch(`/rules/${editId}`, rule);
      } else {
        await api.post(`/assets/${assetId}/rules`, rule);
      }
    }

    setModal(null);
    setMonitoringRuleSelection(null);
    setList("activated");
    await refreshAll();
  };

  const openMonitoringRuleForm = (choiceId) => {
    setModal(null);
    setMonitoringRuleSelection(null);

    navigate(`/assets/${assetId}/monitoring-rules/new/${choiceId}`);
  };

  const openEditRuleForm = (rule) => {
    if (!canManageRules) return;

    const parameters = rule.parameters || {};
    const initialValues = {
      name: rule.name || "",
      description: rule.description || "",
      rule_type: rule.rule_type || "parameter_threshold",
      severity: rule.severity || "warning",
      evaluation_interval_seconds: rule.evaluation_interval_seconds ?? null,
    };

    if (rule.rule_type === "parameter_threshold") {
      initialValues.variable_id = rule.variable_id;
      initialValues.operator = rule.operator || ">=";
      initialValues.threshold = rule.threshold;
    } else if (rule.rule_type === "boolean_count_threshold") {
      initialValues.cycle_variable_id = rule.variable_id;
      const countWarnings = parameters.warning_thresholds;
      initialValues.warning_threshold_1 = Array.isArray(countWarnings)
        ? (countWarnings[0] ?? null)
        : null;
      initialValues.warning_threshold_2 = Array.isArray(countWarnings)
        ? (countWarnings[1] ?? null)
        : null;
      initialValues.alert_threshold = parameters.alert_threshold ?? null;
    } else if (rule.rule_type === "runtime_duration") {
      initialValues.runtime_variable_id = rule.variable_id;
      const warnings = parameters.warning_thresholds_seconds;
      const alert = parameters.alert_threshold_seconds;
      initialValues.runtime_warning_hours =
        Array.isArray(warnings) && warnings.length >= 1
          ? warnings[0] / 3600
          : null;
      initialValues.runtime_warning_2_hours =
        Array.isArray(warnings) && warnings.length >= 2
          ? warnings[1] / 3600
          : null;
      initialValues.runtime_alert_hours = alert != null ? alert / 3600 : null;
    }

    setMonitoringRuleSelection({
      title: "Edit rule",
      initialValues,
      ruleId: rule.id,
    });
    setModal("add");
  };

  const monitoringRuleFormFields = useMemo(() => {
    const isEditing = Boolean(monitoringRuleSelection?.ruleId);
    const editingRuleType = monitoringRuleSelection?.initialValues?.rule_type;

    return ruleFormFields
      .filter(
        (field) => field.key !== "evaluation_interval_seconds" || isEditing,
      )
      .map((field) => {
        let disabled = false;
        let options = field.options;

        if (field.key === "rule_type") {
          if (isEditing) {
            disabled = true;
          }
          if (options && editingRuleType) {
            options = field.options.filter(
              ([ruleType]) => ruleType === editingRuleType,
            );
          }
        }

        if (isSupervisor && isEditing) {
          const allowedFields = [
            "threshold",
            "evaluation_interval_seconds",
            "warning_threshold_1",
            "warning_threshold_2",
            "alert_threshold",
            "runtime_warning_hours",
            "runtime_warning_2_hours",
            "runtime_alert_hours",
          ];
          if (!allowedFields.includes(field.key)) {
            disabled = true;
          }
        }

        return {
          ...field,
          disabled,
          options,
        };
      });
  }, [ruleFormFields, monitoringRuleSelection, isSupervisor]);

  const bulk = async (state) => {
    if (!canManageRules || bulkRequest.current || bulkSaving) return;
    const affected = rules.filter((rule) =>
      state === "activated" ? !isAct(rule) : isAct(rule),
    ).length;
    if (state === "not_activated" && affected > 0) {
      const scope = children
        ? "this asset and its included child assets"
        : "this asset only";
      if (
        !(await confirm(
          `Deactivate ${affected} active rule(s) on ${scope}? Active alerts for those rules will be resolved.`,
          {
            title: "Deactivate rules",
            confirmLabel: "Deactivate",
            destructive: true,
          },
        ))
      ) {
        return;
      }
    }
    bulkRequest.current = true;
    setBulkSaving(true);
    setLoadError("");
    setActionNotice("");
    setMenu(false);
    try {
      const result = await api.post(
        `/assets/${assetId}/rules/bulk?include_children=${children}`,
        { state },
      );
      await refreshAll();
      const action = state === "activated" ? "activated" : "deactivated";
      const skipped = result.skipped || [];
      setActionNotice(
        `${result.updated} rule(s) ${action}.` +
          (skipped.length
            ? ` ${skipped.length} rule(s) were skipped because they are not eligible: ${skipped.map((item) => item.name).join(", ")}.`
            : ""),
      );
    } catch (error) {
      setLoadError(error.message || "Could not update rule states.");
    } finally {
      bulkRequest.current = false;
      setBulkSaving(false);
    }
  };

  return {
    refreshAll,
    confirmLifecycleChange,
    lifecycleStatus,
    lifecycleLabel,
    openRuleDetails,
    remove,
    addRule,
    openEditRuleForm,
    monitoringRuleFormFields,
    bulk,
  };
}
