import React from "react";
import { CardLink } from "../components/UI.jsx";
import { FxIcon, GridIcon, ClipboardIcon, UploadIcon } from "../components/Icons.jsx";

export default function Configuration() {
  return (
    <div>
      <h1>Configuration</h1>
      <div className="cards-col">
        <CardLink to="/configuration/rules" icon={FxIcon} title="Monitoring Rules" desc="Create and manage your Monitoring Rules." />
        <CardLink to="/configuration/collections" icon={GridIcon} title="Monitoring Rule collections" desc="Group the individual monitoring rules, e.g. by machine type." />
        <CardLink to="/configuration/documents" icon={ClipboardIcon} title="Instructions and documents" desc="Create and manage your task descriptions for Monitoring Rules and upload supplementary documents." />
        <CardLink to="/configuration/import" icon={UploadIcon} title="Import configuration" desc="Import monitoring rules and monitoring rule collections." />
      </div>
    </div>
  );
}