import { toDateStr } from '@/lib/dates';

const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_TIMED_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_ALLDAY_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Parse an all-day YYYY-MM-DD value into a UTC-midnight Date.
 */
export function parseDateOnly(value, field) {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) {
    return { error: `${field} must be a YYYY-MM-DD date` };
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return { error: `${field} must be a valid calendar date` };
  }
  return { value: parsed };
}

/**
 * Parse a timed value that must carry an explicit offset or Z.
 */
export function parseTimestampWithOffset(value, field) {
  if (typeof value !== 'string' || !OFFSET_RE.test(value.trim())) {
    return {
      error: `${field} must be an ISO timestamp with an explicit offset (e.g. 2026-08-20T09:00:00+08:00)`,
    };
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { error: `${field} must be a valid timestamp` };
  }
  return { value: parsed };
}

function normalizeTemporal({ allDay, start, end }) {
  const startResult = allDay
    ? parseDateOnly(start, 'start')
    : parseTimestampWithOffset(start, 'start');
  if (startResult.error) return { error: startResult.error };

  let endAt;
  if (end === undefined || end === null) {
    endAt = new Date(
      startResult.value.getTime() +
        (allDay ? DEFAULT_ALLDAY_DURATION_MS : DEFAULT_TIMED_DURATION_MS),
    );
  } else {
    const endResult = allDay
      ? parseDateOnly(end, 'end')
      : parseTimestampWithOffset(end, 'end');
    if (endResult.error) return { error: endResult.error };
    endAt = endResult.value;
  }

  if (endAt.getTime() <= startResult.value.getTime()) {
    return { error: 'end must be after start' };
  }

  return { value: { startAt: startResult.value, endAt } };
}

/**
 * Validate + normalize a POST body into event fields.
 * @returns {{ value: object } | { error: string }}
 */
export function normalizeCreateInput(body) {
  const summary = typeof body?.summary === 'string' ? body.summary.trim() : '';
  if (!summary) return { error: 'summary is required' };
  if (body?.start === undefined || body?.start === null) {
    return { error: 'start is required' };
  }

  const allDay = body.allDay === true;
  if (allDay && typeof body.start === 'string' && body.start.includes('T')) {
    return { error: 'allDay events require YYYY-MM-DD start/end values' };
  }

  const temporal = normalizeTemporal({
    allDay,
    start: body.start,
    end: body.end,
  });
  if (temporal.error) return temporal;

  return {
    value: {
      summary,
      description:
        typeof body.description === 'string' && body.description
          ? body.description
          : null,
      location:
        typeof body.location === 'string' && body.location
          ? body.location
          : null,
      allDay,
      ...temporal.value,
    },
  };
}

const EDITABLE_FIELDS = ['summary', 'start', 'end', 'description', 'location', 'allDay'];

/**
 * Validate + normalize a PATCH body against the current event, returning a
 * fully-validated merged event. Representation changes are explicit:
 * timed → all-day requires an allDay:true patch with a YYYY-MM-DD start;
 * all-day → timed requires allDay:false with an offset-bearing start.
 *
 * @param {object} body raw PATCH body
 * @param {{ summary: string|null, description: string|null, location: string|null,
 *   startAt: Date|null, endAt: Date|null, allDay: boolean }} current
 * @returns {{ value: object } | { error: string }}
 */
export function normalizePatchInput(body, current) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid JSON body' };
  }
  const hasAny = EDITABLE_FIELDS.some((field) => body[field] !== undefined);
  if (!hasAny) return { error: 'PATCH body must include at least one editable field' };

  if (body.summary !== undefined) {
    if (body.summary === null) return { error: 'summary cannot be null' };
    if (typeof body.summary !== 'string' || !body.summary.trim()) {
      return { error: 'summary must be a non-empty string' };
    }
  }
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
    return { error: 'description must be a string or null' };
  }
  if (body.location !== undefined && body.location !== null && typeof body.location !== 'string') {
    return { error: 'location must be a string or null' };
  }

  const targetAllDay =
    body.allDay === undefined ? Boolean(current.allDay) : body.allDay === true;

  if (body.allDay !== undefined && typeof body.allDay !== 'boolean') {
    return { error: 'allDay must be a boolean' };
  }

  const representationChange =
    body.allDay !== undefined && targetAllDay !== Boolean(current.allDay);
  if (representationChange) {
    if (typeof body.start !== 'string') {
      return {
        error: 'Changing allDay requires an explicit start in the target representation',
      };
    }
    if (targetAllDay && !DATE_ONLY_RE.test(body.start)) {
      return { error: 'Switching to allDay requires a YYYY-MM-DD start' };
    }
    if (!targetAllDay && !OFFSET_RE.test(body.start.trim())) {
      return {
        error: 'Switching to a timed event requires an offset-bearing start timestamp',
      };
    }
  }

  const merged = {
    summary:
      body.summary === undefined ? current.summary : body.summary.trim(),
    description:
      body.description === undefined ? current.description : body.description,
    location: body.location === undefined ? current.location : body.location,
    allDay: targetAllDay,
    startAt: current.startAt,
    endAt: current.endAt,
  };

  const touchesTemporal =
    body.start !== undefined || body.end !== undefined || representationChange;
  if (touchesTemporal) {
    const startInput =
      body.start !== undefined
        ? body.start
        : targetAllDay
          ? toDateStr(current.startAt)
          : current.startAt?.toISOString();
    if (!startInput) return { error: 'Current event has no start to preserve' };

    const endInput =
      body.end !== undefined
        ? body.end
        : representationChange
          ? undefined
          : targetAllDay
            ? toDateStr(current.endAt)
            : current.endAt?.toISOString();

    const temporal = normalizeTemporal({
      allDay: targetAllDay,
      start: startInput,
      end: endInput ?? undefined,
    });
    if (temporal.error) return temporal;
    merged.startAt = temporal.value.startAt;
    merged.endAt = temporal.value.endAt;
  }

  if (!merged.summary) return { error: 'summary is required' };
  if (!merged.startAt || !merged.endAt) {
    return { error: 'Event must have start and end times' };
  }
  if (merged.endAt.getTime() <= merged.startAt.getTime()) {
    return { error: 'end must be after start' };
  }

  return { value: merged };
}

/**
 * Whether a merged PATCH result differs from the current event.
 */
export function eventsDiffer(current, merged) {
  const clean = (v) => (v === undefined || v === '' ? null : v);
  return (
    clean(merged.summary) !== clean(current.summary) ||
    clean(merged.description) !== clean(current.description) ||
    clean(merged.location) !== clean(current.location) ||
    Boolean(merged.allDay) !== Boolean(current.allDay) ||
    merged.startAt?.getTime() !== current.startAt?.getTime() ||
    merged.endAt?.getTime() !== current.endAt?.getTime()
  );
}
