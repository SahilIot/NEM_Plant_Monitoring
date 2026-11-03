# Automatic audit stamping for monitoring rules and maintenance records.
"""
The authenticated user comes only from ``session.info["auth_user_id"]``, which
``get_db`` fills from the verified bearer session. Request bodies can never set
it. Sessions without an authenticated user (workers, schedulers) never claim a
user and leave the existing modification stamp untouched.
"""

from datetime import datetime, timezone

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.maintenance import MaintenanceRecord, MaintenanceSchedule
from app.models.rule import MonitoringRule

AUDITED_MODELS = (MonitoringRule, MaintenanceSchedule, MaintenanceRecord)
_IMMUTABLE_COLUMNS = ("created_by_id", "created_at")


def stamp_audit_fields(session, flush_context, instances) -> None:
    user_id = session.info.get("auth_user_id")
    now = datetime.now(timezone.utc)

    for obj in list(session.new):
        if not isinstance(obj, AUDITED_MODELS):
            continue
        # Always derive from the session; ignore anything set by callers.
        obj.created_by_id = user_id
        obj.updated_by_id = user_id
        obj.created_at = now
        obj.updated_at = now

    for obj in list(session.dirty):
        if not isinstance(obj, AUDITED_MODELS) or not session.is_modified(obj):
            continue
        state = inspect(obj)
        for column in _IMMUTABLE_COLUMNS:
            history = state.attrs[column].history
            if history.has_changes() and history.deleted:
                setattr(obj, column, history.deleted[0])
        if user_id is not None:
            obj.updated_by_id = user_id
            obj.updated_at = now
        elif obj.updated_at is not None:
            # System change: re-submit the stored value so the column's onupdate
            # default does not overwrite the last human modification time.
            flag_modified(obj, "updated_at")


event.listen(Session, "before_flush", stamp_audit_fields)
