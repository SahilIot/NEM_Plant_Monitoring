import React, { useCallback, useEffect, useState } from "react";
import { api } from "../../services/api.js";

export default function AdminUsersPage() {
  const [users, setUsers] = useState([]);
  const [assets, setAssets] = useState([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("Viewer");
  const [assetIds, setAssetIds] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [assignedAssetIds, setAssignedAssetIds] = useState([]);
  const [selectedRole, setSelectedRole] = useState("Viewer");
  const [selectedActive, setSelectedActive] = useState(true);
  const [resetPassword, setResetPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [loadedUsers, loadedAssets] = await Promise.all([
      api.get("/auth/users"),
      api.getAll("/assets"),
    ]);
    setUsers(loadedUsers);
    setAssets(loadedAssets);
  }, []);

  useEffect(() => {
    load().catch((loadError) => setError(loadError.message || "Could not load user accounts."));
  }, [load]);

  useEffect(() => {
    const selected = users.find((user) => String(user.id) === selectedUserId);
    setAssignedAssetIds(selected?.asset_ids || []);
    setSelectedRole(selected?.role || "Viewer");
    setSelectedActive(selected?.is_active ?? true);
    setResetPassword("");
  }, [selectedUserId, users]);

  const toggle = (value, list, update) => {
    const id = Number(value);
    update((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  };

  const createUser = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.post("/auth/users", {
        username,
        password,
        role,
        asset_ids: role === "Admin" ? [] : assetIds,
      });
      setUsername("");
      setPassword("");
      setRole("Viewer");
      setAssetIds([]);
      setMessage("User account created.");
      await load();
    } catch (createError) {
      setError(createError.message || "Could not create the user account.");
    } finally {
      setBusy(false);
    }
  };

  const saveAssignments = async () => {
    if (!selectedUserId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const updated = await api.put(`/auth/users/${selectedUserId}/assets`, {
        asset_ids: assignedAssetIds,
      });
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      setMessage("Machine access updated.");
    } catch (saveError) {
      setError(saveError.message || "Could not update machine access.");
    } finally {
      setBusy(false);
    }
  };

  const saveUser = async () => {
    if (!selectedUserId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const changes = { role: selectedRole, is_active: selectedActive };
      if (resetPassword) changes.password = resetPassword;
      const updated = await api.patch(`/auth/users/${selectedUserId}`, changes);
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      setResetPassword("");
      setMessage("Account settings updated.");
    } catch (saveError) {
      setError(saveError.message || "Could not update the account.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-users-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">User access</h1>
          <p className="muted">Create local accounts and assign machine access.</p>
        </div>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {message && <p className="notice" role="status">{message}</p>}

      <section className="panel">
        <h2>Create account</h2>
        <form onSubmit={createUser} className="admin-user-form">
          <label className="field">Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={120} disabled={busy} />
          </label>
          <label className="field">Temporary password (minimum 12 characters)
            <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={1024} disabled={busy} />
          </label>
          <label className="field">Role
            <select value={role} onChange={(event) => setRole(event.target.value)} disabled={busy}>
              <option>Viewer</option>
              <option>Operator</option>
              <option>Admin</option>
            </select>
          </label>
          {role !== "Admin" && (
            <fieldset className="auth-asset-list">
              <legend>Assigned machines</legend>
              {assets.map((asset) => (
                <label key={asset.id}>
                  <input
                    type="checkbox"
                    checked={assetIds.includes(asset.id)}
                    onChange={() => toggle(asset.id, assetIds, setAssetIds)}
                    disabled={busy}
                  />
                  {asset.name}
                </label>
              ))}
            </fieldset>
          )}
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        </form>
      </section>

      <section className="panel">
        <h2>Existing accounts</h2>
        {users.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Machine access</th></tr></thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.username}</td>
                    <td>{user.role}</td>
                    <td>{user.is_active ? "Active" : "Disabled"}</td>
                    <td>{user.role === "Admin" ? "All machines" : user.asset_ids.map((id) => assets.find((asset) => asset.id === id)?.name || `Asset ${id}`).join(", ") || "None"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No user accounts found.</p>}
      </section>

      <section className="panel">
        <h2>Update account and machine access</h2>
        <label className="field">User
          <select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)} disabled={busy}>
            <option value="">Choose a user</option>
            {users.filter((user) => user.role !== "Admin").map((user) => (
              <option key={user.id} value={user.id}>{user.username} ({user.role})</option>
            ))}
          </select>
        </label>
        {selectedUserId && (
          <>
            <div className="admin-user-form">
              <label className="field">Role
                <select value={selectedRole} onChange={(event) => setSelectedRole(event.target.value)} disabled={busy}>
                  <option>Viewer</option>
                  <option>Operator</option>
                </select>
              </label>
              <label className="field">Account status
                <select value={selectedActive ? "active" : "disabled"} onChange={(event) => setSelectedActive(event.target.value === "active")} disabled={busy}>
                  <option value="active">Active</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              <label className="field">Reset password (optional, minimum 12 characters)
                <input type="password" autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} minLength={12} maxLength={1024} disabled={busy} />
              </label>
              <button type="button" className="btn-primary" onClick={saveUser} disabled={busy || (resetPassword.length > 0 && resetPassword.length < 12)}>
                {busy ? "Saving…" : "Save account settings"}
              </button>
            </div>
            {selectedRole !== "Admin" && (
              <>
                <fieldset className="auth-asset-list">
                  <legend>Machines this user can access</legend>
                  {assets.map((asset) => (
                    <label key={asset.id}>
                      <input
                        type="checkbox"
                        checked={assignedAssetIds.includes(asset.id)}
                        onChange={() => toggle(asset.id, assignedAssetIds, setAssignedAssetIds)}
                        disabled={busy}
                      />
                      {asset.name}
                    </label>
                  ))}
                </fieldset>
                <button type="button" className="btn-primary" onClick={saveAssignments} disabled={busy}>
                  {busy ? "Saving…" : "Save machine access"}
                </button>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
