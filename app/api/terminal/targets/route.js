import { NextResponse } from 'next/server';
import { configurationRequestError } from '@/lib/settings/requestGuard';
import { errorStatus } from '@/lib/terminal/errors';
import { listTargets } from '@/lib/terminal/sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

/** GET /api/terminal/targets — hosts the caller may reach. */
export async function GET(request) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  try {
    return NextResponse.json(await listTargets(request), { headers: NO_STORE });
  } catch (error) {
    const status = errorStatus(error, { logEvent: 'terminal.targets.error' });
    return NextResponse.json({ error: error.message }, { status });
  }
}
