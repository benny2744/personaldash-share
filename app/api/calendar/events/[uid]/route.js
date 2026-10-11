import { NextResponse } from 'next/server';
import { requireAgentAuth } from '@/lib/agentAuth';
import { eventsDiffer, normalizePatchInput } from '@/lib/caldav/payload';
import {
  deleteLocalEvent,
  findLocalEventByUid,
  localEventToJson,
  updateLocalEvent,
} from '@/lib/localCalendar';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

function errorResponse(message, status = 500) {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

/**
 * PATCH /api/calendar/events/[uid]
 * Agent-facing partial update. Requires X-Hermes-Session-Token.
 * Body: { summary?, start?, end?, description?, location?, allDay? }
 * null removes description/location. No-op patches return 200 unchanged.
 */
export async function PATCH(request, { params }) {
  const denied = requireAgentAuth(request);
  if (denied) return denied;

  const { uid } = await params;

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  try {
    const event = await findLocalEventByUid(uid);
    if (!event) return errorResponse('Event not found', 404);

    const normalized = normalizePatchInput(body, event);
    if (normalized.error) return errorResponse(normalized.error, 400);

    if (!eventsDiffer(event, normalized.value)) {
      return NextResponse.json(
        { event: localEventToJson(event), unchanged: true },
        { headers: NO_STORE },
      );
    }

    const updated = await updateLocalEvent(uid, normalized.value);
    return NextResponse.json(
      { event: localEventToJson(updated) },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('[calendar/events/uid]', error);
    return errorResponse('Failed to update calendar event', 500);
  }
}

/**
 * DELETE /api/calendar/events/[uid]
 * Agent-facing event deletion. Requires X-Hermes-Session-Token.
 */
export async function DELETE(request, { params }) {
  const denied = requireAgentAuth(request);
  if (denied) return denied;

  const { uid } = await params;

  try {
    const event = await findLocalEventByUid(uid);
    if (!event) return errorResponse('Event not found', 404);
    await deleteLocalEvent(uid);
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (error) {
    console.error('[calendar/events/uid]', error);
    return errorResponse('Failed to delete calendar event', 500);
  }
}
