import ICAL from 'ical.js';

const MAX_EXPANSION_ITERATIONS = 500;

/**
 * Convert an ICAL.Time to a JS Date (UTC instant).
 * @param {import('ical.js').Time} time
 */
export function icalTimeToDate(time) {
  if (!time) return null;
  try {
    return time.toJSDate();
  } catch {
    return null;
  }
}

/**
 * Strip mailto: and normalize a CalDAV address value.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeEmail(value) {
  if (value == null) return null;
  let raw = String(value).trim();
  if (!raw) return null;
  raw = raw.replace(/^mailto:/i, '').trim();
  return raw || null;
}

/**
 * @param {import('ical.js').Property|null|undefined} prop
 * @returns {{ name: string|null, email: string|null, role: string|null, status: string|null }|null}
 */
export function normalizeParticipant(prop) {
  if (!prop) return null;
  try {
    const email = normalizeEmail(prop.getFirstValue?.() ?? prop);
    const params = typeof prop.getParameter === 'function' ? prop : null;
    const name =
      (params?.getParameter('cn') && String(params.getParameter('cn')).trim()) ||
      null;
    const role =
      (params?.getParameter('role') &&
        String(params.getParameter('role')).trim().toUpperCase()) ||
      null;
    const status =
      (params?.getParameter('partstat') &&
        String(params.getParameter('partstat')).trim().toUpperCase()) ||
      null;

    if (!name && !email) return null;
    return { name, email, role, status };
  } catch {
    return null;
  }
}

/**
 * Extract organizer + deduplicated attendees from a VEVENT component.
 * @param {import('ical.js').Component} vevent
 * @returns {{
 *   organizer: { name: string|null, email: string|null, role: string|null, status: string|null }|null,
 *   attendees: Array<{ name: string|null, email: string|null, role: string|null, status: string|null }>
 * }}
 */
export function extractParticipants(vevent) {
  if (!vevent) return { organizer: null, attendees: [] };

  const organizer = normalizeParticipant(vevent.getFirstProperty('organizer'));

  /** @type {Map<string, { name: string|null, email: string|null, role: string|null, status: string|null }>} */
  const byKey = new Map();
  for (const prop of vevent.getAllProperties('attendee') || []) {
    const person = normalizeParticipant(prop);
    if (!person) continue;
    const key = (person.email || person.name || '').toLowerCase();
    if (!key || byKey.has(key)) continue;
    byKey.set(key, person);
  }

  return {
    organizer,
    attendees: [...byKey.values()],
  };
}

/**
 * Prefer exception participants when present; otherwise inherit master.
 * @param {ReturnType<typeof extractParticipants>} master
 * @param {import('ical.js').Component} exceptionVevent
 */
function participantsForException(master, exceptionVevent) {
  const exception = extractParticipants(exceptionVevent);
  return {
    organizer: exception.organizer || master.organizer,
    attendees:
      exception.attendees.length > 0 ? exception.attendees : master.attendees,
  };
}

/**
 * Extract denormalized summary fields from a raw ICS blob (first VEVENT).
 * Used when caching objects after sync.
 * @param {string} rawIcal
 */
export function extractObjectSummary(rawIcal) {
  const empty = {
    uid: null,
    summary: null,
    description: null,
    location: null,
    startAt: null,
    endAt: null,
    allDay: false,
    status: null,
  };

  if (!rawIcal || typeof rawIcal !== 'string') return empty;

  try {
    const jcal = ICAL.parse(rawIcal);
    const vcalendar = new ICAL.Component(jcal);
    const vevent = vcalendar.getFirstSubcomponent('vevent');
    if (!vevent) return empty;

    const event = new ICAL.Event(vevent);
    const start = event.startDate;
    const end = event.endDate;

    return {
      uid: event.uid || vevent.getFirstPropertyValue('uid') || null,
      summary: event.summary || null,
      description: event.description || null,
      location: event.location || null,
      startAt: icalTimeToDate(start),
      endAt: icalTimeToDate(end),
      allDay: Boolean(start?.isDate),
      status: String(vevent.getFirstPropertyValue('status') || '').toUpperCase() || null,
    };
  } catch {
    return empty;
  }
}

/**
 * Whether two half-open intervals [aStart, aEnd) and [bStart, bEnd) overlap.
 */
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Normalize an occurrence into a feed event shape.
 */
function toOccurrence({
  id,
  uid,
  summary,
  description,
  location,
  start,
  end,
  allDay,
  status,
  calendarName,
  sourceId,
  href,
  isRecurring,
  organizer = null,
  attendees = [],
}) {
  return {
    id,
    uid,
    summary: summary || '(No title)',
    description: description || null,
    location: location || null,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    allDay: Boolean(allDay),
    status: status || null,
    calendarName: calendarName || null,
    sourceId,
    href,
    isRecurring: Boolean(isRecurring),
    source: 'dingtalk',
    organizer: organizer || null,
    attendees: Array.isArray(attendees) ? attendees : [],
  };
}

/**
 * Expand a single cached calendar object into occurrences overlapping [rangeStart, rangeEnd).
 * @param {{
 *   id: string,
 *   href: string,
 *   rawIcal: string,
 *   sourceId: string,
 *   source?: { displayName?: string|null },
 * }} object
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 */
export function expandObjectOccurrences(object, rangeStart, rangeEnd) {
  const results = [];
  if (!object?.rawIcal) return results;

  let vcalendar;
  try {
    vcalendar = new ICAL.Component(ICAL.parse(object.rawIcal));
  } catch {
    return results;
  }

  const vevents = vcalendar.getAllSubcomponents('vevent');
  if (!vevents.length) return results;

  const calendarName = object.source?.displayName || null;
  const sourceId = object.sourceId;
  const href = object.href;

  // Group by UID so recurrence exceptions override the master.
  /** @type {Map<string, import('ical.js').Component[]>} */
  const byUid = new Map();
  for (const vevent of vevents) {
    const uid = String(vevent.getFirstPropertyValue('uid') || object.uid || href);
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(vevent);
  }

  for (const [uid, components] of byUid) {
    const master =
      components.find((c) => !c.hasProperty('recurrence-id')) || components[0];
    const exceptions = components.filter((c) => c.hasProperty('recurrence-id'));
    const exceptionMap = new Map();
    for (const ex of exceptions) {
      const rid = ex.getFirstPropertyValue('recurrence-id');
      if (rid) exceptionMap.set(rid.toString(), ex);
    }

    const masterEvent = new ICAL.Event(master);
    const masterParticipants = extractParticipants(master);
    const status = String(master.getFirstPropertyValue('status') || '').toUpperCase();
    if (status === 'CANCELLED' && !masterEvent.isRecurring()) continue;

    if (!masterEvent.isRecurring()) {
      const start = icalTimeToDate(masterEvent.startDate);
      const end = icalTimeToDate(masterEvent.endDate) || start;
      if (!start || !end) continue;
      if (!intervalsOverlap(start, end, rangeStart, rangeEnd)) continue;
      if (status === 'CANCELLED') continue;

      results.push(
        toOccurrence({
          id: `${object.id}:${start.toISOString()}`,
          uid,
          summary: masterEvent.summary,
          description: masterEvent.description,
          location: masterEvent.location,
          start,
          end,
          allDay: Boolean(masterEvent.startDate?.isDate),
          status,
          calendarName,
          sourceId,
          href,
          isRecurring: false,
          organizer: masterParticipants.organizer,
          attendees: masterParticipants.attendees,
        }),
      );
      continue;
    }

    const expand = new ICAL.RecurExpansion({
      component: master,
      dtstart: masterEvent.startDate,
    });

    let iterations = 0;
    let next;
    while (iterations < MAX_EXPANSION_ITERATIONS && (next = expand.next())) {
      iterations += 1;
      const occStart = icalTimeToDate(next);
      if (!occStart) continue;
      if (occStart >= rangeEnd) break;

      const duration = masterEvent.duration;
      let occEnd;
      if (duration) {
        const endTime = next.clone();
        endTime.addDuration(duration);
        occEnd = icalTimeToDate(endTime);
      } else {
        occEnd = new Date(occStart.getTime() + 60 * 60 * 1000);
      }
      if (!occEnd) continue;
      if (!intervalsOverlap(occStart, occEnd, rangeStart, rangeEnd)) continue;

      const exception = exceptionMap.get(next.toString());
      if (exception) {
        const exStatus = String(
          exception.getFirstPropertyValue('status') || '',
        ).toUpperCase();
        if (exStatus === 'CANCELLED') continue;
        const exEvent = new ICAL.Event(exception);
        const exStart = icalTimeToDate(exEvent.startDate) || occStart;
        const exEnd = icalTimeToDate(exEvent.endDate) || occEnd;
        if (!intervalsOverlap(exStart, exEnd, rangeStart, rangeEnd)) continue;
        const participants = participantsForException(
          masterParticipants,
          exception,
        );
        results.push(
          toOccurrence({
            id: `${object.id}:${exStart.toISOString()}`,
            uid,
            summary: exEvent.summary ?? masterEvent.summary,
            description: exEvent.description ?? masterEvent.description,
            location: exEvent.location ?? masterEvent.location,
            start: exStart,
            end: exEnd,
            allDay: Boolean(exEvent.startDate?.isDate),
            status: exStatus || status,
            calendarName,
            sourceId,
            href,
            isRecurring: true,
            organizer: participants.organizer,
            attendees: participants.attendees,
          }),
        );
        continue;
      }

      if (status === 'CANCELLED') continue;

      results.push(
        toOccurrence({
          id: `${object.id}:${occStart.toISOString()}`,
          uid,
          summary: masterEvent.summary,
          description: masterEvent.description,
          location: masterEvent.location,
          start: occStart,
          end: occEnd,
          allDay: Boolean(masterEvent.startDate?.isDate),
          status,
          calendarName,
          sourceId,
          href,
          isRecurring: true,
          organizer: masterParticipants.organizer,
          attendees: masterParticipants.attendees,
        }),
      );
    }
  }

  return results;
}
