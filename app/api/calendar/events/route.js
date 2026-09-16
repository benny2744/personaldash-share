import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireAgentAuth } from '@/lib/agentAuth';
import { listExpandedEvents } from '@/lib/caldav/events';
import { normalizeCreateInput } from '@/lib/caldav/payload';
import { createLocalEvent, localEventToJson } from '@/lib/localCalendar';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

function errorResponse(message, status = 500) {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

/**
 * GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns expanded DingTalk/CalDAV occurrences for the inclusive date range.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get('from');
    const to = searchParams.get('to') || from;
    if (!from) {
      return errorResponse('Missing required query param `from`', 400);
    }

    const result = await listExpandedEvents(from, to);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    const status = error?.status || 500;
    const message =
      status === 400
        ? error.message
        : 'Failed to load calendar events';
    if (status >= 500) {
      console.error('[calendar/events]', error);
    }
    return errorResponse(message, status);
  }
}

/**
 * POST /api/calendar/events
 * Agent-facing event creation. Requires X-Hermes-Session-Token.
 * DingTalk CalDAV is read-only, so events are stored locally.
 * Body: { summary, start, end?, description?, location?, allDay? }
 * Timed values need an explicit offset; all-day values are YYYY-MM-DD with
 * an exclusive end. Omitted end defaults to +1h (timed) / +1 day (all-day).
 */
export async function POST(request) {
  const denied = requireAgentAuth(request);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const normalized = normalizeCreateInput(body);
  if (normalized.error) return errorResponse(normalized.error, 400);

  try {
    const event = await createLocalEvent({
      uid: randomUUID(),
      ...normalized.value,
    });
    return NextResponse.json(
      { event: localEventToJson(event) },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    console.error('[calendar/events]', error);
    return errorResponse('Failed to create calendar event', 500);
  }
}
