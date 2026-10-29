import React from "react";
import MaintenancePanel from "../../components/MaintenancePanel.jsx";
import MaintenanceLogNotes from "./MaintenanceLogNotes.jsx";

export default function LogbookTab({ ctx }) {
  const { assetId, refreshMaintenanceData } = ctx;
  return (
    <>
      <MaintenancePanel assetId={assetId} onChanged={refreshMaintenanceData} />

      <MaintenanceLogNotes ctx={ctx} />
    </>
  );
}
