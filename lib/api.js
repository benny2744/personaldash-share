import { NextResponse } from 'next/server';
export {
  TASK_STATUSES,
  TASK_PRIORITIES,
  PROJECT_STATUSES,
  IDEA_STATUSES,
  IDEA_SCORES,
  HABIT_FREQUENCIES,
  MEETING_TYPES,
} from './domain.js';

export function errorResponse(message, status = 400, extra = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export async function parseJsonBody(request) {
  try {
    return { body: await request.json() };
  } catch {
    return { response: errorResponse('Invalid JSON body', 400) };
  }
}

export function isAllowed(value, allowed) {
  return typeof value === 'string' && allowed.includes(value);
}

export function parseInteger(value, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { error: `${field} must be an integer between ${min} and ${max}` };
  }
  return { value: parsed };
}

export function parseNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return { error: `${field} must be a number between ${min} and ${max}` };
  }
  return { value: parsed };
}

export function parseDate(value, field) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { error: `${field} must be a valid date` };
  }
  return { value: parsed };
}
