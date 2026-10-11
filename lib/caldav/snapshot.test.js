import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_RUNTIME = 'nodejs';
const rows = new Map();
globalThis.__prisma = {
  appSetting: {
    findUnique: async ({ where }) =>
      rows.has(where.key)
        ? { key: where.key, value: rows.get(where.key) }
        : null,
    findMany: async ({ where } = {}) =>
      [...rows]
        .filter(([key]) => !where || where.key.in.includes(key))
        .map(([key, value]) => ({ key, value })),
    upsert: async ({ create }) => rows.set(create.key, create.value),
    deleteMany: async ({ where }) => rows.delete(where.key),
  },
};

const { normalizeCaldavUrl } = await import('@/lib/config');
const { resolveCaldavSnapshot, isSnapshotConfigured } =
  await import('./sync.js');
const { parseCalendarQueryResponse, listCalendars } =
  await import('./client.js');
const { invalidateSettingsCache } = await import('@/lib/settings/resolve');

describe('caldav URL normalization', () => {
  it('normalizes DingTalk host-only values to the published DAV path', () => {
    assert.equal(
      normalizeCaldavUrl('calendar.dingtalk.com'),
      'https://calendar.dingtalk.com/dav/',
    );
    assert.equal(
      normalizeCaldavUrl('https://caldav.example.com'),
      'https://caldav.example.com/',
    );
    assert.equal(
      normalizeCaldavUrl('https://caldav.example.com/dav/'),
      'https://caldav.example.com/dav/',
    );
  });
});

describe('caldav settings snapshot', () => {
  it('normalizes host-only DB overrides that the env path previously normalized', async () => {
    process.env.CALDAV_ENABLED = 'false';
    process.env.CALDAV_URL = 'calendar.dingtalk.com';
    process.env.CALDAV_USERNAME = 'user';
    process.env.CALDAV_PASSWORD = 'pass';
    rows.clear();
    invalidateSettingsCache();
    const snapshot = await resolveCaldavSnapshot();
    assert.equal(snapshot.url, 'https://calendar.dingtalk.com/dav/');
    assert.equal(
      new URL(snapshot.url).toString(),
      'https://calendar.dingtalk.com/dav/',
    );
    assert.equal(isSnapshotConfigured(snapshot), false);
  });

  it('prefers DB overrides and freezes the snapshot', async () => {
    rows.set('calendar.url', 'https://caldav.example.com');
    rows.set('calendar.caldavEnabled', true);
    invalidateSettingsCache();
    const snapshot = await resolveCaldavSnapshot();
    assert.equal(snapshot.url, 'https://caldav.example.com/');
    assert.equal(snapshot.enabled, true);
    assert.throws(() => {
      snapshot.url = 'https://mutated.example.com';
    });
  });

  it('requires credentials and a URL to consider the snapshot configured', async () => {
    assert.equal(
      isSnapshotConfigured({
        enabled: true,
        url: 'https://x/',
        username: 'u',
        password: 'p',
      }),
      true,
    );
    assert.equal(
      isSnapshotConfigured({
        enabled: false,
        url: 'https://x/',
        username: 'u',
        password: 'p',
      }),
      false,
    );
    assert.equal(
      isSnapshotConfigured({
        enabled: true,
        url: '',
        username: 'u',
        password: 'p',
      }),
      false,
    );
  });
});

describe('caldav client snapshot usage', () => {
  it('resolves relative hrefs against the snapshot URL, not global config', () => {
    const objects = parseCalendarQueryResponse(
      `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <D:response>
          <D:href>/cal/user/abc.ics</D:href>
          <D:getetag>"1"</D:getetag>
          <C:calendar-data>BEGIN:VCALENDAR&#10;END:VCALENDAR</C:calendar-data>
        </D:response>
      </D:multistatus>`,
      'https://caldav.example.com/dav/',
    );
    assert.equal(objects.length, 1);
    assert.equal(
      objects[0].href,
      'https://caldav.example.com/cal/user/abc.ics',
    );
  });

  it('uses the snapshot collection override without touching global config', async () => {
    const calendars = await listCalendars(
      {
        url: 'https://caldav.example.com/dav/',
        calendarUrl: 'https://override.example.com/cal/',
      },
      null,
    );
    assert.equal(calendars.length, 1);
    assert.equal(calendars[0].url, 'https://override.example.com/cal/');
  });
});
