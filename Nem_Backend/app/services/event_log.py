# Writes an audit/event row in the caller's transaction (nothing is committed here). It lives apart from the
# monitoring engine so every service that records an event can do so without depending on rule evaluation.
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import MonitoringEvent


def emit_event(
    session: Session,
    *,
    event_type: str,
    message: str,
    occurred_at: datetime,
    asset_id: int | None = None,
    rule_id: int | None = None,
    alert_id: int | None = None,
    severity: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> MonitoringEvent:
    event = MonitoringEvent(
        event_type=event_type,
        message=message,
        occurred_at=occurred_at,
        asset_id=asset_id,
        rule_id=rule_id,
        alert_id=alert_id,
        severity=severity,
        event_metadata=metadata,
    )
    session.add(event)
    return event
