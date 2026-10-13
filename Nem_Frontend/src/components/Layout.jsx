import React from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, matchPath } from "react-router-dom";
import { api } from "../api.js";
import { APP_TITLE } from "../config.js";
import Brand from "./Brand.jsx";
import AssetTree from "./AssetTree.jsx";
import { HomeIcon, TreeIcon, ShapesIcon, GearIcon, DoubleChevron, PanelIcon, PlugIcon, InfoIcon, SunIcon, MoonIcon } from "./Icons.jsx";

const TITLES = {
  rules: "Monitoring Rules",
  collections: "Monitoring Rule collections",
  documents: "Instructions and documents",
  import: "Import configuration",
  user: "User information",
  email: "Email server settings",
  analytics: "Analytics extensions",
  usage: "Usage information",
  backup: "Backup and restore",
  plc: "PLC / OPC UA",
};

function crumbs(path, assets) {
  if (path === "/") return [{ label: "Home" }];
  let m;
  if ((m = matchPath("/rules/:kind", path)))
    return [{ label: "Home", to: "/" }, { label: `Rules with ${m.params.kind} status` }];
  if ((m = matchPath("/assets/:id", path))) {
    const a = assets.find((x) => x.id === Number(m.params.id));
    return [{ label: a ? a.name : m.params.id, to: path }, { label: "Current status" }];
  }
  if (path === "/assets") return [{ label: "Assets" }];
  if (path === "/plc") return [{ label: "PLC / OPC UA" }];
  if ((m = matchPath("/configuration/:sub", path)))
    return [{ label: "Configuration", to: "/configuration" }, { label: TITLES[m.params.sub] || m.params.sub }];
  if ((m = matchPath("/settings/:sub", path)))
    return [{ label: "Settings", to: "/settings" }, { label: TITLES[m.params.sub] || m.params.sub }];
  if (path.startsWith("/configuration")) return [{ label: "Configuration" }];
  if (path.startsWith("/settings")) return [{ label: "Settings" }];
  return [{ label: "Home" }];
}

export default function Layout() {
  const { pathname } = useLocation();
  const [assets, setAssets] = useState([]);
  const [assetError, setAssetError] = useState("");
  const [railOpen, setRailOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(true);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("nem-theme") || (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("nem-theme", theme);
  }, [theme]);

  const load = useCallback(() => api.get("/assets?limit=200").then((items) => {
    setAssetError("");
    setAssets(items.map((asset) => ({
      ...asset,
      parent: asset.parent_asset_id,
      status: asset.is_active ? "online" : "offline",
    })));
  }).catch((error) => {
    setAssetError(error.message);
    throw error;
  }), []);
  useEffect(() => { load().catch(() => {}); }, [load]);

  const showTree = pathname === "/" || pathname.startsWith("/rules") || pathname.startsWith("/assets");
  const sel = Number(matchPath("/assets/:id", pathname)?.params.id);
  const cs = crumbs(pathname, assets);

  const link = (to, Icon, label, end) => (
    <NavLink to={to} end={end} className={({ isActive }) => "rail-item" + (isActive ? " active" : "")} title={label}>
      <Icon size={22} />
      {railOpen && <span>{label}</span>}
    </NavLink>
  );

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <div className="app-title">{APP_TITLE}</div>
        <div className="top-icons">
          <button className="icon-btn" title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <SunIcon size={20} /> : <MoonIcon size={20} />}
          </button>
          <PlugIcon size={20} /><InfoIcon size={20} />
        </div>
      </header>
      <div className="body">
        <nav className={"rail" + (railOpen ? " open" : "")}>
          <div className="rail-main">
            {link("/", HomeIcon, "Home", true)}
            {link("/assets", TreeIcon, "Assets")}
            {link("/configuration", ShapesIcon, "Configuration")}
            {link("/plc", PlugIcon, "PLC / OPC UA")}
            {link("/settings", GearIcon, "Settings")}
          </div>
          <button className="rail-item" onClick={() => setRailOpen(!railOpen)} title="Expand"><DoubleChevron size={20} /></button>
        </nav>
        <div className="main-col">
          <div className="crumbs">
            <div>
              {cs.map((c, i) => (
                <span key={i}>
                  {i > 0 && <span className="sep">/</span>}
                  {c.to ? <Link to={c.to}>{c.label}</Link> : <span className="cur">{c.label}</span>}
                </span>
              ))}
            </div>
            {showTree && <button className="icon-btn" onClick={() => setTreeOpen(!treeOpen)} title="Toggle asset panel"><PanelIcon size={22} /></button>}
          </div>
          <div className="content-row">
            {showTree && treeOpen && <AssetTree assets={assets} selectedId={sel} onRefresh={load} />}
            <main className="content">
              {assetError && <div className="notice error">Could not load assets: {assetError}</div>}
              <Outlet context={{ assets, reload: load }} />
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}