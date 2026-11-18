#Live update system for backend
import asyncio
import json
import logging
import queue
import threading
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy import event, inspect as sa_inspect
from sqlalchemy.orm import Session

LOGGER = logging.getLogger(__name__)
_BRIDGE_CHANNEL = "nem_live_updates"
_NOTIFY_PAYLOAD_LIMIT = 7000  # PostgreSQL rejects NOTIFY payloads of 8000 bytes or more

_CRITICAL_TABLES = {
    "nem_alerts", # alert records
    "nem_monitoring_events", # monitoring events
}
_MAX_RETAINED_CRITICAL_EVENTS = 256 #Maximum number of critical events retained
_ASSIGNMENT_TABLE = "nem_asset_supervisors" # asset assignments; a change alters which assets users may see
#Tracking which db entities changed ,tells the code which IDs to collect for each table.
_ENTITY_ID_ATTRIBUTES = {
    "assets": ("id",),
    "variables": ("id", "asset_id"),
    "readings": ("id", "asset_id", "variable_id"),
    "nem_readings": ("id", "asset_id", "variable_id"),
    "nem_monitoring_rules": ("id", "target_asset_id", "variable_id"),
    "nem_rule_states": ("id", "rule_id", "target_asset_id", "target_variable_id"),
    "nem_rule_counter_states": ("id", "rule_id", "asset_id"),
    "nem_rule_parameters": ("id", "rule_id"),
    "nem_rule_parameter_states": ("id", "parameter_id"),
    "machine_monitoring_states": ("asset_id",),
    "nem_alerts": ("id", "rule_id", "target_asset_id", "maintenance_schedule_id"),
    "nem_monitoring_events": ("id", "rule_id", "asset_id", "alert_id"),
    "nem_maintenance_records": ("id", "asset_id", "alert_id", "schedule_id"),
    "nem_maintenance_schedules": ("id", "asset_id"),
}

# Tables that carry no asset: a restricted user is told they changed (so lists refetch through the
# permission-checked REST API) but never receives identifiers.
_GLOBAL_TABLES = {
    "rule_collections",
    "nem_monitoring_rule_templates",
    "nem_monitoring_rule_template_requests",
    "instruction_documents",
    "labels",
}
_GLOBAL_EVENT_PREFIXES = ("collection.", "rule_template.", "document.")
# Event families that change what the Overview shows.
_OVERVIEW_PREFIXES = ("asset.", "alert.", "rule.", "parameter.", "maintenance.", "counter.", "runtime.", "plc.", "monitoring.")

# One name per kind of change, "<domain>.<what happened>". These are invalidation signals: they say what
# changed so a page can refetch just that data; the committed database row stays the source of truth.
_DOMAINS = {
    "assets": "asset",
    "variables": "variable",
    "nem_monitoring_rules": "rule",
    "nem_rule_parameters": "parameter",
    "nem_alerts": "alert",
    "nem_maintenance_records": "maintenance",
    "nem_maintenance_schedules": "maintenance",
    "rule_collections": "collection",
    "nem_monitoring_rule_templates": "rule_template",
    "instruction_documents": "document",
}
_LIFECYCLE_EVENT = {"in_progress": "rule.activated", "suspended": "rule.suspended", "deactivated": "rule.deactivated"}


class PostgresEventBridge:
    """Moves committed-change batches between server instances through PostgreSQL LISTEN/NOTIFY.

    It needs no extra service. A sender thread and a listener thread each hold their own autocommit
    connection, so nothing here touches request sessions or the event loop. If the listener loses its
    connection it reconnects and tells clients to resynchronise, because notifications sent meanwhile are gone.
    """

    def __init__(self, hub: "LiveUpdateHub", dsn: str) -> None:
        self._hub = hub
        self._dsn = dsn
        self._outbox: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=256)
        self._stop = threading.Event()
        self._overflowed = False
        self._threads = [
            threading.Thread(target=self._send_loop, name="live-notify-send", daemon=True),
            threading.Thread(target=self._listen_loop, name="live-notify-listen", daemon=True),
        ]

    def start(self) -> None:
        for thread in self._threads:
            thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._outbox.put_nowait({}) if not self._outbox.full() else None
        for thread in self._threads:
            thread.join(timeout=3)

    def send(self, batch: dict[str, Any]) -> None:
        try:
            if self._overflowed:
                batch = {**batch, "resync": True}
            self._outbox.put_nowait(batch)
            self._overflowed = False
        except queue.Full:
            self._overflowed = True  # the next batch that fits carries a resync marker

    def _send_loop(self) -> None:
        import psycopg

        while not self._stop.is_set():
            try:
                with psycopg.connect(self._dsn, autocommit=True) as connection:
                    while not self._stop.is_set():
                        batch = self._outbox.get()
                        if not batch:
                            continue
                        connection.execute("SELECT pg_notify(%s, %s)", (_BRIDGE_CHANNEL, json.dumps(batch)))
            except Exception:  # noqa: BLE001 - keep trying; local delivery is unaffected
                LOGGER.warning("Live-update notify connection failed; retrying", exc_info=True)
                self._stop.wait(2)

    def _listen_loop(self) -> None:
        import psycopg

        backoff, connected_before = 1.0, False
        while not self._stop.is_set():
            try:
                with psycopg.connect(self._dsn, autocommit=True) as connection:
                    connection.execute(f"LISTEN {_BRIDGE_CHANNEL}")
                    if connected_before:
                        self._hub.receive_remote({"resync": True})  # notifications sent while we were away are lost
                    connected_before, backoff = True, 1.0
                    while not self._stop.is_set():
                        for notice in connection.notifies(timeout=1.0):
                            try:
                                self._hub.receive_remote(json.loads(notice.payload))
                            except (ValueError, TypeError):
                                LOGGER.warning("Ignored a malformed live-update notification")
                            if self._stop.is_set():
                                break
            except Exception:  # noqa: BLE001
                LOGGER.warning("Live-update listen connection failed; retrying", exc_info=True)
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 30.0)


def _changed(instance: object, attribute: str) -> bool:
    """True when this attribute really has a pending change (not merely touched)."""
    try:
        return bool(sa_inspect(instance).attrs[attribute].history.has_changes())
    except Exception:  # noqa: BLE001 - an unknown attribute simply means "no change"
        return False


def _semantic_events(instance: object, table: str, operation: str) -> set[str]:
    """Event names for one flushed row. `operation` is created, updated or deleted."""
    names: set[str] = set()
    domain = _DOMAINS.get(table)
    if domain:
        names.add(f"{domain}.{operation}")
    if table == "assets" and operation == "updated" and _changed(instance, "is_active"):
        names.add("asset.status_changed")
    elif table in {"readings", "nem_readings"} and operation == "created":
        names.add("variable.value_changed")
    elif table == "variables" and operation == "updated" and _changed(instance, "is_active"):
        names.add("variable.status_changed")
    elif table == "nem_monitoring_rules" and operation == "updated" and _changed(instance, "lifecycle_status"):
        names.add(_LIFECYCLE_EVENT.get(getattr(instance, "lifecycle_status", None), "rule.updated"))
    elif table in {"nem_rule_states", "nem_rule_parameter_states"} and operation != "deleted":
        if operation == "created" or _changed(instance, "status"):
            names.add("rule.status_changed")
    elif table == "nem_rule_counter_states" and operation != "deleted":
        if operation == "created" or _changed(instance, "cycle_count"):
            names.add("counter.updated")
        if _changed(instance, "accumulated_running_seconds"):
            names.add("runtime.updated")
        if _changed(instance, "is_running"):
            names.add("asset.status_changed")
    elif table == "machine_monitoring_states" and operation != "deleted":
        if operation == "created" or _changed(instance, "cycle_count"):
            names.add("counter.updated")
        if _changed(instance, "accumulated_running_seconds"):
            names.add("runtime.updated")
        if _changed(instance, "is_running"):
            names.add("asset.status_changed")
        if _changed(instance, "last_seen_at") and not names:
            names.add("monitoring.status_changed")
    elif table == "nem_alerts" and operation == "updated" and _changed(instance, "acknowledged_at"):
        names.add("alert.acknowledged")
    elif table in {"nem_maintenance_records", "nem_maintenance_schedules"} and operation == "updated" and _changed(instance, "status"):
        if getattr(instance, "status", None) == "completed":
            names.add("maintenance.completed")
    elif table == "rule_collections" and operation == "updated":
        names.add("collection.status_changed")
    return names


# This is the notification manager: it merges, orders and fans out committed changes.
class LiveUpdateHub:
    def __init__(self) -> None:
        # A new epoch tells clients the server restarted, so sequence numbers started over and they must resync.
        self.epoch: str = uuid4().hex
        self.instance_id: str = uuid4().hex  # tells an instance its own notifications apart from other instances'
        self._bridge: "PostgresEventBridge | None" = None
        self._outbound: dict[str, Any] = {"tables": set(), "assets": set(), "entities": {}, "events": set()}
        self._outbound_handle: asyncio.TimerHandle | None = None
        self._seq: int = 0
        self._pending_events: set[str] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._database_change_listeners: set[Callable[[set[str]], None]] = set()
        self._pending_tables: set[str] = set()
        self._pending_asset_ids: set[int] = set()
        self._pending_entity_ids: dict[str, set[int]] = {}
        self._flush_handle: asyncio.TimerHandle | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
#Connecting the frontend to live updates
    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=32)
        self._subscribers.add(queue)
        queue.put_nowait(self._stamp(self._event("connected"), advance=False))
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def add_database_change_listener(self, listener: Callable[[set[str]], None]) -> None:
        self._database_change_listeners.add(listener)

    def publish_from_session(
        self,
        changed_tables: set[str],
        asset_ids: set[int],
        entity_ids: dict[str, set[int]] | None = None,
        events: set[str] | None = None,
    ) -> None:
        if not changed_tables or self._loop is None or self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(
            self._queue_database_change,
            changed_tables,
            asset_ids,
            entity_ids or {},
            events or set(),
        )

    def _queue_database_change(
        self,
        changed_tables: set[str],
        asset_ids: set[int],
        entity_ids: dict[str, set[int]],
        events: set[str] | None = None,
        remote: bool = False,
    ) -> None:
        if not remote and self._bridge is not None:
            self._queue_outbound(changed_tables, asset_ids, entity_ids, events or set())
        self._pending_events.update(events or ())
        self._pending_tables.update(changed_tables)
        self._pending_asset_ids.update(asset_ids)
        for table, identifiers in entity_ids.items():
            self._pending_entity_ids.setdefault(table, set()).update(identifiers)
        if self._flush_handle is None:
            assert self._loop is not None
            self._flush_handle = self._loop.call_later(0.15, self._flush_database_changes)

    def _flush_database_changes(self) -> None:
        self._flush_handle = None
        tables = self._pending_tables
        asset_ids = self._pending_asset_ids
        entity_ids = self._pending_entity_ids
        events = self._pending_events
        self._pending_events = set()
        self._pending_tables = set()
        self._pending_asset_ids = set()
        self._pending_entity_ids = {}
        if not tables:
            return

        for listener in tuple(self._database_change_listeners):
            listener(set(tables))

        self._publish(
            self._event(
                "database_change",
                changed_tables=tables,
                asset_ids=asset_ids,
                entity_ids=entity_ids,
                critical=bool(tables & _CRITICAL_TABLES),
                events=events,
            )
        )

    # ---- Other server instances ---------------------------------------------------------------
    # Several instances may run against one database (one of them owns the OPC UA collector and the
    # evaluators). PostgreSQL LISTEN/NOTIFY carries each committed batch to the others, so a browser
    # connected to any instance sees every change. Remote batches are never sent on again.
    def start_cross_process(self, dsn: str) -> None:
        if self._bridge is None:
            self._bridge = PostgresEventBridge(self, dsn)
            self._bridge.start()

    def stop_cross_process(self) -> None:
        if self._bridge is not None:
            self._bridge.stop()
            self._bridge = None

    def _queue_outbound(self, tables: set[str], assets: set[int], entities: dict[str, set[int]], events: set[str]) -> None:
        out = self._outbound
        out["tables"].update(tables)
        out["assets"].update(assets)
        out["events"].update(events)
        for table, ids in entities.items():
            out["entities"].setdefault(table, set()).update(ids)
        if self._outbound_handle is None and self._loop is not None:
            self._outbound_handle = self._loop.call_later(0.15, self._flush_outbound)

    def _flush_outbound(self) -> None:
        self._outbound_handle = None
        out, self._outbound = self._outbound, {"tables": set(), "assets": set(), "entities": {}, "events": set()}
        if self._bridge is None or not out["tables"]:
            return
        batch = {
            "origin": self.instance_id,
            "tables": sorted(out["tables"]),
            "assets": sorted(out["assets"]),
            "entities": {table: sorted(ids) for table, ids in out["entities"].items() if ids},
            "events": sorted(out["events"]),
        }
        if len(json.dumps(batch)) > _NOTIFY_PAYLOAD_LIMIT:
            # Too large for one NOTIFY: other instances get the tables and assets, and clients resynchronise.
            batch.update(entities={}, resync=True)
        self._bridge.send(batch)

    def receive_remote(self, batch: dict[str, Any]) -> None:
        """A batch published by another instance (called from the bridge's listener thread)."""
        if batch.get("origin") == self.instance_id or self._loop is None or self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(self._apply_remote, batch)

    def _apply_remote(self, batch: dict[str, Any]) -> None:
        if batch.get("status"):
            self._publish(self._event("opcua_status", events=set(batch.get("events", ()))))
            return
        tables = set(batch.get("tables", ()))
        if tables:
            self._queue_database_change(
                tables,
                {int(a) for a in batch.get("assets", ())},
                {table: {int(i) for i in ids} for table, ids in (batch.get("entities") or {}).items()},
                set(batch.get("events", ())),
                remote=True,
            )
        if batch.get("resync") or not tables:
            self._publish(self._event("database_change", resync_required=True))

    def publish_status(self) -> None:
        if self._loop is None or self._loop.is_closed():
            return
        if self._bridge is not None:
            self._bridge.send({"origin": self.instance_id, "status": True,
                               "events": ["plc.status_changed", "monitoring.status_changed", "overview.updated"]})
        self._loop.call_soon_threadsafe(
            self._publish,
            self._event("opcua_status", events={"plc.status_changed", "monitoring.status_changed", "overview.updated"}),
        )

    @staticmethod
    def _event(
        event_type: str,
        *,
        changed_tables: set[str] | None = None,
        asset_ids: set[int] | None = None,
        entity_ids: dict[str, set[int]] | None = None,
        critical: bool = False,
        resync_required: bool = False,
        critical_events_truncated: bool = False,
        events: set[str] | None = None,
    ) -> dict[str, Any]:
        names = set(events or ())
        if any(name.startswith(_OVERVIEW_PREFIXES) for name in names):
            names.add("overview.updated")
        return {
            "event_id": str(uuid4()),
            "events": sorted(names),
            "type": event_type,
            "occurred_at": datetime.now(timezone.utc).isoformat(),
            "changed_tables": sorted(changed_tables or ()),
            "asset_ids": sorted(asset_ids or ()),
            "entity_ids": {
                table: sorted(ids)
                for table, ids in (entity_ids or {}).items()
                if ids
            },
            "payload": {},
            "critical": critical,
            "resync_required": resync_required,
            "critical_events": [],
            "critical_events_truncated": critical_events_truncated,
        }

    @staticmethod
    def _merge_events(
        pending: list[dict[str, Any]],
        incoming: dict[str, Any],
    ) -> dict[str, Any]:
        events = [*pending, incoming]
        tables = set().union(*(set(item.get("changed_tables", ())) for item in events))
        assets = set().union(*(set(item.get("asset_ids", ())) for item in events))
        entities: dict[str, set[int]] = {}
        for item in events:
            for table, ids in item.get("entity_ids", {}).items():
                entities.setdefault(table, set()).update(ids)
        merged = LiveUpdateHub._event(
            "database_change" if tables else incoming["type"],
            changed_tables=tables,
            asset_ids=assets,
            entity_ids=entities,
            critical=any(item.get("critical", False) for item in events),
            resync_required=True,
            events=set().union(*(set(item.get("events", ())) for item in events)),
        )
        retained_events = []
        for item in events:
            retained_events.extend(item.get("critical_events", ()))
            if item.get("critical") and not item.get("resync_required"):
                retained_events.append(item)
        truncated = any(item.get("critical_events_truncated", False) for item in events)
        if len(retained_events) > _MAX_RETAINED_CRITICAL_EVENTS:
            retained_events = retained_events[-_MAX_RETAINED_CRITICAL_EVENTS:]
            truncated = True
        merged["critical_events"] = retained_events
        merged["critical_events_truncated"] = truncated
        # The merged event stands in for the newest one it replaces, so the order stays intact.
        merged["seq"], merged["epoch"] = incoming.get("seq"), incoming.get("epoch")
        return merged

    def _stamp(self, update: dict[str, Any], *, advance: bool = True) -> dict[str, Any]:
        """Number an event so clients can drop stale or repeated ones and notice a restarted server."""
        if advance:
            self._seq += 1
        update["seq"], update["epoch"] = self._seq, self.epoch
        return update

    def _publish(self, update: dict[str, Any]) -> None:
        self._stamp(update)
        for queue in tuple(self._subscribers):
            if queue.full():
                pending: list[dict[str, Any]] = []
                while not queue.empty():
                    pending.append(queue.get_nowait())
                queue.put_nowait(self._merge_events(pending, update))
                continue
            queue.put_nowait(update)


def _collect_changed_tables(session: Session, flush_context: object) -> None:
    changed = session.info.setdefault("_live_changed_tables", set())
    asset_ids = session.info.setdefault("_live_changed_asset_ids", set())
    entity_ids = session.info.setdefault("_live_changed_entity_ids", {})
    names = session.info.setdefault("_live_changed_events", set())
    rows = (
        *((instance, "created") for instance in session.new),
        *((instance, "updated") for instance in session.dirty),
        *((instance, "deleted") for instance in session.deleted),
    )
    for instance, operation in rows:
        table_name = getattr(type(instance), "__tablename__", None)
        if table_name is None:
            continue
        # A row that was only touched, with no value actually changed, is not a change.
        if operation == "updated" and not session.is_modified(instance, include_collections=False):
            continue
        changed.add(table_name)
        names.update(_semantic_events(instance, table_name, operation))
        attributes = _ENTITY_ID_ATTRIBUTES.get(table_name, ("id",))
        ids = entity_ids.setdefault(table_name, set())
        for attribute in attributes:
            value = getattr(instance, attribute, None)
            if isinstance(value, int) and not isinstance(value, bool):
                ids.add(value)
                if attribute in {"asset_id", "target_asset_id"} or (table_name == "assets" and attribute == "id"):
                    asset_ids.add(value)


def _publish_committed_changes(session: Session) -> None:
    changed = session.info.pop("_live_changed_tables", set())
    asset_ids = session.info.pop("_live_changed_asset_ids", set())
    entity_ids = session.info.pop("_live_changed_entity_ids", {})
    names = session.info.pop("_live_changed_events", set())
    hub = session.info.get("live_update_hub")
    if isinstance(hub, LiveUpdateHub):
        hub.publish_from_session(changed, asset_ids, entity_ids, names)


def _discard_rolled_back_changes(session: Session) -> None:
    session.info.pop("_live_changed_tables", None)
    session.info.pop("_live_changed_asset_ids", None)
    session.info.pop("_live_changed_entity_ids", None)
    session.info.pop("_live_changed_events", None)


event.listen(Session, "after_flush", _collect_changed_tables)
event.listen(Session, "after_commit", _publish_committed_changes)
event.listen(Session, "after_rollback", _discard_rolled_back_changes)

#Keeping the Websocket alive
# This is the WebSocket handler that serves connected clients
async def serve_live_updates(
    websocket: WebSocket,
    hub: LiveUpdateHub,
    *,
    authorized_asset_ids: set[int] | None = None,
    authorization_check: Callable[
        [dict[str, Any]], Awaitable[tuple[bool, set[int] | None]]
    ] | None = None,
) -> None:
    await websocket.accept(subprotocol="nem-auth" if "nem-auth" in websocket.scope.get("subprotocols", []) else None)
    queue = hub.subscribe()

    async def receive_until_disconnected() -> None:
        while True:
            await websocket.receive_text()

    receiver = asyncio.create_task(receive_until_disconnected())
    stream_seq = 0
    try:
        while True:
            try:
                update = await asyncio.wait_for(queue.get(), timeout=25)
            except asyncio.TimeoutError:
                update = hub._stamp(hub._event("heartbeat"), advance=False)
            if authorization_check is not None:
                authorized, authorized_asset_ids = await authorization_check(update)
                if not authorized:
                    await websocket.close(code=1008, reason="Session is invalid or expired")
                    return
            if authorized_asset_ids is not None:
                if update["type"] == "database_change":
                    visible_asset_ids = (set(update.get("asset_ids", ())) & authorized_asset_ids)
                    if visible_asset_ids:
                        update = {
                            **update,
                            "asset_ids": sorted(visible_asset_ids),
                            "entity_ids": {},
                            "critical_events": [],
                            # Flags may originate from changes to assets this user cannot reach.
                            "critical": False,
                            "critical_events_truncated": False,
                        }
                    elif update.get("resync_required") or _ASSIGNMENT_TABLE in update.get("changed_tables", ()):
                        # Also sent when assignments change so a user who just gained or
                        # lost access refreshes immediately. Carries no asset information.
                        update = {
                            "type": "database_change",
                            "asset_ids": [],
                            "changed_tables": [],
                            "entity_ids": {},
                            "critical_events": [],
                            "resync_required": True,
                        }
                    elif set(update.get("changed_tables", ())) & _GLOBAL_TABLES:
                        # Rule collections, shared rules, documents and labels belong to no asset. A
                        # restricted user only learns that the list changed; the REST call re-applies visibility.
                        update = {
                            "event_id": update["event_id"], "type": "database_change", "seq": update.get("seq"),
                            "epoch": update.get("epoch"), "occurred_at": update.get("occurred_at"),
                            "asset_ids": [], "changed_tables": sorted(set(update["changed_tables"]) & _GLOBAL_TABLES),
                            "entity_ids": {}, "critical_events": [], "critical": False, "payload": {},
                            "events": [name for name in update.get("events", ()) if name.startswith(_GLOBAL_EVENT_PREFIXES)],
                        }
                    else:
                        continue
                elif update["type"] == "opcua_status":
                    # A plain connection-state notice names no asset, so it is forwarded as is.
                    # A resync marker is reduced to the generic form below.
                    if update.get("resync_required"):
                        update = {
                            "type": "database_change",
                            "asset_ids": [],
                            "changed_tables": [],
                            "entity_ids": {},
                            "critical_events": [],
                            "resync_required": True,
                        }
                elif update.get("resync_required"):
                    update = {
                        "type": "database_change",
                        "asset_ids": [],
                        "changed_tables": [],
                        "entity_ids": {},
                        "critical_events": [],
                        "resync_required": True,
                    }
                elif update["type"] not in {"connected", "heartbeat"}:
                    continue
            # Consecutive per connection: a gap tells the client something was lost and it must resynchronise.
            stream_seq += 1
            await websocket.send_json({**update, "stream_seq": stream_seq})
    except WebSocketDisconnect:
        pass
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)
        hub.unsubscribe(queue)

#Bridge between the db changes and live frontend 