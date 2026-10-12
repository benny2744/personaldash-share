import { NextResponse } from 'next/server';
import { configurationRequestError } from '@/lib/settings/requestGuard';
import { errorStatus } from '@/lib/terminal/errors';
import { refreshLease } from '@/lib/terminal/sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

/**
 * POST /api/terminal/sessions/[id]/lease — re-issue an attach lease for a
 * pending/grace session owned by the caller (grace reattach path).
 */
export async function POST(request, { params }) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  const { id } = await params;
  if (!id || typeof id !== 'string' || id.length > 128) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  try {
    return NextResponse.json(await refreshLease(request, id), {
      headers: NO_STORE,
    });
  } catch (error) {
    const status = errorStatus(error, {
      logEvent: 'terminal.lease.refresh.error',
    });
    return NextResponse.json({ error: error.message }, { status });
  }
}
