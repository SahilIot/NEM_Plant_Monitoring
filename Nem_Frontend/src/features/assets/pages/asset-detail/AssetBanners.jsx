import React from "react";

export default function AssetBanners({ ctx }) {
  const {
    actionNotice,
    bulkSaving,
    loadError,
    refreshAll,
    setActionNotice,
    setLoadError,
  } = ctx;
  return (
    <>
      {loadError && (
        <div className="banner error" role="alert">
          <p>{loadError}</p>
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              setLoadError("");
              refreshAll();
            }}
          >
            Dismiss and retry
          </button>
        </div>
      )}
      {actionNotice && (
        <div className="banner success" role="status">
          <p>{actionNotice}</p>
          <button
            type="button"
            className="btn-outline"
            onClick={() => setActionNotice("")}
          >
            Dismiss
          </button>
        </div>
      )}
      {bulkSaving && (
        <div className="banner" role="status" aria-live="polite">
          <p>Updating rule states and resolving alerts where required…</p>
        </div>
      )}
    </>
  );
}
