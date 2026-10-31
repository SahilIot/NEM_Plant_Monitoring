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
  documents and files, and backup metadata. Rule templates and review requests
  are stored separately from asset-specific rules.
- `scheduler_leases` elects a single owner for scheduled work and the OPC UA
  collector.

Asset, variable, reading, rule, alert, maintenance, and history deletion is
guarded where dependants would otherwise be orphaned. Startup calls
`Base.metadata.create_all()` and applies additive, in-code schema updates in
`app/db/init_db.py`; production database changes should be backed up first.

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

The configured OPC UA client does not enable transport encryption or
certificate validation in the current development implementation. It must not
be treated as suitable for an untrusted or production network without approved
security configuration. There are no PLC write calls.

## API groups

All routers are mounted under `/api/v1` in `app/main.py`:

| Router module | Principal resources |
|---|---|
| `auth.py` | Login, current user, password, user administration |
| `assets.py` | Asset hierarchy, CRUD, move |
| `variables.py` | Asset-owned variable CRUD |
| `readings.py` | Individual/batch ingestion, latest and paginated readings |
| `rules.py` | Asset-specific rule creation, listing and update |
| `monitoring.py` | Evaluation/status, alerts, acknowledgement/completion, events |
| `maintenance.py` | Work records, recurring schedules and occurrences |
| `plc.py` | OPC UA status, test, discovery and one-shot read |
| `notifications.py` | Supervisor assignments and email delivery summary |
| `dashboard.py` | Dashboard summary |
| `frontend_compat.py` | Existing dashboard rule, collection, document, settings, import, and backup workflows |

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

