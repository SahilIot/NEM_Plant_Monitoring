import React from "react";
import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import Home from "./pages/Home.jsx";
import AlertRules from "./pages/AlertRules.jsx";
import AssetsIndex from "./pages/AssetsIndex.jsx";
import AssetDetail from "./pages/AssetDetail.jsx";
import Configuration from "./pages/Configuration.jsx";
import ConfigSub from "./pages/ConfigSub.jsx";
import Settings from "./pages/Settings.jsx";
import SettingsSub from "./pages/SettingsSub.jsx";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/rules/:kind" element={<AlertRules />} />
        <Route path="/assets" element={<AssetsIndex />} />
        <Route path="/assets/:id" element={<AssetDetail />} />
        <Route path="/configuration" element={<Configuration />} />
        <Route path="/configuration/:sub" element={<ConfigSub />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/:sub" element={<SettingsSub />} />
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
  );
}