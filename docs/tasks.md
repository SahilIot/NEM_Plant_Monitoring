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
- Administrator-controlled shared-rule visibility (Admin Only, Specific
  Supervisors) with backend-enforced checks, Supervisor
  threshold-only editing, field-level rule history and visibility history. The
  visibility-request workflow was removed.
- Shared rules are a single source of truth (one threshold, edits propagate to
  every asset, confirmation in the UI); Admin Only / Specific Supervisors are
  the only visibilities (`all_supervisors` retired by a startup migration).
- Administrator-only versioned JSON export / preview / import of monitoring
  rules, collections and maintenance definitions (`/api/v1/config-transfer/*`).
- Hardened, idempotent startup upgrades for audit columns, rule visibility and
  request removal (PostgreSQL only; see `docs/architecture.md`).
- Codebase cleanup: unused imports, functions, components, icons, styles and
  debug logging removed; no API contract or behavior changed.
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
2. **Root README and docs were reconciled** with the current code
   (authentication, roles, email, shared-rule visibility, project layout).
   Re-check them whenever behavior changes.
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
  Temporary local checks (SQLite, since removed from the codebase) covered migration idempotency, shared-name reuse,
  association-only removal, AND filtering, and the 10-label maximum; live
  PostgreSQL behavior remains unverified.
- Exercise the legacy marker-column removal against an isolated PostgreSQL
  database and verify row retention; also verify schedule reference cleanup
  when deleting a completed occurrence.
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
- Run `npm run build` and start the backend after the latest cleanup and
  migration changes; exercise the removed request routes (404), shared-rule
  visibility for each role over real HTTP, and the startup upgrades on a copy of
  the production database.
- Validate the current UI against product requirements for responsive layouts,
  keyboard and screen-reader interaction, and error/empty states; no formal
  accessibility/browser test results were found.

## Cleanup candidates (deliberately left unchanged)

Found during the cleanup but not removed because they could not be confirmed
unnecessary:

- `Nem_Frontend/src/features/assets/pages/ExportConfigurationPage.jsx` is not
  imported anywhere; the router uses the near-identical copy in
  `features/configuration/pages/`.
- Backend routes with no frontend caller (possible external integrations, see
  `.postman`): asset `children`, `hierarchy`, `move` and `rules/time|usage`;
  document file `download`/`view`; maintenance `cancel` and `permanent`;
  `monitoring-status`; `notifications/email/summary`; `plc/discover/{job_id}`;
  reading `latest` per asset and per variable.
- About 100 CSS classes not referenced as literals in JavaScript (many may be
  built dynamically), and a few write-only React state variables.
- Dependencies: frontend `xlsx` (only `@e965/xlsx` is imported); backend
  `python-dotenv`, `httpx` and `pytest` are not imported by application code.
- `LOG_LEVEL` in `.env` is not read by `config.py`; the `npm test` script has
  no tests; local SQLite files (`*.db`) in `Nem_Backend` are leftovers.
- Generic non-PostgreSQL `else` branches remain in `_initialize_schema`.

## Planned functionality

No approved future feature list or product roadmap was found in the repository.
Accordingly, no unimplemented feature is labeled as planned here. The above
verification and documentation tasks concern existing behavior and known
gaps; they are not product commitments.
