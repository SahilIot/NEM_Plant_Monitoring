# Architecture

## System overview

NEM Plant Monitoring is a browser-based React dashboard backed by a FastAPI
service and PostgreSQL. The backend accepts readings through REST endpoints or
a read-only OPC UA client. It persists readings, updates machine/rule state,
evaluates rules, records alerts and events, and exposes status to the dashboard.
There is no PLC write or machine-control path.

```text
PLC (OPC UA, read-only) ──┐
External reading client ──┴─> FastAPI /api/v1 ──> SQLAlchemy ──> PostgreSQL
                                      │                 │
                                      ├─ monitoring, maintenance and email tasks
                                      └─ committed-change/status WebSocket
                                                 │
React + Vite dashboard <── REST refreshes / WebSocket notifications
```

## Project structure

```text
NEM_Plant_Monitoring/
  README.md                         Setup and functionality guide
  docs/                             Architecture, design, product, rules, memory and task docs
  .postman/                         Postman workspace registration
  Nem_Backend/
    app/
      main.py                       App factory: HTTP middleware and role gate, background tasks,
                                    WebSocket, router registration, /ui static mount
      api/routes/
        auth.py                     Login, sessions, user administration, role dependencies
        assets.py                   Asset hierarchy CRUD and move
        variables.py                Asset-owned variables
        readings.py                 Single/batch ingestion, latest and history queries
        rules.py                    Asset-specific rule creation, listing and update
        rule_visibility.py          Admin-controlled shared-rule visibility, history, assignments
        monitoring.py               Evaluation, status, alerts, events
        maintenance.py              Work records, recurring schedules, occurrences
        plc.py                      OPC UA status, test, discovery, one-shot read
        notifications.py            Supervisor assignments and email delivery summary
        dashboard.py                Dashboard summary
        frontend_compat.py          Dashboard workflows: rule templates and suggestions, collections,
                                    documents, settings, import/export, lifecycle actions, backups
      core/                         config.py (environment settings), labels.py (label normalization)
      db/
        base.py, session.py         Declarative base, session factory, UTCDateTime
        init_db.py                  Startup schema creation and idempotent upgrades
        migrations/shared_labels.py Versioned shared-labels migration
      models/                       asset, variable, reading, rule, rule_visibility, maintenance,
                                    machine_monitoring, notification, auth, labels, frontend_data,
                                    audit (+ audit_mixin)
      schemas/                      Pydantic request/response models per area
      services/
        reading_ingestion.py        Validated single/batch reading ingestion
        monitoring_engine.py        Rule evaluation, alerts, events, lifecycle helpers
        opcua_client.py             Read-only OPC UA client, transport security
        opcua_collector.py          Reconnecting subscription collector
        access_scope.py             Asset-assignment scoping for REST and WebSocket
        rule_visibility.py          Shared-rule visibility, edit permission, change history
        maintenance_schedule.py     Calendar recurrence and due-date logic
        email_notifications.py      Email outbox and SMTP delivery
        live_updates.py             Committed-change WebSocket hub
        auth_security.py            Password hashing, sessions
        labels.py                   Shared label catalog service
        frontend_backup.py          Dashboard backup/restore snapshots
    scripts/create_admin.py         Interactive first-Administrator setup
    seed.py                         Idempotent simulated demo data
    requirements.txt
    (local only, git-ignored: .env, certificates/, backups/, uploads/, .venv/)
  Nem_Frontend/
    index.html, vite.config.js, package.json
    public/logo.png
    scripts/add-react-imports.js    Adds `import React` to JSX files (npm run add-react-imports)
    src/
      app/                          App.jsx (routes), main.jsx (router at /ui, providers)
      components/common/            Layout, Brand, GroupedMenu, LabelsField, Icons, UI controls
      features/
        dashboard/pages/            Home (Overview)
        assets/                     components/ (tree, supervisors, maintenance panel, copy rules),
                                    pages/ (asset index/detail, rule and maintenance creation),
                                    rules/monitoringRuleFlow.js
        plc/                        pages/Plc.jsx, styles/Plc.css
        rules/                      components/PredefinedRulesModal, pages/AlertRules, RuleCreatePage
        configuration/pages/        Rule library, visibility dialog, collections, documents,
                                    instructions, import/export
        settings/pages/             Profile, email, usage, backup/restore
        auth/                       AuthContext, LoginPage, AdminUsersPage
      services/                     api.js (REST client), liveUpdates.js (WebSocket client)
      styles/global.css             Light/dark theme tokens and layout
      utils/                        config.js, format.js, navigation.js
```

## Runtime and source layout

- `Nem_Backend/app/main.py` creates the FastAPI application, engine, session
  factory, OPC UA collector, background tasks, HTTP middleware, WebSockets,
  route registrations, and optional production static-file mount.
- `Nem_Backend/app/core/config.py` loads environment-backed `Settings` from
  `Nem_Backend/.env`. Database URLs must use `postgresql+psycopg` and name a
  database. Configuration includes scheduler intervals, stale-data limits,
  OPC UA settings, email delivery, CORS, and backup location.
- `Nem_Backend/app/db/` provides SQLAlchemy's declarative base, session factory,
  UTC datetime conversion, and startup database initialization.
- `Nem_Backend/app/models/` defines operational and dashboard persistence;
  `Nem_Backend/app/schemas/` defines Pydantic request/response validation.
- `Nem_Backend/app/api/routes/` contains the `/api/v1` REST routers.
  `frontend_compat.py` provides endpoints used by existing dashboard workflows.
- `Nem_Backend/app/services/` contains reading ingestion, rule evaluation,
  OPC UA client/collector, live-update hub, maintenance schedule logic,
  authentication helpers, email outbox delivery, and backup/restore.
- `Nem_Frontend/src/` contains the React application, feature pages, shared
  components, API and live-update clients, and global styles.
- `Nem_Frontend/vite.config.js` sets the `/ui/` base and proxies `/api` and
  WebSocket traffic to `127.0.0.1:8000` during development. A production build
  is served by FastAPI from `Nem_Frontend/dist` at `/ui/` when that directory
  exists; `/` redirects to `/ui/` or `/docs`.

The dependency manifests identify FastAPI, SQLAlchemy 2, Pydantic Settings,
psycopg, asyncua, cryptography and python-multipart on the backend, and React
18, React Router, Vite and lucide-react on the frontend.

## Data model and relationships

Primary operational tables and their roles:

- `assets` is a self-referencing parent/child hierarchy.
- `variables` belongs to one asset; `(asset_id, key)` is unique. A variable
  has a data type and may carry an OPC UA NodeId and Boolean signal role.
- `nem_readings` references both an asset and variable. Ingestion verifies that
  the variable belongs to the supplied asset.
- `machine_monitoring_states` stores asset-level machine cycle count, running
  state, accumulated running seconds, freshness timestamps, and optional
  configured limits.
- `nem_monitoring_rules` optionally references an asset, variable, and
  reusable source template. Rules have associated `nem_rule_states` and
  persistent `nem_rule_counter_states` (unique by rule and asset).
- `nem_alerts` references either a rule or a maintenance schedule and records
  active/resolved status, severity, trigger information, and acknowledgement.
- `nem_monitoring_events` records rule, alert, maintenance, machine, and
  lifecycle history, with optional links to asset, rule, and alert.
- `nem_maintenance_schedules` belongs to an asset. Each occurrence is a
  `nem_maintenance_records` row linked to that schedule; a schedule records its
  current occurrence and due date.
- `auth_users` owns revocable `auth_sessions`. `nem_asset_supervisors` links
  supervisors and assets. `nem_email_notifications` is a persistent
  alert-email outbox linked to alert and user.
- Dashboard data includes frontend settings, rule collections, instruction
  documents and files, and backup metadata. Rule templates and rule/maintenance suggestions
  are stored separately from asset-specific rules.
- The shared `labels` catalog is linked by many-to-many association tables to
  asset-specific rules, reusable rule templates, collections, and instruction
  documents. Composite association keys prevent duplicate links; a normalized
  unique label key prevents duplicate names differing only by case or
  whitespace.
- `scheduler_leases` elects a single owner for scheduled work and the OPC UA
  collector. A lease is claimed with one conditional `UPDATE` (same owner or
  expired), so an expired lease is recovered by the next instance; the
  evaluator and maintenance workers release theirs on shutdown.

Asset, variable, reading, rule, alert, maintenance, and history deletion is
guarded where dependants would otherwise be orphaned. Startup calls
`Base.metadata.create_all()` and applies in-code, idempotent schema updates in
`app/db/init_db.py` under a PostgreSQL advisory lock (so concurrent starts
cannot interleave DDL); production database changes should be backed up first.
No migration framework is used. `DATABASE_URL` must be `postgresql+psycopg`;
SQLite is not initialized by the application.
The versioned `app/db/migrations/shared_labels.py` migration imports legacy
document JSON labels into the shared catalog and associations. New document
assignments are stored in the normalized associations; the legacy column
remains for compatibility and is restored from associations by migration
downgrade.
Startup also removes the legacy rule and maintenance visibility-marker
columns. It drops only those columns, preserving all rule and maintenance
records; previously filtered rows are included in normal listings and
evaluation queries according to their existing lifecycle/status fields.

### Startup schema upgrades

`initialize_database()` in `app/db/init_db.py` runs at API startup and from
`scripts/create_admin.py` and `seed.py`. On PostgreSQL it holds a session-level
advisory lock for the whole upgrade, so concurrent processes cannot interleave
DDL. It runs `Base.metadata.create_all()` and then idempotent in-code steps.
There is no migration framework. The application database is PostgreSQL only:
the audit, visibility and request-removal helpers log a warning and skip any
other dialect. Their table, column and index names are fixed constants that are
validated before use, and no step switches off foreign-key enforcement.

- `_upgrade_audit_columns` makes sure rules, maintenance schedules and
  maintenance records have `created_by_id` / `updated_by_id` as nullable
  INTEGER foreign keys to `auth_users(id)` with `ON DELETE SET NULL` and a
  plain single-column index, and that `nem_maintenance_records.updated_at` is a
  `TIMESTAMP WITHOUT TIME ZONE` (the type of `UTCDateTime`). Existing columns
  are verified rather than rewritten: a missing foreign key is added only when
  no value in the column is orphaned; an index is matched by its definition, so
  a same-named index on other columns is left alone and the correct one is
  created as `ix_<table>_<column>_audit`; a different `ON DELETE` action or a
  `timestamptz` column is reported as a warning and left unchanged. Existing
  audit data is never modified.
- `_upgrade_rule_visibility` adds `visibility_type` (`VARCHAR(30) NOT NULL
  DEFAULT 'admin_only'`) and the template audit columns. Valid existing values
  are preserved. A NULL or unknown value is reset to `admin_only` (such rules
  were already hidden from Supervisors) and logged with the affected rule ids,
  so the allowed-values constraint can always be created. The constraint
  `ck_nem_monitoring_rule_templates_visibility` is added when missing and
  replaced when its definition is stale; the existence check is scoped to this
  table in the current schema, so a same-named constraint elsewhere is ignored.
- `_remove_visibility_requests` removes the discontinued
  `nem_rule_visibility_requests` table and `nem_rule_visibility_changes.request_id`
  together, in one transaction that locks both tables (5 second lock timeout),
  so no row can arrive between the emptiness check and the drop. Everything is
  kept, with a warning, when the request table still holds records, a change
  row still points at a request, or anything unexpected references the table.
  The table is dropped without `CASCADE`, so PostgreSQL itself refuses if a
  view depends on it. A lock timeout or database error is logged and retried at
  the next start. The table and the column are handled independently, so a
  half-migrated database finishes on the next start. Visibility history rows
  are never altered.

These three steps were run against a real PostgreSQL 16.15 server (fresh
schema, missing audit and visibility columns, invalid visibility values, a
same-named constraint on another table and schema, empty and non-empty request
tables, partially migrated states, lock contention, repeat startup). They have
not been run against the deployed database, so back it up before deploying.

### Audit trail (rules and maintenance)

`nem_monitoring_rules`, `nem_maintenance_schedules` and `nem_maintenance_records` carry
`created_by_id`, `created_at`, `updated_by_id` and `updated_at` (UTC). The two user columns are
nullable foreign keys to `auth_users` with `ON DELETE SET NULL`; `nem_maintenance_records.updated_at`
is nullable. A single SQLAlchemy `before_flush` listener (`app/models/audit.py`) stamps them from
`session.info["auth_user_id"]`, which `get_db` sets from the verified bearer session, so no request
body can supply it. Creator fields cannot be changed after insert. Sessions without an authenticated
user (workers, schedulers) never claim a user and leave the last human modification stamp intact.
Existing rows stay NULL and display as "Unknown". The columns are added idempotently by
`_upgrade_audit_columns` in `app/db/init_db.py`, which also verifies their foreign keys and
indexes (see Startup schema upgrades). API responses add `created_by` / `updated_by`
(usernames, null for legacy rows or deleted users). A separate activity-history table can later be
fed from the same listener.

### Shared-rule visibility

Shared (reusable) rules, i.e. `nem_monitoring_rule_templates`, carry `visibility_type`
(`admin_only` default, `specific_supervisors`, `all_supervisors`). Selected Supervisors live in
`nem_rule_template_supervisors`. `app/services/rule_visibility.py` is the single authorization point:
Administrators see everything, Supervisors see `all_supervisors` rules and `specific_supervisors` rules
that list them, Operators and everyone else see none. It is enforced in `GET /rule-templates`,
`GET/PUT /rule-templates/{id}`, `POST /rule-templates/{id}/assign` and the rule names embedded in
`GET /collections`; a hidden rule answers 404. Visibility never grants asset access and the asset-level
workflows (`/assets/{id}/rules/...`) are unchanged.

Only Administrators change visibility (`PUT /rule-templates/{id}/visibility`) and choose which Supervisors
may see a rule; there is no in-app request or approval workflow (a Supervisor who needs access asks the
Administrator, or suggests a new rule through the existing rule suggestions). `/api/v1/rule-visibility-requests`
answers 404 for every role. Every change is recorded with previous/new values in
`nem_rule_visibility_changes`, and templates now carry the same `created_by` / `updated_by` audit columns as
rules. The obsolete `nem_rule_visibility_requests` table and `request_id` column are removed at startup only when
that loses nothing; otherwise they are kept and a warning is logged (see Startup schema upgrades). An unknown
stored `visibility_type` is treated as `admin_only`.

Visibility is also enforced in the asset-level predefined-rule list and assignment
(`/assets/{id}/rules/predefined`, `/assets/{id}/rules/assign`), so hidden rule names never reach a Supervisor
there. Every edit of a shared rule is logged field by field (previous value, new value, editor, time) in
`nem_rule_template_changes`; `GET /rule-templates/{id}/history` returns the timeline (Administrators also see
visibility changes) and `GET /rule-templates/{id}/assignments` lists the assets
using the rule, limited to the caller's asset scope.

Visibility, editing and assignment are separate checks. Seeing a shared rule does not allow editing it:
a Supervisor may change only its numeric thresholds (`threshold`, the threshold keys inside `parameters`,
`evaluation_interval_seconds`); any other change answers 403, enforced in the route by
`enforce_template_edit_permission`. Creating and deleting shared rules and all visibility decisions are
Administrator-only in the route itself, and assignment needs an assigning role, visibility of the rule and
access to the target asset. A rule a Supervisor may not see answers 404, identical to a missing rule.
`source_template_id` on asset rule rows is returned only to roles that may see that shared rule.

Editing a shared rule propagates to every asset rule created from it (`source_template_id`). That loop runs
inside `internal_propagation_scope` so the editing Supervisor's asset filter does not block assets they
cannot reach; the affected rows come only from the rule's own assignments and error messages for
non-administrators never name assets.

## Request and monitoring data flow

1. The dashboard calls `/api/v1` using `Nem_Frontend/src/services/api.js`.
   Incoming readings are validated by `reading_ingestion.py` against the
   active asset, variable ownership, declared type, and timestamp constraints.
2. The reading is stored in `nem_readings`. Signal-state updates and matching
   rule evaluation run in the same service transaction.
3. OPC UA notifications pass through `OpcUaCollector` in
   `services/opcua_collector.py`. Each accepted mapped notification becomes a
   normal reading with source and NodeId metadata; cycle/running machine state
   is updated in the same transaction.
4. `services/monitoring_engine.py` evaluates applicable rules immediately on
   readings, on cycle increments, and in the scheduled evaluator. Rule status
   and alert transitions are persisted; alert/event email jobs are enqueued
   without sending email inline.
5. Scheduled monitoring evaluation runs at the configured interval (default
   15 seconds); maintenance due-date evaluation runs once per minute. Both use
   database leases. Email delivery is a separate background loop.
6. SQLAlchemy commit hooks in `services/live_updates.py` publish a coalesced
   database-change message; collector connection changes publish OPC UA status.
   The React views respond by refreshing affected data. Some views also use
   periodic REST refreshes; this is not a push-only application.

## OPC UA integration

`services/opcua_client.py` handles endpoint validation, connection testing, and
one-shot reads. `services/opcua_collector.py` owns the reconnecting background
subscription and maps data-change notifications to asset variables.

- Continuous mappings come from `OPCUA_MACHINE_MAPPINGS` in backend
  configuration, not from a UI-created connection. An entry has an `asset_id`,
  optional `cycle_signal`, optional `running_signal`, and ordinary `readings`.
- A configured mapping must reference active variables belonging to that asset;
  cycle/running variables must be Boolean. A NodeId may be reused across
  assets, but not more than once for the same asset.
- With `OPC_UA_MAPPING_BYPASS_ENABLED=false` (default), only configured
  mappings are used. The optional testing mode also considers active declared
  variable NodeIds and explicit Boolean purposes / variables used by enabled
  rules. Mapping role takes precedence. Changes to rule/asset/variable
  configuration can refresh subscriptions while connected.
- OPC UA timestamps are normalized to aware UTC. Missing timestamps use
  collector receipt time; naive timestamps are interpreted as UTC and logged.
  An out-of-order cycle/running notification is rejected rather than being
  allowed to rewind machine state.
- The default stale window is 300 seconds. Boolean samples without required
  timestamps, stale samples, bad-quality refreshes, non-Boolean cycle/running
  values, and values that fail variable-type validation do not advance trusted
  state. The collector periodically refreshes running signals and checkpoints
  elapsed runtime; it does not infer operation during a disconnect.
- Cycle count advances only on a Boolean false-to-true edge. The first accepted
  sample establishes a baseline. Machine totals and per-rule/per-asset
  counters persist separately.
- Running time accumulates from timestamps while a trustworthy running signal
  is true. It pauses on false, disabled rule, stale/missing data, or connection
  loss; the last trustworthy sample limits the amount that can be accrued.
- `GET /api/v1/plc/status` exposes connection/mapping and machine state;
  `POST /api/v1/plc/read` performs a one-shot read and stores it as a normal
  reading. Discovery and test endpoints are read-only.

Transport security is configured with `OPCUA_SECURITY_MODE` (`None`, `Sign`,
`SignAndEncrypt`) and `OPCUA_SECURITY_POLICY`; see the README section "OPC UA
transport security". The default `None` is unsecured and is reported as such in
status, logs and the PLC page. In the secure modes `services/opcua_client.py`
validates the client certificate/key, requires the server certificate to be in
`OPCUA_TRUSTED_SERVER_CERTIFICATES`, pins it for the session, and fails with a
clear error rather than falling back to `None`. There are no PLC write calls.

Every route that returns asset-related data applies the caller's asset scope
(`services/access_scope.py`): Administrators are unrestricted; Supervisors and
Operators get the assets assigned in `nem_asset_supervisors` plus descendants,
and nothing when none are assigned. Background and system sessions are
unrestricted; a request session without an active user has no access.
WebSocket events are filtered by the same scope and re-evaluated per message.

## API groups

All routers are mounted under `/api/v1` in `app/main.py`:

| Router module | Principal resources |
|---|---|
| `auth.py` | Login, current user, password, user administration |
| `assets.py` | Asset hierarchy, CRUD, move |
| `variables.py` | Asset-owned variable CRUD |
| `readings.py` | Individual/batch ingestion, latest and paginated readings |
| `rules.py` | Asset-specific rule creation, listing and update |
| `rule_visibility.py` | Shared-rule visibility (Administrator), change history, and assignments |
| `monitoring.py` | Evaluation/status, alerts, acknowledgement/completion, events |
| `maintenance.py` | Work records, recurring schedules and occurrences |
| `plc.py` | OPC UA status, test, discovery and one-shot read |
| `notifications.py` | Supervisor assignments and email delivery summary |
| `dashboard.py` | Dashboard summary |
| `frontend_compat.py` | Dashboard rule templates and suggestions, collection, document, settings, import, backup, and rule lifecycle workflows |

The shared label endpoints and filters are part of the existing API surface:
`GET /api/v1/labels` lists reusable labels; rules, rule templates, collections,
and documents accept repeated `label_ids` query parameters. Filtering uses
AND semantics across selected labels. Entry create/update requests accept
label names, which the shared service normalizes and resolves to existing or
new catalog rows.

Health/readiness endpoints and login are unauthenticated. Other `/api/v1`
requests require a valid bearer session. Request bodies with a declared
Content-Length above 25 MiB are rejected. CORS is applied only for configured
origins.

## Configuration and persistence constraints

`DATABASE_URL` is required; SQLite is not accepted as the configured application
database. Timestamps use `UTCDateTime` to store UTC-naive values in the
database and expose aware UTC datetimes to Python. The test-database setting,
when present, is checked not to point at the production or a system database.
The deployment environment, database contents, actual PLC mapping values, SMTP
server, and live sensor quality cannot be confirmed from source code.
