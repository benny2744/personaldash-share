/**
 * lib/dates.js — Local-calendar date helpers (avoid UTC slice bugs).
 *
 * Prefer these over `toISOString().split('T')[0]` for day keys and arithmetic.
 * Date arithmetic uses noon local time to stay DST-safe.
 */

/** @param {Date|string|number} value */
export function toDateStr(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parse YYYY-MM-DD as local noon. */
export function parseLocalDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
    0,
    0,
    0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** @param {Date} date @param {number} days */
export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Sunday-start week containing `date`. */
export function startOfWeek(date) {
  const start = new Date(date);
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

/** Local midnight for a date. */
export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Exclusive end of local day (next midnight). */
export function endOfDay(date) {
  return addDays(startOfDay(date), 1);
}

/** Inclusive list of local dates from start through end (by day key). */
export function daysInRange(start, end) {
  const days = [];
  let cursor = startOfDay(start);
  const last = startOfDay(end);
  while (cursor <= last) {
    days.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }
  return days;
}

/**
 * Inclusive YYYY-MM-DD range for a calendar view.
 * @param {'day'|'week'|'month'} view
 * @param {Date} anchor
 */
export function visibleRangeForView(view, anchor) {
  const base = new Date(anchor);
  base.setHours(12, 0, 0, 0);

  if (view === 'day') {
    const from = toDateStr(base);
    return { from, to: from };
  }

  if (view === 'week') {
    const start = startOfWeek(base);
    const end = addDays(start, 6);
    return { from: toDateStr(start), to: toDateStr(end) };
  }

  const year = base.getFullYear();
  const month = base.getMonth();
  const first = new Date(year, month, 1, 12, 0, 0, 0);
  const last = new Date(year, month + 1, 0, 12, 0, 0, 0);
  // Include leading/trailing days shown in the month grid.
  const gridStart = startOfWeek(first);
  const gridEnd = addDays(startOfWeek(last), 6);
  return { from: toDateStr(gridStart), to: toDateStr(gridEnd) };
}

/** Minutes since local midnight. */
export function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}
