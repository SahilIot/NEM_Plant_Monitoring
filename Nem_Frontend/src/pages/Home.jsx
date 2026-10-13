import React from "react";
import { useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { api } from "../api.js";
import { EmptyState } from "../components/UI.jsx";
import { FxIcon, AssetIcon, ExternalIcon } from "../components/Icons.jsx";

export default function Home() {
  const nav = useNavigate();
  const { assets } = useOutletContext();
  const [s, setS] = useState(null);
  useEffect(() => { api.get("/summary").then(setS).catch((error) => setS({ error: error.message })); }, []);
  if (s?.error) return <div className="panel-gray">Backend error: {s.error}</div>;
  if (!s) return <div className="loading">Loading…</div>;

  const Stat = ({ title, sub, icon: Icon, value, to, link }) => (
    <div className="stat-card clickable" onClick={() => nav(to)}>
      <div className="stat-title">{title} {link && <ExternalIcon size={14} />}</div>
      <div className="stat-sub">{sub}</div>
      <div className="stat-val"><Icon size={26} />{value}</div>
    </div>
  );

  const firstChild = assets.find((a) => a.parent) || assets[0];

  return (
    <div className="home">
      <div className="grid4">
        <Stat title="Assigned rules" sub="with alert status" icon={FxIcon} value={s.rules_alert} to="/rules/alert" link />
        <Stat title="Assigned rules" sub="with warning status" icon={FxIcon} value={s.rules_warning} to="/rules/warning" link />
        <Stat title="Assets" sub="with alert status" icon={AssetIcon} value={s.assets_alert} to="/rules/alert" />
        <Stat title="Assets" sub="with warning status" icon={AssetIcon} value={s.assets_warning} to="/rules/warning" />
      </div>
      <div className="grid2">
        <div className="stat-card wide clickable" onClick={() => firstChild && nav(`/assets/${firstChild.id}`)}>
          <div className="stat-title">Monitored assets</div>
          <div className="stat-sub">Assets with active monitoring rules</div>
          <div className="stat-val"><AssetIcon size={26} />{s.monitored_assets} / {s.total_assets}</div>
        </div>
        <div className="stat-card wide">
          <div className="stat-title">Assigned rules statistics</div>
          <div className="stats-row">
            {[["Activated", "activated"], ["Suspended", "suspended"], ["Finished", "finished"], ["Not activated", "not_activated"]].map(([l, k]) => (
              <div key={k} className="stat-col clickable" onClick={() => nav("/configuration/rules")}>
                <span>{l}</span><b>{s.stats[k]}</b>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="panel-gray">
        <EmptyState title="There are no assets in Alert or Warning status." />
      </div>
    </div>
  );
}