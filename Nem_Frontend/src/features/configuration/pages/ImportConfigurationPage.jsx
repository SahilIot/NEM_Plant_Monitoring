import React from "react";
import { useNavigate } from "react-router-dom";
import { BackIcon } from "../../../components/common/Icons.jsx";
import ImportConfigurationPanel from "./ImportConfigurationPanel.jsx";

export default function ImportConfigurationPage() {
  const nav = useNavigate();
  return (
    <div className="xfer-page">
      <div className="xfer-head">
        <button
          type="button"
          className="link-btn"
          onClick={() => nav("/configuration")}
        >
          <BackIcon size={14} /> Back
        </button>

        <h1 className="page-title">Import configuration</h1>
      </div>

      <ImportConfigurationPanel />
    </div>
  );
}
