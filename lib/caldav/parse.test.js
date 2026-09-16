import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  toDateStr,
  parseLocalDate,
  addDays,
  startOfWeek,
  visibleRangeForView,
} from '../dates.js';
import {
  extractObjectSummary,
  expandObjectOccurrences,
  intervalsOverlap,
  extractParticipants,
} from './parse.js';
import ICAL from 'ical.js';
import { layoutOverlappingEvents } from '../calendarLayout.js';
import { parseEventRange } from './range.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

describe('dates helpers', () => {
  it('formats local date keys without UTC shift', () => {
    const date = new Date(2026, 6, 11, 0, 30, 0);
    assert.equal(toDateStr(date), '2026-07-11');
  });

  it('parses local YYYY-MM-DD at noon', () => {
    const date = parseLocalDate('2026-07-11');
    assert.ok(date);
    assert.equal(date.getFullYear(), 2026);
    assert.equal(date.getMonth(), 6);
    assert.equal(date.getDate(), 11);
    assert.equal(date.getHours(), 12);
  });

  it('computes Sunday-start weeks', () => {
    const wednesday = parseLocalDate('2026-07-08');
    const start = startOfWeek(wednesday);
    assert.equal(toDateStr(start), '2026-07-05');
    assert.equal(start.getDay(), 0);
  });

  it('builds visible ranges for views', () => {
    const anchor = parseLocalDate('2026-07-11');
    assert.deepEqual(visibleRangeForView('day', anchor), {
      from: '2026-07-11',
      to: '2026-07-11',
    });
    assert.deepEqual(visibleRangeForView('week', anchor), {
      from: '2026-07-05',
      to: '2026-07-11',
    });
    const month = visibleRangeForView('month', anchor);
    assert.equal(month.from <= '2026-07-01', true);
    assert.equal(month.to >= '2026-07-31', true);
  });

  it('adds days DST-safely via local dates', () => {
    const start = parseLocalDate('2026-07-11');
    assert.equal(toDateStr(addDays(start, 3)), '2026-07-14');
  });
});

describe('event range validation', () => {
  it('rejects inverted ranges', () => {
    assert.throws(() => parseEventRange('2026-07-20', '2026-07-10'), /on or after/);
  });

  it('rejects oversized ranges', () => {
    assert.throws(() => parseEventRange('2026-01-01', '2026-07-01'), /too large/);
  });

  it('accepts inclusive day ranges as half-open windows', () => {
    const { rangeStart, rangeEnd, daySpan } = parseEventRange(
      '2026-07-11',
      '2026-07-11',
    );
    assert.equal(daySpan, 1);
    assert.equal(toDateStr(rangeStart), '2026-07-11');
    assert.equal(toDateStr(rangeEnd), '2026-07-12');
  });
});

describe('ICS parsing and expansion', () => {
  it('extracts summary fields from a simple event', () => {
    const summary = extractObjectSummary(loadFixture('simple-event.ics'));
    assert.equal(summary.uid, 'simple-meeting@test');
    assert.equal(summary.summary, 'Simple timed meeting');
    assert.equal(summary.location, 'Room A');
    assert.equal(summary.allDay, false);
    assert.ok(summary.startAt instanceof Date);
  });

  it('detects all-day events', () => {
    const summary = extractObjectSummary(loadFixture('allday-event.ics'));
    assert.equal(summary.allDay, true);
    assert.equal(summary.summary, 'All day holiday');
  });

  it('expands a timed event inside a range', () => {
    const rangeStart = new Date(Date.UTC(2026, 6, 15, 0, 0, 0));
    const rangeEnd = new Date(Date.UTC(2026, 6, 16, 0, 0, 0));
    const events = expandObjectOccurrences(
      {
        id: 'obj1',
        href: '/events/1.ics',
        sourceId: 'src1',
        source: { displayName: 'Primary' },
        rawIcal: loadFixture('simple-event.ics'),
      },
      rangeStart,
      rangeEnd,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].summary, 'Simple timed meeting');
    assert.equal(events[0].calendarName, 'Primary');
    assert.equal(events[0].allDay, false);
  });

  it('expands all-day events for the local date window', () => {
    const rangeStart = new Date(2026, 6, 20, 0, 0, 0);
    const rangeEnd = new Date(2026, 6, 21, 0, 0, 0);
    const events = expandObjectOccurrences(
      {
        id: 'obj2',
        href: '/events/2.ics',
        sourceId: 'src1',
        rawIcal: loadFixture('allday-event.ics'),
      },
      rangeStart,
      rangeEnd,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].allDay, true);
  });

  it('expands weekly recurrence with override and cancellation', () => {
    const rangeStart = new Date(Date.UTC(2026, 6, 1, 0, 0, 0));
    const rangeEnd = new Date(Date.UTC(2026, 7, 1, 0, 0, 0));
    const events = expandObjectOccurrences(
      {
        id: 'obj3',
        href: '/events/3.ics',
        sourceId: 'src1',
        rawIcal: loadFixture('recurring-with-exception.ics'),
      },
      rangeStart,
      rangeEnd,
    );

    const titles = events.map((e) => e.summary).sort();
    assert.ok(titles.includes('Weekly standup'));
    assert.ok(titles.includes('Weekly standup (moved)'));
    assert.equal(events.some((e) => e.status === 'CANCELLED'), false);
    // COUNT=4 minus one cancelled => 3 occurrences
    assert.equal(events.length, 3);
  });

  it('detects interval overlap correctly', () => {
    const a0 = new Date('2026-07-11T10:00:00Z');
    const a1 = new Date('2026-07-11T11:00:00Z');
    const b0 = new Date('2026-07-11T10:30:00Z');
    const b1 = new Date('2026-07-11T11:30:00Z');
    const c0 = new Date('2026-07-11T11:00:00Z');
    const c1 = new Date('2026-07-11T12:00:00Z');
    assert.equal(intervalsOverlap(a0, a1, b0, b1), true);
    assert.equal(intervalsOverlap(a0, a1, c0, c1), false);
  });
});

describe('overlap layout', () => {
  it('assigns side-by-side columns for overlapping events', () => {
    const laidOut = layoutOverlappingEvents([
      {
        id: 'a',
        allDay: false,
        startAt: '2026-07-11T10:00:00',
        endAt: '2026-07-11T11:00:00',
      },
      {
        id: 'b',
        allDay: false,
        startAt: '2026-07-11T10:30:00',
        endAt: '2026-07-11T11:30:00',
      },
      {
        id: 'c',
        allDay: false,
        startAt: '2026-07-11T12:00:00',
        endAt: '2026-07-11T13:00:00',
      },
    ]);

    const byId = Object.fromEntries(laidOut.map((item) => [item.event.id, item]));
    assert.equal(byId.a.columnCount, 2);
    assert.equal(byId.b.columnCount, 2);
    assert.notEqual(byId.a.column, byId.b.column);
    assert.equal(byId.c.columnCount, 1);
  });

  it('ignores all-day events', () => {
    const laidOut = layoutOverlappingEvents([
      {
        id: 'all',
        allDay: true,
        startAt: '2026-07-11T00:00:00',
        endAt: '2026-07-12T00:00:00',
      },
    ]);
    assert.equal(laidOut.length, 0);
  });
});

describe('participant parsing', () => {
  it('extracts organizer and deduplicated attendees', () => {
    const vcalendar = new ICAL.Component(
      ICAL.parse(loadFixture('participants-event.ics')),
    );
    const vevent = vcalendar.getFirstSubcomponent('vevent');
    const { organizer, attendees } = extractParticipants(vevent);

    assert.equal(organizer?.name, 'Jessie Lin');
    assert.equal(organizer?.email, 'jessie@example.org');
    assert.equal(attendees.length, 3);
    assert.deepEqual(
      attendees.map((a) => a.email).sort(),
      ['alex@example.org', 'joy@example.org', 'rebecca@example.org'],
    );
    const joy = attendees.find((a) => a.email === 'joy@example.org');
    assert.equal(joy?.status, 'TENTATIVE');
    assert.equal(joy?.role, 'REQ-PARTICIPANT');
  });

  it('includes participants on expanded occurrences', () => {
    const rangeStart = new Date(Date.UTC(2026, 6, 15, 0, 0, 0));
    const rangeEnd = new Date(Date.UTC(2026, 6, 16, 0, 0, 0));
    const events = expandObjectOccurrences(
      {
        id: 'obj-p',
        href: '/events/p.ics',
        sourceId: 'src1',
        rawIcal: loadFixture('participants-event.ics'),
      },
      rangeStart,
      rangeEnd,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].organizer?.name, 'Jessie Lin');
    assert.equal(events[0].attendees.length, 3);
  });

  it('returns empty attendees when ICS has none', () => {
    const rangeStart = new Date(Date.UTC(2026, 6, 15, 0, 0, 0));
    const rangeEnd = new Date(Date.UTC(2026, 6, 16, 0, 0, 0));
    const events = expandObjectOccurrences(
      {
        id: 'obj1',
        href: '/events/1.ics',
        sourceId: 'src1',
        rawIcal: loadFixture('simple-event.ics'),
      },
      rangeStart,
      rangeEnd,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].organizer, null);
    assert.deepEqual(events[0].attendees, []);
  });

  it('inherits master participants and overrides exception participants', () => {
    const rangeStart = new Date(Date.UTC(2026, 6, 1, 0, 0, 0));
    const rangeEnd = new Date(Date.UTC(2026, 7, 1, 0, 0, 0));
    const events = expandObjectOccurrences(
      {
        id: 'obj-rp',
        href: '/events/rp.ics',
        sourceId: 'src1',
        rawIcal: loadFixture('recurring-participants.ics'),
      },
      rangeStart,
      rangeEnd,
    );

    assert.equal(events.length, 3);
    const masterLike = events.filter((e) => e.organizer?.email === 'master@example.org');
    const exception = events.find(
      (e) => e.organizer?.email === 'exception@example.org',
    );
    assert.equal(masterLike.length, 2);
    assert.equal(masterLike[0].attendees.length, 2);
    assert.ok(exception);
    assert.equal(exception.attendees.length, 1);
    assert.equal(exception.attendees[0].email, 'carol@example.org');
  });
});
