/**
 * dwsTime.js — parse `dws` timestamps into real UTC instants.
 *
 * `dws chat message list-all` returns createTime as an Asia/Shanghai
 * wall-clock string ("2026-09-09 22:02:07"). The host/container TZ is UTC, so
 * `new Date(str)` silently stored wall-clock time as UTC (+8h skew). This
 * helper pins the offset explicitly.
 */

const SHANGHAI_OFFSET = '+08:00';

/**
 * Format an instant as the Asia/Shanghai wall-clock string dws expects for
 * --start/--end ("YYYY-MM-DD HH:mm:ss"). The host TZ is UTC; formatting with
 * local getters previously produced windows 8h in the past.
 */
export function formatDwsDate(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function parseDwsTime(value, fallback = Date.now()) {
  if (value === null || value === undefined || value === '') {
    return new Date(fallback);
  }
  if (typeof value === 'number') {
    return new Date(value);
  }
  const s = String(value).trim();
  // "YYYY-MM-DD HH:mm:ss" (dws local wall-clock, Asia/Shanghai)
  const wallClock = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/);
  if (wallClock) {
    return new Date(`${wallClock[1]}T${wallClock[2]}${wallClock[3] || ''}${SHANGHAI_OFFSET}`);
  }
  // Already-offset ISO strings (…Z or ±hh:mm) parse correctly on their own.
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? new Date(fallback) : parsed;
}
