import { NextResponse } from 'next/server';
import { listPins, pinSession, unpinSession } from '@/lib/hermes/pins';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/hermes/pins?profile=<name>
 * Pinned session ids for a Hermes profile, oldest pin first.
 */
export async function GET(request) {
  try {
    const profile = request.nextUrl.searchParams.get('profile') || '';
    const pins = await listPins(profile);
    return NextResponse.json({ pins }, { headers: NO_STORE });
  } catch (error) {
    console.error('[hermes/pins GET]', error);
    return NextResponse.json(
      { error: error.message || String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}

/**
 * POST /api/hermes/pins — pin or unpin a session.
 * Body: { profile: string, sessionId: string, pinned: boolean }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const profile = typeof body?.profile === 'string' ? body.profile : '';
    const sessionId =
      typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    const pinned = Boolean(body?.pinned);

    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400, headers: NO_STORE },
      );
    }

    if (pinned) {
      await pinSession(profile, sessionId);
    } else {
      await unpinSession(profile, sessionId);
    }
    return NextResponse.json({ ok: true, sessionId, pinned }, { headers: NO_STORE });
  } catch (error) {
    console.error('[hermes/pins POST]', error);
    return NextResponse.json(
      { error: error.message || String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
