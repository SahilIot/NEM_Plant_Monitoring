import React from "react";
import { HEALTH_LABEL } from "./constants.js";
import AssetSupervisors from "../../components/AssetSupervisors.jsx";
import {
  AssetIcon,
  ExternalIcon,
  GearIcon,
} from "../../../../components/common/Icons.jsx";

export default function AssetHeader({ ctx }) {
  const {
    asset,
    deleteAsset,
    deletingAsset,
    isAdministrator,
    isOperator,
    isSupervisor,
    setModal,
  } = ctx;
  const health = asset.health || "ok";
  return (
    <div className="asset-head">
      <div>
        <h1 className="page-title">{asset.name}</h1>

        <div className="asset-sub">
          <span className={"health-chip " + health}>
            <i className={"lamp " + health} />
            {HEALTH_LABEL[health]}
          </span>

          <span className="muted">{asset.asset_type}</span>

          {asset.description && (
            <span className="muted">{asset.description}</span>
          )}
        </div>
        {isAdministrator && <AssetSupervisors assetId={asset.id} />}
      </div>

      <div className="asset-links">
        <button
          className="link-btn"
          onClick={() => setModal("settings")}
          disabled={!isAdministrator}
          title={
            !isAdministrator
              ? "Administrator access required to manage assets."
              : undefined
          }
        >
          <GearIcon size={17} /> Asset settings
        </button>

        <button
          className="link-btn danger-link"
          onClick={deleteAsset}
          disabled={deletingAsset || !isAdministrator}
          title={
            !isAdministrator
              ? "Administrator access required to manage assets."
              : "Permanently delete this asset if it has no related records"
          }
        >
          {deletingAsset ? "Deleting asset…" : "Delete asset"}
        </button>
        <button
          type="button"
          className="link-btn"
          disabled={isSupervisor || isOperator}
          title={
            isSupervisor || isOperator
              ? "Supervisors and Operators cannot manage variables."
              : "View configured variables; only Administrators can change them."
          }
          onClick={() => {
            if (isSupervisor || isOperator) return;
            setModal("variables");
          }}
        >
          <AssetIcon size={17} /> Variables
        </button>
        <button
          className="icon-outline"
          title="Open in new tab"
          aria-label="Open in new tab"
          onClick={() => window.open(window.location.href, "_blank")}
        >
          <ExternalIcon size={18} />
        </button>
      </div>
    </div>
  );
}
