
import React from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, matchPath } from "react-router-dom";
import { api } from "../api.js";
import { APP_TITLE } from "../config.js";
import Brand from "./Brand.jsx";
import AssetTree from "./AssetTree.jsx";
import {
  HomeIcon,
  TreeIcon,
  ShapesIcon,
  GearIcon,
  DoubleChevron,
  PanelIcon,
  PlugIcon,
  InfoIcon,
  SunIcon,
  MoonIcon,
} from "./Icons.jsx";

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

  if ((m = matchPath("/rules/:kind", path))) {
    return [
      { label: "Home", to: "/" },
      { label: `Rules with ${m.params.kind} status` },
    ];
  }

  if ((m = matchPath("/assets/:id", path))) {
    const asset = assets.find((x) => x.id === Number(m.params.id));

    return [
      { label: asset ? asset.name : m.params.id, to: path },
      { label: "Current status" },
    ];
  }

  if (path === "/assets") return [{ label: "Assets" }];
  if (path === "/plc") return [{ label: "PLC / OPC UA" }];

  if ((m = matchPath("/configuration/:sub", path))) {
    return [
      { label: "Configuration", to: "/configuration" },
      { label: TITLES[m.params.sub] || m.params.sub },
    ];
  }

  if ((m = matchPath("/settings/:sub", path))) {
    return [
      { label: "Settings", to: "/settings" },
      { label: TITLES[m.params.sub] || m.params.sub },
    ];
  }

  if (path.startsWith("/configuration")) {
    return [{ label: "Configuration" }];
  }

  if (path.startsWith("/settings")) {
    return [{ label: "Settings" }];
  }

  return [{ label: "Home" }];
}

export default function Layout() {
  const { pathname } = useLocation();

  const [assets, setAssets] = useState([]);
  const [assetError, setAssetError] = useState("");
  const [railOpen, setRailOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(true);

  const [theme, setTheme] = useState(() => {
    try {
      const savedTheme = localStorage.getItem("nem-theme");

      if (savedTheme === "light" || savedTheme === "dark") {
        return savedTheme;
      }
    } catch {
      // Storage may be unavailable in restricted browser environments.
    }

    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;

    try {
      localStorage.setItem("nem-theme", theme);
    } catch {
      // The selected theme still works for the current session.
    }
  }, [theme]);

  const load = useCallback(async () => {
    try {
      const result = await api.get("/assets?limit=200");

      if (!Array.isArray(result)) {
        throw new Error(
          "Unexpected assets response. Expected an array of assets."
        );
      }

      const normalizedAssets = result.map((asset) => ({
        ...asset,

        // Preserve the backend's actual hierarchy field.
        parent: asset.parent_asset_id ?? null,

        // This means enabled/disabled, NOT machine connectivity.
        status: asset.is_active === true
          ? "enabled"
          : asset.is_active === false
            ? "disabled"
            : "unknown",
      }));

      setAssets(normalizedAssets);
      setAssetError("");

      return normalizedAssets;
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "An unexpected error occurred while loading assets.";

      setAssetError(message);
      throw error;
    }
  }, []);

  useEffect(() => {
    load().catch(() => {
      // The error is displayed in the page.
    });
  }, [load]);

  const showTree =
    pathname === "/" ||
    pathname.startsWith("/rules") ||
    pathname.startsWith("/assets");

  const selectedId = Number(
    matchPath("/assets/:id", pathname)?.params.id
  );

  const breadcrumbs = crumbs(pathname, assets);

  const link = (to, Icon, label, end) => (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        "rail-item" + (isActive ? " active" : "")
      }
      title={label}
    >
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
          <button
            className="icon-btn"
            title={
              theme === "dark"
                ? "Switch to light mode"
                : "Switch to dark mode"
            }
            aria-label={
              theme === "dark"
                ? "Switch to light mode"
                : "Switch to dark mode"
            }
            onClick={() =>
              setTheme(theme === "dark" ? "light" : "dark")
            }
          >
            {theme === "dark"
              ? <SunIcon size={20} />
              : <MoonIcon size={20} />}
          </button>

          <PlugIcon size={20} />
          <InfoIcon size={20} />
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

          <button
            className="rail-item"
            onClick={() => setRailOpen((open) => !open)}
            title={railOpen ? "Collapse navigation" : "Expand navigation"}
            aria-label={railOpen ? "Collapse navigation" : "Expand navigation"}
          >
            <DoubleChevron size={20} />
          </button>
        </nav>

        <div className="main-col">
          <div className="crumbs">
            <div>
              {breadcrumbs.map((crumb, index) => (
                <span key={index}>
                  {index > 0 && <span className="sep">/</span>}

                  {crumb.to ? (
                    <Link to={crumb.to}>{crumb.label}</Link>
                  ) : (
                    <span className="cur">{crumb.label}</span>
                  )}
                </span>
              ))}
            </div>

            {showTree && (
              <button
                className="icon-btn"
                onClick={() => setTreeOpen((open) => !open)}
                title={treeOpen ? "Hide asset panel" : "Show asset panel"}
                aria-label={treeOpen ? "Hide asset panel" : "Show asset panel"}
                aria-expanded={treeOpen}
              >
                <PanelIcon size={22} />
              </button>
            )}
          </div>

          <div className="content-row">
            {showTree && treeOpen && (
              <AssetTree
                assets={assets}
                selectedId={selectedId}
                onRefresh={load}
              />
            )}

            <main className="content">
              {assetError && (
                <div className="notice error" role="alert">
                  <p>Could not load assets: {assetError}</p>

                  <button
                    type="button"
                    onClick={() => load().catch(() => {})}
                  >
                    Retry
                  </button>
                </div>
              )}

              <Outlet context={{ assets, reload: load }} />
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
