import React from "react";
import { Navigate, useOutletContext } from "react-router-dom";
import { EmptyState } from "../components/UI.jsx";

export default function AssetsIndex() {
  const { assets } = useOutletContext();
  if (assets.length) return <Navigate to={`/assets/${assets[0].id}`} replace />;
  return <div className="panel-gray"><EmptyState title="No assets available" /></div>;
}