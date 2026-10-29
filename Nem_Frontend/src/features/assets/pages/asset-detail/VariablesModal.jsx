import React from "react";
import { Modal } from "../../../../components/common/UI.jsx";
import { Trash2 } from "lucide-react";
import { EditIcon } from "../../../../components/common/Icons.jsx";

export default function VariablesModal({ ctx }) {
  const {
    allVariables,
    deleteVariable,
    deleteEvent,
    deletingEventId,
    deletingVariableId,
    isAdministrator,
    setEditingVariable,
    setModal,
    setVariableDeleteError,
    variableDeleteError,
  } = ctx;
  return (
    <Modal
      title="Variables"
      onClose={() => {
        if (deletingVariableId === null) {
          setModal(null);
          setVariableDeleteError("");
        }
      }}
    >
      {variableDeleteError && (
        <p className="notice error" role="alert">
          {variableDeleteError}
        </p>
      )}
      {allVariables.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Variable</th>
              <th>Key</th>
              <th>Type</th>
              <th>Boolean purpose</th>
              <th>Unit</th>
              <th>OPC UA NodeId</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>

          <tbody>
            {allVariables.map((variable) => (
              <tr key={variable.id}>
                <td>{variable.name}</td>
                <td>{variable.key}</td>
                <td>{variable.data_type}</td>
                <td>
                  {variable.signal_role === "running"
                    ? "Machine running"
                    : variable.signal_role === "cycle"
                      ? "Cycle signal"
                      : "—"}
                </td>
                <td>{variable.unit || "—"}</td>
                <td
                  title={variable.opcua_node_id || undefined}
                  style={{ maxWidth: 180, overflowWrap: "anywhere" }}
                >
                  {variable.opcua_node_id || "—"}
                </td>
                <td>{variable.is_active ? "Active" : "Inactive"}</td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap" }}>
                    <button
                    type="button"
                    className="btn-outline"
                    onClick={() => {
                      setEditingVariable(variable);
                      setModal("editVariable");
                    }}
                    disabled={deletingVariableId !== null || !isAdministrator}
                    title={!isAdministrator ? "Administrator access required to manage variables." : "Edit variable"}
                    aria-label="Edit variable"
                    >
                      <EditIcon size={16} />
                    </button>
                      <button
                      type="button"
                      className="btn-danger"
                      onClick={() => deleteVariable(variable)}
                      disabled={!isAdministrator || deletingVariableId !== null}
                      title="Delete variable permanently"
                      aria-label="Delete variable permanently"
                      style={{ color: "var(--alert)", borderColor: "var(--alert)" }}
                      >
                        <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No variables are configured for this asset.</p>
      )}

      <div className="modal-actions">
        <button
          className="btn-outline"
          onClick={() => {
            setEditingVariable(null);
            setModal("addVariable");
          }}
          disabled={deletingVariableId !== null || !isAdministrator}
          title={
            !isAdministrator
              ? "Administrator access required to manage variables."
              : undefined
          }
        >
          Add variable
        </button>

        <button
          className="btn-primary"
          onClick={() => setModal(null)}
          disabled={deletingVariableId !== null}
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
