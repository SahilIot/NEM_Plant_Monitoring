

import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../../services/api.js";
import "./CopyRulesModal.css";

export default function CopyRulesModal({
  assetId,
  assets = [],
  cycleVariableIds = [],
  onClose,
  onCopied,
}) {
  const [sourceId, setSourceId] = useState("");
  const [sourceRules, setSourceRules] = useState([]);
  const [sourceVariables, setSourceVariables] = useState([]);
  const [destinationVariables, setDestinationVariables] = useState([]);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState(null);

  const otherAssets = useMemo(
    () =>
      assets.filter(
        (asset) => Number(asset.id) !== Number(assetId)
      ),
    [assets, assetId]
  );

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
    setSourceId(value);
    setSourceRules([]);
    setSourceVariables([]);
    setSelected([]);
    setResults(null);
    setError("");

    if (!value) return;

    setLoading(true);

    try {
      const [rules, variables] = await Promise.all([
        api.get(`/assets/${value}/rules`),
        api.getAll(
          `/assets/${value}/variables?is_active=true`
        ),
      ]);

      setSourceRules(Array.isArray(rules) ? rules : []);
      setSourceVariables(
        Array.isArray(variables) ? variables : []
      );
    } catch (err) {
      setError(
        err.message ||
          "Source asset rules could not be loaded."
      );
    } finally {
      setLoading(false);
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

    if (
      rule.rule_type === "parameter_threshold" &&
      !["number", "integer"].includes(variable.data_type)
    ) {
      return {
        variable: null,
        reason:
          "This rule requires a numeric destination variable.",
      };
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

  const getRuleStatus = (rule) => {
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
      const seconds = Number(
        rule.parameters?.duration_seconds
      );

      if (!Number.isFinite(seconds) || seconds <= 0) {
        return {
          variable: null,
          reason:
            "Runtime duration settings are missing or invalid.",
        };
      }
    }

    if (rule.rule_type === "parameter_threshold") {
      if (
        !rule.operator ||
        rule.threshold == null ||
        !Number.isFinite(Number(rule.threshold))
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

  const toggleRule = (id) => {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  };

  const copyRules = async () => {
    if (!selected.length) return;

    setSaving(true);
    setError("");

    const copied = [];
    const failed = [];

    try {
      for (const id of selected) {
        const rule = eligibleRules.find(
          (item) => Number(item.id) === Number(id)
        );

        if (!rule || rule.copyCheck.reason) {
          failed.push({
            name: rule?.name || `Rule ${id}`,
            reason:
              rule?.copyCheck.reason ||
              "Rule is unavailable.",
          });
          continue;
        }

        const payload = {
          name: rule.name,
          description: rule.description || null,
          target_asset_id: Number(assetId),
          severity: rule.severity,
          is_enabled: false,
          rule_type: rule.rule_type,
          parameters: rule.parameters ?? null,
          evaluation_interval_seconds:
            rule.evaluation_interval_seconds ?? null,
          stale_after_seconds:
            rule.stale_after_seconds ?? null,
        };

        if (rule.variable_id != null) {
          payload.variable_id = Number(
            rule.copyCheck.variable.id
          );
        }

        if (rule.rule_type === "parameter_threshold") {
          payload.operator = rule.operator;
          payload.threshold = Number(rule.threshold);
        }

        try {
          await api.post(
            `/assets/${assetId}/rules`,
            payload
          );

          copied.push(rule.name);
        } catch (err) {
          failed.push({
            name: rule.name,
            reason:
              err.message ||
              "The backend rejected this rule.",
          });
        }
      }

      setResults({ copied, failed });
      setSelected([]);

      if (copied.length) {
        await onCopied?.();
      }
    } catch (err) {
      setError(
        err.message || "Could not copy the selected rules."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
  className="copy-rules-overlay"
  onMouseDown={(event) => {
    if (event.target === event.currentTarget && !saving) onClose();
  }}
>
      <section
        className="modal copy-rules-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-rules-title"
      >
        <header className="modal-header">
          <h2 id="copy-rules-title">
            Copy rules from another asset
          </h2>

          <button
            type="button"
            className="copy-rules-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="modal-body">
          <p>
            Select a source asset and choose which rules to
            copy. New rules will be created disabled on this
            asset; the source rules will not be changed.
          </p>

          <label
            className="field-label"
            htmlFor="copy-rules-source"
          >
            Source asset
          </label>

          <select
            id="copy-rules-source"
            className="form-input"
            value={sourceId}
            onChange={(event) =>
              loadSource(event.target.value)
            }
            disabled={saving}
          >
            <option value="">Select an asset</option>

            {otherAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>

          {loading && (
  <p className="copy-rules-loading">
    Loading rules and variables...
  </p>
)}

          {sourceId && !loading && (
            <>
              <div className="copy-rules-summary">
                {copyableRules.length} copyable of{" "}
                {sourceRules.length} rules
                {" · "}
                {selected.length} selected
              </div>

              {!sourceRules.length && (
                <p>This asset has no rules to copy.</p>
              )}

              <div className="copy-rules-list">
                {eligibleRules.map((rule) => {
                  const reason = rule.copyCheck.reason;

                  return (
                    <label
                      className="copy-rule-row"
                      key={rule.id}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(rule.id)}
                        disabled={saving || Boolean(reason)}
                        onChange={() => toggleRule(rule.id)}
                      />

                      <span className="copy-rule-content">
                        <strong>{rule.name}</strong>

                        <small>
                          {rule.rule_type} · {rule.severity}
                          {rule.copyCheck.variable
                            ? ` · Variable: ${rule.copyCheck.variable.name}`
                            : ""}
                        </small>

                        {reason && (
                          <small className="form-error">
                            {reason}
                          </small>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          {results && (
            <div
              className="copy-rules-results"
              role="status"
            >
              <strong>
                {results.copied.length} rule(s) copied.
              </strong>

              {results.copied.length > 0 && (
                <p>
                  Created disabled:{" "}
                  {results.copied.join(", ")}
                </p>
              )}

              {results.failed.length > 0 && (
                <>
                  <p>
                    {results.failed.length} rule(s) could
                    not be copied:
                  </p>

                  <ul>
                    {results.failed.map((item, index) => (
                      <li key={`${item.name}-${index}`}>
                        {item.name}: {item.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>

        <footer className="modal-actions">
          <button
            type="button"
            className="btn-outline"
            onClick={onClose}
            disabled={saving}
          >
            Close
          </button>

          <button
            type="button"
            className="btn-primary"
            onClick={copyRules}
            disabled={saving || !selected.length}
          >
            {saving
              ? "Copying…"
              : `Copy selected (${selected.length})`}
          </button>
        </footer>
      </section>
    </div>
  );
}
