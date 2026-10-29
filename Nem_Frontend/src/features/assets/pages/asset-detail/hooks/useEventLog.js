import { api } from "../../../../../services/api.js";
import { eventActionLabel } from "../eventHelpers.js";

// Event log filtering and event deletion.
export default function useEventLog(ctx) {
  const {
    isAdministrator,
    deletingEventId,
    confirm,
    setDeletingEventId,
    setEventDeleteError,
    setEvents,
    setShowEventDetails,
    setSelectedEvent,
    events,
    eventTypeFilter,
    eventStartDateTime,
    eventEndDateTime,
  } = ctx;

  const deleteEvent = async (event) => {
    if (!isAdministrator || deletingEventId !== null) return;
    if (
      !(await confirm("Permanently delete this event? This cannot be undone.", {
        title: "Delete event",
        confirmLabel: "Delete permanently",
        destructive: true,
      }))
    ) {
      return;
    }
    setDeletingEventId(event.id);
    setEventDeleteError("");
    try {
      await api.del(`/events/${event.id}`);
      setEvents((current) => current.filter((item) => item.id !== event.id));
      setShowEventDetails(false);
      setSelectedEvent(null);
    } catch (error) {
      setEventDeleteError(error.message || "Could not delete this event.");
    } finally {
      setDeletingEventId(null);
    }
  };

  const eventTypes = [
    ...new Set(events.map((event) => event.event_type).filter(Boolean)),
  ].sort((a, b) => eventActionLabel(a).localeCompare(eventActionLabel(b)));

  const filteredEvents = [...events]
    .filter((event) => {
      if (eventTypeFilter && event.event_type !== eventTypeFilter) return false;
      const timestamp = new Date(
        event.time || event.occurred_at || "",
      ).getTime();
      const start = eventStartDateTime
        ? new Date(eventStartDateTime).getTime()
        : Number.NaN;
      const end = eventEndDateTime
        ? new Date(eventEndDateTime).getTime()
        : Number.NaN;
      if (
        Number.isFinite(start) &&
        (!Number.isFinite(timestamp) || timestamp < start)
      ) {
        return false;
      }
      if (
        Number.isFinite(end) &&
        (!Number.isFinite(timestamp) || timestamp > end)
      ) {
        return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        new Date(b.time || b.occurred_at || 0).getTime() -
        new Date(a.time || a.occurred_at || 0).getTime(),
    );

  return {
    deleteEvent,
    eventTypes,
    filteredEvents,
  };
}
