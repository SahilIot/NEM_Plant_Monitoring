import assert from "node:assert/strict";
import test from "node:test";

import {
  collectionAssignmentStatus,
  matchesRuleFilters,
  ruleConditionSummary,
} from "./rulePresentation.js";

// Keep filtering behavior aligned with Assign Monitoring Rules' all-selected-labels rule.
test("rule filters match severity and require every selected label", () => {
  const rule = {
    severity: "alert",
    labels: [{ id: 2, name: "Safety" }, { id: 4, name: "Electrical" }],
  };

  assert.equal(matchesRuleFilters(rule, "alert", [2, 4]), true);
  assert.equal(matchesRuleFilters(rule, "warning", [2]), false);
  assert.equal(matchesRuleFilters(rule, "all", [2, 5]), false);
  assert.equal(matchesRuleFilters({ severity: null, labels: ["7"] }, "warning", [7]), true);
});

// An entirely unavailable collection must never be shown as Available.
test("collection status distinguishes assigned, partial, available, and unavailable", () => {
  assert.equal(collectionAssignmentStatus(2, 2, 0), "Assigned");
  assert.equal(collectionAssignmentStatus(3, 1, 1), "Partially Assigned");
  assert.equal(collectionAssignmentStatus(2, 0, 1), "Available");
  assert.equal(collectionAssignmentStatus(2, 0, 0), "Unavailable");
});

test("rule summaries expose configured runtime thresholds", () => {
  assert.match(
    ruleConditionSummary({
      rule_type: "runtime_duration",
      parameters: {
        warning_thresholds_seconds: [3600, 7200],
        alert_threshold_seconds: 10800,
      },
    }),
    /warning at 1h \/ 2h, alert at 3h/
  );
});
