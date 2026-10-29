import React from "react";
import { Modal, StatusBadge } from "../../../../components/common/UI.jsx";
import {
  LEGACY_RULE_CHOICES,
  legacyRulePath,
} from "../../rules/monitoringRuleFlow.js";
import { ruleConditionSummary, thresholdMetrics } from "./ruleHelpers.js";
import { formatTime, formatValue } from "../../../../utils/format.js";

export default function RuleDialogs({ ctx }) {
  const {
    assetId,
    completionDetails,
    completionDetailsError,
    confirmLifecycleChange,
    deletingRuleId,
    lifecycleAction,
    lifecycleLabel,
    lifecycleStatus,
    loadError,
    modal,
    navigate,
    setCompletionDetails,
    setCompletionDetailsError,
    setLifecycleAction,
    setLoadError,
    setModal,
    setShowPredefinedRules,
    setViewRule,
    viewRule,
  } = ctx;
  return (
    <>
      {modal === "addRuleOptions" && (
        <Modal title="Add Rule" onClose={() => setModal(null)}>
          <div className="rule-type-options">
            <button
              type="button"
              className="rule-type-option"
              onClick={() => setModal("ruleTypeOptions")}
            >
              <strong>Create a Rule</strong>
              <small>Create an interval, time, or usage-based rule.</small>
            </button>

            <button
              type="button"
              className="rule-type-option"
              onClick={() => {
                setModal(null);
                setShowPredefinedRules(true);
              }}
            >
              <strong>Assign Predefined Monitoring Rules</strong>
              <small>Assign predefined rules to this asset.</small>
            </button>

            <button
              type="button"
              className="rule-type-option"
              onClick={() => setModal("copyRules")}
            >
              <strong>Copy from Another Asset</strong>
              <small>Copy rules from another asset.</small>
            </button>
          </div>
        </Modal>
      )}

      {modal === "ruleTypeOptions" && (
        <Modal title="Create a Rule" onClose={() => setModal(null)}>
          <div className="rule-type-options">
            {LEGACY_RULE_CHOICES.map((choice) => (
              <button
                key={choice.kind}
                type="button"
                className="rule-type-option"
                onClick={() => {
                  setModal(null);
                  navigate(legacyRulePath(assetId, choice.kind));
                }}
              >
                <strong>{choice.label}</strong>
                <small>{choice.description}</small>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {lifecycleAction && (
        <Modal
          title={
            lifecycleAction.action === "suspend"
              ? "Suspend monitoring rule"
              : lifecycleAction.action === "deactivate"
                ? "Deactivate monitoring rule"
                : lifecycleAction.action === "resume"
                  ? "Resume monitoring rule"
                  : "Activate monitoring rule"
          }
          onClose={() => {
            if (deletingRuleId === null) {
              setLifecycleAction(null);
              setLoadError("");
            }
          }}
        >
          <p>
            {lifecycleAction.action === "suspend"
              ? "Suspending pauses rule evaluation and prevents new alerts. The rule configuration and history will be retained."
              : lifecycleAction.action === "deactivate"
                ? "Are you sure you want to deactivate this monitoring rule? This disables monitoring but does not mark the rule completed. Its configuration and history will be retained."
                : lifecycleAction.action === "resume"
                  ? "Resume monitoring using this rule's saved configuration?"
                  : "Activate monitoring using this rule's saved configuration?"}
          </p>
          {loadError && (
            <p className="notice error" role="alert">
              {loadError}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="btn-outline"
              disabled={deletingRuleId !== null}
              onClick={() => {
                setLifecycleAction(null);
                setLoadError("");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={deletingRuleId !== null}
              onClick={confirmLifecycleChange}
            >
              {deletingRuleId === lifecycleAction.rule.id
                ? "Saving…"
                : lifecycleAction.action === "suspend"
                  ? "Confirm suspension"
                  : lifecycleAction.action === "deactivate"
                    ? "Deactivate"
                    : lifecycleAction.action === "resume"
                      ? "Resume rule"
                      : "Activate rule"}
            </button>
          </div>
        </Modal>
      )}

      {viewRule && (
        <Modal
          title={viewRule.name || "Monitoring rule"}
          onClose={() => {
            setViewRule(null);
            setCompletionDetails(null);
            setCompletionDetailsError("");
          }}
          wide
        >
          <dl className="rule-detail-grid">
            <div>
              <dt>Rule type</dt>
              <dd>
                {viewRule.rule_type === "runtime_duration"
                  ? "Running time"
                  : viewRule.rule_type === "boolean_count_threshold"
                    ? "Cycle count"
                    : viewRule.rule_type === "parameter_threshold"
                      ? "Parameter threshold"
                      : viewRule.rule_type === "duration" &&
                          viewRule.parameters?.condition === "interval_elapsed"
                        ? "Interval based"
                        : viewRule.rule_type?.replaceAll("_", " ") || "—"}
              </dd>
            </div>
            <div>
              <dt>Lifecycle</dt>
              <dd>{lifecycleLabel(viewRule)}</dd>
            </div>
            <div>
              <dt>Evaluation status</dt>
              <dd>
                <StatusBadge status={viewRule.status || "unknown"} />
              </dd>
            </div>
            <div>
              <dt>Variable</dt>
              <dd>{viewRule.variable_name || "Asset-level rule"}</dd>
            </div>
            <div>
              <dt>Condition</dt>
              <dd>
                {ruleConditionSummary(viewRule) ||
                  "No condition summary available."}
              </dd>
            </div>
            {viewRule.description && (
              <div>
                <dt>Description</dt>
                <dd>{viewRule.description}</dd>
              </div>
            )}
            {thresholdMetrics(viewRule).map((metric) => (
              <div key={metric.label}>
                <dt>{metric.label} threshold</dt>
                <dd>{metric.value}</dd>
              </div>
            ))}
            <div>
              <dt>Latest value</dt>
              <dd>{formatValue(viewRule.latest_value)}</dd>
            </div>
            <div>
              <dt>Last evaluated</dt>
              <dd>
                {viewRule.last_evaluated_at
                  ? formatTime(viewRule.last_evaluated_at)
                  : "Not evaluated yet"}
              </dd>
            </div>
            {viewRule.evaluation_message && (
              <div>
                <dt>Evaluation detail</dt>
                <dd>{viewRule.evaluation_message}</dd>
              </div>
            )}
            {completionDetailsError ? (
              <div>
                <dt>Action history</dt>
                <dd className="error-message">{completionDetailsError}</dd>
              </div>
            ) : completionDetails === null ? (
              <div>
                <dt>Action history</dt>
                <dd>Loading acknowledgement and completion details…</dd>
              </div>
            ) : (
              <>
                {completionDetails.acknowledged_by && (
                  <>
                    <div>
                      <dt>Acknowledged by</dt>
                      <dd>{completionDetails.acknowledged_by}</dd>
                    </div>
                    <div>
                      <dt>Acknowledged at</dt>
                      <dd>
                        {completionDetails.acknowledged_at
                          ? formatTime(completionDetails.acknowledged_at)
                          : "—"}
                      </dd>
                    </div>
                  </>
                )}
                {lifecycleStatus(viewRule) === "completed" && (
                  <>
                    <div>
                      <dt>Completion</dt>
                      <dd>Rule successfully completed and deactivated.</dd>
                    </div>
                    <div>
                      <dt>Completed by</dt>
                      <dd>{completionDetails.completed_by || "—"}</dd>
                    </div>
                    <div>
                      <dt>Completed at</dt>
                      <dd>
                        {completionDetails.completed_at
                          ? formatTime(completionDetails.completed_at)
                          : viewRule.completed_at
                            ? formatTime(viewRule.completed_at)
                            : "—"}
                      </dd>
                    </div>
                  </>
                )}
              </>
            )}
          </dl>
          <div className="modal-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setViewRule(null);
                setCompletionDetails(null);
                setCompletionDetailsError("");
              }}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
