import React from "react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { EmptyState } from "../components/UI.jsx";
import { BackIcon } from "../components/Icons.jsx";

export default function AlertRules() {
  const { kind } = useParams();
  const nav = useNavigate();
  const [rules, setRules] = useState(null);
  useEffect(() => { setRules(null); api.get(`/rules/status/${kind}`).then(setRules).catch(() => setRules([])); }, [kind]);

  return (
    <div>
      <button className="link-btn" onClick={() => nav(-1)}><BackIcon size={14} /> Back</button>
      <h1>Rules with {kind} status</h1>
      <div className="panel-gray">
        {!rules ? <div className="loading">Loading…</div> :
          rules.length === 0 ? <EmptyState title={`There are no rules in ${kind} state`} /> :
          <table className="table">
            <thead><tr><th>Rule</th><th>Asset</th><th>Status</th></tr></thead>
            <tbody>{rules.map((r) => (
              <tr key={r.id} onClick={() => nav(`/assets/${r.asset_id}`)} className="clickable">
                <td>{r.name}</td><td>{r.asset_name}</td><td><span className={"badge " + r.status}>{r.status}</span></td>
              </tr>))}</tbody>
          </table>}
      </div>
    </div>
  );
}