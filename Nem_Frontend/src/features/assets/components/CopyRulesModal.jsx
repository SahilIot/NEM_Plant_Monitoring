

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Search,
  X,
} from "lucide-react";
import { api } from "../../../services/api.js";
import { LoadingIndicator } from "../../../components/common/UI.jsx";
import "./CopyRulesModal.css";
import { ruleCategoryLabel } from "../../rules/ruleCategories.js";

// Display category only; the rule's stored type is not touched.
const RULE_TYPE_LABELS = {
  parameter_threshold: "Parameter Threshold",
  runtime_duration: "Interval Based · Running time",
  duration: "Interval Based",
  boolean_count_threshold: "Interval Based · Cycle count",
  generic: "Generic",
};

const formatSeconds = (value) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return String(value);
  if (seconds >= 3600) return `${+(seconds / 3600).toFixed(2)} h`;
  if (seconds >= 60) return `${+(seconds / 60).toFixed(1)} min`;
  return `${seconds} s`;
};

// One-line, display-only summary of a rule's thresholds. It never feeds the copy request.
function ruleCondition(rule) {
  const parameters = rule.parameters || {};

  if (rule.rule_type === "multi_parameter") {
    const items = Array.isArray(rule.parameter_items) ? rule.parameter_items : [];
    return `${items.length} parameter${items.length === 1 ? "" : "s"}${items.length ? `: ${items.map((item) => item.name).join(", ")}` : ""}`;
  }

  if (rule.rule_type === "runtime_duration") {
    const warnings = parameters.warning_thresholds_seconds;
    const alert = parameters.alert_threshold_seconds;
    if (Array.isArray(warnings) && warnings.length === 2 && alert != null) {
      return `Warnings at ${formatSeconds(warnings[0])} / ${formatSeconds(warnings[1])}, alert at ${formatSeconds(alert)}`;
    }
    if (parameters.duration_seconds != null) {
      return `Runs for ${formatSeconds(parameters.duration_seconds)}`;
    }
  }

  if (rule.rule_type === "boolean_count_threshold") {
    const warnings = parameters.warning_thresholds;
    if (Array.isArray(warnings) && warnings.length === 2 && parameters.alert_threshold != null) {
      return `Warnings at ${warnings[0]} / ${warnings[1]} cycles, alert at ${parameters.alert_threshold}`;
    }
  }

  if (rule.rule_type === "duration" && parameters.duration_seconds != null) {
    return `Condition held for ${formatSeconds(parameters.duration_seconds)}`;
  }

  if (rule.rule_type === "parameter_threshold") {
    if (typeof parameters.expected_value === "boolean") {
      const negated = rule.operator === "!=" || rule.operator === "ne";
      return `Signal ${negated ? "is not" : "is"} ${parameters.expected_value ? "ON" : "OFF"}`;
    }
    if (rule.threshold != null) {
      const unit = rule.variable_unit ? ` ${rule.variable_unit}` : "";
      return `Value ${rule.operator || ""} ${rule.threshold}${unit}`.replace(/\s+/g, " ");
    }
  }

  return "";
}

export default function CopyRulesModal({
  assetId,
  assets = [],
  cycleVariableIds = [],
  runtimeVariableIds = [],
  onClose,
  onCopied,
}) {
  const [sourceId, setSourceId] = useState("");
  const [sourceRules, setSourceRules] = useState([]);
  const [sourceVariables, setSourceVariables] = useState([]);
  const [destinationVariables, setDestinationVariables] = useState([]);
  const [selected, setSelected] = useState([]);
  const [includeDisabled, setIncludeDisabled] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState(null);
  const loadToken = useRef(0);
  const submitting = useRef(false);

  const otherAssets = useMemo(
    () =>
      assets.filter(
        (asset) => Number(asset.id) !== Number(assetId)
      ),
    [assets, assetId]
  );

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    let alive = true;

    api
      .getAll(`/assets/${assetId}/variables?is_active=true`)
      .then((items) => {
        if (alive) {
          setDestinationVariables(
            Array.isArray(items) ? items : []
          );
        }
      })
      .catch((err) => {
        if (alive) {
          setError(
            err.message ||
              "Destination variables could not be loaded."
          );
        }
      });

    return () => {
      alive = false;
    };
  }, [assetId]);

  const loadSource = async (value) => {
    // A newer selection supersedes any request still in flight for an older one.
    const token = ++loadToken.current;
    setSourceId(value);
    setSourceRules([]);
    setSourceVariables([]);
    setSelected([]);
    setResults(null);
    setReviewing(false);
    setError("");
    setSourceError("");

    if (!value) return;

    setLoading(true);

    try {
      const [rules, variables] = await Promise.all([
        api.get(`/assets/${value}/rules`),
        api.getAll(
          `/assets/${value}/variables?is_active=true`
        ),
      ]);

      if (token !== loadToken.current) return;
      setSourceRules(Array.isArray(rules) ? rules : []);
      setSourceVariables(
        Array.isArray(variables) ? variables : []
      );
    } catch (err) {
      if (token !== loadToken.current) return;
      setSourceError(
        err.message ||
          "Source asset rules could not be loaded."
      );
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  };

  const getMapping = (rule) => {
    if (rule.variable_id == null) {
      return { variable: null, reason: "" };
    }

    const sourceVariable = sourceVariables.find(
      (variable) =>
        Number(variable.id) === Number(rule.variable_id)
    );

    if (!sourceVariable) {
      return {
        variable: null,
        reason: "Source variable is missing or inactive.",
      };
    }

    const matches = destinationVariables.filter(
      (variable) =>
        variable.key?.trim().toLowerCase() ===
          sourceVariable.key?.trim().toLowerCase() &&
        variable.data_type === sourceVariable.data_type
    );

    if (matches.length !== 1) {
      return {
        variable: null,
        reason: matches.length
          ? "Multiple destination variables match this key."
          : `No active destination variable matches "${sourceVariable.key}" and its data type.`,
      };
    }

    const variable = matches[0];

    const booleanParameterThreshold =
      rule.rule_type === "parameter_threshold" &&
      typeof rule.parameters?.expected_value === "boolean";
    if (
      rule.rule_type === "parameter_threshold" &&
      (booleanParameterThreshold
        ? variable.data_type !== "boolean"
        : !["number", "integer"].includes(variable.data_type))
    ) {
      return {
        variable: null,
        reason: booleanParameterThreshold
          ? "This rule requires a Boolean destination variable."
          : "This rule requires a numeric destination variable.",
      };
    }

    if (rule.rule_type === "runtime_duration") {
      if (
        variable.data_type !== "boolean" ||
        !runtimeVariableIds.some((id) => Number(id) === Number(variable.id))
      ) {
        return {
          variable: null,
          reason:
            "This rule requires the destination asset's configured running signal.",
        };
      }
    }

    if (rule.rule_type === "boolean_count_threshold") {
      if (variable.data_type !== "boolean") {
        return {
          variable: null,
          reason:
            "This rule requires a Boolean variable.",
        };
      }

      if (
        !cycleVariableIds.some(
          (id) => Number(id) === Number(variable.id)
        )
      ) {
        return {
          variable: null,
          reason:
            "This destination variable is not configured as the active cycle signal.",
        };
      }
    }

    return { variable, reason: "" };
  };

  // Each parameter keeps its own variable: it must match exactly one variable (same key and
  // data type) on the destination asset, otherwise the whole rule is not copied.
  const getMultiParameterStatus = (rule) => {
    for (const parameter of rule.parameter_items || []) {
      if (parameter.variable_id == null) continue;
      const source = sourceVariables.find((variable) => Number(variable.id) === Number(parameter.variable_id));
      if (!source) {
        return { variable: null, reason: `The source variable of "${parameter.name}" is missing or inactive.` };
      }
      const matches = destinationVariables.filter(
        (variable) =>
          variable.key?.trim().toLowerCase() === source.key?.trim().toLowerCase() &&
          variable.data_type === source.data_type
      );
      if (matches.length !== 1) {
        return {
          variable: null,
          reason: matches.length
            ? `Multiple destination variables match "${parameter.name}".`
            : `No active destination variable matches "${source.key}" for "${parameter.name}".`,
        };
      }
    }
    return { variable: null, reason: "" };
  };

  const getRuleStatus = (rule) => {
    if (rule.rule_type === "multi_parameter") return getMultiParameterStatus(rule);
    const supported = [
      "parameter_threshold",
      "runtime_duration",
      "duration",
      "generic",
      "boolean_count_threshold",
    ];

    if (!supported.includes(rule.rule_type)) {
      return {
        variable: null,
        reason: `Unsupported rule type: ${
          rule.rule_type || "unknown"
        }.`,
      };
    }
    if (rule.rule_type === "generic") {
      return {
        variable: null,
        reason: "This rule type has no monitoring evaluator.",
      };
    }

    const mapping = getMapping(rule);

    if (mapping.reason) return mapping;

    if (
      [
        "parameter_threshold",
        "boolean_count_threshold",
        "generic",
      ].includes(rule.rule_type) &&
      !mapping.variable
    ) {
      return {
        variable: null,
        reason:
          "This rule needs a mapped destination variable.",
      };
    }

    if (rule.rule_type === "duration") {
      const parameters = rule.parameters || {};

      if (
        !Number.isFinite(
          Number(parameters.duration_seconds)
        ) ||
        Number(parameters.duration_seconds) <= 0
      ) {
        return {
          variable: null,
          reason:
            "Duration settings are missing or invalid.",
        };
      }

      if (!mapping.variable) {
        return {
          variable: null,
          reason:
            "This duration rule needs a mapped destination variable.",
        };
      }
    }

    if (rule.rule_type === "runtime_duration") {
      const parameters = rule.parameters || {};
      const warnings = parameters.warning_thresholds_seconds;
      const alert = Number(parameters.alert_threshold_seconds);
      const hasThresholds =
        Array.isArray(warnings) &&
        warnings.length === 2 &&
        warnings.every((value) => Number.isFinite(Number(value)) && Number(value) > 0) &&
        Number(warnings[0]) < Number(warnings[1]) &&
        Number.isFinite(alert) &&
        alert > Number(warnings[1]);
      const durationSeconds = Number(parameters.duration_seconds);
      const hasLegacyDuration =
        Number.isFinite(durationSeconds) && durationSeconds > 0;

      if (!hasThresholds && !hasLegacyDuration) {
        return {
          variable: null,
          reason:
            "Running-time thresholds are missing or invalid.",
        };
      }
    }

    if (rule.rule_type === "parameter_threshold") {
      const booleanThreshold =
        typeof rule.parameters?.expected_value === "boolean";
      if (
        !rule.operator ||
        (booleanThreshold
          ? !["==", "!=", "eq", "ne"].includes(rule.operator)
          : rule.threshold == null ||
            !Number.isFinite(Number(rule.threshold)))
      ) {
        return {
          variable: null,
          reason:
            "Threshold settings are missing or invalid.",
        };
      }
    }

    if (rule.rule_type === "boolean_count_threshold") {
      const parameters = rule.parameters || {};
      const thresholds = parameters.warning_thresholds;
      const alert = Number(parameters.alert_threshold);

      if (
        !Array.isArray(thresholds) ||
        thresholds.length !== 2 ||
        !thresholds.every(
          (value) =>
            Number.isSafeInteger(Number(value)) &&
            Number(value) > 0
        ) ||
        Number(thresholds[0]) >= Number(thresholds[1]) ||
        !Number.isSafeInteger(alert) ||
        alert <= Number(thresholds[1])
      ) {
        return {
          variable: null,
          reason: "Boolean count thresholds are invalid.",
        };
      }
    }

    return mapping;
  };

  const eligibleRules = useMemo(
    () =>
      sourceRules.map((rule) => ({
        ...rule,
        copyCheck: getRuleStatus(rule),
      })),
    [
      sourceRules,
      sourceVariables,
      destinationVariables,
      cycleVariableIds,
    ]
  );

  const copyableRules = eligibleRules.filter(
    (rule) => !rule.copyCheck.reason
  );

  // Rules that can be ticked right now: compatible, and not hidden by the "include deactivated" switch.
  const selectableRules = copyableRules.filter(
    (rule) => includeDisabled || rule.is_enabled
  );
  const allSelected =
    selectableRules.length > 0 &&
    selectableRules.every((rule) => selected.includes(rule.id));

  const assetPaths = useMemo(() => {
    const byId = new Map(assets.map((asset) => [Number(asset.id), asset]));
    const pathOf = (asset) => {
      const names = [];
      const seen = new Set([Number(asset.id)]);
      let parentId = asset.parent_asset_id;
      while (parentId != null && !seen.has(Number(parentId))) {
        seen.add(Number(parentId));
        const parent = byId.get(Number(parentId));
        if (!parent) break;
        names.unshift(parent.name);
        parentId = parent.parent_asset_id;
      }
      return names.join(" › ");
    };
    return new Map(assets.map((asset) => [Number(asset.id), pathOf(asset)]));
  }, [assets]);

  const destination = assets.find(
    (asset) => Number(asset.id) === Number(assetId)
  );
  const source = otherAssets.find(
    (asset) => String(asset.id) === String(sourceId)
  );

  const assetGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const groups = new Map();

    otherAssets.forEach((asset) => {
      const path = assetPaths.get(Number(asset.id)) || "";
      const haystack = `${asset.name} ${asset.asset_type || ""} ${path}`.toLowerCase();
      if (query && !haystack.includes(query)) return;
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path).push(asset);
    });

    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, items]) => ({
        path,
        items: items.sort((a, b) => String(a.name).localeCompare(String(b.name))),
      }));
  }, [otherAssets, assetPaths, search]);

  const matchedAssetCount = assetGroups.reduce(
    (total, group) => total + group.items.length,
    0
  );

  const toggleRule = (id) => {
    setReviewing(false);
    setResults(null);
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  };

  const selectAllRules = () => {
    setReviewing(false);
    setResults(null);
    setSelected(selectableRules.map((rule) => rule.id));
  };

  const clearSelection = () => {
    setReviewing(false);
    setSelected([]);
  };

  const copyRules = async () => {
    // The ref blocks a second click in the same tick, before `saving` re-renders.
    if (!selected.length || saving || submitting.current) return;

    submitting.current = true;
    setSaving(true);
    setError("");

    try {
      const result = await api.post(`/assets/${assetId}/rules/copy`, {
        source_asset_id: Number(sourceId),
        rule_ids: selected.map(Number),
        include_disabled: includeDisabled,
      });
      setResults({
        copied: result.created || [],
        alreadyCopied: result.already_copied || [],
        excludedDisabled: result.excluded_disabled || 0,
      });
      setSelected([]);
      setReviewing(false);
      if (result.created?.length) await onCopied?.(result);
    } catch (err) {
      setError(err.message || "Could not copy the selected rules.");
      setReviewing(false);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  const destinationName = destination?.name || `Asset ${assetId}`;

  return (
    <div
      className="copy-rules-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        className="copy-rules-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-rules-title"
      >
        <header className="cr-header">
          <div className="cr-heading">
            <h2 id="copy-rules-title">Copy Rules from Another Asset</h2>
            <p>Select another asset and choose which rules you want to copy.</p>
            <span className="cr-destination">
              <ArrowRight size={14} aria-hidden="true" />
              Copying to
              <strong title={destinationName}>{destinationName}</strong>
            </span>
          </div>

          <button
            type="button"
            className="cr-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="cr-body">
          <section className="cr-panel cr-assets" aria-label="Source asset">
            <div className="cr-panel-head">
              <h3>1. Source asset</h3>
              <span className="cr-count">{otherAssets.length}</span>
            </div>

            <div className="cr-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search assets"
                aria-label="Search assets"
                disabled={saving || !otherAssets.length}
                autoFocus
              />
            </div>

            <div className="cr-scroll" role="listbox" aria-label="Available assets">
              {!otherAssets.length && (
                <p className="cr-empty">No other assets are available.</p>
              )}

              {otherAssets.length > 0 && !matchedAssetCount && (
                <p className="cr-empty">No assets match “{search.trim()}”.</p>
              )}

              {assetGroups.map((group) => (
                <div className="cr-group" key={group.path || "__top"}>
                  {assetGroups.length > 1 && (
                    <div className="cr-group-title" title={group.path}>
                      {group.path || "Top level"}
                    </div>
                  )}

                  {group.items.map((asset) => {
                    const active = String(asset.id) === String(sourceId);
                    return (
                      <button
                        type="button"
                        key={asset.id}
                        role="option"
                        aria-selected={active}
                        className={`cr-asset${active ? " is-active" : ""}`}
                        disabled={saving}
                        onClick={() => !active && loadSource(String(asset.id))}
                      >
                        <span className="cr-asset-main">
                          <strong>{asset.name}</strong>
                          <small>
                            {[asset.asset_type, `ID ${asset.id}`]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                        </span>
                        {asset.status === "disabled" && (
                          <span className="cr-chip">Disabled</span>
                        )}
                        {active && <Check size={16} aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>

          <section className="cr-panel cr-rules" aria-label="Rules to copy">
            <div className="cr-panel-head">
              <h3>2. Rules{source ? ` in ${source.name}` : ""}</h3>
              {sourceId && !loading && !sourceError && (
                <span className="cr-count">
                  {copyableRules.length} of {sourceRules.length} copyable
                </span>
              )}
            </div>

            {!sourceId && (
              <p className="cr-empty cr-placeholder">
                Choose a source asset to see its rules.
              </p>
            )}

            {sourceId && loading && (
              <LoadingIndicator compact message="Loading rules and variables" />
            )}

            {sourceId && !loading && sourceError && (
              <div className="cr-notice is-error" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{sourceError}</span>
                <button
                  type="button"
                  className="cr-link"
                  onClick={() => loadSource(String(sourceId))}
                >
                  Retry
                </button>
              </div>
            )}

            {sourceId && !loading && !sourceError && (
              <>
                {!sourceRules.length ? (
                  <p className="cr-empty">This asset has no rules to copy.</p>
                ) : (
                  <>
                    <div className="cr-toolbar">
                      <span className="cr-selected-count" aria-live="polite">
                        {selected.length} selected
                      </span>
                      <button
                        type="button"
                        className="cr-link"
                        onClick={selectAllRules}
                        disabled={saving || !selectableRules.length || allSelected}
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        className="cr-link"
                        onClick={clearSelection}
                        disabled={saving || !selected.length}
                      >
                        Deselect all
                      </button>
                      <label className="cr-toggle">
                        <input
                          type="checkbox"
                          checked={includeDisabled}
                          disabled={saving}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setIncludeDisabled(checked);
                            if (!checked) {
                              setSelected((current) =>
                                current.filter(
                                  (id) =>
                                    sourceRules.find((rule) => rule.id === id)
                                      ?.is_enabled
                                )
                              );
                            }
                            setReviewing(false);
                          }}
                        />
                        Include deactivated rules
                      </label>
                    </div>

                    <div className="cr-scroll cr-rule-list">
                      {eligibleRules.map((rule) => {
                        const reason = rule.copyCheck.reason;
                        const deactivated = !rule.is_enabled;
                        const excluded = deactivated && !includeDisabled;
                        const unavailable = Boolean(reason) || excluded;
                        const checked = selected.includes(rule.id);
                        const condition = ruleCondition(rule);
                        const signal = rule.variable_name;
                        const mapped = rule.copyCheck.variable?.name;

                        return (
                          <label
                            className={`cr-rule${checked ? " is-selected" : ""}${
                              unavailable ? " is-unavailable" : ""
                            }`}
                            key={rule.id}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={saving || unavailable}
                              onChange={() => toggleRule(rule.id)}
                            />

                            <span className="cr-rule-main">
                              <span className="cr-rule-title">
                                <strong>{rule.name}</strong>
                                <span
                                  className={`cr-chip ${
                                    deactivated ? "" : "is-ok"
                                  }`}
                                >
                                  {deactivated ? "Deactivated" : "Activated"}
                                </span>
                                {rule.severity && (
                                  <span
                                    className={`cr-chip is-${
                                      ["alert", "warning"].includes(rule.severity)
                                        ? rule.severity
                                        : "plain"
                                    }`}
                                  >
                                    {rule.severity}
                                  </span>
                                )}
                              </span>

                              <small>
                                {(rule.rule_type === "multi_parameter" && ruleCategoryLabel(rule)) ||
                                  RULE_TYPE_LABELS[rule.rule_type] ||
                                  rule.rule_type ||
                                  "Unknown type"}
                                {signal ? ` · Signal: ${signal}` : ""}
                                {mapped && mapped !== signal
                                  ? ` → ${mapped} on this asset`
                                  : ""}
                              </small>

                              {condition && <small>{condition}</small>}

                              {reason && (
                                <small className="cr-reason">{reason}</small>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        </div>

        {(error || results) && (
          <div className="cr-feedback">
            {error && (
              <div className="cr-notice is-error" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            {results && (
              <div className="cr-notice is-ok" role="status">
                <CheckCircle2 size={16} aria-hidden="true" />
                <span>
                  <strong>{results.copied.length} rule(s) copied.</strong>
                  {results.copied.length > 0 &&
                    ` Created deactivated: ${results.copied
                      .map((rule) => rule.name)
                      .join(", ")}.`}
                  {results.alreadyCopied.length > 0 &&
                    ` ${results.alreadyCopied.length} matching rule(s) were already on this asset.`}
                  {results.excludedDisabled > 0 &&
                    ` ${results.excludedDisabled} deactivated rule(s) were excluded.`}
                </span>
              </div>
            )}
          </div>
        )}

        <footer className="cr-footer">
          {reviewing ? (
            <p className="cr-confirm" role="status">
              Copy {selected.length} selected rule(s) to {destinationName}? Source
              rules stay unchanged; copied rules are created deactivated.
            </p>
          ) : (
            <p className="cr-summary">
              {selected.length
                ? `${selected.length} rule(s) selected`
                : "No rules selected"}
            </p>
          )}

          <div className="cr-actions">
            <button
              type="button"
              className="btn-outline"
              onClick={() => (reviewing ? setReviewing(false) : onClose())}
              disabled={saving}
            >
              {reviewing ? "Back" : results ? "Close" : "Cancel"}
            </button>

            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                if (reviewing) copyRules();
                else setReviewing(true);
              }}
              disabled={saving || !selected.length || loading}
            >
              {saving
                ? "Copying…"
                : reviewing
                  ? `Confirm copy (${selected.length})`
                  : "Copy Selected Rules"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
