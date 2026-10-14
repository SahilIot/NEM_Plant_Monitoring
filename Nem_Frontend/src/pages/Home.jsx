
import React, { useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { api } from "../api.js";
import { EmptyState } from "../components/UI.jsx";
import {
  FxIcon,
  AssetIcon,
  ExternalIcon,
} from "../components/Icons.jsx";

export default function Home() {
  const nav = useNavigate();
  const { assets = [] } = useOutletContext();

  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadSummary() {
      setError("");

      try {
        const result = await api.get("/dashboard/summary");

        if (!result || typeof result !== "object") {
          throw new Error("The dashboard returned an invalid response.");
        }

        if (!cancelled) {
          setSummary(result);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to load dashboard.");
        }
      }
    }

    loadSummary();

    return () => {
      cancelled = true;
    };
  }, [retry]);

  if (error) {
    return (
      <div className="panel-gray" role="alert">
        <h3>Could not load dashboard</h3>
        <p>{error}</p>
        <button type="button" onClick={() => setRetry((n) => n + 1)}>
          Retry
        </button>
      </div>
    );
  }

  if (!summary) {
    return <div className="loading" role="status">Loading dashboard…</div>;
  }

  const numberOrZero = (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

  const rulesAlert = numberOrZero(summary.rules_alert);
  const rulesWarning = numberOrZero(summary.rules_warning);
  const assetsAlert = numberOrZero(summary.assets_alert);
  const assetsWarning = numberOrZero(summary.assets_warning);
  const monitoredAssets = numberOrZero(summary.monitored_assets);
  const totalAssets = numberOrZero(summary.total_assets);
  const stats = summary.stats ?? {};

  const hasIssues = rulesAlert > 0 ||
    rulesWarning > 0 ||
    assetsAlert > 0 ||
    assetsWarning > 0;

  const firstChild = assets.find(
    (asset) => asset.parent_asset_id != null || asset.parent != null
  ) || assets[0];

  function Stat({ title, sub, icon: Icon, value, to, link = false }) {
    return (
      <button
        type="button"
        className="stat-card clickable"
        onClick={() => nav(to)}
      >
        <div className="stat-title">
          {title} {link && <ExternalIcon size={14} />}
        </div>
        <div className="stat-sub">{sub}</div>
        <div className="stat-val">
          <Icon size={26} />
          {value}
        </div>
      </button>
    );
  }

  const ruleStats = [
    ["Activated", "activated"],
    ["Suspended", "suspended"],
    ["Finished", "finished"],
    ["Not activated", "not_activated"],
  ];

  return (
    <div className="home">
      <div className="grid4">
        <Stat
          title="Assigned rules"
          sub="With alert status"
          icon={FxIcon}
          value={rulesAlert}
          to="/rules/alert"
          link
        />

        <Stat
          title="Assigned rules"
          sub="With warning status"
          icon={FxIcon}
          value={rulesWarning}
          to="/rules/warning"
          link
        />

        <Stat
          title="Assets"
          sub="With alert status"
          icon={AssetIcon}
          value={assetsAlert}
          to="/rules/alert"
        />

        <Stat
          title="Assets"
          sub="With warning status"
          icon={AssetIcon}
          value={assetsWarning}
          to="/rules/warning"
        />
      </div>

      <div className="grid2">
        <button
          type="button"
          className="stat-card wide clickable"
          onClick={() => {
            if (firstChild) nav(`/assets/${firstChild.id}`);
            else nav("/assets");
          }}
        >
          <div className="stat-title">Monitored assets</div>
          <div className="stat-sub">
            Assets with active monitoring rules
          </div>
          <div className="stat-val">
            <AssetIcon size={26} />
            {monitoredAssets} / {totalAssets}
          </div>
        </button>

        <div className="stat-card wide">
          <div className="stat-title">Assigned rules statistics</div>

          <div className="stats-row">
            {ruleStats.map(([label, key]) => (
              <button
                type="button"
                key={key}
                className="stat-col clickable"
                onClick={() => nav("/configuration/rules")}
              >
                <span>{label}</span>
                <b>{numberOrZero(stats[key])}</b>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel-gray">
        {hasIssues ? (
          <EmptyState
            title="Monitoring issues detected"
          />
        ) : (
          <EmptyState
            title="There are no assets in Alert or Warning status."
          />
        )}
      </div>
    </div>
  );
}
