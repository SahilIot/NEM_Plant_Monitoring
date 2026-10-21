import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_RULE_CHOICES,
  MONITORING_RULE_CHOICES,
  buildAssetMonitoringRule,
  legacyRulePath,
  monitoringRuleFormSelection,
} from "../src/features/assets/rules/monitoringRuleFlow.js";

test("Add rule choices enter the selected monitoring-rule form", () => {
  assert.deepEqual(
    MONITORING_RULE_CHOICES.map((choice) => choice.id),
    ["motor_rotation", "running_time", "boolean_count_threshold"]
  );
  assert.deepEqual(monitoringRuleFormSelection("motor_rotation"), {
    title: "Create Motor Rotation rule",
    ruleType: "boolean_count_threshold",
    initialValues: {
      rule_type: "boolean_count_threshold",
      name: "Motor Rotation",
    },
  });
  assert.equal(
    monitoringRuleFormSelection("running_time").ruleType,
    "runtime_duration"
  );
  assert.throws(() => monitoringRuleFormSelection("unknown"));
});

test("legacy maintenance-rule routes remain available from maintenance flows", () => {
  assert.deepEqual(
    LEGACY_RULE_CHOICES.map((choice) => choice.kind),
    ["interval", "usage", "time"]
  );
  assert.equal(legacyRulePath(17, "interval"), "/assets/17/rules/new/interval");
  assert.equal(legacyRulePath(17, "usage"), "/assets/17/rules/new/usage");
  assert.equal(legacyRulePath(17, "time"), "/assets/17/rules/new/time");
});

test("monitoring rule payload is asset-scoped and uses the configured cycle signal", () => {
  const rule = buildAssetMonitoringRule(
    {
      name: "Rotation service",
      severity: "warning",
      rule_type: "boolean_count_threshold",
      cycle_variable_id: 22,
      warning_threshold_1: 9000,
      warning_threshold_2: 9500,
      alert_threshold: 10000,
    },
    17,
    {
      variables: [
        {
          id: 22,
          asset_id: 17,
          data_type: "boolean",
          is_active: true,
        },
      ],
      cycleVariableIds: [22],
      runtimeVariableIds: [],
    }
  );

  assert.equal(rule.target_asset_id, 17);
  assert.equal(rule.variable_id, 22);
  assert.deepEqual(rule.parameters, {
    warning_thresholds: [9000, 9500],
    alert_threshold: 10000,
  });
});

test("running-time payload requires a mapped Boolean variable on the selected asset", () => {
  const options = {
    variables: [
      {
        id: 31,
        asset_id: 17,
        data_type: "boolean",
        is_active: true,
      },
    ],
    cycleVariableIds: [],
    runtimeVariableIds: [31],
  };
  const rule = buildAssetMonitoringRule(
    {
      name: "Runtime",
      severity: "warning",
      rule_type: "runtime_duration",
      runtime_variable_id: 31,
      runtime_warning_hours: 8,
      runtime_warning_2_hours: 9,
      runtime_alert_hours: 10,
    },
    17,
    options
  );
  assert.equal(rule.target_asset_id, 17);
  assert.equal(rule.variable_id, 31);
  assert.deepEqual(rule.parameters, {
    warning_thresholds_seconds: [28800, 32400],
    alert_threshold_seconds: 36000,
  });

  assert.throws(
    () =>
      buildAssetMonitoringRule(
        {
          name: "Cross-asset runtime",
          severity: "warning",
          rule_type: "runtime_duration",
          runtime_variable_id: 31,
          runtime_warning_hours: 8,
          runtime_warning_2_hours: 9,
          runtime_alert_hours: 10,
        },
        18,
        options
      ),
    /configured Boolean running signal/
  );
});

test("mapping-bypass declared Boolean variables can be selected for this asset", () => {
  const variable = {
    id: 44,
    asset_id: 17,
    data_type: "boolean",
    is_active: true,
    opcua_node_id: "ns=2;s=declared-running",
  };
  const runtime = buildAssetMonitoringRule(
    {
      name: "Declared runtime",
      severity: "warning",
      rule_type: "runtime_duration",
      runtime_variable_id: 44,
      runtime_warning_hours: 1,
      runtime_warning_2_hours: 2,
      runtime_alert_hours: 3,
    },
    17,
    {
      variables: [variable],
      cycleVariableIds: [44],
      runtimeVariableIds: [44],
    }
  );
  const cycles = buildAssetMonitoringRule(
    {
      name: "Declared cycles",
      severity: "warning",
      rule_type: "boolean_count_threshold",
      cycle_variable_id: 44,
      warning_threshold_1: 10,
      warning_threshold_2: 20,
      alert_threshold: 30,
    },
    17,
    {
      variables: [variable],
      cycleVariableIds: [44],
      runtimeVariableIds: [44],
    }
  );

  assert.equal(runtime.variable_id, 44);
  assert.equal(cycles.variable_id, 44);
  assert.equal(runtime.target_asset_id, 17);
  assert.equal(cycles.target_asset_id, 17);
});
