
from datetime import date, datetime, time, timezone
from typing import Any

from app.services.maintenance_schedule import (
    RECURRENCE_UNITS,
    next_due_date,
)

# Calculate a date a specified number of calendar units after the starting date.
def calculate_calendar_date(
    start_date: date,
    *,
    interval: int,
    unit: str,
) -> date:
    if interval < 1:
        raise ValueError("Calendar interval must be at least 1")

    if unit not in RECURRENCE_UNITS:
        raise ValueError("Calendar unit must be days, weeks, months or years" )

    return next_due_date(
        start_date,
        interval=interval,
        unit=unit,
        after=start_date,
    )

# Similar to above func , but it also accepts an after date.
def calculate_next_calendar_date(
    start_date: date,
    *,
    interval: int,
    unit: str,
    after: date,
) -> date:
    if interval < 1:
        raise ValueError("Calendar interval must be at least 1")

    if unit not in RECURRENCE_UNITS:
        raise ValueError("Calendar unit must be days, weeks, months or years")

    return next_due_date(
        start_date,
        interval=interval,
        unit=unit,
        after=after,
    )

# Imp func -> Calculate the next due date and its corresponding overdue date.
def calculate_next_calendar_cycle(
    start_date: date,
    *,
    due_interval: int,
    overdue_interval: int,
    unit: str,
    after: date | None = None,
) -> tuple[date, date]:

    if due_interval < 1 or overdue_interval <= due_interval:
        raise ValueError("Overdue interval must be greater than due interval")

    if unit not in RECURRENCE_UNITS:
        raise ValueError( "Calendar unit must be days, weeks, months or years")

    reference_date = after or start_date
# Calcuate a particular cycle`s due date
    def due_for_cycle(cycle: int) -> date:
        return calculate_calendar_date(
            start_date,
            interval=cycle * due_interval,
            unit=unit,
        )

    # Find an upper bound for the next due cycle.
    low = 1
    high = 1

    while due_for_cycle(high) <= reference_date:
        high *= 2

    # Find the first cycle whose due date is after completion.
    while low < high:
        middle = (low + high) // 2

        if due_for_cycle(middle) <= reference_date:
            low = middle + 1
        else:
            high = middle

    next_due = due_for_cycle(low)

    # Overdue belongs to the same cycle as the selected due date.
    overdue_offset = low * due_interval + (overdue_interval - due_interval)

    next_overdue = calculate_calendar_date(
        start_date,
        interval=overdue_offset,
        unit=unit,
    )

    return next_due, next_overdue

# This func reads the calendar start timestamp from a config dictionary
def calendar_start_at(config: dict[str, Any]) -> datetime | None:

    value = config.get("start_at")
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("start_at must include a timezone")
    return parsed.astimezone(timezone.utc)

# This is the date-and-time version of cal_next_cal_cycle() it returns complete timestamps 
def calculate_calendar_cycle_at(
    start_at: datetime,
    *,
    due_interval: int,
    overdue_interval: int,
    unit: str,
    after: datetime | None = None,
) -> tuple[datetime, datetime]:
 
    if due_interval < 1 or overdue_interval <= due_interval:
        raise ValueError("Overdue interval must be greater than due interval")
    start_at = start_at.astimezone(timezone.utc)
    anchor = start_at.date()
    moment = start_at.timetz()

# Build a timestamp for any interval.
    def at(cycle_interval: int) -> datetime:
        return datetime.combine(calculate_calendar_date(anchor, interval=cycle_interval, unit=unit), moment)

    low = 1
    if after is not None:
        high = 1
        while at(high * due_interval) <= after:
            high *= 2
        while low < high:
            middle = (low + high) // 2
            if at(middle * due_interval) <= after:
                low = middle + 1
            else:
                high = middle
    return (
        at(low * due_interval),
        at(low * due_interval + (overdue_interval - due_interval)),
    )
