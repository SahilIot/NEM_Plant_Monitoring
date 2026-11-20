
from datetime import date

from app.services.maintenance_schedule import (
    RECURRENCE_UNITS,
    next_due_date,
)


def calculate_calendar_date(
    start_date: date,
    *,
    interval: int,
    unit: str,
) -> date:
    """
    Calculate a calendar date from the original start date.

    The interval is measured in days, weeks, months, or years.
    """
    if interval < 1:
        raise ValueError("Calendar interval must be at least 1")

    if unit not in RECURRENCE_UNITS:
        raise ValueError(
            "Calendar unit must be days, weeks, months or years"
        )

    return next_due_date(
        start_date,
        interval=interval,
        unit=unit,
        after=start_date,
    )


def calculate_next_calendar_date(
    start_date: date,
    *,
    interval: int,
    unit: str,
    after: date,
) -> date:
    """
    Calculate the next occurrence using the original start date
    as the fixed recurrence anchor.

    Late completion does not shift the recurrence schedule.
    """
    if interval < 1:
        raise ValueError("Calendar interval must be at least 1")

    if unit not in RECURRENCE_UNITS:
        raise ValueError(
            "Calendar unit must be days, weeks, months or years"
        )

    return next_due_date(
        start_date,
        interval=interval,
        unit=unit,
        after=after,
    )


def calculate_next_calendar_cycle(
    start_date: date,
    *,
    due_interval: int,
    overdue_interval: int,
    unit: str,
    after: date | None = None,
) -> tuple[date, date]:
    """
    Calculate the next due and overdue dates using the original
    start date as the fixed recurrence anchor.

    Both dates belong to the same maintenance cycle.
    """
    if due_interval < 1 or overdue_interval <= due_interval:
        raise ValueError("Overdue interval must be greater than due interval")

    if unit not in RECURRENCE_UNITS:
        raise ValueError(
            "Calendar unit must be days, weeks, months or years"
        )

    reference_date = after or start_date

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
    overdue_offset = low * due_interval + (
        overdue_interval - due_interval
    )

    next_overdue = calculate_calendar_date(
        start_date,
        interval=overdue_offset,
        unit=unit,
    )

    return next_due, next_overdue
