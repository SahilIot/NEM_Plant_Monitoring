import React from "react";
import { EmptyState } from "../../../components/common/UI.jsx";
import AssetBanners from "./asset-detail/AssetBanners.jsx";
import AssetHeader from "./asset-detail/AssetHeader.jsx";
import AssetTabs from "./asset-detail/AssetTabs.jsx";
import StatusTab from "./asset-detail/StatusTab.jsx";
import LogbookTab from "./asset-detail/LogbookTab.jsx";
import EventsTab from "./asset-detail/EventsTab.jsx";
import EventDetailsModal from "./asset-detail/EventDetailsModal.jsx";
import RuleDialogs from "./asset-detail/RuleDialogs.jsx";
import MaintenanceEntryModal from "./asset-detail/MaintenanceEntryModal.jsx";
import AssetFormModals from "./asset-detail/AssetFormModals.jsx";
import VariablesModal from "./asset-detail/VariablesModal.jsx";
import PredefinedRulesModal from "../../rules/components/PredefinedRulesModal.jsx";
import useAssetDetail from "./asset-detail/useAssetDetail.js";
import "./AssetDetail.css";

export default function AssetDetail() {
  const ctx = useAssetDetail();
  const {
    asset,
    assetId,
    assetsLoaded,
    modal,
    refreshAll,
    selectedEntry,
    selectedEvent,
    setActionNotice,
    setList,
    setShowPredefinedRules,
    showEventDetails,
    showPredefinedRules,
    tab,
  } = ctx;

  if (!asset) {
    return assetsLoaded ? (
      <div className="panel">
        <EmptyState
          title="This asset was not found"
          lines={[
            "It may have been removed. Pick another asset from the panel.",
          ]}
        />
      </div>
    ) : (
      <div className="loading" role="status">
        Loading…
      </div>
    );
  }

  return (
    <div className="asset-page">
      <AssetBanners ctx={ctx} />

      <AssetHeader ctx={ctx} />

      <AssetTabs ctx={ctx} />

      {tab === "status" && <StatusTab ctx={ctx} />}

      {tab === "logbook" && <LogbookTab ctx={ctx} />}

      {/* Event Log */}
      {tab === "events" && <EventsTab ctx={ctx} />}

      {showEventDetails && selectedEvent && <EventDetailsModal ctx={ctx} />}

      <RuleDialogs ctx={ctx} />

      {tab === "logbook" && modal === "view" && selectedEntry && (
        <MaintenanceEntryModal ctx={ctx} />
      )}

      <AssetFormModals ctx={ctx} />

      {modal === "variables" && <VariablesModal ctx={ctx} />}

      {showPredefinedRules && (
        <PredefinedRulesModal
          assetId={assetId}
          onClose={() => setShowPredefinedRules(false)}
          onAssigned={async (result) => {
            setShowPredefinedRules(false);
            setList("not_activated");
            await refreshAll();
            const assigned = result.created?.length || 0;
            const existing = result.already_assigned?.length || 0;
            setActionNotice(
              `${assigned} predefined rule(s) assigned and created inactive.` +
                (existing ? ` ${existing} rule(s) were already assigned.` : ""),
            );
          }}
        />
      )}
    </div>
  );
}
