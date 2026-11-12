
import React from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import Layout from "../components/common/Layout.jsx";

import Home from "../features/dashboard/pages/Home.jsx";

import AlertRules from "../features/rules/pages/AlertRules.jsx";
import RuleCreatePage from "../features/rules/pages/RuleCreatePage.jsx";

import AssetsIndex from "../features/assets/pages/AssetsIndex.jsx";
import AssetDetail from "../features/assets/pages/AssetDetail.jsx";

import Configuration from "../features/configuration/pages/Configuration.jsx";
import ImportConfigurationPage from "../features/configuration/pages/ImportConfigurationPage.jsx";
import DocumentCreatePage from "../features/configuration/pages/DocumentCreatePage.jsx";
import CreateInstructionPage from "../features/configuration/pages/CreateInstructionPage.jsx";
import DocumentViewerPage from "../features/configuration/pages/DocumentViewerPage.jsx";
import DocumentsPage from "../features/configuration/pages/DocumentsPage.jsx";
import RuleLibrary from "../features/configuration/pages/RuleLibrary.jsx";
import CollectionLibrary from "../features/configuration/pages/CollectionLibrary.jsx";

import Plc from "../features/plc/pages/Plc.jsx";

import Settings from "../features/settings/pages/Settings.jsx";
import SettingsSub from "../features/settings/pages/SettingsSub.jsx";
import CreateMaintenanceSchedulePage from "../features/assets/pages/CreateMaintenanceSchedulePage.jsx";
import CreateMonitoringRulePage from "../features/assets/pages/CreateMonitoringRulePage.jsx";
import LoginPage from "../features/auth/LoginPage.jsx";
import AdminUsersPage from "../features/auth/AdminUsersPage.jsx";
import { useAuth } from "../features/auth/AuthContext.jsx";
import {
  ConfirmationProvider,
  LoadingIndicator,
} from "../components/common/UI.jsx";
import ExportConfigurationPage from "../features/configuration/pages/ExportConfigurationPage.jsx";

function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <main className="panel">
      <h1 className="page-title">{t("auth.notFoundTitle")}</h1>
      <p className="muted">{t("auth.notFoundMessage")}</p>
      <Link className="btn-outline" to="/">
        {t("auth.returnHome")}
      </Link>
    </main>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();

  if (loading) {
    return (
      <main className="auth-page">
        <LoadingIndicator message={t("auth.checkingSession")} />
      </main>
    );
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
            ? <Layout key={user.id} /> /* remount per user so assets/rules/alerts never carry over */
            : <Navigate to="/login" replace state={{ from: location }} />
        }
      >
        {/* Dashboard */}
        <Route path="/" element={<Home />} />

        {/* Alert Rules */}
        <Route path="/rules/:kind" element={<AlertRules />} />

        {/* Assets */}
        <Route path="/assets" element={<AssetsIndex />} />
        <Route path="/assets/:id" element={<AssetDetail />} />
        {/* Reuse the asset maintenance panel on a dedicated schedule-details page. */}
        <Route
          path="/assets/:id/maintenance/schedules/:scheduleId/details"
          element={<AssetDetail />}
        />
        <Route
          path="/assets/:id/rules/new/:kind"
          element={<RuleCreatePage />}
        />

        {/* Configuration */}
        <Route path="/configuration" element={<Configuration />} />
        <Route
          path="/configuration/rules"
          element={<RuleLibrary />}
        />
        <Route
          path="/configuration/collections"
          element={<CollectionLibrary />}
        />
        <Route
          path="/configuration/documents"
          element={<DocumentsPage />}
        />
        <Route
          path="/configuration/documents/new"
          element={<DocumentCreatePage />}
        />
        <Route
          path="/configuration/instructions/new"
          element={<CreateInstructionPage />}
        />
        <Route
          path="/configuration/instructions"
          element={<Navigate to="/configuration/documents" replace />}
        />
        <Route
          path="/configuration/documents/:documentId/files/:fileId/view"
          element={<DocumentViewerPage />}
        />

        <Route
          path="/configuration/import"
          element={<ImportConfigurationPage />}
        />

        {/* Unknown configuration sections return to the configuration home */}
        <Route
          path="/configuration/:sub"
          element={<Navigate to="/configuration" replace />}
        />

        {/* Settings */}
        <Route path="/settings" element={<Settings />} />
        <Route
          path="/settings/users"
          element={<AdminUsersPage />}
        />
        <Route
          path="/settings/:sub"
          element={<SettingsSub />}
        />

        {/* PLC */}
        <Route path="/plc" element={<Plc />} />

        {/* Maintenance */}

{/* Maintenance */}
<Route
          path="/maintenance/suggest"
  element={<CreateMaintenanceSchedulePage />}
/>

        <Route
          path="/assets/:id/maintenance/schedules/new"
          element={<CreateMaintenanceSchedulePage />}
        />

<Route
  path="/assets/:id/maintenance/schedules/:scheduleId/edit"
  element={<CreateMaintenanceSchedulePage />}
/>

{/* Monitoring Rules */}
<Route
  path="/assets/:id/monitoring-rules/new/:choiceId"
  element={<CreateMonitoringRulePage />}
/>

{/* Monitoring Rules */}
<Route
  path="/assets/:id/monitoring-rules/new/:choiceId"
  element={<CreateMonitoringRulePage />}
/>

{/* Edit existing monitoring rule */}
<Route
  path="/assets/:id/monitoring-rules/:rule_type/edit"
  element={<CreateMonitoringRulePage />}
/>

<Route
  path="/configuration/export"
  element={<ExportConfigurationPage />}
/>

<Route
  path="/assets/:id/maintenance/:recordId/edit"
  element={<CreateMaintenanceSchedulePage />}
/>

{/* Fallback — keep this last */}
<Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
    </ConfirmationProvider>
  );
}
