import { NextResponse } from 'next/server';
import { isCaldavConfigured } from '@/lib/config';
import { getCaldavSyncStatus, runCaldavSync } from '@/lib/caldav/sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

const NO_STORE = { 'Cache-Control': 'no-store' };

function errorResponse(message, status = 500) {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

/**
 * GET /api/calendar/sync — last sync status (no credentials).
 */
export async function GET() {
  try {
    const status = await getCaldavSyncStatus();
    return NextResponse.json(status, { headers: NO_STORE });
  } catch (error) {
    console.error('[calendar/sync GET]', error);
    return errorResponse('Failed to load sync status');
  }
}

/**
 * POST /api/calendar/sync — trigger a manual read-only CalDAV refresh.
 * Body optional: { force?: boolean }
 */
export async function POST(request) {
  try {
    if (!isCaldavConfigured()) {
      return errorResponse(
        'CalDAV is not configured. Set CALDAV_ENABLED=true and credentials.',
        400,
      );
    }

    let force = false;
    try {
      const body = await request.json();
      force = Boolean(body?.force);
    } catch {
      // empty body is fine
    }

    const result = await runCaldavSync({ force });
    const status = await getCaldavSyncStatus();

    if (result.skipped) {
      return NextResponse.json(
        { ...status, skipped: true, reason: result.reason },
        { headers: NO_STORE },
      );
    }

    if (!result.ok) {
      return NextResponse.json(
        { ...status, ok: false, error: result.error || 'Sync failed' },
        { status: 502, headers: NO_STORE },
      );
    }

    return NextResponse.json(
      { ...status, ok: true, calendars: result.calendars, objects: result.objects },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('[calendar/sync POST]', error);
    return errorResponse('Failed to run CalDAV sync');
  }
}
