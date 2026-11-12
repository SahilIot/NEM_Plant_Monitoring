// Verify that Temperature Monitoring rule selection and creation preserve the correct rule type, temperature metadata, and engineering unit.
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAssetMonitoringRule,
  monitoringRuleFormSelection,
} from "../src/features/assets/rules/monitoringRuleFlow.js";

test("temperature rule selection resolves the temperature alias", () => {
  const selection = monitoringRuleFormSelection("temperature");

  assert.equal(selection.ruleType, "parameter_threshold");
  assert.equal(selection.initialValues.rule_type, "parameter_threshold");
  assert.equal(selection.title, "Create Temperature Based rule");
});

test("temperature rules preserve temperature metadata and unit information", () => {
  const rule = buildAssetMonitoringRule(
    {
      name: "Boiler temperature alarm",
      description: "Track high temperature before shutdown.",
      rule_type: "parameter_threshold",
      variable_id: "13",
      operator: ">=",
      threshold: "85",
      severity: "alert",
    },
    7,
    {
      variables: [
        { id: 13, asset_id: 7, name: "Boiler temp", data_type: "number", unit: "°C", is_active: true },
      ],
      cycleVariableIds: [],
      runtimeVariableIds: [],
    }
  );

  assert.equal(rule.rule_type, "parameter_threshold");
  assert.equal(rule.operator, ">=");
  assert.equal(rule.threshold, 85);
  assert.equal(rule.parameters.unit, "°C");
  assert.equal(rule.parameters.temperature_rule, true);
});
