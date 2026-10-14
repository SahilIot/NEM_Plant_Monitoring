# Industrial Machine Monitor Backend — Phase 2

Standalone Python/FastAPI backend for a configurable industrial asset hierarchy,
typed time-series readings, evaluated monitoring rules, persisted rule states,
alerts, event history, maintenance records, and a browser dashboard. There is no
PLC write/control path: readings can arrive through the REST API or secure,
read-only OPC UA collection. Demo readings are explicitly marked with
`source_id` and metadata.

## Architecture and database

- `app/api/routes/`: versioned REST endpoints and HTTP validation.
- `app/schemas/`: Pydantic request/response contracts.
- `app/models/`: SQLAlchemy 2.x models.
- `app/services/`: reusable business logic as it is added.
- `app/core/`: environment-driven settings.
- PostgreSQL is the only supported database. SQLAlchemy uses the synchronous
  `psycopg` driver.

The generic NEM schema stores assets with optional self-referential parent
links, variables with keys unique per asset, typed JSON reading values, and
monitoring rules with optional asset/variable targets and JSON parameters. Rule
evaluations persist their current state, alert lifecycle, and event history.
Timestamps are normalized to UTC.

The existing PostgreSQL database contains PLC-shaped `public.readings`,
`public.monitoring_rules`, and `public.alerts` tables. Those tables and their
records are preserved unchanged. NEM uses separate `nem_readings`,
`nem_monitoring_rules`, `nem_rule_states`, `nem_alerts`,
`nem_monitoring_events`, and `nem_maintenance_records` tables, while reusing
the compatible `assets` and `variables` tables. Existing NodeId-based history
is not imported because no NodeId-to-asset/variable mapping has been provided.
Existing legacy `rule_states`, `monitoring_events`, `maintenance_records`, and
the singular `machine_monitoring_state` / `machine_monitoring_config` tables
are left untouched too. The compatible `machine_monitoring_states` table is
reused by the NEM monitoring model.
At startup, all ORM models are imported and `Base.metadata.create_all()` may
create missing tables only; it never modifies existing tables or adds columns.
Back up the database before the first startup that creates these NEM tables.

## Windows PowerShell setup

Prerequisite: Python 3.12 or newer. Open PowerShell and run:

Keep the existing `.env`; do not overwrite it because it may contain PLC
settings. Confirm that `DATABASE_URL` points to the configured PostgreSQL
database. Back it up before the first startup that creates the NEM tables.

```powershell
cd C:\Users\Sahil\Downloads\NEM_Plant_Monitoring\Nem_Backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

New-Item -ItemType Directory -Force -Path .\backups | Out-Null
$backupFile = ".\backups\plc_monitoring-before-nem-tables-$((Get-Date).ToString('yyyyMMdd-HHmmss')).dump"
& 'C:\Program Files\PostgreSQL\18\bin\pg_dump.exe' --host localhost --port 5432 --username plc_app --format=custom --file $backupFile plc_monitoring
if ($LASTEXITCODE -ne 0) { throw "PostgreSQL backup failed" }
& 'C:\Program Files\PostgreSQL\18\bin\pg_restore.exe' --list $backupFile > $null
if ($LASTEXITCODE -ne 0) { throw "PostgreSQL backup verification failed" }

.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

In a separate PowerShell window, start the React frontend during development:

```powershell
cd C:\Users\Sahil\Downloads\NEM_Plant_Monitoring\Nem_Frontend
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/ui/`. Vite proxies `/api/v1` requests to the FastAPI
server at `http://127.0.0.1:8000`. For serving the built frontend from FastAPI,
run `npm run build` in `Nem_Frontend` first; then `http://127.0.0.1:8000/`
redirects to the React dashboard at `/ui/`.

Create a dedicated PostgreSQL test database as an administrator. The following
command may prompt for the administrator password:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' --host localhost --port 5432 --username postgres --dbname postgres --command "CREATE DATABASE plc_monitoring_test OWNER plc_app;"
```

Set `TEST_DATABASE_URL` in the existing `.env` to a `postgresql+psycopg` URL
for `plc_monitoring_test`. Never point it at the application database. Run the
backend test suite with:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

The API is at `http://127.0.0.1:8000`, Swagger UI at
`http://127.0.0.1:8000/docs`, and OpenAPI JSON at
`http://127.0.0.1:8000/openapi.json`. The dashboard is at
`http://127.0.0.1:8000/` (or `/ui/`). Keep the server terminal open and press
Ctrl+C to stop the server.

## Environment configuration

Keep the existing `.env` and its PLC settings. The API and seed script use the
application database; tests use only the separate `TEST_DATABASE_URL`.

- `DATABASE_URL` —
  `postgresql+psycopg://plc_app:<URL-encoded-password>@localhost:5432/plc_monitoring`.
  There is no fallback database.
- `TEST_DATABASE_URL` — a `postgresql+psycopg` URL for a dedicated test
  database whose name differs from the application database.
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
- `OPCUA_MACHINE_MAPPINGS` — optional JSON array configuring continuous
  subscriptions. Leave empty until the PLC engineer provides NodeIds and the
  corresponding existing NEM asset/boolean-variable IDs.
- `OPCUA_RECONNECT_DELAY_SECONDS` — wait before retrying a disconnected
  subscription, default `5`.
- `OPCUA_RUNTIME_CHECKPOINT_SECONDS` — subscription publishing and persisted
  running-time checkpoint interval, default `10`.
- `SETTINGS_ENCRYPTION_KEY` — Fernet key used to encrypt the SMTP password
  saved by the dashboard. Generate one with
  `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
  and keep it secret and stable; changing it prevents decrypting the stored
  password.
- `BACKUP_DIRECTORY` — location for database backup snapshot files; defaults
  to `Nem_Backend/backups`.

No credentials or secrets belong in source control. PostgreSQL requires the
appropriate SQLAlchemy driver to be installed. Authentication and role-based
authorization are not implemented; do not expose this API to a factory network
or the public internet until access control and deployment hardening are added.
The dashboard profile is a single local profile, not an authenticated user
account. Backup restore replaces the current monitoring data with the selected
snapshot; keep backup files in a protected location and confirm the restore
prompt before proceeding.
The React dashboard is built from `Nem_Frontend`; its PLC page exposes the
read-only connection test, one-shot read endpoint, and continuous monitoring
status when configured. SMTP settings are stored
by the dashboard with the password encrypted, but configuring SMTP does not by
itself send alert email notifications.

### OPC UA read-only PLC connection and machine monitoring

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

Continuous collection is started once by the FastAPI application lifespan only
when `OPCUA_MACHINE_MAPPINGS` is set. The collector subscribes only to
configured data-change NodeIds and uses the same secure, read-only OPC UA client
as the one-shot read endpoint. It is guarded by a database lease so only one
backend instance for the configured database owns the collector. Bad-quality
and non-boolean machine-state notifications are ignored. A cycle is counted
only on a `false` to `true` signal transition; the first valid signal is only
the baseline. Running-time totals are checkpointed in `machine_monitoring_states`
and survive restarts. Runtime accumulated while the collector is disconnected
is not inferred or added.

Create the PLC asset and its boolean `cycle_signal` / `running_signal`
variables through the existing asset API or dashboard, then use their IDs and
the real NodeIds supplied by the PLC engineer in `.env`. Optional entries in
`readings` may map other NodeIds to active NEM variables of their matching data
types; these readings use the shared ingestion, rule, alert, and event paths.
Example structure (replace the placeholders; these are not real NodeIds or IDs):

```dotenv
OPCUA_MACHINE_MAPPINGS=[{"asset_id":<NEM_ASSET_ID>,"cycle_signal":{"node_id":"<PLC_CYCLE_NODEID>","variable_id":<CYCLE_BOOLEAN_VARIABLE_ID>},"running_signal":{"node_id":"<PLC_RUNNING_NODEID>","variable_id":<RUNNING_BOOLEAN_VARIABLE_ID>},"readings":[{"node_id":"<PLC_VALUE_NODEID>","variable_id":<NEM_VARIABLE_ID>}],"cycle_limit":<OPTIONAL_CYCLE_LIMIT>,"runtime_limit_seconds":<OPTIONAL_RUNTIME_LIMIT_SECONDS>}]
```

For a machine with only one available status signal, omit the other signal
object. There may be one mapping per asset; do not map one NodeId to more than
one signal. Restart the backend after changing the mapping. The startup
configuration is validated against active NEM assets and boolean variables.
No PLC NodeIds, asset IDs, or credentials are bundled with the project.

The API's NEM ORM uses PostgreSQL-only `nem_*` tables to avoid interpreting
existing PLC-shaped tables as NEM data. No legacy rows are renamed, dropped, or
copied. A future import requires an explicitly reviewed NodeId mapping.

`GET /api/v1/plc/status` reports the subscription status, latest valid
notification freshness, machine state, persisted cycle/runtime totals,
configured limits, and active NEM alerts attached to each configured asset.
Limit values are informational targets; to raise alerts, configure rules in
NEM using its normal rule/alert workflow. OPC UA input remains read-only.

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
For multi-instance deployments, use a shared PostgreSQL database with reliable transactions. Do not run multiple independent schedulers against separate databases.

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

Automated tests require the dedicated PostgreSQL database configured by
`TEST_DATABASE_URL`. Each test rolls back its data changes and does not connect
to `DATABASE_URL`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

## Implemented features and limitations

Implemented: generic nested assets, hierarchy reads and moves, variables,
single and batch reading ingestion, time-series queries, threshold and duration
rule evaluation, periodic scheduling, rule state, alert lifecycle and
acknowledgement, event history, persistent maintenance records with next-due
dates, a browser dashboard, dashboard state counts, health checks, and
repeatable demo data.

Not implemented: email/SMS delivery, automatic calendar-trigger rules,
maintenance task templates, authentication/
authorization, analytics integrations, or backup/restore. Validate the
read-only OPC UA path with simulated inputs and PLC-engineer-approved
credentials before connecting live equipment.
