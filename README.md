# NEM Plant Monitoring


FastAPI + PostgreSQL backend and React dashboard for monitoring industrial
assets. Readings arrive from the REST API or from a **read-only** OPC UA
subscription to a Siemens S7-1200 PLC. The backend counts machine cycles,
accumulates running time, evaluates monitoring rules, raises warnings/alerts,
and records events. The React dashboard shows this live without page reloads.

There is **no PLC write or control path**. This is monitoring software, not a
safety interlock; see [Safety](#safety).

## Project layout

```text
Nem_Backend/   FastAPI app (app/), tests (tests/), seed.py, requirements.txt, .env
Nem_Frontend/  React + Vite dashboard (built output in dist/, served at /ui/)
README.md
```

Backend layout: `app/api/routes/` (REST endpoints), `app/schemas/` (Pydantic),
`app/models/` (SQLAlchemy 2.x), `app/services/` (monitoring engine, OPC UA
client and collector, ingestion), `app/core/` (settings), `app/db/` (engine,
UTC type, startup initialization).

## Implemented features

- **Asset management:** create, edit, browse, move, and organize assets in a
  parent/child hierarchy. Asset pages bring together machine status, readings,
  rules, maintenance, notes, and event history.
- **Variables and readings:** define typed variables for each asset, associate
  variables with OPC UA NodeIds, ingest individual or batched readings, and
  inspect recent or latest readings.
- **Live OPC UA monitoring:** read-only subscriptions, connection testing,
  node discovery, one-shot reads, mapping validation, reconnect handling, and
  live PLC status. OPC UA mappings are configured in the backend environment;
  an opt-in mapping-bypass test mode can also subscribe to registered variables
  with NodeIds.
- **Monitoring rules:** create rules from an asset's Current status page,
  including Motor Rotation cycle thresholds, Running Time thresholds, Boolean
  Count Thresholds, and supported variable-condition rules. Rule templates can
  be created, assigned, copied between assets, and managed separately from
  maintenance scheduling.
- **Cycle and runtime counters:** count a cycle on a Boolean `false`-to-`true`
  transition; maintain counters independently for each rule and asset; and
  accumulate actual elapsed running time while a trustworthy Boolean running
  signal is `true`.
- **Alerts and history:** evaluate warning and alert thresholds, keep a single
  active alert episode per rule condition, acknowledge alerts, and retain
  monitoring events and audit history.
- **Maintenance management:** record and edit maintenance work, track planned,
  in-progress, completed, and cancelled occurrences, manage recurring
  calendar schedules, approve or decline proposed next occurrences, and view
  active and archived maintenance history. Schedule due dates can raise
  warning alerts.
- **Dashboard configuration:** manage collections and documents, profile and
  settings, SMTP configuration, usage information, and database backup and
  restore through the existing dashboard workflows.

Asset and variable deletion is available when safe. Deletion is rejected when
referenced data, rules, alerts, maintenance records, child assets, or active
OPC UA mappings would be orphaned; deactivate or remove the references first.
Removing an otherwise empty asset also removes its asset-scoped event history.

## How it works

1. **Collector** (`opcua_collector.py`) normally subscribes only to the NodeIds
   listed in `OPCUA_MACHINE_MAPPINGS` and receives data-change notifications.
   A NodeId can be fanned out to different assets; it must not be mapped more
   than once for the same asset. The optional mapping-bypass mode is described
   below.
2. Each notification is normalized to timezone-aware UTC, checked against the
   out-of-order guard, saved as a reading, and applied to the machine state.
3. **Cycle counting:** a cycle is counted only on a `false`-to-`true` transition
   of the mapped *cycle signal*. The first valid value is only a baseline;
   repeated values do not count. The count is persisted in
   `machine_monitoring_states.cycle_count` and survives restarts. The frontend
   never increments counts; the backend is the source of truth. Motor
   Rotation/Boolean Count Threshold counters are also stored per rule and
   asset, so a newly created rule starts at zero without resetting another
   rule's counter.
4. **Running time:** accumulated from a mapped Boolean *running signal* using
   elapsed timestamps, not fixed time increments. The collector periodically
   reads running signals while connected so a stable `true` value remains
   fresh even when the PLC sends only value-change notifications. The timer
   pauses when the signal becomes `false`, on bad or missing data, or when the
   signal becomes stale; time during a disconnect is not inferred. Persisted
   per-rule runtime state survives normal restarts.
5. **Rules** are evaluated when readings arrive, when a cycle is counted, and
   by the periodic monitoring evaluator. The evaluator uses the configured
   interval and a PostgreSQL scheduler lease; a manual evaluation endpoint is
   also available. Runtime and cycle rules advance through configured warning,
   higher-warning, and alert thresholds. Alerts are updated rather than
   duplicated on every evaluation.
6. The dashboard polls status endpoints and updates React state in place,
   without a full page reload.

Only one backend instance may run the collector for a database; it is guarded
by a PostgreSQL lease (see [Leases](#leases)).

## Setup (Windows PowerShell)

Prerequisites: Python 3.12+, Node.js, PostgreSQL.

Keep your existing `.env`; do not overwrite it. Back up the database before the
first startup against a new database or after upgrading.

```powershell
cd C:\Users\Sahil\Downloads\NEM_Plant_Monitoring\Nem_Backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Frontend (separate window):

```powershell
cd C:\Users\Sahil\Downloads\NEM_Plant_Monitoring\Nem_Frontend
npm ci
npm run dev
```

- Dev dashboard: `http://127.0.0.1:5173/ui/` (Vite proxies `/api` to
  `http://127.0.0.1:8000`).
- Production-style: run `npm run build`, then FastAPI serves the built
  dashboard at `http://127.0.0.1:8000/` (redirects to `/ui/`).
- API: `http://127.0.0.1:8000`; Swagger UI `/docs`; OpenAPI `/openapi.json`.
- Restart the backend after changing `.env`, especially
  `OPCUA_MACHINE_MAPPINGS`. Press Ctrl+C to stop it.

## Database

PostgreSQL is the only supported database (`psycopg`). The NEM ORM uses
`assets`, `variables`, `machine_monitoring_states`, and `nem_*` tables
(`nem_readings`, `nem_monitoring_rules`, `nem_rule_states`, `nem_alerts`,
`nem_monitoring_events`, `nem_maintenance_records`,
`nem_maintenance_schedules`) plus `scheduler_leases` and dashboard configuration
tables, and `nem_rule_counter_states` for persistent per-rule cycle and runtime
counters. Pre-existing PLC-shaped tables
(`readings`, `monitoring_rules`, `alerts`, and others) are left untouched.

At startup `Base.metadata.create_all()` creates missing tables. Additive startup
updates also add `nem_monitoring_rules.is_archived`, maintenance schedule links,
the maintenance period-start date (backfilled from each schedule's start date),
and fields required to use the existing alerts table for due-date alerts. Older
maintenance rows are retained and treated as completed inspections;
`actual_completed_at` is backfilled from their legacy `performed_at` value. No
rows are deleted. Back up production data before deploying schema changes.

### Timestamp convention

- Python: timezone-aware **UTC** everywhere.
- PostgreSQL: columns are `timestamp without time zone` holding **UTC wall time**.
  The `UTCDateTime` type (`app/db/session.py`) converts aware datetimes to UTC
  on write and marks them UTC on read.
- Naive incoming OPC UA timestamps are interpreted as UTC and logged. Missing
  timestamps use the backend's current UTC time.
- Older code could store UTC values shifted by the PostgreSQL session timezone
  (for example `Asia/Calcutta`, +5:30), producing "future" timestamps that made
  valid notifications look out of order. Current code stores UTC correctly.
  Legacy shifted rows must be repaired deliberately; never apply a blind
  offset. Compare suspect rows against `now() AT TIME ZONE 'UTC'`, restrict
  changes to confirmed rows, work inside a transaction with `RETURNING`, and
  confirm counts before `COMMIT`.

### Out-of-order guard

The collector rejects a notification older than the last accepted cycle/running
signal timestamp and logs a warning with both timestamps. The guard is kept; fix
inconsistent timestamps at the source rather than disabling it.

## Environment configuration (`Nem_Backend/.env`)

No secrets belong in source control.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | `postgresql+psycopg://user:<URL-encoded-password>@localhost:5432/plc_monitoring`. No fallback. |
| `TEST_DATABASE_URL` | Dedicated test database, different from the application database. |
| `CORS_ORIGINS` | Comma-separated browser origins; empty (disabled) by default. |
| `MONITORING_SCHEDULER_ENABLED` | Enables periodic monitoring-rule evaluation; defaults to `true`. |
| `MONITORING_EVALUATION_INTERVAL_SECONDS` | Period between scheduled monitoring evaluations, default `15` seconds (1-3600). |
| `MAINTENANCE_DUE_ALERTS_ENABLED` | Enables the leased maintenance due-alert evaluator; defaults to `true` and checks once per minute. |
| `MONITORING_DEFAULT_STALE_AFTER_SECONDS` | Freshness window, default `300`; a rule may override it. |
| `OPCUA_ENDPOINT` | `opc.tcp://host:port/...` for the PLC. |
| `OPCUA_USERNAME`, `OPCUA_PASSWORD` | Optional; set both or neither. |
| `OPCUA_TIMEOUT_SECONDS` | Connection/read timeout, default `10`. |
| `OPCUA_RECONNECT_DELAY_SECONDS` | Delay before reconnecting, default `5`. |
| `OPCUA_SUBSCRIPTION_PUBLISHING_INTERVAL_MS` | Requested publishing interval, default `1000`. The server may revise it; `/api/v1/plc/status` reports requested and negotiated values. |
| `OPCUA_RUNTIME_CHECKPOINT_SECONDS` | Running-signal refresh and running-time checkpoint interval, default `10` seconds. Does not set the subscription publishing interval. |
| `OPCUA_MACHINE_MAPPINGS` | JSON array of NodeId mappings (below). Empty disables mapped collection unless mapping bypass is enabled. |
| `OPC_UA_MAPPING_BYPASS_ENABLED` | Temporary testing mode; defaults to `false`. When `true`, also subscribes to active asset-owned variables with valid declared NodeIds. |
| `SETTINGS_ENCRYPTION_KEY` | Fernet key for the dashboard's SMTP password. |
| `BACKUP_DIRECTORY` | Backup snapshot location, default `Nem_Backend/backups`. |

The monitored-item sampling interval is asyncua's `50` ms default and the queue
size is the server default. A short publishing interval does not guarantee that
very short pulses are captured.

## OPC UA machine mappings

The collector's subscription and one-shot read paths are read-only. OPC UA
transport encryption and certificate validation are intentionally disabled for
development testing. Use this only on a trusted, isolated network; do not use
this configuration on production or untrusted networks. Add the PLC-approved
security policy and certificates before deployment.

Mappings live in `OPCUA_MACHINE_MAPPINGS`; they are not created from the UI.
There is at most one entry per asset. A NodeId may be shared across different
assets, but may only appear once within a given asset mapping. Each
`variable_id` must identify an active variable belonging to that asset, with a
matching data type (Boolean for cycle/running signals).

```dotenv
OPCUA_MACHINE_MAPPINGS=[{"asset_id":1,"cycle_signal":{"node_id":"ns=2;s=Machine.Cycle","variable_id":11},"running_signal":{"node_id":"ns=2;s=Machine.Running","variable_id":12},"readings":[{"node_id":"ns=2;s=Machine.Temperature","variable_id":13}]}]
```

Example (replace the asset, variable, and NodeId values with those from your
database and PLC):

```dotenv
OPCUA_MACHINE_MAPPINGS=[{"asset_id":1,"cycle_signal":{"node_id":"ns=4;i=13","variable_id":11},"running_signal":{"node_id":"ns=4;i=14","variable_id":15},"readings":[{"node_id":"ns=4;i=16","variable_id":16}]}]
```

To add a running signal: create a Boolean variable on the asset (with
`opcua_node_id` set), add it as `running_signal`, remove the NodeId from any
duplicate mapping on that same asset, and restart the backend. Running time
stays at zero until the mapped signal reports `true`. While the collector is
connected, it periodically re-reads the signal and only accepts good-quality
Boolean values; failed or bad-quality reads do not refresh the signal's
freshness.

### Temporary mapping-bypass test mode

Set `OPC_UA_MAPPING_BYPASS_ENABLED=true` in `Nem_Backend/.env` and restart the
backend to enable this reversible test mode. Set it to `false` (or remove the
setting) and restart to restore mapping-only collection. Explicit mappings
remain active in either mode.

When enabled, the collector additionally discovers active variables belonging
to active assets when `opcua_node_id` is present and syntactically valid. Each
declared variable is associated only with its existing `asset_id`; variables
are not broadcast to every asset. A unique NodeId is subscribed once even if
multiple asset-owned variables use it. Boolean declared variables become
available for asset-scoped cycle-count and running-time rules; those rules
still validate Boolean data type, active status, asset ownership, and NodeId
syntax. The periodic good-quality Boolean refresh keeps stable running signals
fresh. New, edited, deactivated, or removed declared variables are detected
while connected and cause the collector to rebuild its subscriptions within
the configured runtime checkpoint interval. Invalid NodeIds are skipped and
logged. A mismatch between the declared variable type and the PLC's actual
value is rejected by normal reading validation, so the reading does not update
rule state. OPC UA NodeIds can be entered or edited in the asset's Variables
dialog; restart the backend after changing `.env` mappings or bypass settings.

This mode does not assign declared variables an implicit machine-state role:
only explicit `cycle_signal` and `running_signal` mappings drive legacy
machine-level state. Rule counters and runtime remain isolated by rule and
asset. The variable model requires every variable to belong to one asset, so
the mode removes the mapping prerequisite but does not support asset-free
variables. No database migration is required; the mode uses existing asset,
variable, and rule-counter tables.

`GET /api/v1/plc/status` (read-only) returns connection state, requested and
negotiated publishing interval, configured mappings (with validity), and per
machine: status, `cycle_count`, `running_seconds`, last signal time, staleness,
limits, and active alerts. Alerts listed here come only from enabled,
non-archived rules.

## Leases

A `scheduler_leases` row elects one monitoring evaluator, one maintenance
due-alert evaluator, and one collector owner (`opcua-subscription-collector`).
Acquisition and renewal are atomic updates; a lease can be reclaimed once
expired, and shutdown releases only the owner's own lease. Collector lease
duration is in seconds (default 30, capped at 900); monitoring and maintenance
evaluators use their own leases. A lease with a far-future expiry is a symptom
of the legacy timestamp shift above. If a stale lease from a stopped backend
blocks startup, verify no backend process owns it, then correct that single row
with an owner- and expiry-matched `UPDATE` (never delete it or change the
owner). Do not force-take a lease from a live owner.

## Dashboard

- **Overview:** summary tiles, a *Live cycle monitoring* panel (cycle count, last
  signal, running time, rule status, thresholds for each mapped machine), and
  active alerts with acknowledgement.
- **Assets -> asset page:** machine strip (status, cycles, running time, last
  signal, OPC UA connection, mapped cycle signal), *Live values* with the latest
  reading per variable, monitoring rule cards, logbook, maintenance records and
  schedules, and Event log. Runtime cards show the changing accumulated time
  and configured thresholds.
- **PLC / OPC UA:** connection test, one-shot read,
  mapping and publishing-interval details, and live machine cards.
- **Configuration / Settings:** rules, collections, documents, import, profile,
  SMTP, usage, and backup/restore.

On an asset's **Current status** page, **Add rule** opens the monitoring-rule
flow (Motor Rotation, Running Time, or Boolean Count Threshold). These forms
are scoped to the selected asset and submit to the existing monitoring-rule
API. Motor Rotation uses the asset's configured Boolean cycle signal.
Running Time uses its configured Boolean running signal and accepts custom
warning, higher-warning, and alert thresholds in hours. The thresholds must be
positive and strictly increasing. The maintenance panel has its own actions
for creating and managing maintenance work and schedules; maintenance
scheduling choices are separate from monitoring rules.

The asset page also provides guarded asset deletion and variable management.
A variable cannot be deleted while referenced by readings, rules, alerts, or
an OPC UA mapping. An asset cannot be deleted while it has children, variables,
monitoring data, maintenance records, or related state. Deleting an otherwise
empty asset also removes its asset-scoped event history.

Live polling (React state updates, no reloads, overlapping requests prevented,
timers cleaned up on unmount, errors shown without crashing):

| View | Data | Interval |
| --- | --- | --- |
| Overview live panel | `/plc/status`, `/monitoring/status` | 500 ms |
| PLC page | `/plc/status` | 1.5 s |
| Asset page | latest readings | 500 ms |
| Asset page | `/plc/status`, rules, rule states | 1.5 s |

Form modals keep what you typed while polling refreshes their options.

### Cycle-count threshold rules

Rule type `boolean_count_threshold` watches the persistent backend cycle count
with two increasing warning thresholds and a larger alert threshold, for
example `9000`, `9500`, and `10000`. It must target the Boolean variable
configured as the asset's `cycle_signal`; otherwise creation is rejected. In the
UI, open an asset, choose **Add rule**, select **Motor Rotation** or
**Boolean Count Threshold**, and pick the configured cycle signal. With
mapping bypass disabled, an empty dropdown means the asset has no cycle signal
in `OPCUA_MACHINE_MAPPINGS`. When bypass is enabled, active declared Boolean
variables on that asset are also offered as cycle signals.
Enabled rules are evaluated on each accepted cycle increment. Each rule has
its own counter and initial signal state: repeated `true` readings do not
count, and a newly created rule begins at zero even if another rule uses the
same variable or was previously archived or deleted.

### Running-time threshold rules

Rule type `runtime_duration` uses the asset's configured Boolean
`running_signal`, not a momentary cycle pulse. Configure positive warning,
higher-warning, and alert thresholds in increasing order (for example 8, 9,
and 10 hours). With mapping bypass enabled, a declared Boolean variable on the
asset can be selected instead of a configured `running_signal`. The backend
persists accumulated seconds per rule and asset,
computes elapsed time from timestamps, pauses while stopped, and periodically
re-reads the signal while connected. Missing, stale, disconnected, bad-quality,
or unknown signals do not cause additional run time to be inferred. The rule
status advances through normal, warning, and alert states as thresholds are
crossed; its active alert is updated rather than recreated at every evaluation.

### Rule lifecycle

- **Deactivate** a rule: its state becomes `unknown` and its active alert is
  closed (resolved) with history retained, so the asset no longer shows red.
- **Archive** (the *Archive* button appears only for deactivated rules; API
  `DELETE /api/v1/rules/{id}`): hides the rule from normal lists and
  evaluation while keeping evaluation state, alerts, and events. Archiving an
  enabled rule is rejected. A newly created rule has a new identity and fresh
  rule-specific counter state.
- Re-enabling a rule evaluates it again.

### Event log

The asset Event log shows only: rule created, warning/alert triggered, and
machine stopped. Cycle pulses and routine evaluation or maintenance events are
not shown. Other audit events remain in the database and are available from
`GET /api/v1/events`.

## API endpoints

Health: `GET /api/v1/health`, `GET /api/v1/ready`.

**Assets:** `POST/GET /api/v1/assets`, `GET/PATCH/DELETE /api/v1/assets/{id}`,
`GET /assets/{id}/children`, `GET /assets/{id}/hierarchy`,
`POST /assets/{id}/move`. Delete is allowed only when there are no child
assets, variables, readings, rules, alerts, maintenance records, or related
monitoring state; otherwise deactivate or remove the dependents first. An
otherwise empty asset's asset-scoped events are removed on deletion.

**Variables:** `POST/GET /api/v1/assets/{id}/variables`,
`GET/PATCH/DELETE /api/v1/variables/{id}`. Types: `number`, `integer`,
`string`, `boolean`. Keys are unique per asset. A variable can be deleted only
when it has no reading, rule, rule-state, alert, or OPC UA mapping references.

**Readings:** `POST /api/v1/readings`, `POST /api/v1/readings/batch` (1-100,
atomic), `GET /readings/variables/{id}/latest`, `GET /readings/assets/{id}/latest`,
`GET /readings/variables/{id}` (time filters, pagination). Values must match the
variable type, the variable must belong to the asset, and readings more than five
minutes in the future are rejected. Request bodies with a declared
`Content-Length` greater than 25 MiB are rejected.

**Rules and monitoring:** `POST/GET /api/v1/rules`, `GET/PATCH /rules/{id}`,
`GET /rules/{id}/status`, `POST /monitoring/evaluate`, `GET /monitoring/status`,
`GET /assets/{id}/monitoring-status`. Rule types: `parameter_threshold`,
`runtime_duration`, `duration`, `generic`, `boolean_condition`,
`boolean_count_threshold`. Runtime and cycle/count rules use per-rule,
per-asset persisted counters. Monitoring rules created for an asset must use
variables belonging to that asset; runtime and cycle rules must use the
configured Boolean signal for their respective role. Severity is `warning` or
`alert`. Missing, stale, future-dated, or invalid input is `unknown`, never
normal. `DELETE /api/v1/rules/{id}` archives a disabled rule while retaining
its history; the explicit `/api/v1/rules/{id}/permanent` action permanently
deletes an eligible disabled rule and its associated rule state.

**Alerts and events:** `GET /alerts/active`, `GET /alerts`,
`GET /alerts/{id}`, `POST /alerts/{id}/acknowledge`, `GET /events`,
`GET /events/{id}`. `/alerts/active` excludes alerts of disabled or archived
rules. Acknowledgement does not resolve the condition. No email or other
outbound notification is sent.

**Maintenance:** `POST /api/v1/maintenance`, `GET /api/v1/maintenance`,
`GET/PATCH/DELETE /api/v1/maintenance/{id}`, and
`POST /api/v1/maintenance/{id}/start`, `/complete`, or `/cancel`. Asset Detail
includes maintenance history, create and edit forms, status actions, planned
and actual dates, and summary counts. Completed occurrences are read-only;
DELETE archives them in a separate log without deleting their history.
Cancelling retains the record. Planned
work uses calendar dates only; running-hour and cycle-based maintenance
scheduling is not implemented. Schedules use `POST/GET
/api/v1/maintenance/schedules`, `GET/PATCH
/api/v1/maintenance/schedules/{schedule_id}`, and the
`/confirm-next` and `/decline-next` actions. Due-date alerts are active warning
rows in the existing `nem_alerts` table and are evaluated by a leased backend
task; they are resolved when the occurrence is completed. Schedule progress is
shown as elapsed/total calendar days, inclusive of the current period's start
and due dates. Deleting completed maintenance archives it from the active list
without deleting the history; the archived log and an audit event retain it.

**Dashboard summary:** `GET /api/v1/dashboard/summary` (asset counts, rule state
counts, active and unacknowledged alerts, latest reading time; archived and
disabled rules are not counted as active).

**Dashboard compatibility endpoints** (used by the React app): `/summary`,
`/assets/{id}/rules` (+ `/rules/bulk`), `DELETE /rules/{id}` (archive),
`/assets/{id}/logbook`, `/assets/{id}/events`, `/collections`, `/documents`,
`/import`, `/me`, `/settings/{section}`, `/usage`, `/backups` and
`/backups/{id}/restore`. Backup restore **replaces** current monitoring data;
keep backup files protected and confirm the prompt.

**PLC / OPC UA:** `GET /plc/status`, `GET /plc/test` (reads `i=2258`),
`POST /plc/discover` and `GET /plc/discover/{job_id}` (browse nodes),
`POST /plc/read` (one read stored as a normal reading, running matching rules).
There are no write operations.

Errors use `{"error": {"code": 404, "message": "..."}}` or FastAPI's `detail`.

Node-RED can post readings to `POST /api/v1/readings` instead of writing to the
database directly:

```json
{
  "asset_id": 8,
  "variable_id": 12,
  "value": 900,
  "recorded_at": "2026-10-12T06:30:00Z",
  "source_id": "node-red",
  "metadata": {"machine": "Machine 1", "signal": "Motor.RotationCount"}
}
```

## Verifying OPC UA operation

1. Start the backend and confirm `GET /api/v1/plc/status` shows
   `connection.connected: true`, the expected mappings, and a negotiated
   publishing interval.
2. Watch `cycle_count` rise while the cycle signal toggles. Confirm the latest
   readings alternate and `last_seen_at` is current.
3. For a running signal, confirm `status: running` and growing `running_seconds`.
4. If notifications are logged as out of order, compare stored timestamps with
   `now() AT TIME ZONE 'UTC'` for the legacy shift described above.
5. If the collector reports a lease conflict, see [Leases](#leases).

## Demo data

`python seed.py` (from `Nem_Backend`) creates an idempotent, clearly marked demo
asset tree, variables, and sample readings. It does not modify real assets, and
does not represent live equipment.

## Tests and builds

If you configure tests to connect to PostgreSQL, set `TEST_DATABASE_URL` to a
dedicated database that is not the application database. The runtime and
cycle-counter tests use an isolated in-memory SQLite database:

```powershell
cd Nem_Backend
.\.venv\Scripts\python.exe -m pytest -q
```

Frontend tests and production build:

```powershell
cd Nem_Frontend
npm test
npm run build
```

## Safety

This software only reads PLC values. It does not stop machinery and is not a
substitute for certified PLC safety logic, operator procedures,
authentication/authorization, or industrial network hardening. The API has no
authentication yet; do not expose it to a factory network or the internet. An
alert means a configured software condition was met, not that equipment is
physically safe or unsafe.

## Limitations

Not implemented: email/SMS delivery, authentication and roles, automatic
calendar-trigger rules, maintenance task templates, and analytics integrations.
Validate the read-only OPC UA path with approved credentials and simulated
inputs before connecting live equipment.
