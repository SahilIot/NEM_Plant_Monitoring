# Real-time updates

This document describes how committed database changes reach open browser tabs.
It is based on `Nem_Backend/app/services/live_updates.py`, the WebSocket route in
`Nem_Backend/app/main.py` and `Nem_Frontend/src/services/liveUpdates.js`. It
describes the implementation; it has not been exercised against a real PLC, a
production database or a real browser session.

## Endpoints

The WebSocket is served at `/api/v1/ws/live` (alias `/api/v1/live`). A valid
session is required. The browser client sends its bearer token in the
`nem-auth.<token>` WebSocket subprotocol and the server accepts the plain
`nem-auth` subprotocol. If the session expires or the account loses access, the
server closes the socket with code 1008.

## Backend flow

1. Request sessions come from `get_db`. SQLAlchemy session events on `Session`
   (`after_flush`, `after_commit`, `after_rollback`) collect the tables,
   asset ids and entity ids touched by each flush into `session.info`.
2. Nothing is published before the commit. `after_commit` hands the collected
   changes to the `LiveUpdateHub`; `after_rollback` discards them, so a rolled
   back change never produces an event.
3. Statements executed with `session.execute(delete/update ...)` bypass the ORM
   change tracking. Code that uses them calls `record_bulk_change(...)` so the
   change is still published after the commit (for example permanent
   maintenance deletion and schedule/alert cleanup in `routes/maintenance.py`).
4. The hub turns the changed tables into named events using `_DOMAINS`
   (`assets` -> `asset`, `nem_alerts` -> `alert`, `nem_maintenance_records` and
   `nem_maintenance_schedules` -> `maintenance`, ...). The name is
   `<domain>.<operation>` (for example `maintenance.deleted`,
   `alert.deleted`) plus a few semantic names such as `rule.activated`,
   `maintenance.ready`, `maintenance.started`, `maintenance.completed` and
   `maintenance.cancelled`. Events starting with `asset.`, `alert.`, `rule.`,
   `parameter.`, `maintenance.`, `counter.`, `runtime.`, `plc.` or `monitoring.`
   also add `overview.updated`.
5. Rapid changes are coalesced. Each subscriber has a bounded queue; when it is
   full the pending messages are merged into one.

### Message shape

Each message carries: `event_id`, `type` (`database_change`, `opcua_status`,
`connected`, `heartbeat`), `events`, `occurred_at`, `changed_tables`,
`asset_ids`, `entity_ids` (per table), `critical`, `resync_required`, `seq`,
`epoch` and, per connection, `stream_seq`. A heartbeat is sent after 25 seconds
of silence.

`seq` increases with every published event and `epoch` changes when the server
restarts, so a client can drop stale or repeated messages. `stream_seq` counts
the messages on one connection; a gap means a message was lost and the client
must refetch.

### Visibility

Administrators receive every event. For Supervisors and Operators the server
filters by assigned assets (`services/access_scope.py`): asset-specific events
are limited to the visible asset ids, global changes (rule collections, shared
rule templates, documents, labels) are reduced to a "list changed" notice, and
an assignment change sends a resync marker so access changes apply immediately.

### Multiple backend processes

`PostgresEventBridge` uses PostgreSQL `LISTEN`/`NOTIFY` on the channel
`nem_live_updates` so a change committed by one backend instance reaches
WebSocket clients connected to another. Each hub has an `instance_id` and
ignores its own notifications. If the bridge connection drops, or its bounded
queue overflows, the receiving side sends `resync_required` so clients refetch.

OPC UA connection changes are published as `opcua_status` messages.

## Frontend flow

`services/liveUpdates.js` keeps one shared socket per tab, reconnects with
backoff, deduplicates events by `event_id`, tracks `epoch`/`seq`/`stream_seq`
and notifies subscribers. Pages subscribe and refetch only what the event
concerns. Two helpers keep this efficient:

- `createLiveUpdateScheduler(callback, delay)` coalesces bursts of events into
  one refresh (Asset detail uses 200 ms for live status and 250 ms for
  maintenance data).
- `shareInFlight(key, start, { fresh })` lets simultaneous requests share one
  fetch, but a `fresh` refresh never joins a request that started before the
  newest live event.

`MAINTENANCE_LIFECYCLE_EVENTS` lists the maintenance events that change what a
maintenance card or summary shows (`maintenance.created`, `.deleted`,
`.schedule_created`, `.ready`, `.started`, `.completed`, `.cancelled`), as
opposed to a schedule only advancing its saved progress.

Destructive actions in the UI (for example Delete maintenance) remove an item
from the list only after the backend confirms the request; the deletion event
then updates other open tabs.

## Troubleshooting

- No live updates behind a proxy: the proxy must forward WebSocket upgrades for
  `/api/v1/ws/live` (the Vite dev server does this for `/api`).
- Updates reach only some tabs when several backend processes run: the
  PostgreSQL role needs permission to `LISTEN`/`NOTIFY` on the application
  database.
- A client that reports a `stream_seq` gap or `resync_required` refetches its
  data; this is expected after a reconnect or a queue overflow.
