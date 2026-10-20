import React from "react";
import { Routes, Route } from "react-router-dom";
import Layout from "../components/common/Layout.jsx";
import Home from "../features/dashboard/pages/Home.jsx";
import AlertRules from "../features/rules/pages/AlertRules.jsx";
import RuleCreatePage from "../features/rules/pages/RuleCreatePage.jsx";
import AssetsIndex from "../features/assets/pages/AssetsIndex.jsx";
import AssetDetail from "../features/assets/pages/AssetDetail.jsx";
import Configuration from "../features/configuration/pages/Configuration.jsx";
import ConfigSub from "../features/configuration/pages/ConfigSub.jsx";
import Plc from "../features/plc/pages/Plc.jsx";
import Settings from "../features/settings/pages/Settings.jsx";
import SettingsSub from "../features/settings/pages/SettingsSub.jsx";
import DocumentCreatePage from "../features/configuration/pages/DocumentCreatePage.jsx";
import RuleLibrary from "../features/configuration/pages/RuleLibrary.jsx";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/rules/:kind" element={<AlertRules />} />
        <Route path="/assets" element={<AssetsIndex />} />
        <Route path="/assets/:id" element={<AssetDetail />} />
        <Route path="/assets/:id/rules/new/:kind"element={<RuleCreatePage />} />
        <Route path="/configuration/documents/new"element={<DocumentCreatePage />}/>
        <Route path="/configuration" element={<Configuration />} />
        <Route path="/configuration/rules" element={<RuleLibrary />} />
        <Route path="/configuration/:sub" element={<ConfigSub />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/:sub" element={<SettingsSub />} />
        <Route path="/plc" element={<Plc />} />
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
  );
}