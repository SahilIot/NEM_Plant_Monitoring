import React, { useEffect, useRef, useState } from "react";
import { Eye, Pause, Pencil, Power, PowerOff } from "lucide-react";
import { api } from "../../../services/api.js";
import { DotsIcon } from "../../../components/common/Icons.jsx";
import { FloatingMenu, useConfirmation } from "../../../components/common/UI.jsx";
import { useAuth } from "../../auth/AuthContext.jsx";

const ACTIONS = {
  suspend: {
    title: "Suspend parameter?",
    confirmLabel: "Suspend",
    message: (name) => `Suspend "${name}"? Only this parameter stops being evaluated and raising alerts. The other parameters and the rule keep running. Its progress, configuration and history are kept.`,
  },
  resume: {
    title: "Resume parameter?",
    confirmLabel: "Resume",
    message: (name) => `Resume "${name}"? It continues from its preserved progress; the time it was suspended is not counted.`,
  },
  deactivate: {
    title: "Deactivate parameter?",
    confirmLabel: "Deactivate",
    destructive: true,
    message: (name) => `Deactivate "${name}"? Only this parameter stops being evaluated. The other parameters and the rule keep running. Its configuration, progress and history are kept, and it can be activated again.`,
  },
  activate: {
    title: "Activate parameter?",
    confirmLabel: "Activate",
    message: (name) => `Activate "${name}"? It is evaluated again from its preserved progress; the time it was deactivated is not counted.`,
  },
};

/**
 * Three-dot menu of ONE parameter card. Every action here is sent for this parameter only
 * (POST /rules/{rule}/parameters/{parameter}/lifecycle); the parent rule's own menu is separate.
 */
export default function ParameterCardMenu({ ruleId, rule, p, detailsOpen, onToggleDetails, onEdit, onChanged }) {
  const { user } = useAuth();
  const confirm = useConfirmation();
  const isAdministrator = user?.role === "Administrator";
  const isSupervisor = user?.role === "Supervisor";
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const root = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (event.target instanceof Element && (event.target.closest(".floating-menu") || root.current?.contains(event.target))) return;
      setOpen(false);
    };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const state = p.lifecycle_status || "active";
  const run = async (action) => {
    setOpen(false);
    if (submitting.current) return;
    const copy = ACTIONS[action];
    if (!(await confirm(copy.message(p.name), { title: copy.title, confirmLabel: copy.confirmLabel, cancelLabel: "Cancel", destructive: Boolean(copy.destructive) }))) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await api.post(`/rules/${ruleId}/parameters/${p.id}/lifecycle`, { action });
      await onChanged?.();
    } catch (requestError) {
      setError(requestError?.message || "Could not change the parameter.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const notEditable = p.editable === false;
  const editBlocked = notEditable || (!isAdministrator && !isSupervisor) || (isSupervisor && rule.lifecycle_status === "in_progress");
  const adminOnly = "Only Administrators can change a parameter's state.";

  return (
    <div className="dropdown rule-actions-menu rsd-param-menu" data-menu-open={open} ref={root}>
      <button type="button" className="icon-outline sm" title={`More actions for ${p.name}`} aria-label={`More actions for ${p.name}`}
        aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((value) => !value)}>
        <DotsIcon size={15} />
      </button>
      {open && (
        <FloatingMenu align="right" role="menu">
          <button type="button" className="rule-action-menu-item rule-action-menu-item--view" role="menuitem"
            onClick={() => { setOpen(false); onToggleDetails(); }}>
            <Eye size={16} aria-hidden="true" />
            <span>{detailsOpen ? "Hide parameter details" : "View parameter"}</span>
          </button>
          <button type="button" className="rule-action-menu-item rule-action-menu-item--edit" role="menuitem"
            disabled={editBlocked}
            title={editBlocked ? (notEditable ? p.not_editable_reason : isSupervisor ? "A running rule cannot be edited by a Supervisor. Edit it while it is not activated." : "You do not have permission to manage monitoring rules.") : undefined}
            onClick={() => { setOpen(false); onEdit(); }}>
            <Pencil size={16} aria-hidden="true" />
            <span>Edit parameter</span>
          </button>
          {state === "active" && (
            <button type="button" className="rule-action-menu-item rule-action-menu-item--lifecycle" role="menuitem"
              disabled={!isAdministrator} title={!isAdministrator ? adminOnly : undefined} onClick={() => run("suspend")}>
              <Pause size={16} aria-hidden="true" /><span>Suspend parameter</span>
            </button>
          )}
          {state === "suspended" && (
            <button type="button" className="rule-action-menu-item rule-action-menu-item--lifecycle" role="menuitem"
              disabled={!isAdministrator} title={!isAdministrator ? adminOnly : undefined} onClick={() => run("resume")}>
              <Power size={16} aria-hidden="true" /><span>Resume parameter</span>
            </button>
          )}
          {state === "deactivated" && (
            <button type="button" className="rule-action-menu-item rule-action-menu-item--lifecycle" role="menuitem"
              disabled={!(isAdministrator || isSupervisor)} title={!(isAdministrator || isSupervisor) ? "Only Administrators and Supervisors can activate parameters." : undefined}
              onClick={() => run("activate")}>
              <Power size={16} aria-hidden="true" /><span>Activate parameter</span>
            </button>
          )}
          {(state === "active" || state === "suspended") && (
            <button type="button" className="rule-action-menu-item rule-action-menu-item--lifecycle" role="menuitem"
              disabled={!isAdministrator} title={!isAdministrator ? adminOnly : undefined} onClick={() => run("deactivate")}>
              <PowerOff size={16} aria-hidden="true" /><span>Deactivate parameter</span>
            </button>
          )}
        </FloatingMenu>
      )}
      {error && <span className="rsd-param-error" role="alert">{error}</span>}
    </div>
  );
}
