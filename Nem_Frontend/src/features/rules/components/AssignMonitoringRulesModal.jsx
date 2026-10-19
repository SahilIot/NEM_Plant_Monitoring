
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../../services/api.js";
import "./AssignMonitoringRulesModal.css";

const RULE_NAMES = [
  "Quality Control - Defective Bottles",
  "Tank-Health State",
  "Conveyor Belt Lubrication-Bottles Produced",
];

export default function AssignMonitoringRulesModal({
  assetId,
  onClose,
  onAssigned,
}) {
  const [rules, setRules] = useState([]);
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");
  const [sortSeverity, setSortSeverity] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("collection");

  useEffect(() => {
    let active = true;

    api.getAll("/rules", 200)
      .then((data) => {
        if (!active) return;

        const list = Array.isArray(data) ? data : [];
        const unassigned = list.filter(
          (rule) =>
            rule.target_asset_id == null &&
            rule.asset_id == null
        );

        
        setRules(
          unassigned.length
            ? unassigned
            : RULE_NAMES.map((name, index) => ({
                id: `sample-${index + 1}`,
                name,
                rule_type:
                  index === 0
                    ? "Parameter limits"
                    : "Intervals",
                severity: "warning",
                isSample: true,
              }))
        );
      })
      .catch((err) => {
        if (active) {
          setError(err.message || "Could not load monitoring rules.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const filteredRules = useMemo(() => {
    const query = search.trim().toLowerCase();

    let result = rules.filter((rule) => {
      const text = [
        rule.name,
        rule.description,
        rule.rule_type,
        rule.severity,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return text.includes(query);
    });

    if (sortSeverity !== "all") {
      result = result.filter(
        (rule) =>
          (rule.severity || "warning").toLowerCase() === sortSeverity
      );
    }

    return [...result].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "")
    );
  }, [rules, search, sortSeverity]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredRules.length / pageSize)
  );

  const currentPage = Math.min(page, totalPages);

  const visibleRules = filteredRules.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  function toggleRule(id) {
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id]
    );
  }

  function toggleVisible() {
    const ids = visibleRules
      .filter((rule) => !rule.isSample)
      .map((rule) => rule.id);

    const allSelected =
      ids.length > 0 && ids.every((id) => selected.includes(id));

    setSelected((previous) =>
      allSelected
        ? previous.filter((id) => !ids.includes(id))
        : [...new Set([...previous, ...ids])]
    );
  }


async function handleAssign() {
  if (!selected.length) {
    setError("Please select at least one monitoring rule.");
    return;
  }

  const selectedRules = rules.filter((rule) =>
    selected.includes(rule.id)
  );

  if (selectedRules.some((rule) => rule.isSample)) {
    setError("Sample preview rules cannot be assigned. Load real rules from the backend.");
    return;
  }

  setSaving(true);
  setError("");

  try {
    for (const ruleId of selected) {
      await api.patch(`/rules/${ruleId}`, {
        target_asset_id: Number(assetId),
        is_enabled: false,
      });
    }

    await onAssigned?.();
    onClose();
  } catch (err) {
    setError(err.message || "Could not assign monitoring rules.");
  } finally {
    setSaving(false);
  }
}


  return (
    <div
      className="arm-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        className="arm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="arm-title"
      >
        <header className="arm-header">
          <div>
            <h2 id="arm-title">Assign Monitoring Rules</h2>
            <p>Select rules from the Monitoring Rule collection.</p>
          </div>

          <button
            type="button"
            className="arm-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="arm-tabs">
            <button
            type="button"
            className={`arm-tab ${activeTab === "collection" ? "active" : ""}`}
            onClick={() => setActiveTab("collection")}
            >
                Monitoring Rule collection
                </button>
                <button
                type="button"
                className={`arm-tab ${activeTab === "settings" ? "active" : ""}`}
                onClick={() => setActiveTab("settings")}
                >
                    Asset settings
                    </button>
                    <button
                    type="button"
                    className={`arm-tab ${activeTab === "variables" ? "active" : ""}`}
                    onClick={() => setActiveTab("variables")}
                    >
                        Variables
                        </button>
                        </div>

        <div className="arm-toolbar">
          <input
            type="search"
            value={search}
            placeholder="Filter monitoring rules..."
            aria-label="Filter monitoring rules"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />

          <label>
            Sort:
            <select
              value={sortSeverity}
              onChange={(event) => {
                setSortSeverity(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">Severity</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </label>
        </div>

        <div className="arm-count">
          <strong>Monitoring Rules</strong>
          <span>{selected.length} selected</span>
        </div>

        {error && (
          <div className="arm-error" role="alert">
            {error}
          </div>
        )}

        <div className="arm-table-wrap">
          <table className="arm-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select visible rules"
                    checked={
                      visibleRules.length > 0 &&
                      visibleRules
                        .filter((rule) => !rule.isSample)
                        .every((rule) => selected.includes(rule.id))
                    }
                    onChange={toggleVisible}
                  />
                </th>
                <th>Monitoring rule</th>
                <th>Type</th>
                <th>Status</th>
                <th>Severity</th>
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="5" className="arm-empty">
                    Loading monitoring rules...
                  </td>
                </tr>
              ) : visibleRules.length === 0 ? (
                <tr>
                  <td colSpan="5" className="arm-empty">
                    No monitoring rules found.
                  </td>
                </tr>
              ) : (
                visibleRules.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(rule.id)}
                        disabled={rule.isSample}
                        onChange={() => toggleRule(rule.id)}
                        aria-label={`Select ${rule.name}`}
                      />
                    </td>
                    <td>
                      <strong>{rule.name || "Unnamed rule"}</strong>
                      <small className="arm-description">
                        {rule.description || "Monitoring rule"}
                      </small>
                    </td>
                    <td>
                      {rule.rule_type
                        ? rule.rule_type.replaceAll("_", " ")
                        : "Intervals"}
                    </td>
                    <td>
                      <span className="arm-status">Not activated</span>
                    </td>
                    <td>
                      <span className="arm-severity">
                        {rule.severity || "Warning"}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="arm-pagination">
          <span>
            {filteredRules.length === 0
              ? "0 items"
              : `${(currentPage - 1) * pageSize + 1}–${Math.min(
                  currentPage * pageSize,
                  filteredRules.length
                )} of ${filteredRules.length}`}
          </span>

          <label>
            Items per page
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={20}>20</option>
            </select>
          </label>

          <button
            type="button"
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            disabled={currentPage <= 1}
          >
            ‹
          </button>

          <span>
            {currentPage} / {totalPages}
          </span>

          <button
            type="button"
            onClick={() =>
              setPage((value) => Math.min(totalPages, value + 1))
            }
            disabled={currentPage >= totalPages}
          >
            ›
          </button>
        </div>

        <footer className="arm-footer">
          <p>Assigned rules remain inactive until activated separately.</p>

          <div>
            <button
              type="button"
              className="arm-cancel"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>

            <button
              type="button"
              className="arm-assign"
              onClick={handleAssign}
              disabled={saving || loading || selected.length === 0}
            >
              {saving ? "Assigning..." : "Assign"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
