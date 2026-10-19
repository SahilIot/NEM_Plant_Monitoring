
import React, { useEffect, useState } from "react";
import {
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import { api } from "../../../services/api.js";
import "./RuleCreatePage.css";

const titles = {
  interval: "Create interval-based rule",
  usage: "Create usage-based rule",
  time: "Create time-based rule",
};

const initialValues = {
  name: "",
  description: "",
  variable_id: "",
  operator: ">=",
  threshold: "",
  usage_limit: "",
  current_time: "",
  end_time: "",
  severity: "warning",
};

export default function RuleCreatePage() {
  const { id, kind } = useParams();
  const navigate = useNavigate();

  const { assets = [], refreshStatus } =
    useOutletContext() || {};

  const assetId = Number(id);

  const asset = assets.find(
    (item) => Number(item.id) === assetId
  );

  const [variables, setVariables] = useState([]);
  const [values, setValues] = useState({ ...initialValues });
  const [loading, setLoading] = useState(kind === "interval");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (kind !== "interval") return;

    let cancelled = false;

    api
      .getAll(`/assets/${assetId}/variables?is_active=true`)
      .then((items) => {
        if (cancelled) return;

        const numericVariables = (
          Array.isArray(items) ? items : []
        ).filter((item) =>
          ["number", "integer"].includes(item.data_type)
        );

        setVariables(numericVariables);

        if (numericVariables.length > 0) {
          setValues((previous) => ({
            ...previous,
            variable_id: String(numericVariables[0].id),
          }));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err.message || "Could not load numeric variables."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [assetId, kind]);

  const goBack = () => navigate(`/assets/${id}`);

  const updateField = (event) => {
    const { name, value } = event.target;

    setValues((previous) => ({
      ...previous,
      [name]: value,
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");

    if (!values.name.trim()) {
      setError("Please enter a rule name.");
      return;
    }

    if (
      kind === "interval" &&
      (!values.variable_id ||
        values.threshold.trim() === "")
    ) {
      setError(
        "Select a numeric variable and enter a threshold."
      );
      return;
    }

    if (
      kind === "usage" &&
      values.usage_limit.trim() === ""
    ) {
      setError("Please enter a usage limit.");
      return;
    }

    if (
      kind === "time" &&
      (!values.current_time || !values.end_time)
    ) {
      setError("Select both current time and end time.");
      return;
    }

    if (
      kind === "time" &&
      values.current_time === values.end_time
    ) {
      setError(
        "Current time and end time cannot be the same."
      );
      return;
    }

    const common = {
      name: values.name.trim(),
      description: values.description.trim() || null,
      severity: values.severity,
    };

    try {
      setSaving(true);

      if (kind === "interval") {
        if (!variables.length) {
          throw new Error(
            "Add an active numeric variable before creating this rule."
          );
        }

        const threshold = Number(values.threshold);

        if (!Number.isFinite(threshold)) {
          throw new Error(
            "Enter a valid numeric threshold."
          );
        }

        await api.post(`/assets/${assetId}/rules`, {
          ...common,
          target_asset_id: assetId,
          variable_id: Number(values.variable_id),
          rule_type: "parameter_threshold",
          operator: values.operator,
          threshold,
        });
      } else if (kind === "usage") {
        const limit = Number(values.usage_limit);

        if (!Number.isFinite(limit) || limit <= 0) {
          throw new Error(
            "Enter a valid positive usage limit."
          );
        }

        await api.post(
          `/assets/${assetId}/rules/usage`,
          {
            ...common,
            usage_limit: limit,
          }
        );
      } else if (kind === "time") {
        await api.post(
          `/assets/${assetId}/rules/time`,
          {
            ...common,
            current_time: values.current_time,
            end_time: values.end_time,
          }
        );
      } else {
        throw new Error("Unknown rule type.");
      }

      await refreshStatus?.();

      navigate(`/assets/${id}`, { replace: true });
    } catch (err) {
      setError(
        err.message || "Could not create the rule."
      );
    } finally {
      setSaving(false);
    }
  };

  if (!titles[kind]) {
    return (
      <section className="panel">
        <p>Unknown rule type.</p>

        <button
          type="button"
          className="btn-outline rule-back-btn"
          onClick={goBack}
        >
          Back to asset
        </button>
      </section>
    );
  }

  if (loading) {
    return (
      <div className="loading">
        Loading numeric variables…
      </div>
    );
  }

  return (
    <div className="rule-create-page">
      <div className="rule-create-container">

        {/* Back link */}
        <button
          type="button"
          className="btn-outline rule-back-btn"
          onClick={goBack}
        >
          ← Back to {asset?.name || "asset"}
        </button>

        {/* Page heading */}
        <div
          className="page-head rule-page-head"
          style={{ marginTop: 20 }}
        >
          <h1 className="page-title rule-page-title">
            {titles[kind]}
          </h1>

          {/* Asset name */}
          <p className="muted rule-page-subtitle">
            Asset: {asset?.name || `#${assetId}`}
          </p>
        </div>

        {/* Rule create card */}
        <section className="rule-create-card">
          <div className="rule-create-card-header">
            <h2>{titles[kind]}</h2>

            <p>
              Configure the rule details below.
            </p>
          </div>

          <div className="rule-create-form">
            {error && (
              <p
                role="alert"
                className="error-message"
              >
                {error}
              </p>
            )}

            <form onSubmit={handleSubmit}>
              {/* Rule name */}
              <div className="form-group">
                <label htmlFor="rule-name">
                  Rule name *
                </label>

                <input
                  id="rule-name"
                  name="name"
                  value={values.name}
                  onChange={updateField}
                  placeholder="e.g. Motor temperature limit"
                  required
                />
              </div>

              {/* Description */}
              <div className="form-group">
                <label htmlFor="rule-description">
                  Description
                </label>

                <textarea
                  id="rule-description"
                  name="description"
                  value={values.description}
                  onChange={updateField}
                  rows={3}
                />
              </div>

              {/* Interval-based fields */}
              {kind === "interval" && (
                <>
                  <div className="form-group">
                    <label htmlFor="variable-id">
                      Numeric variable *
                    </label>

                    <select
                      id="variable-id"
                      name="variable_id"
                      value={values.variable_id}
                      onChange={updateField}
                      required
                    >
                      <option value="">
                        Select a variable
                      </option>

                      {variables.map((variable) => (
                        <option
                          key={variable.id}
                          value={String(variable.id)}
                        >
                          {variable.name}
                          {variable.unit
                            ? ` (${variable.unit})`
                            : ""}
                        </option>
                      ))}
                    </select>

                    {!variables.length && (
                      <small>
                        No active numeric variables are available.
                      </small>
                    )}
                  </div>

                  <div className="form-group">
                    <label htmlFor="operator">
                      Trigger condition
                    </label>

                    <select
                      id="operator"
                      name="operator"
                      value={values.operator}
                      onChange={updateField}
                    >
                      <option value=">=">
                        Greater than or equal to
                      </option>

                      <option value=">">
                        Greater than
                      </option>

                      <option value="<=">
                        Less than or equal to
                      </option>

                      <option value="<">
                        Less than
                      </option>

                      <option value="==">
                        Equal to
                      </option>

                      <option value="!=">
                        Not equal to
                      </option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor="threshold">
                      Threshold *
                    </label>

                    <input
                      id="threshold"
                      name="threshold"
                      type="number"
                      step="any"
                      value={values.threshold}
                      onChange={updateField}
                      required
                    />
                  </div>
                </>
              )}

              {/* Usage-based fields */}
              {kind === "usage" && (
                <div className="form-group">
                  <label htmlFor="usage-limit">
                    Usage limit *
                  </label>

                  <input
                    id="usage-limit"
                    name="usage_limit"
                    type="number"
                    min="0.01"
                    step="any"
                    value={values.usage_limit}
                    onChange={updateField}
                    required
                  />
                </div>
              )}

              {/* Time-based fields */}
              {kind === "time" && (
                <>
                  <div className="form-group">
                    <label htmlFor="current-time">
                      Current time *
                    </label>

                    <input
                      id="current-time"
                      name="current_time"
                      type="time"
                      value={values.current_time}
                      onChange={updateField}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="end-time">
                      End time *
                    </label>

                    <input
                      id="end-time"
                      name="end_time"
                      type="time"
                      value={values.end_time}
                      onChange={updateField}
                      required
                    />
                  </div>
                </>
              )}

              {/* Severity */}
              <div className="form-group">
                <label htmlFor="severity">
                  Severity
                </label>

                <select
                  id="severity"
                  name="severity"
                  value={values.severity}
                  onChange={updateField}
                >
                  <option value="warning">
                    Warning
                  </option>

                  <option value="alert">
                    Alert
                  </option>
                </select>
              </div>

              {/* Form buttons */}
              <div className="form-actions rule-form-actions">
                <button
                  type="button"
                  className="btn-outline"
                  onClick={goBack}
                  disabled={saving}
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={
                    saving ||
                    (kind === "interval" &&
                      !variables.length)
                  }
                >
                  {saving ? "Creating…" : "Create rule"}
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
