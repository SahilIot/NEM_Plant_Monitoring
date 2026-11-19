import React from "react";
import { useNavigate } from "react-router-dom";
import ImportConfigurationPanel from "./ImportConfigurationPanel.jsx";
import { BackButton } from "../../../components/common/NavButtons.jsx";

export default function ImportConfigurationPage() {
  const nav = useNavigate();
  return (
    <div className="xfer-page">
        <BackButton label="Configuration" onClick={() => nav("/configuration")} />
      <div className="xfer-head">
        <h1 className="page-title">Import configuration</h1>
      </div>

      <ImportConfigurationPanel />
    </div>
  );
}
