# NEM Plant Monitoring

NEM Plant Monitoring is a React dashboard and FastAPI service for monitoring
industrial assets. It stores readings, tracks machine cycle and running-time
signals, evaluates monitoring rules, records alerts and events, and manages
maintenance work and recurring calendar schedules.

> **Safety and deployment:** The application is monitoring software, not a
> safety interlock. It has no PLC write or machine-control path. The OPC UA
> client supports signed and encrypted connections with server-certificate
> validation (see [OPC UA transport security](#opc-ua-transport-security)),
> but defaults to `OPCUA_SECURITY_MODE=None` (unsecured) so existing
> deployments keep working. Use the secure modes, and set
> `OPCUA_REQUIRE_SECURE_TRANSPORT=true`, on any production or untrusted
> network, and complete a deployment security review first.

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
  assign or copy rules, and manage rule lifecycle. Shared (reusable) rules have
  Administrator-controlled visibility. Rule types and limitations are described
  under [Monitoring rules](#monitoring-rules).
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
- **Dashboard configuration:** Manage the Monitoring Rule Library and Rule
  Collection Library, instructions and documents (with optional attachments),
  configuration import/export, profile and email settings, usage information,
  and database backup/restore.
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
        configuration/pages/        RuleLibrary, CollectionLibrary, visibility dialog,
                                    DocumentsPage / DocumentCreatePage / DocumentViewerPage /
                                    CreateInstructionPage (utils/documents.js helpers),
                                    ImportConfigurationPage + panel, ExportConfigurationPage
        settings/pages/             Profile, email, usage, backup/restore
        auth/                       AuthContext, LoginPage, AdminUsersPage
      services/                     api.js (REST client), liveUpdates.js (WebSocket client)
      styles/global.css             Light/dark theme tokens and layout
      utils/                        config.js, format.js, navigation.js
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
| `OPCUA_SECURITY_MODE` | `None` (default, unsecured), `Sign` or `SignAndEncrypt`. See [OPC UA transport security](#opc-ua-transport-security). |
| `OPCUA_SECURITY_POLICY` | `Basic256Sha256` (default), `Aes128Sha256RsaOaep` or `Aes256Sha256RsaPss`; used when the mode is not `None`. |
| `OPCUA_REQUIRE_SECURE_TRANSPORT` | When `true`, `OPCUA_SECURITY_MODE=None` is rejected as a configuration error; `false` by default. |
| `OPCUA_CLIENT_CERTIFICATE_PATH`, `OPCUA_CLIENT_PRIVATE_KEY_PATH` | Client certificate and private key (PEM or DER) for secure modes. |
| `OPCUA_CLIENT_PRIVATE_KEY_PASSWORD` | Optional password for an encrypted private key. |
| `OPCUA_TRUSTED_SERVER_CERTIFICATES` | File, or directory of `.pem`/`.crt`/`.cer`/`.der` files, holding the PLC server certificate(s) you trust. |
| `OPCUA_APPLICATION_URI` | Client application URI; must match the URI in the client certificate's subject alternative name. Default `urn:nem:plant-monitoring:opcua-client`. |
| `OPCUA_CHECK_SERVER_HOSTNAME` | When `true`, the server certificate must also match the host in `OPCUA_ENDPOINT`; `false` by default. |
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

### OPC UA transport security

The client stays read-only in every mode. `OPCUA_SECURITY_MODE` selects the
channel:

- `None` (default): no signing or encryption and no server authentication.
  A warning is logged once, and `/plc/status`, `/plc/test` and the PLC page show
  the mode. Username/password may be exposed in this mode.
- `Sign` / `SignAndEncrypt`: a secure channel using `OPCUA_SECURITY_POLICY`.

For the secure modes the backend, before every (re)connection:

1. Loads the client certificate and private key, rejecting an expired or
   not-yet-valid certificate, a wrong key password, or a key that does not match
   the certificate. On Linux/macOS the key file must not be readable by group or
   others (for example `chmod 600`).
2. Asks the server which certificate it uses for the configured policy/mode
   (public endpoint data only) and requires it to be present in
   `OPCUA_TRUSTED_SERVER_CERTIFICATES` (exact SHA-256 match). An untrusted,
   expired or not-yet-valid server certificate is rejected, and the rejected
   certificate's fingerprint is logged so it can be verified out of band.
3. Pins that certificate for the session, so a server presenting a different
   one is refused.

There is no fallback: if any step fails the connection is not made, the
collector reports a clear `last_error`, and `/plc/test` returns an error. It
never retries with `None`. Private keys, passwords and certificate paths are
not logged or returned by the API; `/plc/status` exposes only the mode, policy
and booleans.

PLC/server side: enable an endpoint with the chosen policy and mode; add the
client certificate to the server's trusted list (the certificate should carry a
URI SAN equal to `OPCUA_APPLICATION_URI`); and keep the user-identity settings
the server requires. When the PLC certificate is renewed, update the trust
location. Not every PLC supports every policy: `Basic256Sha256` is the most
widely supported. These paths have not been exercised against a live PLC.

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
- **Reusable rule templates:** create, organize, assign, and copy compatible
  rules through the configuration and asset workflows. Administrators decide
  which Supervisors can see each shared rule (see
  [Shared rule visibility](#shared-rule-visibility)); Supervisors can suggest a
  new reusable rule or maintenance schedule for Administrator review.

The first cycle sample establishes a baseline; only a subsequent false-to-true
edge increments the count. Running time is calculated from timestamps, not
fixed ticks. It pauses when the signal becomes false or is no longer
trustworthy; time across disconnects is not inferred. Missing, invalid,
future-dated, or stale data is reported as unknown rather than normal.

Rules can be suspended, resumed, activated, deactivated, completed, or
permanently deleted subject to lifecycle and role restrictions. `generic` and
`boolean_condition` have no evaluator: the engine reports them as unknown (never
normal), and they cannot raise, change or clear alerts. The database accepts
both (so existing rows load), `RuleCreate` accepts `generic` but not
`boolean_condition`, and the UI offers neither.

### Shared rule visibility

Each shared rule has exactly one of two visibilities: **Admin Only** or
**Specific Supervisors** (one or more). There is no "All Supervisors" option and
no default: an Administrator must choose a visibility when creating a rule.
Only an Administrator changes it afterwards. There is no request or approval
workflow; `/api/v1/rule-visibility-requests` answers 404 for every role. A
rule saved as `all_supervisors` by an older version is converted at startup to
Specific Supervisors listing the active Supervisors it was visible to.

A shared rule is a single record: a Supervisor allowed to edit its thresholds
changes it for every asset and user using it, after a confirmation dialog, and
the change is written to the rule history.

### Monitoring Rule Library and Rule Collection Library

`/configuration/rules` lists the reusable (shared) rules that belong to no
collection, with an overview (total, available, disabled, added in the last 30
days, rules per category), search, filters (rule type, category, availability,
labels) and sorting. Categories are derived from the implemented rule types:
Runtime-based, Cycle count, Time interval, Boolean condition and Threshold.
**View** opens the read-only details (configuration, assigned assets within the
caller's scope, change history). Editing, duplicating, deleting and visibility
keep their existing role restrictions.

`/configuration/collections` lists collections with their rule count (at most
five rules each), rule-category summary, labels, search and sorting. A
collection **owns** its rules (each rule template has one `collection_id`);
library rules are the templates without one. Collection management is
Administrator-only; other roles can view the contents they are allowed to see.
Deleting a collection deletes the rules inside it (the confirmation says so);
rules already assigned to assets are not changed. Moving an existing library
rule into a collection is not offered, because it would change ownership.

### Instructions & Documents

`/configuration/documents` combines two independent capabilities, both stored
in `instruction_documents` (with `instruction_document_files` for attachments):

- **Instruction** (`entry_type = "instruction"`, **Create New Instruction**):
  a title, category, content (required, up to 10,000 characters), optional asset
  and labels, and an **optional** attachment. An instruction with no file is
  valid and shows the status "No attachment".
- **Document** (`entry_type = "document"`, **Upload document**): one or more
  files are required.

Attachments: `.pdf`, `.doc`, `.docx`, `.txt` (content signatures are checked on
the server), up to 10 files, 10 MB each and 24 MB in total, stored under
`Nem_Backend/uploads/instruction_documents`. Administrators and Supervisors can
create; editing, deleting and replacing/adding/removing files are
Administrator-only. Every role can read and download, except entries hidden by
asset scope (`asset_id`) or schedule attachment. Rows record creator, last
editor and timestamps. Existing rows keep working: the startup upgrade adds
`entry_type` (default `document`), `asset_id` and the audit columns, and legacy
rows with kind `Instruction` are shown as instructions.

Endpoints: `GET/POST /documents`, `POST /documents/with-files`,
`PATCH/DELETE /documents/{id}`, `POST /documents/{id}/files`,
`PUT/DELETE /documents/{id}/files/{file_id}`, and `GET .../view|download`.

### Configuration import / export (Administrators only)

`GET /api/v1/config-transfer/export` returns a versioned JSON package
(`application: nem-plant-monitoring`, `format_version: 1.0`) with Monitoring
Rules, Monitoring Rule Collections and Maintenance Rules (recurring definitions
only). It contains no database ids, runtime counters, alerts, events, completed
maintenance, documents or credentials; Supervisors are referenced by username
and assets by name/type/parent name. `POST /config-transfer/preview` validates a
package and writes nothing; `POST /config-transfer/import` re-validates and
creates the records in one transaction (all or nothing). Existing rules are
never overwritten: duplicates are skipped or imported under a new name.
Missing destination Supervisors fall back to Admin Only unless the Administrator
maps them. Maintenance rules need a destination asset: an exact name, type and parent match is used
automatically; otherwise the import review lists the exported asset with the active assets of the same type
(same-name assets first as suggestions) and the Administrator picks one, which applies to every rule on that
source asset. Nothing is mapped automatically, assets are never created, and the choice is re-validated
(exists, active, same type) and duplicate-checked on the server. The
importing Administrator is recorded as creator and each import is logged in
`nem_configuration_imports`.

`GET /config-transfer/export` accepts optional `categories`
(`monitoring_rules,collection_rules,maintenance_rules`) and `asset_ids`
(limits maintenance rules); with no parameters the output is unchanged.
`GET /config-transfer/export/summary` returns the counts shown before
downloading, and each export writes a log line (user id, categories, counts).
JSON is the only supported format. The Import page (`/configuration/import`)
takes a `.json` file up to 5 MB, shows a server-side preview with counts per
status, lets the Administrator confirm what will be created, skipped or
rejected, and offers a CSV validation/error report. Database backup and restore
are separate (Settings → Backup and restore).

Visibility, editing and assignment are separate checks, all enforced by the
backend. A Supervisor who can see a shared rule may change only its numeric
thresholds and evaluation interval; creating or deleting shared rules is
Administrator-only; assigning a rule to an asset also needs access to that
asset. A rule a caller may not see answers 404, the same as a missing rule.
Every edit is recorded field by field, and every visibility change with its
previous and new value, in a history shown in the Rule Library **View** dialog.

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

**Asset assignment scope:** Administrators see everything. A Supervisor or
Operator sees and can act on only the assets assigned to them (Asset detail ->
assigned users, using the `nem_asset_supervisors` table) and those assets'
descendants. A non-admin with no assignments sees nothing. The scope is applied
on the server for asset, variable, reading, rule, alert, event, dashboard,
maintenance, document and PLC-status queries and for WebSocket events; an
out-of-scope item returns 404, and a parent outside the scope is hidden.
Assigning an Operator grants access only; email recipients remain the assigned
Supervisors. This has been checked by reading and compiling the code, not by an
automated or live multi-role test, so verify it against a real database before
relying on it as a data-isolation boundary. The frontend stores its session
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
| Shared rules | `/rule-templates`, `/rule-templates/{id}/visibility` (Administrator), `/rule-templates/{id}/history`, `/rule-templates/{id}/assignments`, `/rule-visibility/supervisors`, `/rule-template-requests` (suggestions) |
| Monitoring | `/monitoring/status`, `/monitoring/evaluate`, alerts and events |
| Maintenance | `/maintenance`, `/maintenance/schedules`, start/complete/cancel and next-date actions |
| PLC / OPC UA | `/plc/status`, `/plc/test`, `/plc/discover`, `/plc/read` |
| Notifications | Asset supervisor assignment and email delivery summary |
| Dashboard/configuration | Summary, `/collections`, `/documents` (instructions and files), settings, `/config-transfer/*` (export, export/summary, preview, import), usage, backups |
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

At startup (and in `create_admin.py` / `seed.py`),
`initialize_database()` runs `Base.metadata.create_all()` and the additive,
idempotent updates in `app/db/init_db.py`, serialized across processes by a
PostgreSQL advisory lock. SQLite is never initialized by the application:
`DATABASE_URL` must be a `postgresql+psycopg` URL. On an older database it also
widens `ck_nem_monitoring_rules_type` to the current rule types (added `NOT
VALID`, so no existing row is changed); rollback is
`ALTER TABLE nem_monitoring_rules DROP CONSTRAINT ck_nem_monitoring_rules_type`
followed by re-adding the previous definition. Startup still drops the legacy
`nem_monitoring_rules.is_archived` and `nem_maintenance_records.archived_at`
columns if present. Startup also verifies the audit columns (foreign keys and indexes), the
shared-rule `visibility_type` column and its allowed-values constraint, and
removes the discontinued visibility-request table and `request_id` column only
when that loses nothing; otherwise it keeps them and logs a warning. See
[Startup schema upgrades](docs/architecture.md#startup-schema-upgrades). This
is not a substitute for reviewing schema changes. Back
up the database before deploying updates. Dashboard backups are separate snapshots managed through
the Settings workflow; restoring one replaces current monitoring data.
Protect database backups and the backend `backups/` directory.

**Dashboard backup and restore** (Administrators only). A backup is one ZIP file
(`format_version` 2) written from a single PostgreSQL `REPEATABLE READ` snapshot, so all
tables show the same moment even while users work. It contains `manifest.json` (row counts and
SHA-256 checksums), one `tables/<name>.jsonl` per table, and the uploaded document attachments
(`files/`). Scope: assets, variables, readings, rule collections, templates and rules (with their
label links, supervisor grants and change history), rule states and counters, alerts, events,
maintenance schedules and records, machine states, labels, instructions with attachment metadata
and files, asset supervisor assignments and dashboard configuration. Not included: user accounts
and sessions, the email outbox, rule suggestions, configuration-import log, scheduler leases and
the backup history itself. Settings may hold SMTP credentials, so treat backup files as secrets.

Restore is a staged workflow in Settings → Backup and restore: select, validate, preview impact,
confirm, execute, result. The whole file is validated first (format version, tables, columns, types
including numeric precision/scale and integer ranges, primary keys, references, checksums) and
attachment files are staged and verified; nothing is deleted if that fails. The preview
(`POST /backups/{id}/restore/preview`) lists tables replaced, attachments restored/renamed/missing
and records in tables outside the backup that would be deleted (`ON DELETE CASCADE`), cleared
(`SET NULL`) or reset (`SET DEFAULT`); rows that block the restore (`RESTRICT`/`NO ACTION`) must be
removed first. When the restore changes data outside the backup, or the backup is a legacy v1 file,
the preview returns a signed confirmation token bound to that backup file, its checksum, the
calculated impact and the administrator; it expires after 15 minutes and is rejected (HTTP 409) if
anything differs when the restore runs. The database part (advisory lock, exclusive table locks,
delete, insert, sequence reset) is one transaction, so it is all-or-nothing; the caller's own session
is neither committed nor rolled back. After the commit, attachments are moved into `uploads/`
(existing files are never overwritten or deleted; a clashing name is stored under a new name and the
record updated) and start-up rule migrations are re-run. If a file cannot be moved it is kept in a
`restore-recovery-*` folder next to the uploads with a `recovery.json` naming the document and
original file name; the result is then reported as partial, and an administrator can retry from the
page (`POST /backups/recovery/{folder}/retry`). Records pointing at missing user accounts are kept
with the reference cleared. Only one restore can run at a time.

Other endpoints (Administrators only): `GET /backups`, `GET /backups/storage`, `GET /backups/{id}`
(details), `GET /backups/{id}/download`, `POST /backups/upload`, `DELETE /backups/{id}`. Old `.json`
backups (format version 1) can still be restored, but they do not contain schedules, label links,
attachment files and similar data; the limitations are shown in the preview and need an explicit
confirmation before a legacy restore runs. Every restore requires a signed confirmation token from
the preview, bound to the selected backup, user, and reviewed impact.

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
