import React, { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "./AuthContext.jsx";
import { resolveNavigationOrigin } from "../../utils/navigation.js";

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (loading) return <main className="auth-page"><p role="status">{t("auth.checkingSession")}</p></main>;
  if (user) return <Navigate to="/" replace />;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(username, password);
      const destination = location.state?.from;
      const target = resolveNavigationOrigin(destination, "/");
      navigate(
        {
          pathname: target.pathname,
          search: target.search,
          hash: target.hash,
        },
        { replace: true, state: target.state }
      );
    } catch (loginError) {
      setError(loginError.message || t("auth.signInFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="panel auth-card">
        <h1 className="page-title">{t("auth.signInTitle")}</h1>
        <p className="muted">{t("auth.signInSubtitle")}</p>
        <form onSubmit={submit}>
          <label className="field">
            {t("auth.username")}
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              maxLength={120}
              disabled={busy}
            />
          </label>
          <label className="field">
            {t("auth.password")}
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              maxLength={1024}
              disabled={busy}
            />
          </label>
          {error && <p className="notice error" role="alert">{error}</p>}
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? t("auth.signingIn") : t("auth.signIn")}
          </button>
        </form>
      </section>
    </main>
  );
}
