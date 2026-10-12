import { NextResponse } from 'next/server';
import { configurationRequestError } from '@/lib/settings/requestGuard';
import { errorStatus } from '@/lib/terminal/errors';
import {
  createSession,
  listSessions,
} from '@/lib/terminal/sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

/**
 * POST /api/terminal/sessions — create a session (pending) + attach lease.
 * Body: { hostSlug, cols?, rows? }
 */
export async function POST(request) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  try {
    return NextResponse.json(await createSession(request), { headers: NO_STORE });
  } catch (error) {
    const status = errorStatus(error, {
      logEvent: 'terminal.session.create.error',
    });
    return NextResponse.json({ error: error.message }, { status });
  }
}

/** GET /api/terminal/sessions — recent sessions for the caller (admins: all). */
export async function GET(request) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  try {
    return NextResponse.json(await listSessions(request), { headers: NO_STORE });
  } catch (error) {
    const status = errorStatus(error, { logEvent: 'terminal.session.list.error' });
    return NextResponse.json({ error: error.message }, { status });
  }
}
