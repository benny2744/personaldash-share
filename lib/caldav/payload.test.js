import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  eventsDiffer,
  normalizeCreateInput,
  normalizePatchInput,
} from './payload.js';

const CURRENT_TIMED = {
  summary: 'Existing',
  description: 'desc',
  location: 'office',
  startAt: new Date('2026-08-20T01:00:00Z'),
  endAt: new Date('2026-08-20T02:00:00Z'),
  allDay: false,
};

const CURRENT_ALLDAY = {
  summary: 'All day',
  description: null,
  location: null,
  startAt: new Date('2026-08-20T00:00:00Z'),
  endAt: new Date('2026-08-21T00:00:00Z'),
  allDay: true,
};

describe('normalizeCreateInput', () => {
  it('requires summary and start', () => {
    assert.ok(normalizeCreateInput({ start: '2026-08-20T09:00:00+08:00' }).error);
    assert.ok(normalizeCreateInput({ summary: 'x' }).error);
  });

  it('rejects ambiguous timestamps without an offset', () => {
    const result = normalizeCreateInput({
      summary: 'x',
      start: '2026-08-20T09:00:00',
    });
    assert.match(result.error, /explicit offset/);
  });

  it('converts offset-bearing timestamps to UTC instants', () => {
    const { value } = normalizeCreateInput({
      summary: 'x',
      start: '2026-08-20T09:00:00+08:00',
      end: '2026-08-20T10:30:00+08:00',
    });
    assert.equal(value.startAt.toISOString(), '2026-08-20T01:00:00.000Z');
    assert.equal(value.endAt.toISOString(), '2026-08-20T02:30:00.000Z');
  });

  it('defaults end to +1h (timed) and +1 day (all-day)', () => {
    const timed = normalizeCreateInput({
      summary: 'x',
      start: '2026-08-20T09:00:00Z',
    }).value;
    assert.equal(timed.endAt.getTime() - timed.startAt.getTime(), 3600_000);

    const allDay = normalizeCreateInput({
      summary: 'x',
      start: '2026-08-20',
      allDay: true,
    }).value;
    assert.equal(allDay.endAt.getTime() - allDay.startAt.getTime(), 86_400_000);
  });

  it('treats all-day end as exclusive and requires end > start', () => {
    const { value } = normalizeCreateInput({
      summary: 'conf',
      start: '2026-08-20',
      end: '2026-08-22',
      allDay: true,
    });
    assert.equal(value.endAt.toISOString(), '2026-08-22T00:00:00.000Z');

    assert.ok(
      normalizeCreateInput({
        summary: 'x',
        start: '2026-08-20',
        end: '2026-08-20',
        allDay: true,
      }).error,
    );
    assert.ok(
      normalizeCreateInput({
        summary: 'x',
        start: '2026-08-20T09:00:00Z',
        end: '2026-08-20T08:00:00Z',
      }).error,
    );
  });

  it('rejects timestamp-style values for allDay events', () => {
    assert.ok(
      normalizeCreateInput({
        summary: 'x',
        start: '2026-08-20T09:00:00Z',
        allDay: true,
      }).error,
    );
  });
});

describe('normalizePatchInput', () => {
  it('rejects empty bodies and summary: null', () => {
    assert.ok(normalizePatchInput({}, CURRENT_TIMED).error);
    assert.ok(normalizePatchInput({ summary: null }, CURRENT_TIMED).error);
    assert.ok(normalizePatchInput({ summary: '  ' }, CURRENT_TIMED).error);
  });

  it('supports description/location removal via null', () => {
    const { value } = normalizePatchInput(
      { description: null, location: null },
      CURRENT_TIMED,
    );
    assert.equal(value.description, null);
    assert.equal(value.location, null);
    assert.equal(value.summary, 'Existing');
  });

  it('leaves untouched fields unchanged', () => {
    const { value } = normalizePatchInput({ summary: 'Renamed' }, CURRENT_TIMED);
    assert.equal(value.summary, 'Renamed');
    assert.equal(value.description, 'desc');
    assert.equal(value.startAt.getTime(), CURRENT_TIMED.startAt.getTime());
    assert.equal(value.endAt.getTime(), CURRENT_TIMED.endAt.getTime());
    assert.equal(value.allDay, false);
  });

  it('requires an explicit start when switching representations', () => {
    assert.ok(
      normalizePatchInput({ allDay: true }, CURRENT_TIMED).error,
    );
    assert.ok(
      normalizePatchInput({ allDay: false }, CURRENT_ALLDAY).error,
    );
    assert.ok(
      normalizePatchInput(
        { allDay: true, start: '2026-08-20T09:00:00Z' },
        CURRENT_TIMED,
      ).error,
    );
    assert.ok(
      normalizePatchInput(
        { allDay: false, start: '2026-08-20' },
        CURRENT_ALLDAY,
      ).error,
    );
  });

  it('accepts valid representation switches', () => {
    const toAllDay = normalizePatchInput(
      { allDay: true, start: '2026-08-21' },
      CURRENT_TIMED,
    ).value;
    assert.equal(toAllDay.allDay, true);
    assert.equal(toAllDay.startAt.toISOString(), '2026-08-21T00:00:00.000Z');
    // End defaults to start + 1 day when switching representations.
    assert.equal(toAllDay.endAt.toISOString(), '2026-08-22T00:00:00.000Z');

    const toTimed = normalizePatchInput(
      { allDay: false, start: '2026-08-21T09:00:00+08:00' },
      CURRENT_ALLDAY,
    ).value;
    assert.equal(toTimed.allDay, false);
    assert.equal(toTimed.startAt.toISOString(), '2026-08-21T01:00:00.000Z');
  });

  it('validates the merged event, not fields in isolation', () => {
    // Moving start past the current end must fail without a new end.
    assert.ok(
      normalizePatchInput(
        { start: '2026-08-20T05:00:00Z' },
        CURRENT_TIMED,
      ).error,
    );
    const ok = normalizePatchInput(
      { start: '2026-08-20T05:00:00Z', end: '2026-08-20T06:00:00Z' },
      CURRENT_TIMED,
    );
    assert.ok(!ok.error);
  });
});

describe('eventsDiffer', () => {
  it('detects no-op patches', () => {
    const merged = { ...CURRENT_TIMED };
    assert.equal(eventsDiffer(CURRENT_TIMED, merged), false);
  });

  it('detects changes', () => {
    assert.equal(
      eventsDiffer(CURRENT_TIMED, { ...CURRENT_TIMED, summary: 'Other' }),
      true,
    );
    assert.equal(
      eventsDiffer(CURRENT_TIMED, {
        ...CURRENT_TIMED,
        endAt: new Date('2026-08-20T03:00:00Z'),
      }),
      true,
    );
  });
});
