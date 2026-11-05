# Implementation memory

This file records verified implementation decisions, important constraints,
and items where repository documentation and code disagree. It is not a
roadmap.

## Decisions and constraints

- PostgreSQL using `postgresql+psycopg` is the configured application database.
  `Settings` rejects other configured database URL schemes.
- Python application timestamps are aware UTC. The SQLAlchemy `UTCDateTime`
  adapter stores UTC-naive timestamps and returns aware UTC timestamps.
  Naive OPC UA timestamps are explicitly interpreted as UTC.
- Keep the out-of-order OPC UA guard. A notification older than the last
  accepted cycle/running signal is rejected. Legacy shifted timestamps must be
  investigated and repaired deliberately; a blind timezone offset is unsafe.
- The PLC integration is read-only. No application endpoint or collector
  method writes PLC values. The OPC UA client supports signed/encrypted
  connections with server-certificate validation, but defaults to the
  unsecured mode for compatibility; production must set a secure mode. Secure
  mode has not been verified against a live PLC.
- Machine cycle/runtime state and rule-specific counters are persisted. Rule
  counters are isolated per rule and asset so a new rule does not reset or
  inherit another rule's counter.
- Database initialization creates missing SQLAlchemy tables and applies
  additive startup updates in code. The repository instructions advise backup
  before schema changes. Existing database files in the workspace are not
  proof of the active deployment database or schema.
- Shared labels use the `labels` catalog and many-to-many links for monitoring
  rules, reusable rule templates, collections, and instruction documents.
  `001_shared_labels` migrates existing document JSON labels into the shared
  catalog, clears the legacy JSON values after import, and restores document
  labels to that column on downgrade. The migration is invoked during database
  initialization; a temporary local check (run on SQLite, which the application no longer supports) verified repeat initialization,
  reuse/filtering, the 10-label limit, and rollback. A live PostgreSQL upgrade
  has not been exercised.
- Startup drops the legacy rule and maintenance visibility-marker columns
  without deleting rows. Rows previously hidden by those markers now follow
  their existing lifecycle/status fields in normal listings. Deleting a
  completed scheduled occurrence retains its schedule; deleting a
  noncompleted scheduled occurrence keeps the pre-existing explicit
  delete-the-schedule behavior.
- Shared-rule visibility is Administrator-controlled only. The Supervisor
  visibility-request feature was removed (routes, model, schemas, UI);
  `/api/v1/rule-visibility-requests` answers 404. Visibility, editing
  (Supervisor threshold-only) and asset access are separate checks, each
  enforced in the backend. Unknown stored visibility values are treated as
  `admin_only`.
- Startup upgrades for audit columns, rule visibility and request removal are
  PostgreSQL-only, verify real definitions (foreign keys, indexes, constraint
  scope) and never delete request records or visibility history. See
  `docs/architecture.md`, "Startup schema upgrades". SQLite support was
  removed from the migration code, `shared_labels.py` and the role guard.
- Demo data created by `Nem_Backend/seed.py` is explicitly marked as simulated
  and must not be interpreted as live equipment telemetry.

## Current discrepancies and verification items

1. **Access scope is implemented but not runtime-tested.** Supervisors and
   Operators are limited to assigned assets (and descendants) by
   `services/access_scope.py`, applied in the REST routes and the WebSocket
   (`authorized_asset_ids`, per-message re-check). Users with no assignments see
   nothing. Verified by code review and compilation only; exercise every role
   against a real database before relying on it.
2. **Root README was reconciled with the code.** It now describes local
   bearer sessions and roles, the email outbox, Administrator-controlled
   shared-rule visibility, and the current project layout. Production SMTP
   delivery still requires environment verification.
3. **Email behavior is conditional.** The outbox path is implemented, but
   delivery depends on the email feature setting, saved SMTP configuration,
   valid supervisor assignment/email addresses, and SMTP reachability. Pending
   jobs are revalidated at delivery time against the effective assignments:
   direct asset selections take precedence, with parent assignments inherited
   only when no direct selections exist. Removed or superseded recipients are
   skipped. Actual delivery still requires a safe SMTP verification.
4. **Maintenance recurrence is calendar-based.** The schema and service support
   days, weeks, months, and years plus confirm/decline of proposed dates.
   Running-hour/cycle-based maintenance scheduling is not implemented in the
   inspected code.
5. **Current terminology varies.** Current asset rule choices include “Cycle
   Clock” and “Motor Running Time”; some README text uses “Motor Rotation”.
   Preserve UI labels unless product owners confirm a terminology change.
6. **Test coverage is not established by this checkout.** `Nem_Backend` has no
   `tests/` directory or `*test*.py` source files in the inspected tree.
   `Nem_Frontend`'s `npm test` command is `node --test`; the prior interactive
   maintenance-fix session observed zero tests. A successful build from that
   session verified compilation, not runtime behavior or acceptance coverage.
7. **Shared labels have local verification only.** Case/whitespace
   normalization, duplicate reuse, AND filtering, document-label migration
   and rollback, and the 10-label maximum passed temporary local checks (run on SQLite, since removed from the codebase).
   The production PostgreSQL migration and role-specific API/UI flows still
   require verification against an isolated deployment-like environment.

## Latest verification status

Verified: Python compilation and internal import resolution for the backend;
Babel parsing and local import/export resolution for every frontend source
file; the visibility, authorization, history and threshold-only editing logic
against an in-memory database; and the three startup upgrades against a real
PostgreSQL 16.15 server (a scratch instance, not the deployed one).

Not verified: `npm run build` and a backend startup after the latest changes, real
HTTP/middleware behavior (including the 404 for removed request routes),
the rendered UI, a live login, PLC or SMTP, and the upgrades against the
deployed database. Run `npm run build` and restart the backend before relying
on them.

## Instructions, libraries and import/export (latest session)

Implemented but **not run**: the backend changes (`entry_type`, `asset_id` and
audit columns on `instruction_documents`, document file add/replace/remove,
export filters and summary) and the redesigned Documents, Create Instruction,
Rule Library, Collection Library and Import/Export pages were only
syntax-checked (Python `ast`, Babel). The additive `entry_type` upgrade SQL was
run against a scratch PostgreSQL 16 instance. `npm run build` could not be run
(Windows `node_modules` in a Linux sandbox) and the new API behaviour has not
been exercised over HTTP. Design facts worth keeping: a collection owns its
rules (`collection_id`, max five), so "add/remove library rule to collection"
is intentionally absent; `GET /collections` returns no creation date;
Instruction content lives in `description`.

## Recently corrected UI root cause

The Current status maintenance details modal passed `now={clockNow}` from
`features/assets/components/CurrentMaintenanceCards.jsx` without defining
`clockNow`. Opening **View maintenance** for an in-progress item raised
`ReferenceError`. The component now has a clock state and starts a one-second
timer only while the selected record is in progress; the timer is cleaned up
when the selection/status changes. The same value feeds
`MaintenanceDetails` for elapsed-duration display. The preceding session's
frontend production build succeeded after the correction.

## Verification still environment-dependent

- Confirm actual PostgreSQL schema/version and backup before applying
  startup-initialized schema updates.
- Confirm each deployed OPC UA NodeId, variable ownership/type, role mapping,
  source timestamps, quality, negotiated publishing interval, and PLC-approved
  network security.
- Exercise fresh/stale/reordered samples, false-to-true cycle edges, running
  timer pauses, alert acknowledgement/resolution, maintenance due alerts, and
  recurrence approvals against a controlled database and simulator.
- Exercise Administrator/Supervisor/Operator API permissions and asset
  assignment scope (REST and WebSocket) against a real database.
- Exercise OPC UA `Sign`/`SignAndEncrypt` against the target PLC (policy
  support, trusted certificates, expiry handling).
- Verify SMTP credentials, supervisor recipients, retries, and actual message
  delivery in a safe test environment.
