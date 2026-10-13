import React from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AssetIcon, ChevronDown, ChevronRight, FxIcon, AlertDiamond, WarnTriangle, RefreshIcon } from "./Icons.jsx";

export default function AssetTree({ assets, selectedId, onRefresh }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState({ edge: true });
  const [onlyRules, setOnlyRules] = useState(false);

  const match = (a) => a.name.toLowerCase().includes(q.toLowerCase());
  const roots = assets.filter((a) => !a.parent);
  const kids = (id) => assets.filter((a) => a.parent === id);

  const row = (a, depth) => {
    const children = kids(a.id);
    const visible = match(a) || children.some(match);
    if (!visible) return null;
    return (
      <div key={a.id}>
        <div
          className={"tree-row" + (selectedId === a.id ? " selected" : "")}
          style={{ paddingLeft: 12 + depth * 28 }}
          onClick={() => { nav(`/assets/${a.id}`); if (children.length) setOpen({ ...open, [a.id]: true }); }}
        >
          {children.length ? (
            <span className="tree-toggle" onClick={(e) => { e.stopPropagation(); setOpen({ ...open, [a.id]: !open[a.id] }); }}>
              {open[a.id] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </span>
          ) : <span className="tree-toggle" />}
          <span className="asset-ico">
            <AssetIcon size={24} />
            <i className={"dot " + (a.status === "online" ? "green" : "grey")} />
          </span>
          <span>{a.name}</span>
        </div>
        {open[a.id] && children.map((c) => row(c, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="tree">
      <div className="tree-tools">
        <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="btn-group">
          <button title="Assets with rules" className={onlyRules ? "on" : ""} onClick={() => setOnlyRules(!onlyRules)}><FxIcon size={18} /></button>
          <button title="Rules with alert status" onClick={() => nav("/rules/alert")}><AlertDiamond size={18} /></button>
          <button title="Rules with warning status" onClick={() => nav("/rules/warning")}><WarnTriangle size={18} /></button>
          <button title="Refresh" onClick={onRefresh}><RefreshIcon size={18} /></button>
        </div>
      </div>
      <div className="tree-body">{roots.map((r) => row(r, 0))}</div>
    </aside>
  );
}