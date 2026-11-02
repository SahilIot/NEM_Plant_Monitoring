import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, AUTH_TOKEN_KEY, getAuthToken } from "../../services/api.js";
import { resetLiveUpdates } from "../../services/liveUpdates.js";

const AuthContext = createContext(null);

// Per-user browser state (saved form/navigation state) must not leak to the next
// account that signs in on the same browser tab.
function clearUserScopedBrowserState() {
  try {
    Object.keys(window.sessionStorage)
      .filter((key) => key.startsWith("nem-navigation-flash:"))
      .forEach((key) => window.sessionStorage.removeItem(key));
  } catch (error) {
    // Storage may be unavailable; there is nothing to clear in that case.
  }
}

function storeToken(token) {
  clearUserScopedBrowserState();
  resetLiveUpdates();
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch (error) {
    throw new Error("Could not store the login session in this browser.");
  }
}

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const token = getAuthToken();
    if (!token) {
      setLoading(false);
      return undefined;
    }
    api.get("/auth/me")
      .then((currentUser) => active && setUser(currentUser))
      .catch((error) => {
        if (!active) return;
        if (error.status === 401) storeToken(null);
        setUser(null);
      })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    // The session token is shared by every tab of this browser. When another tab signs in
    // (possibly as a different user) or out, this tab's in-memory assets, rules and alerts
    // belong to the previous user while its next request already carries the new token.
    // "storage" events fire only in the *other* tabs, so reloading here starts clean.
    const onStorage = (event) => {
      if (event.key === AUTH_TOKEN_KEY || event.key === null) window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const expire = () => {
      storeToken(null);
      setUser(null);
      navigate("/login", { replace: true });
    };
    window.addEventListener("nem-auth-expired", expire);
    return () => window.removeEventListener("nem-auth-expired", expire);
  }, [navigate]);

  const refreshUser = useCallback(async () => {
    const currentUser = await api.get("/auth/me");
    setUser(currentUser);
    return currentUser;
  }, []);

  const value = useMemo(() => ({
    user,
    loading,
    login: async (username, password) => {
      const response = await api.post("/auth/login", { username, password });
      storeToken(response.access_token);
      setUser(response.user);
      return response.user;
    },
    logout: async () => {
      try {
        await api.post("/auth/logout");
      } finally {
        storeToken(null);
        setUser(null);
        navigate("/login", { replace: true });
      }
    },
    refreshUser,
  }), [loading, navigate, refreshUser, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
