import prisma from '@/lib/db';

/**
 * lib/localCalendar.js — CRUD for agent-created local calendar events.
 * DingTalk CalDAV is read-only (Allow: OPTIONS, GET, HEAD, TRACE, PROPFIND,
 * REPORT), so agent events live in Postgres and merge into the calendar feed.
 */

export function localEventToJson(event) {
  return {
    uid: event.uid,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt.toISOString(),
    allDay: event.allDay,
    sequence: event.sequence,
    origin: event.origin,
  };
}

export async function createLocalEvent(fields) {
  return prisma.localCalendarEvent.create({
    data: {
      uid: fields.uid,
      summary: fields.summary,
      description: fields.description,
      location: fields.location,
      startAt: fields.startAt,
      endAt: fields.endAt,
      allDay: fields.allDay,
    },
  });
}

export async function findLocalEventByUid(uid) {
  if (!uid) return null;
  return prisma.localCalendarEvent.findUnique({ where: { uid: String(uid) } });
}

export async function updateLocalEvent(uid, merged) {
  return prisma.localCalendarEvent.update({
    where: { uid: String(uid) },
    data: {
      summary: merged.summary,
      description: merged.description,
      location: merged.location,
      startAt: merged.startAt,
      endAt: merged.endAt,
      allDay: merged.allDay,
      sequence: { increment: 1 },
    },
  });
}

export async function deleteLocalEvent(uid) {
  return prisma.localCalendarEvent.delete({ where: { uid: String(uid) } });
}

/**
 * Local events overlapping [rangeStart, rangeEnd).
 */
export async function listLocalEventsForRange(rangeStart, rangeEnd) {
  return prisma.localCalendarEvent.findMany({
    where: {
      startAt: { lt: rangeEnd },
      endAt: { gt: rangeStart },
    },
    orderBy: { startAt: 'asc' },
  });
}
