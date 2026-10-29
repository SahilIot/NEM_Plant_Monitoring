import React from "react";

export default function AssetTabs({ ctx }) {
  const { setTab, tab } = ctx;
  return (
    <div className="tabs" role="tablist">
      {[
        ["status", "Current status"],
        ["logbook", "Maintenance logbook"],
        ["events", "Event log"],
      ].map(([key, label]) => (
        <button
          key={key}
          role="tab"
          aria-selected={tab === key}
          className={tab === key ? "active" : ""}
          onClick={() => setTab(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
