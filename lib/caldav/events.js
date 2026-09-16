/**
 * lib/caldav/events.js — Range query over cached CalDAV objects + local events.
 */

import { expandObjectOccurrences } from './parse.js';
import { loadObjectsForRange } from './db.js';
import { parseEventRange, MAX_EVENTS } from './range.js';
import { listLocalEventsForRange } from '@/lib/localCalendar';

export { parseEventRange } from './range.js';

function localEventToOccurrence(event) {
  return {
    id: `local:${event.uid}`,
    uid: event.uid,
    summary: event.summary || '(No title)',
    description: event.description || null,
    location: event.location || null,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt.toISOString(),
    allDay: Boolean(event.allDay),
    status: null,
    calendarName: 'Agent',
    sourceId: 'local',
    href: null,
    isRecurring: false,
    source: 'local',
    organizer: null,
    attendees: [],
  };
}

/**
 * Expand cached CalDAV objects into occurrences for a date range,
 * merged with locally stored agent events.
 * @param {string} from
 * @param {string} to
 */
export async function listExpandedEvents(from, to) {
  const { rangeStart, rangeEnd } = parseEventRange(from, to);
  const [objects, localEvents] = await Promise.all([
    loadObjectsForRange(rangeStart, rangeEnd),
    listLocalEventsForRange(rangeStart, rangeEnd).catch((error) => {
      console.error('[calendar/events] local events failed', error);
      return [];
    }),
  ]);

  /** @type {ReturnType<typeof expandObjectOccurrences>} */
  const events = [];
  for (const event of localEvents) {
    events.push(localEventToOccurrence(event));
  }
  for (const object of objects) {
    const occurrences = expandObjectOccurrences(object, rangeStart, rangeEnd);
    for (const occ of occurrences) {
      events.push(occ);
      if (events.length >= MAX_EVENTS) break;
    }
    if (events.length >= MAX_EVENTS) break;
  }

  events.sort(
    (a, b) =>
      new Date(a.startAt).getTime() - new Date(b.startAt).getTime() ||
      String(a.summary).localeCompare(String(b.summary)),
  );

  return {
    from,
    to,
    truncated: events.length >= MAX_EVENTS,
    events,
  };
}
