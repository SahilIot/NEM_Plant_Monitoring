import { api } from "../../../../../services/api.js";

// Asset and variable actions: edit asset, delete asset, add/edit/delete variables.
export default function useAssetActions(ctx) {
  const {
    isAdministrator,
    assetId,
    setModal,
    reload,
    setEditingVariable,
    loadVariables,
    editingVariable,
    deletingAsset,
    confirm,
    asset,
    setDeletingAsset,
    setLoadError,
    navigate,
    deletingVariableId,
    setDeletingVariableId,
    setVariableDeleteError,
  } = ctx;

  const saveAsset = async (values) => {
    if (!isAdministrator) return;
    await api.patch(`/assets/${assetId}`, {
      name: values.name.trim(),
      asset_type: values.asset_type.trim(),
      description: values.description?.trim() || null,
      is_active: String(values.is_active) === "true",
    });

    setModal(null);
    await reload();
  };

  const addVariable = async (values) => {
    if (!isAdministrator) return;
    await api.post(`/assets/${assetId}/variables`, {
      name: values.name.trim(),
      key: values.key.trim(),
      data_type: values.data_type,
      signal_role:
        values.data_type === "boolean" && values.signal_role
          ? values.signal_role
          : null,
      unit: values.unit?.trim() || null,
      opcua_node_id: values.opcua_node_id?.trim() || null,
      // Data source and connector
      data_source: values.data_source || "none",
      connector_id:
        values.data_source === "connector" ? values.connector_id || null : null,
    });

    setEditingVariable(null);
    setModal("variables");
    await loadVariables();
  };

  const updateVariable = async (values) => {
    if (!isAdministrator || !editingVariable) return;
    await api.patch(`/variables/${editingVariable.id}`, {
      name: values.name.trim(),
      key: values.key.trim(),
      data_type: values.data_type,
      signal_role:
        values.data_type === "boolean" && values.signal_role
          ? values.signal_role
          : null,
      unit: values.unit?.trim() || null,
      opcua_node_id: values.opcua_node_id?.trim() || null,
    });

    setEditingVariable(null);
    setModal("variables");
    await loadVariables();
  };

  const deleteAsset = async () => {
    if (!isAdministrator || deletingAsset) return;
    const confirmed = await confirm(
      `Permanently delete asset "${asset.name}" and its asset-scoped event history? This cannot be undone. Deletion is blocked if it still has child assets, variables, readings, rules, alerts, or maintenance records.`,
      {
        title: "Permanently delete asset",
        confirmLabel: "Delete permanently",
        destructive: true,
      },
    );
    if (!confirmed) return;

    setDeletingAsset(true);
    setLoadError("");
    try {
      await api.del(`/assets/${assetId}`);
      await reload();
      navigate("/assets", { replace: true });
    } catch (error) {
      setLoadError(error.message || "Could not delete the asset.");
    } finally {
      setDeletingAsset(false);
    }
  };

  const deleteVariable = async (variable) => {
    if (!isAdministrator || deletingVariableId !== null) return;
    const confirmed = await confirm(
      `Permanently delete variable "${variable.name}"? Variables with readings, monitoring rules, alerts, or an OPC UA mapping cannot be deleted.`,
      {
        title: "Permanently delete variable",
        confirmLabel: "Delete permanently",
        destructive: true,
      },
    );
    if (!confirmed) return;

    setDeletingVariableId(variable.id);
    setVariableDeleteError("");
    try {
      await api.del(`/variables/${variable.id}`);
      await loadVariables();
    } catch (error) {
      setVariableDeleteError(
        error.message || "Could not delete this variable.",
      );
    } finally {
      setDeletingVariableId(null);
    }
  };

  return {
    saveAsset,
    addVariable,
    updateVariable,
    deleteAsset,
    deleteVariable,
  };
}
