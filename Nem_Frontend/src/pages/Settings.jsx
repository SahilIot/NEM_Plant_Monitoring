import React from "react";
import { CardLink } from "../components/UI.jsx";
import { UserIcon, MailIcon, LinkIcon, BookmarkIcon, BackupIcon } from "../components/Icons.jsx";

export default function Settings() {
  return (
    <div>
      <h1>Settings</h1>
      <div className="cards-col">
        <CardLink to="/settings/user" icon={UserIcon} title="User information" desc="Show user profile." />
        <CardLink to="/settings/email" icon={MailIcon} title="Email server settings" desc="Set up the address and credentials for an outgoing email service to send notifications." />
        <CardLink to="/settings/analytics" icon={LinkIcon} title="Analytics extensions" desc="Set up Databus connection and detect analytics extensions" />
        <CardLink to="/settings/usage" icon={BookmarkIcon} title="Usage information" desc="Information on resources in use." />
        <CardLink to="/settings/backup" icon={BackupIcon} title="Backup and restore" desc="Backup or restore the app." />
      </div>
    </div>
  );
}