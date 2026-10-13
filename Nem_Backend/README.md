# Industrial Machine Monitor Backend — Phase 2

Standalone Python/FastAPI backend for a configurable industrial asset hierarchy,
typed time-series readings, evaluated monitoring rules, persisted rule states,
alerts, event history, maintenance records, and a browser dashboard. There is no
continuous PLC/Node-RED connection: readings can arrive through the REST API or
a secure one-shot OPC UA read request. Demo readings are explicitly marked with
`source_id` and metadata.

## Architecture and database

- `app/api/routes/`: versioned REST endpoints and HTTP validation.
- `app/schemas/`: Pydantic request/response contracts.
- `app/models/`: SQLAlchemy 2.x models.
- `app/services/`: reusable business logic as it is added.
- `app/core/`: environment-driven settings.
- `alembic/`: versioned schema migrations.

PostgreSQL is the recommended database for deployment and Node-RED ingestion.
The backend uses SQLAlchemy, so all assets, variables, readings, monitoring
rules, alerts, and maintenance records are stored in the configured database.
SQLite remains available for local development and tests. The generic schema
stores assets with optional self-referential parent links, variables with keys
unique per asset, typed JSON reading values with asset/variable/time indexes,
and monitoring rules with optional asset/variable targets and JSON parameters.
Rule evaluations persist their current state, alert lifecycle, and event
history. Timestamps are normalized to UTC.

The earlier prototype's `plants`, `production_lines`, `machines`, and
`machine_readings` tables are preserved by the new migration; the new generic
asset API does not use those tables.

## Windows PowerShell setup

Prerequisite: Python 3.12 or newer. Open PowerShell and run:

First create the PostgreSQL database and application user, then configure
`DATABASE_URL` in `.env` as described below. If `.env` does not exist, create it
from `.env.postgres.example`; if it already exists, preserve it and update only
`DATABASE_URL` so OPC UA settings are not overwritten.

```powershell
cd C:\Users\Sahil\Downloads\NEM_Plant_Monitoring\Nem_Backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m alembic upgrade head
python seed.py
python -m uvicorn app.main:app --reload
```

If PowerShell blocks activation, use the virtual-environment executable
directly instead:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe seed.py
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Create the `nem_plant_monitoring` database and a dedicated application user in
PostgreSQL (for example, using pgAdmin), then set this value in `.env` with the
actual user and password:

```dotenv
DATABASE_URL=postgresql+psycopg://nem_user:YOUR_PASSWORD@127.0.0.1:5432/nem_plant_monitoring
```

If the username or password contains URL-reserved characters, percent-encode
them in the connection URL. Keep the real `.env` out of source control.

The API is at `http://127.0.0.1:8000`, Swagger UI at
`http://127.0.0.1:8000/docs`, and OpenAPI JSON at
`http://127.0.0.1:8000/openapi.json`. The dashboard is at
`http://127.0.0.1:8000/` (or `/ui/`). Keep the server terminal open and press
Ctrl+C to stop the server.

Without a `DATABASE_URL` setting, the fallback database is
`machine_monitor.db` in the current working directory (SQLite). For normal
Node-RED operation, configure PostgreSQL explicitly in `.env`. Apply Alembic
migrations before starting the server or running the demo seed.

## Environment configuration

Configure `.env` using `.env.postgres.example` as a reference; do not overwrite
an existing `.env` because it may contain OPC UA settings. Apply migrations
against the configured PostgreSQL database before starting the API; the same
URL is used by Alembic, the API, and the seed script.

- `DATABASE_URL` — set to
  `postgresql+psycopg://user:password@host:5432/database` for PostgreSQL.
  The default `sqlite:///./machine_monitor.db` is for local development only.
- `CORS_ORIGINS` — comma-separated origins allowed to call the API from a
  browser. It is empty by default (CORS disabled); never enable unrestricted
  origins in production.
- `DEMO_ROOT_NAME` — optional root name for the repeatable demo seed.
- `MONITORING_SCHEDULER_ENABLED` — start periodic evaluation; defaults to
  `true`. Disable in tests or when an external scheduler is used.
- `MONITORING_EVALUATION_INTERVAL_SECONDS` — periodic evaluation interval,
  default `15` seconds.
- `MONITORING_DEFAULT_STALE_AFTER_SECONDS` — default reading freshness window,
  default `300` seconds; a rule may override it with `stale_after_seconds`.
- `OPCUA_ENDPOINT` — the PLC engineer-provided `opc.tcp://host:port/...`
  endpoint. Leave empty until the actual endpoint is known.
- `OPCUA_CLIENT_CERT`, `OPCUA_CLIENT_KEY`, `OPCUA_SERVER_CERT` — paths to the
  approved client certificate, private key, and trusted PLC server certificate.
  Relative paths are resolved from `Nem_Backend/`.
- `OPCUA_USERNAME`, `OPCUA_PASSWORD` — optional credentials; configure both or
  leave both empty. Keep credentials and private keys out of Git.
- `OPCUA_TIMEOUT_SECONDS` — connection/read timeout, default `10`.

No credentials or secrets belong in source control. PostgreSQL requires the
appropriate SQLAlchemy driver to be installed. Authentication and role-based
authorization are not implemented; do not expose this API to a factory network
or the public internet until access control and deployment hardening are added.

### OPC UA read-only PLC connection

Install the new dependency after updating the environment:

```powershell
python -m pip install -r requirements.txt
```

Merge the non-secret placeholders in `.env.opcua.example` into the local,
git-ignored `.env`, then set the real endpoint and certificate paths provided
through your organization's approved process. The client requires a client
certificate and private key plus the PLC server certificate. It always uses
`Basic256Sha256` with `SignAndEncrypt`; the server certificate is pinned for
validation. The PLC must offer a compatible endpoint and trust the client
certificate. If the endpoint uses a different security policy, coordinate that
securely with the PLC engineer; do not disable validation or downgrade to an
unencrypted connection.

Endpoints:

- `POST /api/v1/readings` accepts one reading; `POST /api/v1/readings/batch`
  accepts up to 100 readings. Node-RED should send readings to these API
  endpoints, not write directly to database tables. The API validates the
  asset/variable mapping, writes each reading to PostgreSQL, and evaluates
  matching rules so warnings and alerts remain consistent.
- `GET /plc/test` (also available as `GET /api/v1/plc/test`) securely reads the
  standard OPC UA `ServerStatus.CurrentTime` node (`i=2258`).
- `POST /api/v1/plc/read` reads one configured NodeId and stores the value as a
  normal backend reading, so matching monitoring rules run immediately. The
  asset and variable IDs must already exist and the value must match the
  variable's declared type.

Example read request:

```json
{
  "node_id": "ns=3;s=Machine1.Motor.RotationCount",
  "asset_id": 8,
  "variable_id": 12
}
```

Example Node-RED HTTP Request node payload for a single reading:

```json
{
  "asset_id": 8,
  "variable_id": 12,
  "value": 900,
  "recorded_at": "2026-10-12T06:30:00Z",
  "source_id": "node-red",
  "metadata": {
    "machine": "Machine 1",
    "signal": "Motor.RotationCount"
  }
}
```

Configure the Node-RED HTTP Request node to `POST` this JSON to
`http://<backend-host>:8000/api/v1/readings` with `Content-Type: application/json`.
Create the asset and variable in the monitoring API first, and ensure that the
variable's data type matches the incoming value. Batch ingestion is available
at `/api/v1/readings/batch` when sending multiple readings.

This integration only issues OPC UA read requests; it has no write or control
operations and does not poll continuously. Call `/api/v1/plc/read` from an
approved polling/orchestration process as needed. Errors do not include
credential values. The REST API has no authentication yet, so do not expose
PLC read endpoints beyond a trusted network until access control is added.

### Checking OPC UA from the dashboard

Start the backend and open `http://127.0.0.1:8000/`, then choose **PLC / OPC UA**
in the navigation. **Test secure connection** reads the standard server-time
node and reports the configured connection result. To read a machine signal,
enter the NodeId supplied by the PLC engineer, select an active asset and its
existing variable, and choose **Read node and ingest**. Each click performs one
read; it does not start polling. A successful value is saved as a reading and
matching monitoring rules are evaluated. A real connection requires the
engineer-provided endpoint and approved certificates in the backend `.env`;
the dashboard does not configure or expose secrets.

## Database migrations

Apply all migrations:

```powershell
python -m alembic upgrade head
```

The initial migration records the former prototype tables; later migrations add
the generic assets, variables, readings, rules, and Phase 2 monitoring tables
without dropping those existing tables. After model changes, create and apply a
subsequent migration:

```powershell
python -m alembic revision --autogenerate -m "describe schema change"
python -m alembic upgrade head
python -m alembic check
```

The Alembic environment explicitly ignores the retained legacy tables during
autogeneration so changing the new generic models cannot inadvertently drop
that older data.

## Demo data

`python seed.py` creates a configurable demo root asset, five sample assets,
variables, and nine recent readings. It is idempotent: rerunning it reuses
generated assets, variables, and readings rather than replacing or duplicating
records. The data uses demo-only asset flags and source identifiers; the script
does not update real (non-demo) assets. One sample asset intentionally has no
operating-status reading. Demo data does not come from or represent live
industrial equipment.

## API endpoints

### Health

- `GET /api/v1/health` — API process responds.
- `GET /api/v1/ready` — checks database connectivity.

### Assets

- `POST /api/v1/assets` — create a root or child asset.
- `GET /api/v1/assets` — list and paginate; filters: `parent_asset_id`,
  `root_only`, `asset_type`, `is_active`, `limit`, `offset`.
- `GET /api/v1/assets/{asset_id}` — retrieve.
- `PATCH /api/v1/assets/{asset_id}` — update or deactivate; set
  `parent_asset_id` to `null` to make it a root.
- `GET /api/v1/assets/{asset_id}/children` — list direct children.
- `GET /api/v1/assets/{asset_id}/hierarchy` — return the root tree containing
  this asset.
- `POST /api/v1/assets/{asset_id}/move?parent_asset_id={id}` — move to another
  parent; omit the query parameter to move to root.
- `DELETE /api/v1/assets/{asset_id}` — delete only when no dependent records
  exist; otherwise deactivate the asset to preserve history.

Parent IDs are validated and moves that would create a cycle are rejected.
Hierarchy depth is not tied to a particular asset type or plant/line/machine
structure.

### Variables

- `POST /api/v1/assets/{asset_id}/variables`
- `GET /api/v1/assets/{asset_id}/variables` — supports `is_active`, `limit`,
  and `offset`.
- `GET /api/v1/variables/{variable_id}`
- `PATCH /api/v1/variables/{variable_id}` — use `is_active: false` to
  deactivate without deleting history.

Supported data types are `number`, `integer`, `string`, and `boolean`. Variable
keys must be unique within their asset.

### Readings

- `POST /api/v1/readings` — ingest one reading.
- `POST /api/v1/readings/batch` — atomically ingest 1–100 readings.
- `GET /api/v1/readings/variables/{variable_id}/latest`
- `GET /api/v1/readings/assets/{asset_id}/latest`
- `GET /api/v1/readings/variables/{variable_id}` — paginate/filter with
  `start_time`, `end_time`, `limit`, and `offset`.

Every value must match its variable's declared data type. A reading's asset
must be the asset that owns its variable. Batch validation happens before
writing, so invalid batches do not partially insert data. The API enforces a
1 MiB request-body limit.

### Monitoring rules

- `POST /api/v1/rules`
- `GET /api/v1/rules` — filters: `target_asset_id`, `rule_type`, `severity`,
  `is_enabled`, `limit`, and `offset`.
- `GET /api/v1/rules/{rule_id}`
- `PATCH /api/v1/rules/{rule_id}` — set `is_enabled: false` to disable evaluation.
- `GET /api/v1/rules/{rule_id}/status` — current state.
- `POST /api/v1/monitoring/evaluate` — evaluate enabled rules immediately;
  optional `asset_id` or `rule_id` filters.
- `GET /api/v1/monitoring/status` — paginated state list; supports `status`,
  `asset_id`, and `rule_id` filters.
- `GET /api/v1/assets/{asset_id}/monitoring-status` — states for an asset.

Rule types are `parameter_threshold`, `runtime_duration`, `duration`, and
`generic`. Threshold rules need a numeric variable, an operator (`lt`, `lte`,
`eq`, `ne`, `gte`, or `gt` and symbolic equivalents), and a threshold.
`duration` rules need a variable and a positive `parameters.duration_seconds`;
their condition can match an `expected_value` or use a numeric threshold
condition. Severity is `warning` or `alert`. For example, flag a motor after it
has continuously reported `running` for five minutes:

```json
{
  "name": "Motor running continuously",
  "rule_type": "duration",
  "target_asset_id": 2,
  "variable_id": 1,
  "parameters": {
    "condition": "equals",
    "expected_value": "running",
    "duration_seconds": 300
  },
  "severity": "warning"
}
```

Threshold rules are evaluated when readings are ingested and by the periodic
scheduler. Set `evaluation_interval_seconds` on a rule to limit its periodic
evaluation cadence; ingestion still evaluates it immediately. For example,
create a numeric motor rotation variable and a rule
with `operator: ">="`, `threshold: 900`, and `severity: "warning"`; create a
second rule for 950 rotations with `severity: "alert"`, and another for 1000
rotations with the desired maintenance severity. Each active rule creates one
deduplicated alert episode until the condition clears.

Missing, stale, future-dated, invalid, or unavailable input is reported as
`unknown`, never as normal. Per-rule `stale_after_seconds` overrides the
environment default. Disabling a rule sets its state to unknown and retains
active alerts; after re-enabling, the next valid clear evaluation resolves them.
Acknowledging an alert records acknowledgement but does not resolve the
condition.

### Alerts and event history

- `GET /api/v1/alerts/active` — active alerts, with optional asset/rule,
  severity, acknowledgement, and time filters.
- `GET /api/v1/alerts` — alert history; also accepts `lifecycle_status=active`
  or `resolved`.
- `GET /api/v1/alerts/{alert_id}`
- `POST /api/v1/alerts/{alert_id}/acknowledge` — optional JSON body
  `{"acknowledged_by": "operator name"}`. Identity is not verified.
- `GET /api/v1/events` — paginated event history with asset/rule/alert,
  `event_type`, severity, and time filters.
- `GET /api/v1/events/{event_id}`

Alerts and events are persisted in the same database as readings and rule
states. This phase does **not** send email or other outbound notifications;
alert delivery and recipient management remain future work.

### Maintenance records

- `POST /api/v1/maintenance` — save a completed service record; supports an
  optional linked alert, notes, completion timestamp, and next due date.
- `GET /api/v1/maintenance` — list records with optional `asset_id`, `alert_id`,
  `start_time`, and `end_time` filters.
- `GET /api/v1/maintenance/{record_id}` — retrieve a record.

The browser dashboard at `/` brings together the overview, asset directory and
latest signals, threshold/duration rule creation, alert review and
acknowledgement, and maintenance history. Select an asset to add variables,
create a rule for one of its signals, or log work against an active alert.
Maintenance due dates are entered by the operator on each service record; the
dashboard highlights upcoming and overdue dates. Logging work does not
automatically acknowledge or resolve an alert; alert recovery still depends on
the rule condition and subsequent readings. The dashboard is served by FastAPI
from `frontend/`, so no separate JavaScript build or development server is
required.

### Dashboard

- `GET /api/v1/dashboard/summary` reports asset counts and the evaluated state
  counts (`rules_normal`, `rules_warning`, `rules_alert`, `rules_unknown`),
  active alerts, unacknowledged active alerts, and the latest reading timestamp.
  An alert means a configured software condition was met; it does not establish
  the physical condition or safety of equipment.

## Evaluation scheduling and safety

The periodic scheduler starts with the application by default and evaluates
enabled rules every `MONITORING_EVALUATION_INTERVAL_SECONDS`. A database lease
elects one scheduler worker when multiple app processes share the database.
Apply migrations before starting the app. For multi-instance deployments, use a
shared database with reliable transactions; SQLite is intended for local
development, not concurrent production scheduling. Do not run multiple
independent schedulers against separate databases.

This is monitoring software, **not a safety interlock or control system**. It
does not stop machinery, and it is not a substitute for certified PLC safety
logic, operator procedures, authentication/authorization, or industrial
network hardening. The API currently has no authentication. Do not expose it to
the public internet or rely on it for personnel/equipment protection.

## Try it with Swagger or Postman

Open `/docs`, expand an endpoint, choose **Try it out**, provide JSON, and
execute. In Postman, use the same URL and method, and choose **Body → raw →
JSON** for request bodies.

Create a root asset:

```http
POST http://127.0.0.1:8000/api/v1/assets
Content-Type: application/json
```

```json
{
  "name": "Factory A",
  "asset_type": "facility",
  "description": "Example root asset"
}
```

Create a child asset by using the returned root `id`:

```json
{
  "name": "Mixer 01",
  "asset_type": "mixer",
  "parent_asset_id": 1,
  "is_active": true
}
```

Create a variable on that asset:

```json
{
  "name": "Temperature",
  "key": "temperature",
  "data_type": "number",
  "unit": "°C"
}
```

Ingest a reading using the returned asset and variable IDs:

```json
{
  "asset_id": 2,
  "variable_id": 1,
  "value": 42.5,
  "recorded_at": "2026-10-10T08:00:00Z",
  "source_id": "demo-postman-001",
  "metadata": {
    "origin": "manual API test"
  }
}
```

Example response:

```json
{
  "id": 1,
  "asset_id": 2,
  "variable_id": 1,
  "value": 42.5,
  "recorded_at": "2026-10-10T08:00:00Z",
  "source_id": "demo-postman-001",
  "metadata": {
    "origin": "manual API test"
  }
}
```

API errors use a consistent envelope, for example:

```json
{
  "error": {
    "code": 404,
    "message": "Asset 999 was not found"
  }
}
```

## Tests

Automated tests use a separate temporary SQLite database and never modify the
development database:

```powershell
python -m pytest -q
```

## Implemented features and limitations

Implemented: generic nested assets, hierarchy reads and moves, variables,
single and batch reading ingestion, time-series queries, threshold and duration
rule evaluation, periodic scheduling, rule state, alert lifecycle and
acknowledgement, event history, persistent maintenance records with next-due
dates, a browser dashboard, dashboard state counts, health checks, SQLite
migrations, and repeatable demo data.

Not implemented: PLC/Node-RED continuous polling, email/SMS delivery,
automatic calendar-trigger rules, maintenance task templates, authentication/
authorization, analytics integrations, or backup/restore. Validate the
read-only one-shot OPC UA path with simulated inputs and PLC-engineer-approved
credentials before connecting live equipment.
