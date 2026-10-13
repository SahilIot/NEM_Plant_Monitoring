import React from "react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { CreateModal, EmptyState } from "../components/UI.jsx";
import { BackIcon } from "../components/Icons.jsx";

const TITLES = {
  user: "User information",
  email: "Email server settings",
  analytics: "Analytics extensions",
  usage: "Usage information",
  backup: "Backup and restore",
};

const FORMS = {
  email: [["host", "SMTP host"], ["port", "Port"], ["username", "Username"], ["password", "Password", "password"], ["sender", "Sender address"]],
  analytics: [["databus_host", "Databus host"], ["databus_port", "Databus port"], ["enabled", "Enabled (true/false)"]],
};

// [key, label, editable by the user?]  (role comes from the login, so it is read-only)
const FIELDS = [
  ["name", "Name", true],
  ["role", "Role", false],
  ["email", "Email", true],
  ["phone", "Phone", true],
];

function UserInfo() {
  const [u, setU] = useState(null);
  const [draft, setDraft] = useState(null); // null = view mode, object = edit mode
  const [err, setErr] = useState("");
  const [saveErr, setSaveErr] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => { api.get("/me").then(setU).catch((e) => setErr(String(e.message || e))); }, []);
  if (err) return <div className="panel-white" style={{ color: "crimson" }}>Backend error: {err}</div>;
  if (!u) return <div className="loading">Loading…</div>;

  const startEdit = () => { setDraft({ name: u.name || "", email: u.email || "", phone: u.phone || "" }); setSaveErr(""); setMsg(""); };
  const cancel = () => { setDraft(null); setSaveErr(""); };
  const save = async () => {
    if (!draft.name.trim()) return setSaveErr("Name cannot be empty.");
    if (draft.email && !draft.email.includes("@")) return setSaveErr("Please enter a valid email.");
    try {
      const saved = await api.put("/me", draft);
      setU(saved); setDraft(null); setSaveErr(""); setMsg("Profile saved.");
    } catch (e) {
      setSaveErr("Could not save: " + String(e.message || e));
    }
  };

  const editing = draft !== null;
  return (
    <div className="panel-white profile">
      <div className="profile-head">
        <div className="avatar">{(u.name || "?").charAt(0).toUpperCase()}</div>
        <div className="profile-who">
          <div className="profile-name">{u.name}</div>
          <span className="badge role">{u.role}</span>
        </div>
        {!editing && <button className="btn-outline profile-edit" onClick={startEdit}>Edit profile</button>}
      </div>

      <dl className="profile-list">
        {FIELDS.map(([k, label, canEdit]) => (
          <React.Fragment key={k}>
            <dt>{label}</dt>
            <dd>
              {editing && canEdit ? (
                <input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
              ) : k === "email" && u.email ? (
                <a href={`mailto:${u.email}`}>{u.email}</a>
              ) : (
                u[k] || <span className="muted">-</span>
              )}
            </dd>
          </React.Fragment>
        ))}
      </dl>

      {editing && (
        <div className="profile-actions">
          <button className="btn-primary" onClick={save}>Save</button>
          <button className="btn-outline" onClick={cancel}>Cancel</button>
        </div>
      )}
      {editing && <p className="hint">Role is set by your login / administrator and cannot be changed here.</p>}
      {saveErr && <p className="notice error">{saveErr}</p>}
      {msg && !editing && <p className="notice">{msg}</p>}
    </div>
  );
}

function SettingsForm({ section }) {
  const [v, setV] = useState(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    setMsg(""); setV(null);
    api.get(`/settings/${section}`).then(setV).catch((error) => setMsg(`Could not load settings: ${error.message}`));
  }, [section]);
  if (!v) return msg ? <div className="notice error">{msg}</div> : <div className="loading">Loading…</div>;
  const save = async () => {
    try {
      const saved = await api.put(`/settings/${section}`, v);
      setV(saved);
      setMsg("Settings saved.");
    } catch (error) {
      setMsg(`Could not save settings: ${error.message}`);
    }
  };
  return (
    <div className="panel-white form">
      {section === "email" && <p className="hint">{v.has_password
        ? "An SMTP password is stored securely. Leave the password field empty to keep it, or enter a replacement."
        : "The SMTP password is encrypted before it is saved."}</p>}
      {FORMS[section].map(([k, label, type]) => (
        <label key={k}>{label}
          <input type={type || "text"} autoComplete={type === "password" ? "new-password" : undefined}
            value={v[k] || ""} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
        </label>
      ))}
      <div><button className="btn-primary" onClick={save}>Save</button></div>
      {msg && <p className="notice">{msg}</p>}
    </div>
  );
}

function Usage() {
  const [u, setU] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { api.get("/usage").then(setU).catch((e) => setError(e.message)); }, []);
  if (error) return <div className="notice error">Could not load usage: {error}</div>;
  if (!u) return <div className="loading">Loading…</div>;
  return (
    <div className="usage-grid">
      {Object.entries(u).map(([k, v]) => (
        <div key={k} className="stat-card"><div className="stat-sub">{k.replace("_", " ")}</div><div className="stat-val">{v}</div></div>
      ))}
    </div>
  );
}

function Backup() {
  const [list, setList] = useState([]);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);
  const load = () => api.get("/backups").then(setList).catch((error) => setMsg(`Could not load backups: ${error.message}`));
  useEffect(() => { load(); }, []);
  const create = async (values) => {
    const b = await api.post("/backups", values);
    setOpen(false); setMsg(`Backup ${b.name} created.`); load();
  };
  const restore = async (b) => {
    if (!window.confirm(`Restore "${b.name}"? This replaces all current monitoring data.`)) return;
    try {
      await api.post(`/backups/${b.id}/restore`);
      setMsg(`Backup ${b.name} restored.`);
    } catch (error) {
      setMsg(`Could not restore backup: ${error.message}`);
    }
  };
  return (
    <>
      <div className="panel-white">
        <button className="btn-primary" onClick={() => setOpen(true)}>Create backup</button>
        {msg && <p className="notice">{msg}</p>}
      </div>
      {open && (
        <CreateModal
          title="Create backup" submitLabel="Create backup" onSubmit={create} onClose={() => setOpen(false)}
          fields={[
            { key: "name", label: "Backup name", placeholder: "Leave empty for an automatic name" },
            { key: "note", label: "Note", type: "textarea", placeholder: "Why are you taking this backup?" },
          ]}
        />
      )}
      <div className="panel-white">
        {list.length === 0 ? <EmptyState title="No backups yet" /> :
          <table className="table"><thead><tr><th>Name</th><th>Created</th><th /></tr></thead>
            <tbody>{list.map((b) => (
              <tr key={b.id}><td>{b.name}</td><td>{b.created}</td>
                <td className="right"><button className="btn-outline" onClick={() => restore(b)}>Restore</button></td></tr>))}</tbody></table>}
      </div>
    </>
  );
}

export default function SettingsSub() {
  const { sub } = useParams();
  const nav = useNavigate();
  return (
    <div>
      <button className="link-btn" onClick={() => nav("/settings")}><BackIcon size={14} /> Back</button>
      <h1>{TITLES[sub] || "Settings"}</h1>
      {sub === "user" && <UserInfo />}
      {(sub === "email" || sub === "analytics") && <SettingsForm section={sub} />}
      {sub === "usage" && <Usage />}
      {sub === "backup" && <Backup />}
    </div>
  );
}