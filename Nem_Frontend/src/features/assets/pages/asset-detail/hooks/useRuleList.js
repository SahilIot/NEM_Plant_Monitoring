import { useMemo } from "react";
import { ruleFields } from "../ruleFields.js";
import { ORDER } from "../constants.js";

// Rule form fields and the filtered / sorted list of rules shown on the status tab.
export default function useRuleList(ctx) {
  const {
    variables,
    cycleVariableIds,
    runtimeVariableIds,
    mappingBypassEnabled,
    rules,
    completedMaintenanceCount,
    list,
    filter,
    sort,
  } = ctx;

  const availableVariables = variables;

  const ruleFormFields = useMemo(
    () =>
      ruleFields(
        availableVariables,
        cycleVariableIds,
        runtimeVariableIds,
        mappingBypassEnabled,
      ),
    [
      availableVariables,
      cycleVariableIds,
      runtimeVariableIds,
      mappingBypassEnabled,
    ],
  );

  const isAct = (rule) => rule.state === "activated";

  const nAct = rules.filter(isAct).length;

  const nNot = rules.length - nAct + completedMaintenanceCount;

  let shown = rules
    .filter((rule) => (list === "activated" ? isAct(rule) : !isAct(rule)))
    .filter((rule) =>
      (rule.name || "").toLowerCase().includes(filter.toLowerCase()),
    );

  shown = [...shown].sort((a, b) =>
    sort === "name"
      ? (a.name || "").localeCompare(b.name || "")
      : (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3),
  );

  return {
    availableVariables,
    ruleFormFields,
    isAct,
    nAct,
    nNot,
    shown,
  };
}
