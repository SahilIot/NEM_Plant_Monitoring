import React, { useEffect, useState } from "react";
import { api } from "../../../services/api.js";
import { Modal } from "../../../components/common/UI.jsx";
import "./AssetDeletionDialog.css";

const COUNT_LABELS = [
  ["child_assets", "Child assets"],
  ["variables", "Variables"],
  ["readings", "Readings"],
  ["rules", "Monitoring rules"],
  ["rule_parameters", "Rule parameters"],
  ["rule_states", "Rule states"],
  ["rule_counter_states", "Counter records"],
  ["runtime_records", "Runtime records"],
  ["alerts", "Alerts (active and historical)"],
  ["monitoring_events", "Events and monitoring history"],
  ["maintenance_schedules", "Maintenance schedules"],
  ["maintenance_records", "Maintenance records"],
  ["supervisor_assignments", "Supervisor assignments"],
];

// Shows exactly what a permanent asset delete would remove, then deletes only after explicit confirmation.
export default function AssetDeletionDialog({ asset, onClose, onDeleted, onDeactivate }) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get(`/assets/${asset.id}/deletion-summary`)
      .then((data) => !cancelled && setSummary(data))
      .catch((err) => !cancelled && setError(err.message || "Could not load the deletion summary."));
    return () => { cancelled = true; };
  }, [asset.id]);

  const needsName = Boolean(summary?.requires_confirmation);
  const canDelete = summary && summary.can_delete && (!needsName || typed === asset.name) && !busy;

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      const query = needsName ? `?confirm_name=${encodeURIComponent(typed)}` : "";
      await api.del(`/assets/${asset.id}${query}`);
      onDeleted();
    } catch (err) {
      setError(err.message || "Could not delete the asset. Nothing was deleted.");
      setBusy(false);
    }
  };

  return (
    <Modal title="Permanently delete asset" wide onClose={() => !busy && onClose()}>
      {!summary && !error && <p className="muted">Checking dependencies…</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {summary && (
        <div className="asset-delete-dialog">
          <p>
            <strong>{asset.name}</strong> will be permanently deleted. This cannot be undone.
            {summary.asset.is_active && " Deactivating it instead keeps every record and can be reversed."}
          </p>

          {summary.hierarchy.length > 1 && (
            <section>
              <h4>Affected hierarchy ({summary.hierarchy.length} assets)</h4>
              <ul className="asset-delete-tree">
                {summary.hierarchy.map((row) => (
                  <li key={row.id} style={{ paddingLeft: row.depth * 18 }}>
                    {row.name}
                    {!row.is_active && <span className="muted"> (inactive)</span>}
                  </li>
                ))}
              </ul>
              <p className="muted">Deleting a parent also deletes all of its descendants and their data.</p>
            </section>
          )}

          <section>
            <h4>Will be deleted</h4>
            <table className="table asset-delete-counts">
              <tbody>
                {COUNT_LABELS.filter(([key]) => summary.counts[key] > 0).map(([key, label]) => (
                  <tr key={key}>
                    <td>{label}{key === "variables" && summary.counts.inactive_variables > 0 ? ` (${summary.counts.inactive_variables} inactive)` : ""}{key === "alerts" && summary.counts.active_alerts > 0 ? ` (${summary.counts.active_alerts} active)` : ""}</td>
                    <td>{summary.counts[key].toLocaleString()}</td>
                  </tr>
                ))}
                {!summary.has_dependencies && (
                  <tr><td colSpan={2} className="muted">No dependent records.</td></tr>
                )}
              </tbody>
            </table>
          </section>

          {summary.retained.length > 0 && (
            <section>
              <h4>Retained</h4>
              <ul>
                {summary.retained.map((item) => (
                  <li key={item.kind}>{item.count} {item.kind.replace(/_/g, " ")} — {item.action}</li>
                ))}
              </ul>
            </section>
          )}

          {summary.blockers.length > 0 && (
            <section className="notice error" role="alert">
              <h4>Deletion is blocked</h4>
              <ul>{summary.blockers.map((text) => <li key={text}>{text}</li>)}</ul>
              <p>{summary.alternative}</p>
            </section>
          )}

          {summary.can_delete && needsName && (
            <label className="asset-delete-confirm">
              <span>Type <strong>{asset.name}</strong> to confirm</span>
              <input value={typed} onChange={(event) => setTyped(event.target.value)} disabled={busy} />
            </label>
          )}
        </div>
      )}

      <div className="modal-actions asset-delete-actions">
        <button type="button" className="btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        {summary?.asset.is_active && (
          <button type="button" className="btn-outline" onClick={onDeactivate} disabled={busy}>Deactivate instead</button>
        )}
        <button type="button" className="btn-danger" onClick={remove} disabled={!canDelete}>
          {busy ? "Deleting…" : "Delete permanently"}
        </button>
      </div>
    </Modal>
  );
}
