# Maintenance lifecycle

This document summarizes how maintenance is modelled and which actions are
allowed. The authoritative code is `Nem_Backend/app/api/routes/maintenance.py`,
`app/services/maintenance_schedule.py`, `maintenance_progress.py` and
`rule_maintenance.py`; the UI is under `Nem_Frontend/src/features/assets`.
Business rules in prose are also in [rules.md](rules.md#maintenance-rules).

## Records and schedules

- A **maintenance record** (`nem_maintenance_records`) is one piece of work.
  Statuses: `planned`, `in_progress`, `completed`, `cancelled`.
- A **maintenance schedule** (`nem_maintenance_schedules`) plans recurring or
  signal-driven work for one asset. Schedule statuses include `active`,
  `paused`, `completed` and `cancelled`. A schedule status is separate from
  the status of its records: cancelling a record does not by itself describe the
  schedule and completing a schedule's last record may leave the schedule
  `active` (runtime/usage) or `completed` (no next cycle).
- Schedule modes (`schedule_mode`): `calendar`, `runtime`, `usage` and `rule`.
  A **rule** schedule is created and controlled by an interval-based monitoring
  rule parameter (`rule_maintenance.py`); its record carries `rule_context`.
  Rule schedules show a RULE badge in the UI. Their eligibility is `not_due`
  or `ready`; Start is accepted only when the rule reports Due (backend check
  `ensure_startable`).
- The next cycle of a rule parameter creates a **new** schedule row. A unique
  partial index (`uq_maintenance_schedule_open_rule_parameter`) allows only one
  open schedule per rule parameter.

## Where items appear in the UI (Asset detail -> Maintenance logbook)

- **Schedules** tab: active work only. A schedule whose status is `completed`
  or `cancelled` is not listed here.
- **Jobs & History** tab: Completed and Cancelled records, planned work that is
  not yet due, and Cancelled schedules (with their cancellation date, who
  cancelled them, reason when one exists, and record count).
- **Current status**: due-today and in-progress scheduled work.

## Cancellation

- A schedule is cancelled by changing its status to `cancelled`
  (`PATCH /maintenance/schedules/{id}`) or by cancelling its record
  (`POST /maintenance/{id}/cancel`). Both cancel the planned occurrence, clear
  the schedule's current-occurrence pointer, resolve its active due alerts and
  record `cancelled_at`, `cancelled_by_*` and `cancellation_kind`.
- A cancelled schedule cannot be reactivated.
- Rule-generated maintenance cannot be cancelled through the record-cancel
  endpoint. If its rule or parameter was deleted, an Administrator cancels the
  schedule with `POST /maintenance/schedules/{id}/cancel-unavailable` (a reason of at
  least three characters is required). Rule changes that make a rule
  ineligible also close its unstarted (Not Due) schedules automatically.

## Deletion (Administrator only)

Permanent deletion is enforced on the backend with
`require_roles("Administrator")`; Supervisors and Operators get 403 and the UI
does not show the Delete action to them.

| Item | Result |
|---|---|
| Ordinary Completed or Cancelled record | Deleted (`DELETE /maintenance/{id}`); schedule, other records, alerts and shared documents are kept; its schedule's current-occurrence pointer is cleared when it pointed at it. |
| Ordinary Planned record that belongs to a schedule | Deletes the whole schedule series with its records and alerts; refused if a record is in progress. The schedule's alerts are removed with it. |
| In-progress record or schedule with an in-progress record | Refused (409). |
| Ordinary Cancelled schedule | Deleted (`DELETE /maintenance/schedules/{id}/permanent`) together with its own records and alerts. |
| Ordinary schedule that is not cancelled and has records | Refused (409); cancel it instead. |
| Rule-generated Completed or Cancelled record | Deleted (single record). |
| Rule-generated Planned or In-progress record | Refused (409); controlled by the rule. |
| Cancelled rule schedule with only finished records | Deleted. Refused while any record is unfinished or an alert is active. |
| Active rule schedule | Refused (409). |

Deleting maintenance never changes rule counters, a rule's
`maintenance_scheduled_at` marker or the creation of future rule cycles; these
live on rule state, which the delete code does not touch. Documents are
referenced from a schedule by id (`instruction_document_ids`), so a delete
cannot remove a shared document.

Each delete writes a `maintenance_record_permanently_deleted` or
`maintenance_schedule_permanently_deleted` event and publishes
`maintenance.deleted` after commit (see
[realtime-updates.md](realtime-updates.md)).

## Role limits in short

- Administrators: all actions above.
- Supervisors: manage maintenance within their assigned assets, but not
  permanent deletion.
- Operators: start and complete only the active scheduled occurrence that is
  due today or overdue (or the active occurrence of a runtime/usage/rule
  schedule that is ready), subject to backend checks.
