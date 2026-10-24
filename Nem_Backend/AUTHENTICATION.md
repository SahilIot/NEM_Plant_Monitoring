# Authentication and access control

## Roles

Roles are case-sensitive and are stored as `Administrator`, `Supervisor`, or
`Operator`.

| Role | Plant access | Allowed actions |
| --- | --- | --- |
| Administrator | All machines | Full application and plant administration, including user access, configuration, and monitoring/maintenance management. |
| Supervisor | Explicitly assigned machines only | Read assigned plant data and manage monitoring rules, alerts, and maintenance for those machines. Permanent deletes and application configuration remain unavailable. |
| Operator | Explicitly assigned machines only | View assigned alert/task information and acknowledge active alerts. Operators cannot complete alerts, deactivate rules, or write monitoring/maintenance data. |

Assignments are direct asset IDs; access is not inherited by child assets. An
empty assignment set grants no plant-asset access. Administrator access is
independent of assignments and includes every machine.

## Existing database upgrade

The application upgrades role data during database initialization at startup:

- `Admin` is migrated to `Administrator`.
- `Viewer` is migrated to `Supervisor`.
- `Operator` remains unchanged.

PostgreSQL receives a role check constraint. Existing SQLite databases receive
role-validation triggers; newly created databases also use the model check
constraint. Any stored role outside the three supported values stops startup
with an error rather than being assigned a new permission level. Back up the
database before deploying the upgrade and resolve any such invalid roles before
restarting.

To bootstrap the first Administrator from `Nem_Backend`, configure the database
connection in the environment and run:

```powershell
.\.venv\Scripts\python.exe scripts\create_admin.py
```

## Authentication endpoints

All endpoints are under `/api/v1`:

- `POST /auth/login` creates a revocable session and returns the bearer token.
- `GET /auth/me` returns the authenticated user and direct asset assignments.
- `POST /auth/logout` revokes the current session.
- Administrator-only user management is under `/auth/users`; direct machine
  assignments are managed at `/auth/users/{user_id}/assets`.

Authenticated WebSocket clients provide the session token using the
`nem-auth.<token>` subprotocol. Asset-scoped users receive only updates for
assigned machines; global OPC UA status details are not sent to them. Overflow
resynchronization notifications are retained without including hidden asset
details.

Alert acknowledgements are attributed to the authenticated account by the
server. Acknowledging records the actor, timestamp, and acknowledgement outcome;
it does not resolve the alert or deactivate its monitoring rule.
