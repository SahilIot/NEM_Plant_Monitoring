import React from "react";
import RuleToolbar from "./RuleToolbar.jsx";
import RuleList from "./RuleList.jsx";
import CurrentMaintenanceCards from "../../components/CurrentMaintenanceCards.jsx";

export default function StatusTab({ ctx }) {
  const {
    assetId,
    list,
    refreshMaintenanceData,
    setCompletedMaintenanceCount,
    setList,
  } = ctx;
  return (
    <>
      <RuleToolbar ctx={ctx} />

      <RuleList ctx={ctx} />
      <CurrentMaintenanceCards
        assetId={assetId}
        onChanged={refreshMaintenanceData}
        onCompletedRecordsCount={setCompletedMaintenanceCount}
        onCompleted={() => setList("not_activated")}
        showCompleted={list === "not_activated"}
      />
    </>
  );
}
