# Industrial Machine Monitor Backend — Phase 2

Standalone Python/FastAPI backend for a configurable industrial asset hierarchy,
typed time-series readings, evaluated monitoring rules, persisted rule states,
alerts, event history, and a dashboard summary. There is no frontend and no
PLC/CNC or other industrial protocol connection: readings currently arrive
through the REST API (a Node-RED gateway can be integrated later). Demo readings
are explicitly marked with `source_id` and metadata.

## Architecture and database

- `app/api/routes/`: versioned REST endpoints and HTTP validation.
- `app/schemas/`: Pydantic request/response contracts.
- `app/models/`: SQLAlchemy 2.x models.
- `app/services/`: reusable business logic as it is added.
- `app/core/`: environment-driven settings.
- `alembic/`: versioned schema migrations.

SQLite is the default development database. Set `DATABASE_URL` for another
SQLAlchemy database URL when its driver is installed. The generic schema stores
assets with optional self-referential parent links, variables with keys unique
per asset, typed JSON reading values with asset/variable/time indexes, and
monitoring rules with optional asset/variable targets and JSON parameters.
Rule evaluations persist their current state, alert lifecycle, and event
history. Timestamps are normalized to UTC.

The earlier prototype's `plants`, `production_lines`, `machines`, and
`machine_readings` tables are preserved by the new migration; the new generic
asset API does not use those tables.

## Windows PowerShell setup

Prerequisite: Python 3.12 or newer. Open PowerShell and run:

```powershell
cd C:\Users\Sahil\Downloads\NEM_Plant_Monitoring\Nem_Backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
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

The API is at `http://127.0.0.1:8000`, Swagger UI at
`http://127.0.0.1:8000/docs`, and OpenAPI JSON at
`http://127.0.0.1:8000/openapi.json`. Keep the server terminal open and press
Ctrl+C to stop the server.

The default database is `machine_monitor.db` in the current working directory.
Apply Alembic migrations before starting the server or running the demo seed;
the application does not silently create or change the schema at startup.

## Environment configuration

Copy `.env.example` to `.env` and configure:

- `DATABASE_URL` — defaults to `sqlite:///./machine_monitor.db`.
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

No credentials or secrets belong in source control. PostgreSQL requires the
appropriate SQLAlchemy driver to be installed. Authentication and role-based
authorization are not implemented; do not expose this API to a factory network
or the public internet until access control and deployment hardening are added.

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
acknowledgement, event history, dashboard state counts, health/readiness,
SQLite migrations, and repeatable demo data.

Not implemented: real PLC/CNC or Node-RED connectivity, email/SMS delivery,
maintenance work orders, authentication/authorization, analytics integrations,
backup/restore, or a frontend. Validate against simulated inputs before
connecting any real PLC/Node-RED gateway.
