import React from "react";
import { Navigate, useOutletContext } from "react-router-dom";
import { EmptyState } from "../../../components/common/UI.jsx";

export default function AssetsIndex() {
  const { assets, assetsLoaded } = useOutletContext();
  if (!assetsLoaded) return <div className="loading" role="status">Loading assets…</div>;
  
 const first = assets.find((asset) => asset.parent_asset_id == null) || assets[0];
  if (first) return <Navigate to={`/assets/${first.id}`} replace />;
  return (
    <div className="panel">
      <EmptyState
        title="No assets yet"
        lines={["Use “Add asset” in the asset panel to create the first machine."]}
      />
    </div>
  );
}
