import React, { useCallback, useEffect, useState } from "react";
import { api } from "../../services/api.js";
import { useAuth } from "./AuthContext.jsx";
import { Trash2 } from "lucide-react";
import { useConfirmation } from "../../components/common/UI.jsx";

export default function AdminUsersPage() {
  const { user } = useAuth();
  const canManageUsers = user?.role === "Administrator";
  const [users, setUsers] = useState([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("Supervisor");
  const [contactNumber, setContactNumber] = useState("");
  const [email, setEmail] = useState("");
  const requiresContactDetails = ["Supervisor", "Operator"].includes(role);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState("Supervisor");
  const [selectedActive, setSelectedActive] = useState(true);
  const [selectedContact, setSelectedContact] = useState("");
  const [selectedEmail, setSelectedEmail] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState("");

  const confirm = useConfirmation();

  const deleteUser = async (userId) => {
    const confirmed = await confirm(
      "Are you sure you want to delete this account? This cannot be undone.",
      { title: "Delete account", confirmLabel: "Delete", cancelLabel: "Cancel", destructive: true }
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    setMessage("");
    setDeletingUserId(userId);
    try {
      await api.del(`/auth/users/${userId}`);
      setUsers((current) => current.filter((u) => u.id !== userId));
      setMessage("Account deleted.");
    } catch (deleteError) {
      setError(deleteError.message || "Could not delete the account.");
    } finally {
      setBusy(false);
      setDeletingUserId("");
    }
  };

  const load = useCallback(async () => {
    setUsers(await api.get("/auth/users"));
  }, []);

  useEffect(() => {
    if (!canManageUsers) {
      setError("You do not have permission to manage user accounts.");
      return undefined;
    }
    load().catch((loadError) => setError(loadError.message || "Could not load user accounts."));
    return undefined;
  }, [canManageUsers, load]);

  useEffect(() => {
    const selected = users.find((user) => String(user.id) === selectedUserId);
    setSelectedRole(selected?.role || "Supervisor");
    setSelectedActive(selected?.is_active ?? true);
    setSelectedContact(selected?.contact_number ?? "");
    setSelectedEmail(selected?.email_address ?? "");
    setResetPassword("");
  }, [selectedUserId, users]);

  const createUser = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (requiresContactDetails && (!contactNumber.trim() || !email.trim())) {
        setError("Contact number and email are required for Supervisor and Operator accounts.");
        return;
      }
      await api.post("/auth/users", {
        username: username.trim(),
        password,
        role,
        contact_number: requiresContactDetails
        ? contactNumber.trim()
        : null,
      email: requiresContactDetails
        ? email.trim()
        : null,
      });
      setUsername("");
      setPassword("");
      setRole("Supervisor");
      setContactNumber("");
      setEmail("");
      setMessage("User account created.");
      await load();
    } catch (createError) {
      setError(createError.message || "Could not create the user account.");
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
      const changes = {
        role: selectedRole,
        is_active: selectedActive,
        contact_number: selectedContact.trim() || null,
        email_address: selectedEmail.trim() || null,
      };
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
          <p className="muted">Create local accounts and manage roles. All roles can view all machines.</p>
        </div>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {message && <p className="notice" role="status">{message}</p>}

      <section className="panel">
        <h2>Create account</h2>
        <form onSubmit={createUser} className="admin-user-form">
          <label className="field">Username
            <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            maxLength={120}
            disabled={busy || !canManageUsers}
            title={!canManageUsers ? "Administrator access required" : undefined}
            />
            </label>
            <label className="field">
              Temporary password (minimum 12 characters)
              <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={12}
              maxLength={1024}
              disabled={busy || !canManageUsers}
              title={!canManageUsers ? "Administrator access required" : undefined}
              />
              </label>
              {/* Role field */}
              <label className="field">
                Role
                <select
                value={role}
                onChange={(event) => setRole(event.target.value)}
                disabled={busy || !canManageUsers}
                title={!canManageUsers ? "Administrator access required" : undefined}
                >
                  <option>Supervisor</option>
                  <option>Operator</option>
                  <option>Administrator</option>
                  </select>
                  </label>
                  {/* ADD CONTACT NUMBER AND EMAIL HERE */}
                  {requiresContactDetails && (
                    <>
                    <label className="field">
                      Contact number
                      <input
                      type="tel"
                      value={contactNumber}
                      onChange={(event) => setContactNumber(event.target.value)}
                      placeholder="Enter contact number"
                      autoComplete="tel"
                      required
                      maxLength={20}
                      disabled={busy || !canManageUsers}
                      title={!canManageUsers ? "Administrator access required" : undefined}
                      />
                      </label>
                      <label className="field">
                        Email address
                        <input
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="Enter email address"
                        autoComplete="email"
                        required
                        maxLength={254}
                        disabled={busy || !canManageUsers}
                        title={!canManageUsers ? "Administrator access required" : undefined}
                        />
                        </label>
                        </>
                      )}
                      {/* Create account button */}
                      <button
                      type="submit"
                      className="btn-primary"
                      disabled={busy || !canManageUsers}
                      title={!canManageUsers ? "Administrator access required" : undefined}
                      >
                        {busy ? "Creating…" : "Create account"}
                        </button>
                        </form>
                        </section>

      <section className="panel">
        <h2>Existing accounts</h2>
        {users.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Contact</th><th>Email</th><th>Delete</th></tr></thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.username}</td>
                    <td>{user.role}</td>
                    <td>{user.is_active ? "Active" : "Disabled"}</td>
                    <td>{user.contact_number || ""}</td>
                    <td>{user.email_address || ""}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => deleteUser(user.id)}
                        disabled={busy || deletingUserId !== "" || user.role === "Administrator"}
                        title={user.role === "Administrator" ? "Cannot delete an administrator account here" : "Delete account"}
                      >
                        {deletingUserId === user.id ? <span>Deleting…</span> : <Trash2 size={16} aria-hidden="true" />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No user accounts found.</p>}
      </section>

      <section className="panel">
        <h2>Update account</h2>
        <label className="field">User
          <select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)} disabled={busy || !canManageUsers} title={!canManageUsers ? "Administrator access required" : undefined}>
            <option value="">Choose a user</option>
            {users.filter((user) => user.role !== "Administrator").map((user) => (
              <option key={user.id} value={user.id}>{user.username} ({user.role})</option>
            ))}
          </select>
        </label>
        {selectedUserId && (
          <>
            <div className="admin-user-form">
              <label className="field">Role
                <select value={selectedRole} onChange={(event) => setSelectedRole(event.target.value)} disabled={busy || !canManageUsers} title={!canManageUsers ? "Administrator access required" : undefined}>
                  <option>Supervisor</option>
                  <option>Operator</option>
                </select>
              </label>
              <label className="field">Account status
                <select value={selectedActive ? "active" : "disabled"} onChange={(event) => setSelectedActive(event.target.value === "active")} disabled={busy || !canManageUsers} title={!canManageUsers ? "Administrator access required" : undefined}>
                  <option value="active">Active</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              <label className="field">Contact number
                <input type="tel" value={selectedContact} onChange={(event) => setSelectedContact(event.target.value)} placeholder="Enter contact number" autoComplete="tel" maxLength={20} disabled={busy || !canManageUsers} title={!canManageUsers ? "Administrator access required" : undefined} />
              </label>
              <label className="field">Email address
                <input type="email" value={selectedEmail} onChange={(event) => setSelectedEmail(event.target.value)} placeholder="Enter email address" autoComplete="email" maxLength={254} disabled={busy || !canManageUsers} title={!canManageUsers ? "Administrator access required" : undefined} />
              </label>
              <label className="field">Reset password (optional, minimum 12 characters)
                <input type="password" autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} minLength={12} maxLength={1024} disabled={busy || !canManageUsers} title={!canManageUsers ? "Administrator access required" : undefined} />
              </label>
              <button type="button" className="btn-primary" onClick={saveUser} disabled={busy || !canManageUsers || (resetPassword.length > 0 && resetPassword.length < 12)} title={!canManageUsers ? "Administrator access required" : undefined}>
                {busy ? "Saving…" : "Save account settings"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
