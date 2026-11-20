# Shared datetime helpers.
from __future__ import annotations

from datetime import datetime, timezone


def to_utc(value: datetime | None) -> datetime | None:
    # Aware UTC datetime for any input: None stays None, a naive value is taken to be UTC, an aware value is converted.
    if value is None:
        return None
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
