
import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AssetIcon,
  ChevronDown,
  ChevronRight,
  FxIcon,
  AlertDiamond,
  WarnTriangle,
  RefreshIcon,
} from "./Icons.jsx";

export default function AssetTree({ assets = [], selectedId, onRefresh }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState({ edge: true });
  const [onlyRules, setOnlyRules] = useState(false);

  const tree = useMemo(() => {
    const childrenByParent = new Map();

    for (const asset of assets) {
      const parentId = asset.parent ?? asset.parent_asset_id ?? null;
      const key = parentId == null ? null : parentId;

      if (!childrenByParent.has(key)) {
        childrenByParent.set(key, []);
      }

      childrenByParent.get(key).push(asset);
    }

    const getChildren = (asset) =>
      childrenByParent.get(asset.id) ?? [];

    const query = q.trim().toLowerCase();

    function matchesTree(asset, ancestors = new Set()) {
      if (ancestors.has(asset.id)) return null;

      const nextAncestors = new Set(ancestors);
      nextAncestors.add(asset.id);

      const children = getChildren(asset);
      const matchingChildren = children
        .map((child) => matchesTree(child, nextAncestors))
        .filter(Boolean);

      const matchesName =
        !query || String(asset.name ?? "").toLowerCase().includes(query);

      const hasRules = asset.has_rules === true;
      const matchesRuleFilter = !onlyRules || hasRules;

      if (matchesName && matchesRuleFilter) {
        return { asset, children: matchingChildren };
      }

      // Preserve ancestors so matching descendants remain visible.
      if (matchingChildren.length) {
        return { asset, children: matchingChildren };
      }

      return null;
    }

    return (childrenByParent.get(null) ?? [])
      .map((asset) => matchesTree(asset))
      .filter(Boolean);
  }, [assets, q, onlyRules]);

  const toggle = (id) => {
    setOpen((previous) => ({
      ...previous,
      [id]: !previous[id],
    }));
  };

  const renderNode = (node, depth = 0) => {
    const { asset, children } = node;
    const expanded =
      Boolean(q.trim()) || Boolean(open[asset.id]) || depth === 0;

    const enabled =
      asset.is_active === true ||
      asset.status === "enabled";

    const statusText = enabled
      ? "Enabled"
      : asset.is_active === false || asset.status === "disabled"
        ? "Disabled"
        : "Status unknown";

    return (
      <div key={asset.id}>
        <div
          className={
            "tree-row" +
            (selectedId === asset.id ? " selected" : "")
          }
          style={{ paddingLeft: 12 + depth * 20 }}
          onClick={() => nav(`/assets/${asset.id}`)}
          title={`${asset.name} — ${statusText}`}
        >
          {children.length > 0 ? (
            <span
              className="tree-toggle"
              onClick={(event) => {
                event.stopPropagation();
                toggle(asset.id);
              }}
              role="button"
              tabIndex={0}
              aria-label={
                expanded
                  ? `Collapse ${asset.name}`
                  : `Expand ${asset.name}`
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  toggle(asset.id);
                }
              }}
            >
              {expanded
                ? <ChevronDown size={16} />
                : <ChevronRight size={16} />}
            </span>
          ) : (
            <span className="tree-toggle" />
          )}

          <span className="asset-ico">
            <AssetIcon size={24} />
            <i
              className={
                "dot " + (enabled ? "green" : "grey")
              }
              aria-label={statusText}
            />
          </span>

          <span>{asset.name || `Asset ${asset.id}`}</span>

          {onlyRules && asset.has_rules === true && (
            <span title="Has monitoring rules">
              <FxIcon size={14} />
            </span>
          )}
        </div>

        {expanded &&
          children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="tree">
      <div className="tree-tools">
        <input
          placeholder="Search assets"
          aria-label="Search assets"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />

        <div className="btn-group">
          <button
            type="button"
            title="Show assets with monitoring rules"
            aria-label="Show assets with monitoring rules"
            aria-pressed={onlyRules}
            className={onlyRules ? "on" : ""}
            onClick={() => setOnlyRules((value) => !value)}
          >
            <FxIcon size={18} />
          </button>

          <button
            type="button"
            title="Rules with alert status"
            aria-label="Rules with alert status"
            onClick={() => nav("/rules/alert")}
          >
            <AlertDiamond size={18} />
          </button>

          <button
            type="button"
            title="Rules with warning status"
            aria-label="Rules with warning status"
            onClick={() => nav("/rules/warning")}
          >
            <WarnTriangle size={18} />
          </button>

          <button
            type="button"
            title="Refresh assets"
            aria-label="Refresh assets"
            onClick={() => onRefresh?.().catch?.(() => {})}
          >
            <RefreshIcon size={18} />
          </button>
        </div>
      </div>

      <div className="tree-body">
        {tree.length > 0 ? (
          tree.map((node) => renderNode(node))
        ) : (
          <p className="tree-empty">
            {onlyRules
              ? "No matching assets with known monitoring rules."
              : "No matching assets found."}
          </p>
        )}
      </div>
    </aside>
  );
}
