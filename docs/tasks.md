# Development status and verification

This is an inventory based on the source tree, not a prioritized delivery
roadmap. “Implemented” means code paths are present; it does not certify
deployment configuration or field validation.

## Implemented

- FastAPI application, PostgreSQL/SQLAlchemy persistence, Pydantic schemas,
  startup database initialization, `/api/v1` health/readiness and error
  handling.
- Local user accounts, bearer sessions, roles, password hashing, revocation,
  and Administrator account workflows.
- Asset hierarchy and CRUD; asset-owned variables and readings; single/batch
  ingestion and query endpoints.
- Monitoring rule and reusable template workflows; threshold, duration,
  runtime and cycle-counter evaluation; persisted states, alerts, events and
  lifecycle actions.
- Shared reusable labels for rules, reusable templates, collections, and
  instruction documents; create/edit assignment, compact chips, and
  server-side AND filtering. Existing document label data is imported by a
  reversible, idempotent startup migration.
- Removed legacy visibility-marker behavior for rules and maintenance.
  Startup drops those marker columns without deleting rows; previously hidden
  records use their normal lifecycle/status fields and maintenance deletion
  preserves the established schedule behavior.
- Read-only OPC UA test/read/discovery and continuous collector, mappings,
  reconnect behavior, machine cycle/runtime state, freshness handling, and
  status endpoint.
- Dashboard, asset, PLC, configuration, rule, settings, auth, and maintenance
  React routes/components; WebSocket notifications plus REST refreshes.
- Individual maintenance work, recurring calendar schedules, due alerts,
  occurrence approval/decline, details, logbook and history.
- Persistent email notification outbox and SMTP delivery worker; settings and
  backup/restore workflows.
- Demo asset/variable/reading seeding through `Nem_Backend/seed.py`.

## Known issues and discrepancies

1. **Assigned-asset authorization needs runtime testing.** Server-side scoping
   is implemented for REST and WebSocket (`services/access_scope.py`), but only
   reviewed and compiled; test direct API/WebSocket access for each role.
2. **Root README has stale security/notification statements.** It says auth,
   roles, and outbound delivery are absent; current code includes authentication
   and an email notification implementation. Reconcile documentation to
   current source and deployment settings.
3. **OPC UA secure mode is unverified against a PLC.** `Sign`/`SignAndEncrypt`
   with trusted-server-certificate validation is implemented, but the default
   remains unsecured and the secure path has not been run against a live
   server. The installed `asyncua` in the project venv is 1.1.8 while
   `requirements.txt` asks for `>=2.1`; confirm the APIs used still apply.
4. **Some rule terminology/type contracts need review.** Current rule-choice
   UI uses “Cycle Clock” while README text uses “Motor Rotation”; the model
   accepts `boolean_condition`, while `RuleCreate` does not list that literal.
   `generic` and `boolean_condition` have no evaluator and report unknown.
5. **Testing coverage is not present in the inspected tree.** No backend
   `tests/` directory or Python test source files were found. The frontend test
   script exists, but the prior `npm test` run reported zero tests. Runtime and
   integration acceptance remain unverified.

## Verification required

- Test the assignment/read-scope policy across all REST endpoints and live
  update types for Administrator, Supervisor, and Operator; update the
  product/backend documentation based on observed intended behavior.
- Against an isolated PostgreSQL database, exercise schema initialization and
  upgrade behavior with representative legacy data and a verified backup.
- Exercise the shared-label migration and rollback against an isolated
  PostgreSQL database, including existing document labels and repeat startup.
  SQLite checks covered migration idempotency, shared-name reuse,
  association-only removal, AND filtering, and the 10-label maximum; live
  PostgreSQL behavior remains unverified.
- Exercise the legacy marker-column removal against an isolated PostgreSQL
  database and verify row retention; SQLite verification should cover schedule
  reference cleanup when deleting a completed occurrence.
- Against a PLC simulator/approved test server, verify NodeId mappings,
  variable ownership/types, signal roles, source/server timestamps, data
  quality, negotiated publishing intervals, reconnection, and freshness.
- Verify cycle baseline and edge count, per-rule counter isolation, runtime
  accumulation/pause/staleness, threshold transitions, alert acknowledgement,
  clearing, and event history.
- Verify maintenance recurrence across each calendar unit, due-today/overdue
  permissions, date approval/decline, cancellation/completion, and alert
  resolution.
- In a safe SMTP environment, verify recipient selection from supervisor
  assignments, encrypted credential handling, feature flag, delivery, retries,
  and skipped/failed outbox states.
- Reconcile the root README with the code: authentication/safety posture,
  email behavior, tests actually present, route permissions, and current rule
  names.
- Validate the current UI against product requirements for responsive layouts,
  keyboard and screen-reader interaction, and error/empty states; no formal
  accessibility/browser test results were found.

## Planned functionality

No approved future feature list or product roadmap was found in the repository.
Accordingly, no unimplemented feature is labeled as planned here. The above
verification and documentation tasks concern existing behavior and known
gaps; they are not product commitments.
