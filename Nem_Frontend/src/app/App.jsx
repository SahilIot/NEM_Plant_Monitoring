
import React from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import Layout from "../components/common/Layout.jsx";

import Home from "../features/dashboard/pages/Home.jsx";

import AlertRules from "../features/rules/pages/AlertRules.jsx";
import RuleCreatePage from "../features/rules/pages/RuleCreatePage.jsx";

import AssetsIndex from "../features/assets/pages/AssetsIndex.jsx";
import AssetDetail from "../features/assets/pages/AssetDetail.jsx";

import Configuration from "../features/configuration/pages/Configuration.jsx";
import ConfigSub from "../features/configuration/pages/ConfigSub.jsx";
import DocumentCreatePage from "../features/configuration/pages/DocumentCreatePage.jsx";
import CreateInstructionPage from "../features/configuration/pages/CreateInstructionPage.jsx";
import DocumentViewerPage from "../features/configuration/pages/DocumentViewerPage.jsx";
import RuleLibrary from "../features/configuration/pages/RuleLibrary.jsx";

import Plc from "../features/plc/pages/Plc.jsx";

import Settings from "../features/settings/pages/Settings.jsx";
import SettingsSub from "../features/settings/pages/SettingsSub.jsx";
import CreateMaintenanceSchedulePage from "../features/assets/pages/CreateMaintenanceSchedulePage.jsx";
import CreateMonitoringRulePage from "../features/assets/pages/CreateMonitoringRulePage.jsx";
import LoginPage from "../features/auth/LoginPage.jsx";
import AdminUsersPage from "../features/auth/AdminUsersPage.jsx";
import { useAuth } from "../features/auth/AuthContext.jsx";
import { ConfirmationProvider } from "../components/common/UI.jsx";

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <main className="auth-page"><p role="status">Checking session…</p></main>;
  }

  return (
    <ConfirmationProvider>
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        element={
          user
            ? <Layout />
            : <Navigate to="/login" replace state={{ from: location }} />
        }
      >
        {/* Dashboard */}
        <Route path="/" element={<Home />} />

        {/* Alert Rules */}
        <Route
          path="/rules/:kind"
          element={user?.role === "Operator" ? <Navigate to="/" replace /> : <AlertRules />}
        />

        {/* Assets */}
        <Route
          path="/assets"
          element={user?.role === "Operator" ? <Navigate to="/" replace /> : <AssetsIndex />}
        />
        <Route
          path="/assets/:id"
          element={user?.role === "Operator" ? <Navigate to="/" replace /> : <AssetDetail />}
        />
        <Route
          path="/assets/:id/rules/new/:kind"
          element={user?.role === "Operator" ? <Navigate to="/" replace /> : <RuleCreatePage />}
        />

        {/* Configuration */}
        <Route path="/configuration" element={user?.role === "Administrator" ? <Configuration /> : <Navigate to="/" replace />} />
        <Route
          path="/configuration/rules"
          element={user?.role === "Administrator" ? <RuleLibrary /> : <Navigate to="/" replace />}
        />
        <Route
          path="/configuration/documents/new"
          element={user?.role === "Administrator" ? <DocumentCreatePage /> : <Navigate to="/" replace />}
        />
        <Route
          path="/configuration/instructions/new"
          element={user?.role === "Administrator" ? <CreateInstructionPage /> : <Navigate to="/" replace />}
        />
        <Route
          path="/configuration/documents/:documentId/files/:fileId/view"
          element={user?.role === "Administrator" ? <DocumentViewerPage /> : <Navigate to="/" replace />}
        />

        {/* Other configuration sections */}
        <Route
          path="/configuration/:sub"
          element={user?.role === "Administrator" ? <ConfigSub /> : <Navigate to="/" replace />}
        />

        {/* Settings */}
        <Route path="/settings" element={user?.role === "Administrator" ? <Settings /> : <Navigate to="/" replace />} />
        <Route
          path="/settings/users"
          element={user?.role === "Administrator" ? <AdminUsersPage /> : <Navigate to="/" replace />}
        />
        <Route
          path="/settings/:sub"
          element={user?.role === "Administrator" ? <SettingsSub /> : <Navigate to="/" replace />}
        />

        {/* PLC */}
        <Route path="/plc" element={user?.role === "Administrator" ? <Plc /> : <Navigate to="/" replace />} />

        {/* Maintenance */}

{/* Maintenance */}
<Route
  path="/assets/:id/maintenance/schedules/new"
  element={user?.role === "Operator" ? <Navigate to="/" replace /> : <CreateMaintenanceSchedulePage />}
/>

<Route
  path="/assets/:id/maintenance/schedules/:scheduleId/edit"
  element={user?.role === "Operator" ? <Navigate to="/" replace /> : <CreateMaintenanceSchedulePage />}
/>

{/* Monitoring Rules */}
<Route
  path="/assets/:id/monitoring-rules/new/:choiceId"
  element={user?.role === "Operator" ? <Navigate to="/" replace /> : <CreateMonitoringRulePage />}
/>

{/* Fallback — keep this last */}
<Route path="*" element={<Home />} />
      </Route>
    </Routes>
    </ConfirmationProvider>
  );
}
