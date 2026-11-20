# Rule operations: manual reset, notifications, component identifiers, event export

This document describes behaviour that exists in the code. Authoritative
sources: `Nem_Backend/app/api/routes/rule_parameters.py`,
`app/services/rule_maintenance.py`, `notification_settings.py`,
`component_identifier.py`, `email_notifications.py`,
`app/api/routes/frontend_compat.py`, and shared names in
`app/core/constants.py`. All endpoints are under `/api/v1`; use `/docs` for
exact schemas.

## Manual interval reset

An interval parameter of an interval-based rule can be reset by hand, without
completing maintenance.

| Endpoint | Purpose |
|---|---|
| `POST /rules/{rule_id}/parameters/{parameter_id}/reset-progress` | Reset one interval parameter. |
| `POST /rules/{rule_id}/reset-progress` | Reset every eligible interval of the rule in one transaction; other parameters are untouched. |

Both accept `{"dry_run": true}` to preview what would be reset or skipped.
Only **Administrators and Supervisors** may reset (others get 403). A parameter
is skipped (409 for the single-parameter endpoint) when it is not an interval
parameter of an interval-based rule, the rule is not active, the parameter is
not active, or maintenance for that interval is already in progress (complete
it instead).

A reset sets the interval's cycle baseline to now, returns its state to Normal
with a value of 0, and resolves its active alerts (an `alert_resolved` event
records who reset it). An unstarted maintenance schedule for that interval is
cancelled with cancellation kind `progress_reset` and a fresh one is created
for the new cycle, so nothing is duplicated.

## Completing rule-generated maintenance

Completing maintenance that a rule generated requires an explicit
`reset_progress` value (`true` or `false`; it is never defaulted and is
rejected for other maintenance kinds). It applies to
`POST /maintenance/{id}/complete` and `POST /alerts/{id}/complete`.

- **Reset & Start Next Cycle** (`reset_progress: true`): the schedule's
  `progress_reset` becomes `reset`; progress restarts and the next cycle is
  created. For **Calendar Time** parameters the next cycle is derived by the
  calendar from the actual completion time (Due and Overdue are the configured
  intervals after that moment); other interval types use the cycle baseline.
- **Complete Without Reset** (`reset_progress: false`): `progress_reset`
  becomes `retained`; accumulated progress is kept, no new cycle starts, and a
  `maintenance_completed_without_reset` event is recorded.

Completion registration fields (`actual_completed_at`, `performed_by`, `notes`,
`completion_notes`, `parts_used`, `checklist`, `actual_values`) are described in
the README section "Completion registration".

## Notification settings per rule

`POST /rules/{rule_id}/notification-settings` (Administrator or Supervisor with
access to the rule) stores settings in `rules.parameters["notifications"]`:

```json
{"warning": {"enabled": true, "message": null},
 "alert":   {"enabled": true, "message": "Call the shift lead"}}
```

- Only `warning` and `alert` can be configured; there is no Info severity.
- A rule without the key behaves as before: both enabled, default message.
- The custom message is trimmed, line breaks become spaces, control characters
  are rejected, and it is limited to 500 characters (`MAX_CUSTOM_MESSAGE_LENGTH`).
  Blank means "use the default message".
- Maintenance-ready notices are never gated by these settings.
- Saving settings does not change the rule, its parameters, activation state or
  alerts, and a settings-only difference does not make two rules different when
  duplicates are detected. A `notification_settings_changed` event is recorded.
- Delivery is queued as one `EmailNotification` per alert, severity and
  recipient (unique), so repeated evaluations do not send duplicates; recipients
  are the assigned Supervisors (see the README access-control notes).

## Component identifiers

`POST /rules/{rule_id}/component-identifier` (Administrator or Supervisor)
sets an optional tag such as `P-101` on a rule assigned to an asset. It is
stored on the asset's own rule (`MonitoringRule.component_identifier`), not on a
shared rule. Whitespace is trimmed and collapsed; blank clears it; the maximum is
100 characters; allowed characters are letters, numbers, spaces and
`. , : ; # / \ ( ) + & ' - _`. It is also accepted when creating, assigning or
copying rules. Changes record a `component_identifier_changed` event.

## Event log filtering and export

- `GET /assets/{asset_id}/events` lists events; `component_identifier` filters
  case-insensitively by the rule's identifier.
- `GET /assets/{asset_id}/events/export?format=csv|json` exports with the same
  filters (`event_type`, `rule_id`, `severity`, `component_identifier`,
  `start_time`, `end_time`). `start_time` must not be later than `end_time`.
  The export includes a `component_identifier` column.
- The Event log tab in the UI also offers an **Excel** (`.xlsx`) export, built
  in the browser from the displayed rows.

## Rule suspension and activation

`POST /rules/{rule_id}/suspend` and `/resume` are Administrator only.
`POST /rules/{rule_id}/parameters/{parameter_id}/lifecycle` changes a single
parameter's lifecycle. A parameter's lifecycle value is `active`, `suspended`
or `deactivated` (database check constraint); a rule's lifecycle value is `in_progress`,
`suspended`, `deactivated` or `completed` (`ck_nem_monitoring_rules_lifecycle_status`
in `app/models/rule.py`). Names are in `app/core/constants.py`.

## Document deletion protection

`DELETE /documents/{id}` (Administrator only) returns **409** with the list of
references when the document is still used by a monitoring rule, shared rule,
maintenance schedule or rule request. The last file of a referenced document
cannot be removed either. Nothing is changed on a 409.

## Constants

Shared backend values (rule types, parameter kinds, statuses, severities, roles,
event types, error messages) are defined once in `Nem_Backend/app/core/constants.py`
and imported where needed. Values stored in the database or returned by the API
are unchanged by that consolidation. The frontend keeps its own copies of the
strings it needs; it does not import Python.
