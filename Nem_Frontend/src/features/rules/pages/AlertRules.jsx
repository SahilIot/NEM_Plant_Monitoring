import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import { EmptyState, StatusBadge } from "../../../components/common/UI.jsx";
import { BackIcon } from "../../../components/common/Icons.jsx";

export default function AlertRules() {
  const { kind } = useParams();
  const nav = useNavigate();
  const [rules, setRules] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setRules(null);
    setError("");
    api
      .get(`/rules/status/${kind}`)
      .then((items) => alive && setRules(Array.isArray(items) ? items : []))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [kind]);

  return (
    <div>
      <button className="link-btn" onClick={() => nav(-1)}>
        <BackIcon size={14} /> Back
      </button>
      <h1 className="page-title">Rules in {kind} status</h1>
      <div className="panel">
        {error ? (
          <div className="notice error" role="alert">{error}</div>
        ) : !rules ? (
          <div className="loading" role="status">Loading…</div>
        ) : rules.length === 0 ? (
          <EmptyState title={`No rules are in ${kind} status`} lines={["Only enabled rules that have been evaluated appear here."]} />
        ) : (
          <table className="table">
            <thead>
              <tr><th>Rule</th><th>Asset</th><th>Configured severity</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr
                  key={r.id}
                  className={r.asset_id ? "clickable" : ""}
                  onClick={() => r.asset_id && nav(`/assets/${r.asset_id}`)}
                >
                  <td>{r.name}</td>
                  <td>{r.asset_name || <span className="muted">-</span>}</td>
                  <td className="cap">{r.severity}</td>
                  <td><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
