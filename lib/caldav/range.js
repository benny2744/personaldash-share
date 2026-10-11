/**
 * lib/caldav/range.js — Pure date-range validation for calendar feeds.
 */

import { parseLocalDate, addDays, startOfDay } from '../dates.js';

export const MAX_RANGE_DAYS = 93;
export const MAX_EVENTS = 2000;

/**
 * @param {string} from YYYY-MM-DD inclusive
 * @param {string} to YYYY-MM-DD inclusive
 */
export function parseEventRange(from, to) {
  const start = parseLocalDate(from);
  const endDay = parseLocalDate(to);
  if (!start || !endDay) {
    throw Object.assign(new Error('Invalid from/to date (expected YYYY-MM-DD)'), {
      status: 400,
    });
  }
  if (endDay < start) {
    throw Object.assign(new Error('`to` must be on or after `from`'), {
      status: 400,
    });
  }

  const daySpan =
    Math.round((startOfDay(endDay) - startOfDay(start)) / (24 * 60 * 60 * 1000)) +
    1;
  if (daySpan > MAX_RANGE_DAYS) {
    throw Object.assign(
      new Error(`Date range too large (max ${MAX_RANGE_DAYS} days)`),
      { status: 400 },
    );
  }

  const rangeStart = startOfDay(start);
  const rangeEnd = addDays(startOfDay(endDay), 1);
  return { rangeStart, rangeEnd, daySpan };
}
