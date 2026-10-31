# Product requirements

## Product overview

NEM Plant Monitoring is a dashboard and backend for monitoring industrial
assets, PLC readings, machine cycles/runtime, configurable rules, alerts,
events, and maintenance work. Its purpose is to make the current operational
state and required follow-up visible to authorized users. It is not a safety
interlock and does not control machinery.

This document describes requirements supported by the repository. No separate
approved roadmap or product specification was found; functionality described
as planned below is not represented as a committed future feature.

## Objectives

1. Organize machines/equipment into a browsable asset hierarchy.
2. Connect typed asset variables to read-only OPC UA signals or externally
   ingested readings.
3. Persist trustworthy measurements and evaluate rule conditions, freshness,
   cycle counts, and running time.
4. Surface active warnings/alerts, state transitions, and historical events
   without requiring full-page reloads.
5. Track planned, active, completed, and recurring maintenance against assets.
6. Provide local account authentication and role-sensitive workflows.

## Users and roles

The source defines `Administrator`, `Supervisor`, and `Operator`.

- **Administrator:** account administration, asset/variable and PLC
  configuration, system settings, and privileged actions such as permanent
  deletion and backup/restore.
- **Supervisor:** monitoring-rule and maintenance management, with limits on
  rule field edits and privileged configuration. Supervisors can submit
  reusable template/content requests for Administrator review.
- **Operator:** view operational information, acknowledge/complete active
  alerts subject to their state, and start/complete the active scheduled
  maintenance occurrence due today or overdue.

`auth.py`, `main.py`, and route-level checks enforce role capabilities. The
backend README claims assigned-asset scoping, but inspected standard read routes
and WebSocket setup do not establish that scope; asset-assignment enforcement
is therefore a verification requirement, not a confirmed product guarantee.

## Functional requirements and status

| ID | Requirement | Status in repository |
|---|---|---|
| FR-01 | Create, update, browse, organize, and move assets in a parent/child hierarchy. | Implemented |
| FR-02 | Define active typed variables per asset; attach optional OPC UA NodeIds and Boolean signal roles. | Implemented |
| FR-03 | Ingest single and batch readings, validate asset-variable ownership and types, and retrieve latest/history data. | Implemented |
| FR-04 | Subscribe read-only to configured OPC UA signals; test, discover, and read nodes; show connection state. | Implemented; live PLC/server verification required |
| FR-05 | Count cycle-signal false-to-true edges and accumulate runtime only during trustworthy true running signals. | Implemented; physical/signal behavior requires verification |
| FR-06 | Create/edit, assign/copy, evaluate, suspend, deactivate, archive, and inspect supported monitoring rules. | Implemented with type-specific limitations documented in `rules.md` |
| FR-07 | Raise and update alerts; acknowledge alerts; complete eligible alerts; preserve event history. | Implemented |
| FR-08 | Record, schedule, start, complete, cancel, and review maintenance; manage calendar recurrence and proposed next dates. | Implemented |
| FR-09 | Show operational status and affected-data refreshes in the React dashboard. | Implemented through a combination of WebSocket notifications and REST refresh/polling |
| FR-10 | Manage local accounts, roles, profile/email settings, collections/documents, and database backups through existing workflows. | Implemented to varying degrees; deployment configuration and access scope require verification |
| FR-11 | Use OPC UA to write PLC values or control/stop machinery. | Explicitly not implemented |
| FR-12 | Schedule maintenance from machine running-hour or cycle thresholds. | Not implemented |

## Principal workflows

### Monitor an asset

1. Create an asset and optional parent relationship.
2. Create typed variables for that asset and configure source mappings.
3. Ingest readings from an external API client or configure the backend OPC UA
   mappings; verify freshness and machine status.
4. Create compatible monitoring rules and configure thresholds/conditions.
5. Review the asset Current status, Overview alerts, and event history.

### Respond to an alert

1. An evaluator moves a rule state to warning/alert and creates or updates the
   associated active alert.
2. A user reviews asset, rule, message, value, and alert age.
3. Acknowledge the alert. Acknowledgement records the user and does not by
   itself clear the triggering condition.
4. Complete an alert only after acknowledgement; rule-condition alerts are
   completed as a separate user action that completes/disables the associated
   rule. Completing a maintenance due alert completes its linked current
   occurrence. Normal condition evaluation can also resolve a rule alert when
   its condition clears.

### Manage maintenance

1. Create an individual work record or a recurring calendar schedule.
2. Review current/due work in Current status and history in the Maintenance
   logbook.
3. Start, complete, or cancel permitted records; capture actual dates,
   technician, notes, parts, checklist, or completion notes as provided.
4. On recurring completion, review the proposed next due date and confirm or
   decline it. Declining a proposal does not cancel the recurring schedule.

## Non-functional requirements / constraints

- **Data integrity:** Validate value type, variable/asset relationship, finite
  numeric values, and timestamps; reject invalid or future-dated input beyond
  the accepted tolerance.
- **Freshness:** Missing, invalid, stale, future-dated, or untrusted source data
  must not be reported as a normal condition. Defaults and per-rule overrides
  are defined in `rules.md`.
- **Time:** Store and compare application timestamps as UTC. Preserve source
  timestamps where available.
- **Availability/consistency:** Persist counter/runtime state and use database
  leases to avoid duplicate scheduled evaluators/collectors across instances.
- **Security:** Authenticate `/api/v1` except health/readiness/login; enforce
  role capabilities; protect credentials and use trusted HTTPS in deployment.
  Asset assignment scope requires verification.
- **Operational safety:** No PLC write/control path. Current OPC UA transport
  settings are development-only and not suitable for untrusted networks.
- **Usability:** Provide visible status, error, empty, and loading feedback;
  preserve typed form input through refresh; support responsive layout and
  accessible focus/dialog/menu semantics already used by the UI.
- No numeric uptime, latency, throughput, browser-support, or accessibility
  conformance target is stated in source; such targets are unknown.

## Acceptance criteria grounded in current behavior

- A cycle count changes only on a valid false-to-true cycle edge, not on the
  first sample or repeated true samples.
- Running-time accumulation stops or becomes unknown when the running signal
  is false, stale, invalid, or disconnected; it does not count disconnect time.
- Rule status is unknown when required input is unavailable or untrustworthy;
  valid input below configured thresholds is normal.
- An active alert is updated for a continuing rule condition rather than
  duplicated each evaluation; acknowledgement is recorded separately from
  resolution.
- The dashboard renders the asset, rule state, alert and maintenance actions
  permitted by role, while the API independently enforces permissions.
- Recurrence uses calendar intervals and requires review of proposed dates
  when the schedule is in an approval state.
- No workflow writes to the PLC or claims safety-interlock behavior.

The repository does not include an approved user acceptance test plan or a
confirmed product roadmap. Criteria requiring real PLC, PostgreSQL, SMTP, or
role-scope integration are not verified solely by a frontend build.
