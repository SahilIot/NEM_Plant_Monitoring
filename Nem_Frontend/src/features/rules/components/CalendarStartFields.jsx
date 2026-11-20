import React from "react";
import { RuleField } from "./RuleFormParts.jsx";

/**
 * Calendar Start of a calendar Time interval: a date and a time of day, shown side by side.
 * Shared by the rule wizard (asset, monitoring-rule and collection flows) and the parameter edit dialog, so
 * every flow collects and validates the start the same way. The two values are combined into one
 * timestamp by calendarStartConfig() in parameterRules.js.
 */
export default function CalendarStartFields({ idPrefix, startDate, startTime, onChange, disabled = false }) {
  const zone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
  })();
  return (
    <>
      <RuleField
        id={`${idPrefix}-start-date`}
        label="Calendar Start Date *"
        hint="The recurring calendar schedule is anchored to this date."
      >
        <input
          id={`${idPrefix}-start-date`}
          type="date"
          value={startDate || ""}
          onChange={(e) => onChange({ startDate: e.target.value })}
          disabled={disabled}
          required
        />
      </RuleField>
      <RuleField
        id={`${idPrefix}-start-time`}
        label="Calendar Start Time *"
        hint={`Exact start time${zone ? ` (${zone})` : ""}; progress is measured from this moment.`}
      >
        <input
          id={`${idPrefix}-start-time`}
          type="time"
          value={startTime || ""}
          onChange={(e) => onChange({ startTime: e.target.value })}
          disabled={disabled}
          required
        />
      </RuleField>
    </>
  );
}
