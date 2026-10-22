import React, { useEffect, useState } from "react";
import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import { buildAssetMonitoringRule } from "../../assets/rules/monitoringRuleFlow.js";
import "./RuleCreatePage.css";

const TITLES = {
  interval: "Create interval-based rule",
  usage: "Create usage-based rule",
  time: "Create time-based rule",
};

const INITIAL_VALUES = {
  name: "",
  description: "",
  cycle_variable_id: "",
  runtime_variable_id: "",
  severity: "warning",
  warning_threshold_1: "",
  warning_threshold_2: "",
  alert_threshold: "",
  runtime_warning_hours: "",
  runtime_warning_2_hours: "",
  runtime_alert_hours: "",
  activation_at: "",
};

export default function RuleCreatePage() {
  const { id, kind } = useParams();
  const navigate = useNavigate();
  const { assets = [], refreshStatus } = useOutletContext() || {};
  const assetId = Number(id);
  const asset = assets.find((item) => Number(item.id) === assetId);
  const isUsage = kind === "usage";
  const isScheduled = kind === "time";

  const [variables, setVariables] = useState([]);
  const [cycleVariableIds, setCycleVariableIds] = useState([]);
  const [runtimeVariableIds, setRuntimeVariableIds] = useState([]);
  const [values, setValues] = useState({ ...INITIAL_VALUES });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      api.getAll(`/assets/${assetId}/variables?is_active=true`),
      api.get("/plc/status"),
    ])
      .then(([items, plc]) => {
        if (!active) return;
        const activeVariables = Array.isArray(items) ? items : [];
        const mappings = Array.isArray(plc?.mappings) ? plc.mappings : [];
        const booleanMappings = mappings.filter(
          (mapping) =>
            Number(mapping.asset_id) === assetId &&
            mapping.mapping_valid === true &&
            mapping.data_type === "boolean"
        );
        const cycleIds = booleanMappings
          .filter((mapping) => mapping.role === "cycle_signal")
          .map((mapping) => Number(mapping.variable_id));
        const runtimeIds = booleanMappings
          .filter((mapping) => mapping.role === "running_signal")
          .map((mapping) => Number(mapping.variable_id));

        setVariables(activeVariables);
        setCycleVariableIds([...new Set(cycleIds)]);
        setRuntimeVariableIds([...new Set(runtimeIds)]);
      })
      .catch((requestError) => {
        if (active) {
          setError(
            requestError.message ||
              "Could not load this asset's Boolean OPC UA variables."
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [assetId]);

  const goBack = () =>
    navigate(`/assets/${id}`, { state: { activeTab: "status" } });

  const updateField = (event) => {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
    setError("");
  };

  const runtimeVariableOptions = variables.filter(
    (variable) =>
      variable.data_type === "boolean" &&
      runtimeVariableIds.includes(Number(variable.id))
  );
  const cycleVariableOptions = variables.filter(
    (variable) =>
      variable.data_type === "boolean" &&
      cycleVariableIds.includes(Number(variable.id))
  );

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setError("");
    if (!values.name.trim()) {
      setError("Please enter a rule name.");
      return;
    }
    if (isScheduled && !values.activation_at) {
      setError("Choose when the time-based rule should activate.");
      return;
    }

    setSaving(true);
    try {
      const rule = buildAssetMonitoringRule(
        {
          ...values,
          rule_type: isUsage
            ? "boolean_count_threshold"
            : "runtime_duration",
          ...(isScheduled ? {} : { activation_at: "" }),
        },
        assetId,
        { variables, cycleVariableIds, runtimeVariableIds }
      );
      await api.post(`/assets/${assetId}/rules`, rule);
      try {
        await refreshStatus?.();
      } catch (refreshError) {
        console.error("Rule saved, but dashboard status refresh failed.", refreshError);
      }
      navigate(`/assets/${id}`, {
        replace: true,
        state: {
          createdNotice: isUsage
            ? "Usage-based cycle rule created and activated."
            : isScheduled
              ? "Time-based runtime rule created. Monitoring starts at its scheduled activation time and continues until deactivated."
              : "Interval-based running-time rule created and activated.",
          activeTab: "status",
        },
      });
    } catch (requestError) {
      setError(requestError.message || "Could not create the monitoring rule.");
    } finally {
      setSaving(false);
    }
  };

  if (!TITLES[kind]) {
    return (
      <section className="panel">
        <p>Unknown rule type.</p>
        <button type="button" className="btn-outline rule-back-btn" onClick={goBack}>
          Back to asset
        </button>
      </section>
    );
  }

  if (loading) {
    return <div className="loading" role="status">Loading asset variables…</div>;
  }

  const disableSubmit =
    saving ||
    (isUsage && cycleVariableOptions.length === 0) ||
    (!isUsage && runtimeVariableOptions.length === 0);

  return (
    <div className="rule-create-page">
      <div className="rule-create-container">
        <button type="button" className="btn-outline rule-back-btn" onClick={goBack}>
          ← Back to {asset?.name || `Asset ${assetId}`}
        </button>

        <div className="page-head rule-page-head" style={{ marginTop: 20 }}>
          <h1 className="page-title rule-page-title">{TITLES[kind]}</h1>
          <p className="muted rule-page-subtitle">
            Asset: {asset?.name || `#${assetId}`}
          </p>
        </div>

        <section className="rule-create-card">
          <div className="rule-create-card-header">
            <h2>{TITLES[kind]}</h2>
            <p>
              {isUsage
                ? "Each complete OFF-to-ON cycle increments the counter and is checked against the warning and alert thresholds."
                : isScheduled
                  ? "At the scheduled time, runtime tracking begins, counts only while the selected Boolean signal is ON, and continues until the rule is deactivated."
                  : "Running time accumulates while the selected Boolean signal is ON and is checked against the thresholds."}
            </p>
          </div>

          <div className="rule-create-form">
            {error && <p role="alert" className="error-message">{error}</p>}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label htmlFor="rule-name">Rule name *</label>
                <input
                  id="rule-name"
                  name="name"
                  value={values.name}
                  onChange={updateField}
                  placeholder={isUsage ? "e.g. Rotation count limit" : "e.g. Machine running time"}
                  required
                  disabled={saving}
                />
              </div>

              <div className="form-group">
                <label htmlFor="rule-description">Description</label>
                <textarea
                  id="rule-description"
                  name="description"
                  value={values.description}
                  onChange={updateField}
                  rows={3}
                  disabled={saving}
                />
              </div>

              {isUsage ? (
                <>
                  <div className="form-group">
                    <label htmlFor="cycle-variable">Boolean cycle signal *</label>
                    <select
                      id="cycle-variable"
                      name="cycle_variable_id"
                      value={values.cycle_variable_id}
                      onChange={updateField}
                      required
                      disabled={saving || !cycleVariableOptions.length}
                    >
                      <option value="">Select the cycle on/off variable</option>
                      {cycleVariableOptions.map((variable) => (
                        <option key={variable.id} value={String(variable.id)}>
                          {variable.name}
                        </option>
                      ))}
                    </select>
                    {!cycleVariableOptions.length && (
                      <small>
                        No cycle signal is configured. In the asset's Variables panel, edit the Boolean variable and set its purpose to Cycle signal.
                      </small>
                    )}
                  </div>
                  <div className="form-group">
                    <label htmlFor="warning-1">First warning at cycle count *</label>
                    <input
                      id="warning-1"
                      name="warning_threshold_1"
                      type="number"
                      min="1"
                      step="1"
                      value={values.warning_threshold_1}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="warning-2">Higher warning at cycle count *</label>
                    <input
                      id="warning-2"
                      name="warning_threshold_2"
                      type="number"
                      min="1"
                      step="1"
                      value={values.warning_threshold_2}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="cycle-alert">Alert at cycle count *</label>
                    <input
                      id="cycle-alert"
                      name="alert_threshold"
                      type="number"
                      min="1"
                      step="1"
                      value={values.alert_threshold}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="form-group">
                    <label htmlFor="runtime-variable">
                      Boolean running signal * (ON means machine is running)
                    </label>
                    <select
                      id="runtime-variable"
                      name="runtime_variable_id"
                      value={values.runtime_variable_id}
                      onChange={updateField}
                      required
                      disabled={saving || !runtimeVariableOptions.length}
                    >
                      <option value="">Select the always-on running variable</option>
                      {runtimeVariableOptions.map((variable) => (
                        <option key={variable.id} value={String(variable.id)}>
                          {variable.name}
                        </option>
                      ))}
                    </select>
                    {!runtimeVariableOptions.length && (
                      <small>
                        No running signal is configured. In the asset's Variables panel, edit the Boolean variable and set its purpose to Machine running state.
                      </small>
                    )}
                  </div>
                  {isScheduled && (
                    <div className="form-group">
                      <label htmlFor="activation-at">Activate monitoring at *</label>
                      <input
                        id="activation-at"
                        name="activation_at"
                        type="datetime-local"
                        value={values.activation_at}
                        onChange={updateField}
                        required
                        disabled={saving}
                      />
                    </div>
                  )}
                  <div className="form-group">
                    <label htmlFor="runtime-warning">Warning after running (hours) *</label>
                    <input
                      id="runtime-warning"
                      name="runtime_warning_hours"
                      type="number"
                      min="0.000001"
                      step="any"
                      value={values.runtime_warning_hours}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="runtime-warning-2">Higher warning after running (hours) *</label>
                    <input
                      id="runtime-warning-2"
                      name="runtime_warning_2_hours"
                      type="number"
                      min="0.000001"
                      step="any"
                      value={values.runtime_warning_2_hours}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="runtime-alert">Alert after running (hours) *</label>
                    <input
                      id="runtime-alert"
                      name="runtime_alert_hours"
                      type="number"
                      min="0.000001"
                      step="any"
                      value={values.runtime_alert_hours}
                      onChange={updateField}
                      required
                      disabled={saving}
                    />
                  </div>
                </>
              )}

              <div className="form-actions rule-form-actions">
                <button type="button" className="btn-outline" onClick={goBack} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={disableSubmit}>
                  {saving ? "Saving…" : isScheduled ? "Create scheduled rule" : isUsage ? "Create usage rule" : "Create interval rule"}
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
