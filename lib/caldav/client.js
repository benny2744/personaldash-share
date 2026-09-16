/**
 * lib/caldav/client.js — Read-only CalDAV client wrapper.
 *
 * Uses tsdav for calendar discovery. DingTalk's CalDAV server rejects tsdav's
 * default object queries (404), so object fetch uses a raw calendar-query REPORT
 * with an explicit time range — verified against calendar.dingtalk.com.
 *
 * Never writes to the remote calendar. Credentials come from config/env only.
 */

import { createDAVClient } from 'tsdav';
import config from '@/lib/config';

/** Default sync window: 1 year back, 1 year forward. */
const DEFAULT_RANGE_DAYS_BACK = 365;
const DEFAULT_RANGE_DAYS_FORWARD = 365;

function redactError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(config.caldavPassword || '___', '[redacted]')
    .replace(config.caldavUsername || '___', '[redacted]');
}

function authHeader() {
  const token = Buffer.from(
    `${config.caldavUsername}:${config.caldavPassword}`,
  ).toString('base64');
  return `Basic ${token}`;
}

function toCalDavUtcStamp(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&#13;/g, '\r')
    .replace(/&#10;/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function absoluteHref(href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  const base = new URL(config.caldavUrl);
  return new URL(href, `${base.origin}/`).toString();
}

/**
 * @param {AbortSignal} [signal]
 */
export async function createCaldavClient(signal) {
  const serverUrl = String(config.caldavUrl || '').replace(/\/?$/, '/');
  const client = await createDAVClient({
    serverUrl,
    credentials: {
      username: config.caldavUsername,
      password: config.caldavPassword,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
    fetchOptions: {
      signal,
    },
  });
  return client;
}

/**
 * Discover readable calendars, or use CALDAV_CALENDAR_URL override.
 * @param {Awaited<ReturnType<typeof createCaldavClient>>} client
 */
export async function listCalendars(client) {
  const override = String(config.caldavCalendarUrl || '').trim();
  if (override) {
    return [
      {
        url: override.endsWith('/') ? override : `${override}/`,
        displayName: 'DingTalk',
        ctag: undefined,
        syncToken: undefined,
      },
    ];
  }

  try {
    const calendars = await client.fetchCalendars();
    return (calendars || [])
      .filter((cal) => cal?.url)
      .map((cal) => ({
        url: cal.url,
        displayName: cal.displayName || cal.url,
        ctag: cal.ctag != null ? String(cal.ctag) : undefined,
        syncToken: cal.syncToken != null ? String(cal.syncToken) : undefined,
      }));
  } catch (error) {
    const username = config.caldavUsername;
    if (username) {
      const base = String(config.caldavUrl || '').replace(/\/?$/, '/');
      const fallbackUrl = `${base}${username}/primary/`;
      return [
        {
          url: fallbackUrl,
          displayName: 'DingTalk Primary',
          ctag: undefined,
          syncToken: undefined,
        },
      ];
    }
    throw new Error(`CalDAV discovery failed: ${redactError(error)}`);
  }
}

/**
 * Parse a CalDAV multistatus REPORT body into { href, etag, data } objects.
 * @param {string} xml
 */
export function parseCalendarQueryResponse(xml) {
  const objects = [];
  const responseRe = /<D:response\b[^>]*>([\s\S]*?)<\/D:response>/gi;
  let match;
  while ((match = responseRe.exec(xml))) {
    const block = match[1];
    const href = /<D:href[^>]*>([^<]*)<\/D:href>/i.exec(block)?.[1]?.trim();
    const etag = /<D:getetag[^>]*>([^<]*)<\/D:getetag>/i
      .exec(block)?.[1]
      ?.trim()
      ?.replace(/^"|"$/g, '');
    const dataMatch =
      /<C:calendar-data\b[^>]*>([\s\S]*?)<\/C:calendar-data>/i.exec(block) ||
      /<[\w-]+:calendar-data\b[^>]*>([\s\S]*?)<\/[\w-]+:calendar-data>/i.exec(
        block,
      );
    if (!href || !dataMatch) continue;
    const data = decodeXmlEntities(dataMatch[1]).trim();
    if (!data.includes('BEGIN:VCALENDAR')) continue;
    objects.push({
      href: absoluteHref(href),
      etag: etag || null,
      data,
    });
  }
  return objects;
}

/**
 * Fetch calendar objects via calendar-query REPORT with a time range.
 * DingTalk requires this; unbounded fetchCalendarObjects often 404s or returns [].
 *
 * @param {Awaited<ReturnType<typeof createCaldavClient>>} _client unused (kept for API stability)
 * @param {{ url: string }} calendar
 * @param {{ start?: Date, end?: Date, signal?: AbortSignal }} [options]
 */
export async function fetchAllObjects(_client, calendar, options = {}) {
  const now = new Date();
  const start =
    options.start ||
    new Date(now.getTime() - DEFAULT_RANGE_DAYS_BACK * 24 * 60 * 60 * 1000);
  const end =
    options.end ||
    new Date(now.getTime() + DEFAULT_RANGE_DAYS_FORWARD * 24 * 60 * 60 * 1000);

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${toCalDavUtcStamp(start)}" end="${toCalDavUtcStamp(end)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  const url = calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`;
  const response = await fetch(url, {
    method: 'REPORT',
    headers: {
      Authorization: authHeader(),
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body,
    signal: options.signal,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `CalDAV calendar-query failed: ${response.status} ${response.statusText} for ${url}`,
    );
  }

  return parseCalendarQueryResponse(text);
}

/**
 * Incremental sync is unreliable on DingTalk; always return null so callers
 * fall back to time-ranged full fetch.
 */
export async function syncCollectionObjects() {
  return null;
}

export { redactError };
