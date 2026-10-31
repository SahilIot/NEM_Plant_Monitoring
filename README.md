# NEM Plant Monitoring

NEM Plant Monitoring is a React dashboard and FastAPI service for monitoring
industrial assets. It stores readings, tracks machine cycle and running-time
signals, evaluates monitoring rules, records alerts and events, and manages
maintenance work and recurring calendar schedules.

> **Safety and deployment:** The application is monitoring software, not a
> safety interlock. It has no PLC write or machine-control path. The current
> OPC UA client is configured without transport encryption or certificate
> validation and is for trusted development/test networks only. Do not connect
> it to a production or untrusted network without PLC-approved security
> configuration and a deployment security review.

## What is implemented

- **Assets:** Create and organize assets in a parent/child hierarchy, move
  assets, and view asset status and operational history.
- **Variables and readings:** Define per-asset variables with `number`,
  `integer`, `string`, or `boolean` types; optionally associate a variable with
  an OPC UA NodeId. Readings can be submitted individually or in batches and
  queried by asset or variable.
- **OPC UA monitoring:** Test a connection, discover nodes, perform a
  read-only one-shot read, and continuously subscribe to configured NodeIds.
  The collector reconnects, reports connection/mapping status, checks data
  quality and signal freshness, and writes accepted values as ordinary
  readings.
- **Machine counters:** Count cycle-signal false-to-true transitions and
  accumulate running time from a trustworthy Boolean running signal. Machine
  counters and per-rule/per-asset counters persist in the database. The
  frontend does not increment cycle counts.
- **Monitoring rules:** Create supported asset rules, use reusable templates,
  assign or copy rules, and manage rule lifecycle. Rule types and limitations
  are described under [Monitoring rules](#monitoring-rules).
- **Alerts and events:** Maintain active/resolved alerts and event history;
  acknowledge and complete eligible alerts. Alert acknowledgement does not by
  itself clear a rule condition.
- **Maintenance:** Create work records and recurring calendar schedules,
  manage planned/in-progress/completed/cancelled work, review proposed next
  dates, and view maintenance history. Due or overdue schedules can create
  warning alerts.
- **Local accounts:** Authenticate with username/password, manage
  Administrator, Supervisor, and Operator accounts, and revoke sessions.
  Sessions expire after eight hours. Passwords are hashed; browser sessions
  use a bearer token held in local storage.
- **Dashboard configuration:** Manage rule collections and templates,
  instruction documents and attachments, profile and email settings, usage
  information, and database backup/restore.
- **Email notifications:** Eligible alert transitions can enqueue email jobs
  for assigned supervisors. A separate worker delivers and retries jobs using
  configured SMTP settings. Actual delivery depends on recipient assignments,
  valid addresses, email settings, and reachable SMTP.
- **Live updates:** A WebSocket publishes committed database changes and OPC UA
  connection changes. Dashboard views use these messages together with REST
  refreshes/polling; the UI updates without a full-page reload.

No automatic running-hour/cycle-based maintenance scheduling, SMS delivery,
analytics integration, or PLC control/write workflow is implemented in the
current code.

## Project layout

```text
Nem_Backend/
  app/
    api/routes/       FastAPI routers, including dashboard compatibility routes
    core/              Environment-backed application settings
    db/                SQLAlchemy base, sessions, UTC type, startup initialization
    models/             SQLAlchemy persistence models
    schemas/            Pydantic request/response validation
    services/           Rule engine, ingestion, OPC UA, live updates, email, backups
  scripts/              Administrator setup script
  seed.py               Idempotent simulated demo data
  requirements.txt
Nem_Frontend/
  src/app/              React routes and application entry point
  src/components/       Shared layout, menus, icons, dialogs, UI controls
  src/features/         Assets, monitoring, dashboard, PLC, configuration, auth,
                       settings and maintenance screens
  src/services/         REST API and WebSocket clients
  src/styles/           Global light/dark theme and layout styles
  package.json
docs/                    Architecture, design, product, rules, memory and task docs
```

The root `README.md` is the project setup and functionality guide. Detailed
documentation is in [docs/architecture.md](docs/architecture.md),
[docs/design.md](docs/design.md), [docs/prd.md](docs/prd.md),
[docs/rules.md](docs/rules.md), [docs/memory.md](docs/memory.md), and
[docs/tasks.md](docs/tasks.md).

## Requirements and local setup

Prerequisites:

- Python 3.12 or newer
- Node.js and npm
- PostgreSQL

### Configure and start the backend

Configure `Nem_Backend/.env` with a PostgreSQL connection URL. Keep secrets out
of source control and do not overwrite an existing environment file.
`DATABASE_URL` is required and must use the `postgresql+psycopg` driver. For
example:

```dotenv
DATABASE_URL=postgresql+psycopg://user:URL_ENCODED_PASSWORD@localhost:5432/plc_monitoring
```

From PowerShell:

```powershell
cd C:\path\to\NEM_Plant_Monitoring\Nem_Backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Create the first Administrator account interactively:

```powershell
.\.venv\Scripts\python.exe scripts\create_admin.py
```

The script initializes missing tables, requires an Administrator password of
at least 12 characters, and refuses to replace an existing username. Back up
production data before first startup or deploying database updates. Then start
the API:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

The API is available at `http://127.0.0.1:8000`; Swagger UI is at `/docs` and
the OpenAPI schema at `/openapi.json`.

### Start the frontend

In a separate PowerShell window:

```powershell
cd C:\path\to\NEM_Plant_Monitoring\Nem_Frontend
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/ui/`. The `/ui/` suffix is required by the Vite
base path. Vite proxies `/api` and WebSocket connections to the backend at
`http://127.0.0.1:8000`.

For a production frontend bundle, run `npm run build` in `Nem_Frontend`. When
`Nem_Frontend/dist` exists, FastAPI serves it under `/ui/`; the root URL
redirects to `/ui/` (or to `/docs` if the bundle is absent).

## Configuration

Settings are loaded by `Nem_Backend/app/core/config.py` from environment
variables and `Nem_Backend/.env`. Common options:

| Variable | Purpose and default |
|---|---|
| `DATABASE_URL` | Required PostgreSQL `postgresql+psycopg` URL. |
| `TEST_DATABASE_URL` | Optional isolated test database URL; must not match the application or a system database. |
| `CORS_ORIGINS` | Comma-separated allowed browser origins; empty by default. |
| `MONITORING_SCHEDULER_ENABLED` | Enables periodic rule evaluation; `true` by default. |
| `MONITORING_EVALUATION_INTERVAL_SECONDS` | Rule evaluator interval; 15 seconds by default. |
| `MONITORING_DEFAULT_STALE_AFTER_SECONDS` | Default signal/readings freshness window; 300 seconds by default. Rules may override it. |
| `MAINTENANCE_DUE_ALERTS_ENABLED` | Enables the scheduled maintenance due-alert evaluator; `true` by default. |
| `OPCUA_ENDPOINT` | OPC UA endpoint in `opc.tcp://host:port/...` form. |
| `OPCUA_USERNAME`, `OPCUA_PASSWORD` | Optional OPC UA credentials; configure both or neither. |
| `OPCUA_TIMEOUT_SECONDS` | OPC UA timeout; 10 seconds by default. |
| `OPCUA_RECONNECT_DELAY_SECONDS` | Collector reconnect delay; 5 seconds by default. |
| `OPCUA_SUBSCRIPTION_PUBLISHING_INTERVAL_MS` | Requested OPC UA publishing interval; 1000 ms by default. Server negotiation may change it. |
| `OPCUA_RUNTIME_CHECKPOINT_SECONDS` | Running-signal refresh/runtime checkpoint; 10 seconds by default. |
| `OPCUA_MACHINE_MAPPINGS` | JSON array of configured asset-to-NodeId mappings; empty by default. |
| `OPC_UA_MAPPING_BYPASS_ENABLED` | Optional mapping-bypass test mode; `false` by default. |
| `EMAIL_NOTIFICATIONS_ENABLED` | Enables the background email delivery loop; `true` by default. |
| `EMAIL_NOTIFICATION_MAX_ATTEMPTS` | Maximum email attempts; 5 by default. |
| `EMAIL_SMTP_TIMEOUT_SECONDS` | SMTP timeout; 15 seconds by default. |
| `EMAIL_DISPLAY_TIMEZONE` | Timezone used to display email event times; UTC by default. |
| `SETTINGS_ENCRYPTION_KEY` | Fernet key used to encrypt the saved SMTP password. |
| `FRONTEND_BASE_URL` | Optional base URL included in notification links. |
| `BACKUP_DIRECTORY` | Backup snapshot directory; `backups` by default. |

SMTP host, port, username, password, sender, and notification enablement are
also managed through the dashboard settings. Keep the encryption key protected
and available to the backend when reading saved SMTP credentials.

### OPC UA mapping format

Mappings are configured in the backend environment, not created by the UI.
Each mapping references an asset and its variables. Cycle and running signals
must map to Boolean variables; each variable must belong to the configured
asset. A NodeId may be reused across different assets but must not be repeated
within one asset mapping.

```dotenv
OPCUA_MACHINE_MAPPINGS=[{"asset_id":1,"cycle_signal":{"node_id":"ns=2;s=Machine.Cycle","variable_id":11},"running_signal":{"node_id":"ns=2;s=Machine.Running","variable_id":12},"readings":[{"node_id":"ns=2;s=Machine.Temperature","variable_id":13}]}]
```

Use IDs and NodeIds from the actual database and PLC. Restart the backend after
changing mappings or mapping-bypass settings. Mapping bypass is a temporary
testing option; see [docs/architecture.md](docs/architecture.md) for its
behavior and [docs/rules.md](docs/rules.md) for signal freshness and evaluation
logic.

## Monitoring rules

Rules are attached to assets and, where needed, a variable belonging to that
asset. Supported behavior includes:

- **Parameter thresholds:** numeric comparisons; Boolean expected values use
  equality/inequality.
- **Running-time thresholds:** accumulate while the selected Boolean running
  signal is true; thresholds advance through warning, higher warning, and
  alert.
- **Duration rules:** detect a condition held for a configured duration;
  interval-elapsed rules are also supported.
- **Cycle/count thresholds:** count false-to-true transitions on the configured
  Boolean cycle signal and use a separate counter for each rule/asset.
- **Reusable rule templates:** create, organize, request/review, assign, and
  copy compatible rules through the configuration and asset workflows.

The first cycle sample establishes a baseline; only a subsequent false-to-true
edge increments the count. Running time is calculated from timestamps, not
fixed ticks. It pauses when the signal becomes false or is no longer
trustworthy; time across disconnects is not inferred. Missing, invalid,
future-dated, or stale data is reported as unknown rather than normal.

Rules can be suspended, resumed, activated, deactivated, completed, archived,
or permanently deleted subject to lifecycle and role restrictions. `generic`
rules have no evaluator and remain unknown. The database permits
`boolean_condition`, but the main `RuleCreate` schema does not accept it; treat
that type as legacy/compatibility behavior requiring verification.

## Alerts, events, and maintenance

Rule evaluation creates or updates an active alert for an ongoing condition;
it does not create a new alert on every evaluator pass. When the condition
returns to normal, its active alert can resolve. A user can acknowledge an
active alert, which records who acknowledged it but does not clear the
condition. Completing an acknowledged rule alert completes/disables its rule.
Maintenance due alerts are associated with the relevant schedule and due date.

Maintenance records track planned, in-progress, completed, and cancelled
work. Calendar recurrence units are days, weeks, months, or years. Completing
a recurring occurrence may propose a next due date for review; confirming or
declining that proposal does not add running-hour/cycle-based scheduling.
Operators may start or complete only the active scheduled occurrence due
today or overdue, subject to backend checks.

Asset detail contains **Current status**, **Maintenance logbook**, and
**Event log** tabs. The Overview page shows alert status and action controls.
The PLC / OPC UA page displays recent readings and connection/mapping status.

## Authentication and access-control notes

The API supports local accounts with the roles **Administrator**,
**Supervisor**, and **Operator**. `/api/v1` endpoints require a bearer session
except `/api/v1/health`, `/api/v1/ready`, and `/api/v1/auth/login`. Sessions
expire after eight hours. Logging out, disabling an account, or changing its
role/password revokes sessions. The WebSocket endpoints
`/api/v1/live` and `/api/v1/ws/live` also require a session.

Role checks restrict account administration, global settings, PLC
configuration, destructive actions, monitoring-rule management, maintenance,
and alert actions. Exact permissions vary by endpoint and are enforced in the
backend as well as reflected in the UI.

**Important verification:** Supervisor-to-asset assignments are implemented
for workflows such as email recipient selection, but the inspected API query
and WebSocket wiring does not establish that all data is filtered by assigned
asset IDs. Do not rely on assignments as a data-isolation boundary until this
behavior is verified and corrected if needed. The frontend stores its session
token in local storage; use trusted HTTPS in deployment.

## API overview

API routers are mounted under `/api/v1`:

| Area | Common endpoints |
|---|---|
| Health | `GET /health`, `GET /api/v1/health`, `GET /api/v1/ready` |
| Authentication | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, user administration |
| Assets | `/assets` CRUD, children, hierarchy, and move |
| Variables | `/assets/{asset_id}/variables`, `/variables/{variable_id}` |
| Readings | `POST /readings`, `POST /readings/batch`, latest and history queries |
| Rules | `/rules`, rule status, template assignment/copy, lifecycle operations |
| Monitoring | `/monitoring/status`, `/monitoring/evaluate`, alerts and events |
| Maintenance | `/maintenance`, `/maintenance/schedules`, start/complete/cancel and next-date actions |
| PLC / OPC UA | `/plc/status`, `/plc/test`, `/plc/discover`, `/plc/read` |
| Notifications | Asset supervisor assignment and email delivery summary |
| Dashboard/configuration | Summary, collections, documents, settings, import/export, usage, backups |
| Live updates | WebSocket `/api/v1/live` and `/api/v1/ws/live` |

Use `/docs` or `/openapi.json` for the exact request/response schemas and query
parameters. Reading batches contain 1–100 readings and are processed
atomically. The backend rejects requests with a declared Content-Length above
25 MiB.

## Database and backups

PostgreSQL is the supported application database. The schema includes core
`assets` and `variables` tables plus `nem_*` operational tables for readings,
monitoring rules/states, counters, alerts, events, maintenance, supervisor
assignments, and email notifications. Dashboard configuration and account
tables are also stored in PostgreSQL.

At startup, `Base.metadata.create_all()` creates missing model tables and
`app/db/init_db.py` applies selected additive compatibility updates. This is
not a substitute for reviewing schema changes. Back up the database before
deploying updates. Dashboard backups are separate snapshots managed through
the Settings workflow; restoring one replaces current monitoring data.
Protect database backups and the backend `backups/` directory.

Application datetimes are handled as UTC. The SQLAlchemy `UTCDateTime` type
stores UTC-naive values in the database and returns aware UTC datetimes to the
application.

## Demo data and verification

Run `python seed.py` from `Nem_Backend` to create idempotent demo assets,
variables, and sample readings. Demo entries are marked simulated and do not
represent live equipment.

Frontend commands:

```powershell
cd C:\path\to\NEM_Plant_Monitoring\Nem_Frontend
npm test
npm run build
```

No backend automated test suite or frontend test cases were found in the
current repository snapshot; the frontend `npm test` script runs Node's test
runner. A successful build validates compilation, not PLC, database, SMTP,
authorization, or operational behavior. Test those integrations in a
controlled environment before deployment.

## Further documentation

- [Architecture](docs/architecture.md)
- [Design and interaction](docs/design.md)
- [Product requirements](docs/prd.md)
- [Business rules](docs/rules.md)
- [Implementation memory and verification notes](docs/memory.md)
- [Development status and tasks](docs/tasks.md)
