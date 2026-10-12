import { NextResponse } from 'next/server';
import { configurationRequestError } from '@/lib/settings/requestGuard';
import { errorResponse } from '@/lib/api';
import { errorStatus } from '@/lib/terminal/errors';
import { createHost, listHosts, requireHostsAdmin } from '@/lib/terminal/hosts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

function hostErrorResponse(error) {
  const status = errorStatus(error, { logEvent: 'terminal.hosts.error' });
  return errorResponse(error.message, status);
}

/** GET /api/terminal/hosts — full registry (admins only). */
export async function GET(request) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  try {
    requireHostsAdmin(request);
    return NextResponse.json(await listHosts(), { headers: NO_STORE });
  } catch (error) {
    return hostErrorResponse(error);
  }
}

/** POST /api/terminal/hosts — register a host (admins only). */
export async function POST(request) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  try {
    const identity = requireHostsAdmin(request);
    const host = await createHost(body, { identity });
    return NextResponse.json({ host }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return hostErrorResponse(error);
  }
}
