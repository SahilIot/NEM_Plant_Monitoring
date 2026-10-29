import React from "react";
import {
  EmptyState,
  FloatingMenu,
  StatusBadge,
} from "../../../../components/common/UI.jsx";
import {
  formatTimeUntilStart,
  ruleConditionSummary,
  thresholdSequence,
} from "./ruleHelpers.js";
import {
  formatDuration,
  formatTime,
  formatValue,
} from "../../../../utils/format.js";
import { DotsIcon } from "../../../../components/common/Icons.jsx";
import { Trash2 } from "lucide-react";

export default function RuleList({ ctx }) {
  const {
    alerts,
    canManageRules,
    clockNow,
    deleteEvent,
    deletingEventId,
    deletingRuleId,
    isAdministrator,
    lifecycleLabel,
    lifecycleStatus,
    list,
    openEditRuleForm,
    openRuleDetails,
    remove,
    ruleActionMenuId,
    ruleStates,
    runtimeReadings,
    setLifecycleAction,
    setRuleActionMenuId,
    shown,
  } = ctx;
  return shown.length === 0 && list === "activated" ? (
    <div className="panel">
      <EmptyState
        art={false}
        title={
          list === "activated"
            ? "No activated rules"
            : "No rules are switched off"
        }
        lines={[
          list === "activated"
            ? "Select “Add rule” to watch a variable on this asset."
            : "Rules you deactivate are kept here and can be activated again.",
        ]}
      />
    </div>
  ) : (
    <div className="rule-list">
      {shown.map((rule) => {
        const state = ruleStates.get(rule.id);

        const currentValue = state?.latest_value ?? rule.latest_value;
        const runtimeReading = runtimeReadings.get(rule.variable_id);
        const evaluatedAt = state?.last_evaluated_at
          ? new Date(state.last_evaluated_at).getTime()
          : Number.NaN;
        const signalAt = runtimeReading?.recorded_at
          ? new Date(runtimeReading.recorded_at).getTime()
          : Number.NaN;
        const signalIsFresh =
          Number.isFinite(signalAt) &&
          clockNow - signalAt <=
            (Number(rule.stale_after_seconds) || 300) * 1000;
        const runtimeIsRunning =
          rule.rule_type === "runtime_duration" &&
          state?.status !== "unknown" &&
          runtimeReading?.value === true &&
          signalIsFresh;
        const displayedValue =
          runtimeIsRunning &&
          Number.isFinite(currentValue) &&
          Number.isFinite(evaluatedAt)
            ? currentValue + Math.max(0, clockNow - evaluatedAt) / 1000
            : currentValue;
        const numericCurrentValue =
          displayedValue === null || displayedValue === undefined
            ? Number.NaN
            : Number(displayedValue);
        const runtimeCurrentSeconds =
          rule.rule_type === "runtime_duration" &&
          !Number.isFinite(numericCurrentValue)
            ? 0
            : numericCurrentValue;
        const canShowNextThreshold =
          rule.rule_type === "boolean_count_threshold" &&
          lifecycleStatus(rule) === "in_progress" &&
          ["ok", "warning"].includes(rule.status) &&
          Number.isFinite(numericCurrentValue);
        const nextThreshold = canShowNextThreshold
          ? thresholdSequence(rule).find(
              (threshold) => threshold.value > numericCurrentValue,
            )
          : null;
        const formattedCurrentValue =
          rule.rule_type === "runtime_duration"
            ? formatDuration(displayedValue)
            : rule.rule_type === "boolean_count_threshold" &&
                Number.isFinite(numericCurrentValue)
              ? numericCurrentValue.toLocaleString()
              : formatValue(displayedValue);
        const formattedNextThreshold = nextThreshold
          ? rule.rule_type === "runtime_duration"
            ? formatDuration(nextThreshold.value)
            : nextThreshold.value.toLocaleString()
          : null;
        const scheduledActivationAt =
          rule.rule_type === "runtime_duration"
            ? Date.parse(rule.parameters?.activation_at)
            : Number.NaN;
        const scheduledStartCountdown =
          lifecycleStatus(rule) === "in_progress" &&
          Number.isFinite(scheduledActivationAt) &&
          scheduledActivationAt > clockNow
            ? scheduledActivationAt - clockNow
            : null;
        const runtimeThresholds = thresholdSequence(rule);
        const runtimeNextThreshold =
          rule.rule_type === "runtime_duration" &&
          Number.isFinite(runtimeCurrentSeconds)
            ? runtimeThresholds.find(
                (threshold) => threshold.value > runtimeCurrentSeconds,
              )
            : null;
        const runtimeAlertReached =
          rule.rule_type === "runtime_duration" &&
          Number.isFinite(runtimeCurrentSeconds) &&
          runtimeCurrentSeconds >=
            Number(rule.parameters?.alert_threshold_seconds);
        const runtimeAlert =
          rule.rule_type === "runtime_duration"
            ? alerts.find(
                (alert) =>
                  alert.rule_id === rule.id &&
                  alert.target_asset_id ===
                    (state?.target_asset_id ?? rule.target_asset_id) &&
                  alert.severity === "alert" &&
                  alert.status === "active",
              )
            : null;
        const runtimeAlertPending =
          runtimeAlertReached &&
          lifecycleStatus(rule) === "in_progress" &&
          state?.status === "alert" &&
          runtimeAlert &&
          !runtimeAlert.acknowledged_at;
        const runtimeAlertStartedAt = Date.parse(
          state?.last_transition_at || "",
        );
        const runtimeOvertimeSeconds = runtimeAlertPending
          ? Number.isFinite(runtimeAlertStartedAt)
            ? Math.max(0, (clockNow - runtimeAlertStartedAt) / 1000)
            : Math.max(
                0,
                runtimeCurrentSeconds -
                  Number(rule.parameters?.alert_threshold_seconds),
              )
          : 0;
        const parameters = rule.parameters || {};
        const isTimedBooleanRule =
          rule.rule_type === "duration" &&
          typeof parameters.expected_value === "boolean" &&
          Number.isFinite(Number(parameters.duration_seconds));
        const conditionStartedAt = state?.condition_started_at
          ? new Date(state.condition_started_at).getTime()
          : Number.NaN;
        const conditionMatches =
          isTimedBooleanRule && displayedValue === parameters.expected_value;
        const conditionElapsedSeconds =
          conditionMatches && Number.isFinite(conditionStartedAt)
            ? Math.max(0, (clockNow - conditionStartedAt) / 1000)
            : 0;

        return (
          <article
            key={rule.id}
            className={`rule-row rule-card ${rule.status || "unknown"}${ruleActionMenuId === rule.id ? " rule-card-menu-open" : ""}`}
          >
            <span className={"sev " + rule.status} />

            <div className="rule-name rule-card-main">
              <strong>{rule.name}</strong>
              {rule.description && (
                <small className="rule-description">{rule.description}</small>
              )}
              {ruleConditionSummary(rule) && (
                <small
                  className={`rule-description${rule.evaluation_error === "invalid_rule_or_reading" ? " error-message" : ""}`}
                >
                  {ruleConditionSummary(rule)}
                </small>
              )}
            </div>

            <div className="rule-evaluation">
              <StatusBadge status={rule.status} />
              <span className="rule-lifecycle-label">
                {lifecycleLabel(rule)}
              </span>
            </div>

            <div className="rule-card-metrics">
              <div className="rule-current-next-value">
                <span>
                  {list === "not_activated"
                    ? "Last evaluated"
                    : scheduledStartCountdown !== null
                      ? "Due in"
                      : isTimedBooleanRule
                        ? "Signal / Hold time"
                        : rule.rule_type === "boolean_count_threshold"
                          ? "Current / Target"
                          : rule.rule_type === "runtime_duration"
                            ? runtimeAlertPending
                              ? "Take action"
                              : "Current / Next"
                            : "Current / Next"}
                </span>
                <b>
                  {list === "not_activated" ? (
                    rule.last_evaluated_at ? (
                      formatTime(rule.last_evaluated_at)
                    ) : (
                      "Not evaluated yet"
                    )
                  ) : scheduledStartCountdown !== null ? (
                    formatTimeUntilStart(scheduledStartCountdown)
                  ) : isTimedBooleanRule ? (
                    `${formatValue(displayedValue)} · ${formatDuration(conditionElapsedSeconds)} / ${formatDuration(parameters.duration_seconds)}`
                  ) : rule.rule_type === "runtime_duration" ? (
                    runtimeAlertPending ? (
                      `Required time complete · ${formatDuration(runtimeOvertimeSeconds)} over`
                    ) : (
                      `${formatDuration(runtimeCurrentSeconds)} / ${runtimeNextThreshold ? `Next warning in ${formatDuration(runtimeNextThreshold.value - runtimeCurrentSeconds)}` : "—"}`
                    )
                  ) : (
                    <>
                      {displayedValue !== null && displayedValue !== undefined
                        ? formattedCurrentValue
                        : "—"}
                      {" / "}
                      {nextThreshold
                        ? rule.rule_type === "boolean_count_threshold"
                          ? formattedNextThreshold
                          : `${nextThreshold.label} at ${formattedNextThreshold}`
                        : "—"}
                    </>
                  )}
                </b>
              </div>
            </div>

            <div className="rule-card-actions">
              <div
                className="dropdown rule-actions-menu"
                data-menu-open={ruleActionMenuId === rule.id}
              >
                <button
                  type="button"
                  className="icon-outline sm"
                  title={`More actions for ${rule.name}`}
                  aria-label={`More actions for ${rule.name}`}
                  aria-haspopup="menu"
                  aria-expanded={ruleActionMenuId === rule.id}
                  onClick={() =>
                    setRuleActionMenuId((current) =>
                      current === rule.id ? null : rule.id,
                    )
                  }
                >
                  <DotsIcon size={17} />
                </button>
                {ruleActionMenuId === rule.id && (
                  <FloatingMenu align="right" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setRuleActionMenuId(null);
                        openRuleDetails(rule);
                      }}
                    >
                      View rule
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setRuleActionMenuId(null);
                        openEditRuleForm(rule);
                      }}
                      disabled={!canManageRules}
                      title={
                        !canManageRules
                          ? "You do not have permission to manage monitoring rules."
                          : undefined
                      }
                    >
                      Edit rule
                    </button>
                    {lifecycleStatus(rule) === "in_progress" && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setRuleActionMenuId(null);
                          setLifecycleAction({ rule, action: "suspend" });
                        }}
                        disabled={deletingRuleId !== null || !canManageRules}
                        title={
                          !canManageRules
                            ? "You do not have permission to manage monitoring rules."
                            : undefined
                        }
                      >
                        Suspend rule
                      </button>
                    )}
                    {lifecycleStatus(rule) === "suspended" && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setRuleActionMenuId(null);
                          setLifecycleAction({ rule, action: "resume" });
                        }}
                        disabled={deletingRuleId !== null || !canManageRules}
                        title={
                          !canManageRules
                            ? "You do not have permission to manage monitoring rules."
                            : undefined
                        }
                      >
                        Activate rule
                      </button>
                    )}
                    {lifecycleStatus(rule) === "deactivated" && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setRuleActionMenuId(null);
                          setLifecycleAction({ rule, action: "activate" });
                        }}
                        disabled={deletingRuleId !== null || !canManageRules}
                        title={
                          !canManageRules
                            ? "You do not have permission to manage monitoring rules."
                            : undefined
                        }
                      >
                        Activate rule
                      </button>
                    )}
                    {["in_progress", "suspended"].includes(
                      lifecycleStatus(rule),
                    ) && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setRuleActionMenuId(null);
                          setLifecycleAction({ rule, action: "deactivate" });
                        }}
                        disabled={deletingRuleId !== null || !canManageRules}
                        title={
                          !canManageRules
                            ? "You do not have permission to manage monitoring rules."
                            : undefined
                        }
                      >
                        Deactivate rule
                      </button>
                    )}
                    {lifecycleStatus(rule) !== "in_progress" &&
                      lifecycleStatus(rule) !== "completed" && (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setRuleActionMenuId(null);
                              remove(rule);
                            }}
                            disabled={
                              deletingRuleId !== null || !canManageRules
                            }
                            title={
                              !canManageRules
                                ? "You do not have permission to manage monitoring rules."
                                : undefined
                            }
                          >
                            Archive
                          </button>
                          <button
                            type="button"
                            className="btn-outline danger"
                            onClick={() => deleteEvent(event)}
                            disabled={
                              !isAdministrator || deletingEventId !== null
                            }
                            title="Delete event permanently"
                            aria-label="Delete event permanently"
                          >
                            <Trash2 size={16} />
                            Delete
                          </button>
                        </>
                      )}
                    {lifecycleStatus(rule) === "completed" && (
                      <button
                        type="button"
                        className="btn-outline danger"
                        onClick={() => deleteEvent(event)}
                        disabled={!isAdministrator || deletingEventId !== null}
                        title="Delete event permanently"
                        aria-label="Delete event permanently"
                      >
                        <Trash2 size={16} />
                        Delete
                      </button>
                    )}
                  </FloatingMenu>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
