import React, { useCallback, useEffect, useState } from "react";
import { Eye, RefreshCw, X } from "lucide-react";
import { api } from "../../../services/api.js";
import { EmptyState, LoadingIndicator } from "../../../components/common/UI.jsx";

export const VISIBILITY_LABELS = {
  admin_only: "Admin only",
  specific_supervisors: "Specific supervisors",
  all_supervisors: "All supervisors",
};

const VISIBILITY_HELP = {
  admin_only: "Only Administrators can see and manage this shared rule.",
  specific_supervisors: "Only the Supervisors you select can see and manage it.",
  all_supervisors: "Every active Supervisor can see and manage it.",
};

const STATUS_LABELS = { pending: "Pending", approved: "Approved", rejected: "Rejected" };

function formatWhen(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function ModalShell({ id, title, subtitle, onClose, busy, children, footer }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, busy]);
  return (
    <div
      className="rule-library-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section className="rule-library-modal" role="dialog" aria-modal="true" aria-labelledby={id}>
        <header>
          <div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            <X size={19} />
          </button>
        </header>
        <div className="rule-visibility-body">{children}</div>
        <footer>{footer}</footer>
      </section>
    </div>
  );
}

export function VisibilityBadge({ type }) {
  return (
    <span className="rule-library-status" title="Who can see and manage this shared rule">
      <Eye size={11} aria-hidden="true" /> {VISIBILITY_LABELS[type] || VISIBILITY_LABELS.admin_only}
    </span>
  );
}

/** Administrator: change a shared rule's visibility directly. */
export function VisibilityModal({ template, onClose, onSaved }) {
  const [type, setType] = useState(template.visibility_type || "admin_only");
  const [supervisors, setSupervisors] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get("/rule-visibility/supervisors"),
      api.get(`/rule-templates/${template.id}/visibility`),
    ])
      .then(([users, detail]) => {
        if (!alive) return;
        setSupervisors(Array.isArray(users) ? users : []);
        setSelected(new Set((detail.supervisors || []).map((item) => item.id)));
        setType(detail.visibility_type);
      })
      .catch((err) => alive && setError(err.message || "Could not load visibility settings."));
    return () => {
      alive = false;
    };
  }, [template.id]);

  const toggle = (id) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.put(`/rule-templates/${template.id}/visibility`, {
        visibility_type: type,
        supervisor_ids: type === "specific_supervisors" ? [...selected] : [],
      });
      await onSaved();
    } catch (err) {
      setError(err.message || "Could not update visibility.");
      setSaving(false);
    }
  };

  const needsSelection = type === "specific_supervisors" && selected.size === 0;
  return (
    <ModalShell
      id="rule-visibility-title"
      title={`Rule visibility — ${template.name}`}
      subtitle="Controls who can see and edit this shared rule. It does not change anyone's asset access."
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn-primary"
            onClick={save}
            disabled={saving || supervisors === null || needsSelection}
          >
            {saving ? "Saving…" : "Save visibility"}
          </button>
        </>
      }
    >
      {error && <p className="notice error" role="alert">{error}</p>}
      <fieldset className="rule-visibility-options" disabled={saving}>
        <legend className="muted">Visibility</legend>
        {Object.keys(VISIBILITY_LABELS).map((key) => (
          <label key={key} className="rule-visibility-option">
            <input
              type="radio"
              name="rule-visibility"
              checked={type === key}
              onChange={() => setType(key)}
            />
            <span>
              <strong>{VISIBILITY_LABELS[key]}</strong>
              <small>{VISIBILITY_HELP[key]}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {type === "specific_supervisors" && (
        <div className="rule-visibility-supervisors">
          <p className="muted">Supervisors who can see and manage this rule</p>
          {supervisors === null ? (
            <LoadingIndicator compact message="Loading supervisors" />
          ) : supervisors.length === 0 ? (
            <p className="muted">There are no active Supervisors.</p>
          ) : (
            supervisors.map((person) => (
              <label key={person.id} className="rule-visibility-option">
                <input
                  type="checkbox"
                  checked={selected.has(person.id)}
                  onChange={() => toggle(person.id)}
                  disabled={saving}
                />
                <span>{person.username}</span>
              </label>
            ))
          )}
          {needsSelection && supervisors?.length > 0 && (
            <small className="rule-library-error">Select at least one Supervisor.</small>
          )}
        </div>
      )}
    </ModalShell>
  );
}

/** Supervisor: ask the Administrator for access to a rule, or for All Supervisors visibility. */
export function RequestVisibilityModal({ onClose, onSubmitted }) {
  const [rules, setRules] = useState(null);
  const [templateId, setTemplateId] = useState("");
  const [requestType, setRequestType] = useState("self");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .get("/rule-visibility-requests/requestable")
      .then((result) => alive && setRules(Array.isArray(result) ? result : []))
      .catch((err) => alive && setError(err.message || "Could not load rules."));
    return () => {
      alive = false;
    };
  }, []);

  const chosen = (rules || []).find((rule) => String(rule.id) === templateId);
  // A rule you can already see only needs the "all supervisors" request.
  const canRequestSelf = chosen ? !chosen.has_access : true;
  useEffect(() => {
    if (chosen && chosen.has_access) setRequestType("all_supervisors");
  }, [chosen]);

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      await api.post("/rule-visibility-requests", {
        template_id: Number(templateId),
        request_type: requestType,
        reason,
      });
      await onSubmitted();
    } catch (err) {
      setError(err.message || "Could not submit the request.");
      setSaving(false);
    }
  };

  return (
    <ModalShell
      id="rule-visibility-request-title"
      title="Request rule visibility"
      subtitle="An Administrator must approve the request before anything changes."
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn-primary"
            onClick={submit}
            disabled={saving || !templateId || !reason.trim()}
          >
            {saving ? "Submitting…" : "Submit request"}
          </button>
        </>
      }
    >
      {error && <p className="notice error" role="alert">{error}</p>}
      {rules === null && !error ? (
        <LoadingIndicator compact message="Loading rules" />
      ) : (
        <>
          <label className="rule-visibility-field">
            <span className="muted">Rule</span>
            <select value={templateId} onChange={(event) => setTemplateId(event.target.value)} disabled={saving}>
              <option value="">Choose a rule</option>
              {(rules || []).map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.name} ({VISIBILITY_LABELS[rule.visibility_type]})
                </option>
              ))}
            </select>
          </label>
          <fieldset className="rule-visibility-options" disabled={saving || !templateId}>
            <legend className="muted">What do you need?</legend>
            <label className="rule-visibility-option">
              <input
                type="radio"
                name="request-type"
                checked={requestType === "self"}
                onChange={() => setRequestType("self")}
                disabled={!canRequestSelf}
              />
              <span>
                <strong>Access for me</strong>
                <small>Add yourself to the Supervisors who can see and manage this rule.</small>
              </span>
            </label>
            <label className="rule-visibility-option">
              <input
                type="radio"
                name="request-type"
                checked={requestType === "all_supervisors"}
                onChange={() => setRequestType("all_supervisors")}
              />
              <span>
                <strong>Visible to all Supervisors</strong>
                <small>Make this rule visible to every active Supervisor.</small>
              </span>
            </label>
          </fieldset>
          <label className="rule-visibility-field">
            <span className="muted">Reason</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={saving}
            />
          </label>
        </>
      )}
    </ModalShell>
  );
}

function RejectModal({ request, onClose, onRejected }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const reject = async () => {
    setSaving(true);
    setError("");
    try {
      await api.post(`/rule-visibility-requests/${request.id}/reject`, { reason });
      await onRejected();
    } catch (err) {
      setError(err.message || "Could not reject this request.");
      setSaving(false);
    }
  };
  return (
    <ModalShell
      id="rule-visibility-reject-title"
      title={`Reject request — ${request.rule_name}`}
      subtitle="The rule's visibility stays unchanged."
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-outline danger" onClick={reject} disabled={saving}>
            {saving ? "Rejecting…" : "Reject request"}
          </button>
        </>
      }
    >
      {error && <p className="notice error" role="alert">{error}</p>}
      <label className="rule-visibility-field">
        <span className="muted">Reason (optional)</span>
        <textarea rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} disabled={saving} />
      </label>
    </ModalShell>
  );
}

function describeRequest(request) {
  if (request.requested_visibility === "all_supervisors") return VISIBILITY_LABELS.all_supervisors;
  const names = (request.requested_users || []).map((item) => item.username).join(", ");
  return `${VISIBILITY_LABELS.specific_supervisors}${names ? ` (${names})` : ""}`;
}

/** Admin: pending visibility requests with approve/reject. Supervisor: own request status. */
export function VisibilityRequestsPanel({ isAdministrator, refreshKey, onChanged, onMessage }) {
  const [status, setStatus] = useState(isAdministrator ? "pending" : "");
  const [items, setItems] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [rejecting, setRejecting] = useState(null);

  const load = useCallback(async () => {
    try {
      const query = status ? `?status=${status}` : "";
      const result = await api.get(`/rule-visibility-requests${query}`);
      setItems(Array.isArray(result) ? result : []);
    } catch (err) {
      setItems([]);
      onMessage({ text: err.message || "Could not load visibility requests.", error: true });
    }
  }, [status, onMessage]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const approve = async (request) => {
    if (busyId !== null) return;
    setBusyId(request.id);
    try {
      await api.post(`/rule-visibility-requests/${request.id}/approve`, {});
      onMessage({ text: `Visibility request for "${request.rule_name}" approved.`, error: false });
      await onChanged();
    } catch (err) {
      onMessage({ text: err.message || "Could not approve this request.", error: true });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="rule-library-panel pending-suggestions">
      <div className="rule-library-tools">
        <div>
          <h2>{isAdministrator ? "Pending Visibility Requests" : "My Visibility Requests"}</h2>
          <p className="muted">
            {isAdministrator
              ? "Review Supervisor requests to change who can see shared rules."
              : "Requests you have sent to an Administrator."}
          </p>
        </div>
        <select
          aria-label="Filter visibility requests by status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          {!isAdministrator && <option value="">All</option>}
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <button type="button" className="icon-outline" onClick={load} title="Refresh" aria-label="Refresh visibility requests">
          <RefreshCw size={17} aria-hidden="true" />
        </button>
      </div>
      {items === null ? (
        <LoadingIndicator message="Loading visibility requests" />
      ) : items.length === 0 ? (
        <EmptyState art={false} title="No visibility requests" lines={[isAdministrator ? "Supervisor requests will appear here." : "You have not sent any requests."]} />
      ) : (
        <div className="rule-library-list">
          {items.map((request) => (
            <article className="rule-library-card" key={request.id}>
              <div className="rule-library-card-icon"><Eye size={19} /></div>
              <div className="rule-library-card-main">
                <div className="rule-library-card-title">
                  <h2>{request.rule_name}</h2>
                  <span className={`rule-library-status ${request.status === "approved" ? "available" : "disabled"}`}>
                    {STATUS_LABELS[request.status] || request.status}
                  </span>
                </div>
                <p>{request.reason}</p>
                <small>
                  Current: {VISIBILITY_LABELS[request.current_visibility] || request.current_visibility}
                  {" · "}Requested: {describeRequest(request)}
                </small>
                <small>
                  {isAdministrator && <>Requested by {request.requested_by_name || "Unknown"} · </>}
                  {formatWhen(request.created_at)}
                </small>
                {request.reviewed_at && (
                  <small>
                    {STATUS_LABELS[request.status]} by {request.reviewed_by_name || "Unknown"} on {formatWhen(request.reviewed_at)}
                    {request.rejection_reason ? ` — ${request.rejection_reason}` : ""}
                  </small>
                )}
              </div>
              {isAdministrator && request.status === "pending" && (
                <div className="rule-library-actions">
                  <button className="btn-primary" onClick={() => approve(request)} disabled={busyId !== null}>
                    {busyId === request.id ? "Processing…" : "Approve"}
                  </button>
                  <button className="btn-outline danger" onClick={() => setRejecting(request)} disabled={busyId !== null}>
                    Reject
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {rejecting && (
        <RejectModal
          request={rejecting}
          onClose={() => setRejecting(null)}
          onRejected={async () => {
            const name = rejecting.rule_name;
            setRejecting(null);
            onMessage({ text: `Visibility request for "${name}" rejected.`, error: false });
            await onChanged();
          }}
        />
      )}
    </section>
  );
}
