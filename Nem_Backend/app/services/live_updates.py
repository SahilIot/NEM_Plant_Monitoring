import asyncio #Manages asycnhronous tasks,queues and communication between trhreads and the event loop
from datetime import datetime, timezone 
from typing import Any, Callable

from fastapi import WebSocket, WebSocketDisconnect #handle the persistent frontend connection
from sqlalchemy import event 
from sqlalchemy.orm import Session

#This class is the central manager for live notifications.
class LiveUpdateHub:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._database_change_listeners: set[Callable[[set[str]], None]] = set()
#Stores the application`s running asyncio event loop.`
    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
#Queues belonging to connected WebSocket clients
    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1)
        self._subscribers.add(queue)
        queue.put_nowait(self._event("connected", [], []))
        return queue
#Removes that queue when client disconnects
    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)
#Registering db change listeners
    def add_database_change_listener(self,listener: Callable[[set[str]], None],) -> None:
        self._database_change_listeners.add(listener)
#Publishing db changes
    def publish_from_session(self,changed_tables: set[str],asset_ids: set[int],) -> None:
        if not changed_tables or self._loop is None or self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(self._publish,
            self._event("database_change", sorted(changed_tables), sorted(asset_ids)),
        )
#Publishing OPC UA status
    def publish_status(self) -> None:
        if self._loop is None or self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(self._publish,self._event("opcua_status", [], []),)
#Create the event message
    @staticmethod
    def _event(
        event_type: str,
        changed_tables: list[str],
        asset_ids: list[int],
    ) -> dict[str, Any]:
        return {
            "type": event_type,
            "changed_tables": changed_tables,
            "asset_ids": asset_ids,
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        }
#Ditrtibuting updates
    def _publish(self, update: dict[str, Any]) -> None:
        if update["type"] == "database_change":
            changed_tables = set(update["changed_tables"])
            for listener in tuple(self._database_change_listeners):
                listener(changed_tables)

        for queue in tuple(self._subscribers):
            subscriber_update = update
            if queue.full():
                pending = queue.get_nowait()
                subscriber_update = {
                    **subscriber_update,
                    "changed_tables": sorted(
                        set(subscriber_update["changed_tables"])
                        | set(pending["changed_tables"])
                    ),
                    "asset_ids": sorted(
                        set(subscriber_update["asset_ids"])
                        | set(pending["asset_ids"])
                    ),
                    "type": (
                        "database_change"
                        if subscriber_update["changed_tables"]
                        or pending["changed_tables"]
                        else subscriber_update["type"]
                    ),
                }
            queue.put_nowait(subscriber_update)
#Three functions connect the db session lifecycle to the notificstion hub
#after_flush event calls this function after pending db changes have been flushed.
def _collect_changed_tables(session: Session, flush_context: object) -> None:
    changed = session.info.setdefault("_live_changed_tables", set())
    asset_ids = session.info.setdefault("_live_changed_asset_ids", set())
    for instance in (*session.new, *session.dirty, *session.deleted):
        table_name = getattr(type(instance), "__tablename__", None)
        if table_name is None:
            continue
        changed.add(table_name)
        attributes = (("id",)
            if table_name == "assets"
            else ("asset_id", "target_asset_id")
        )
        for attribute in attributes:
            value = getattr(instance, attribute, None)
            if isinstance(value, int) and not isinstance(value, bool):
                asset_ids.add(value)
#runs after a successful db commit
def _publish_committed_changes(session: Session) -> None:
    changed = session.info.pop("_live_changed_tables", set())
    asset_ids = session.info.pop("_live_changed_asset_ids", set())
    hub = session.info.get("live_update_hub")
    if isinstance(hub, LiveUpdateHub):
        hub.publish_from_session(changed, asset_ids)
#important because a transaction that fails or is rolled back should not trigger a misleading frontend refresh notification
def _discard_rolled_back_changes(session: Session) -> None:
    session.info.pop("_live_changed_tables", None)
    session.info.pop("_live_changed_asset_ids", None)

event.listen(Session, "after_flush", _collect_changed_tables)
event.listen(Session, "after_commit", _publish_committed_changes)
event.listen(Session, "after_rollback", _discard_rolled_back_changes)
#Accept the connection and create a queue
async def serve_live_updates(websocket: WebSocket,hub: LiveUpdateHub,) -> None:
    await websocket.accept()
    queue = hub.subscribe()
#Listen for disconnection
    async def receive_until_disconnected() -> None:
        while True:
            await websocket.receive_text()

    receiver = asyncio.create_task(receive_until_disconnected())
    try:
        #Send updates and heartbeats
        while True:
            try:
                update = await asyncio.wait_for(queue.get(), timeout=25)
            except asyncio.TimeoutError:
                update = hub._event("heartbeat", [], [])
            await websocket.send_json(update)
    except WebSocketDisconnect:
        pass
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)
        hub.unsubscribe(queue)