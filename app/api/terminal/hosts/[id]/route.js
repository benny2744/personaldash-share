import { NextResponse } from 'next/server';
import { configurationRequestError } from '@/lib/settings/requestGuard';
import { errorResponse } from '@/lib/api';
import { errorStatus } from '@/lib/terminal/errors';
import {
  deleteHost,
  requireHostsAdmin,
  updateHost,
} from '@/lib/terminal/hosts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function hostErrorResponse(error) {
  const status = errorStatus(error, { logEvent: 'terminal.hosts.error' });
  return errorResponse(error.message, status);
}

/** PATCH /api/terminal/hosts/[id] — partial update (admins only). */
export async function PATCH(request, { params }) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  const { id } = await params;
  if (!id || typeof id !== 'string' || id.length > 64) {
    return errorResponse('Invalid host id', 400);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  try {
    const identity = requireHostsAdmin(request);
    const host = await updateHost(id, body, { identity });
    return NextResponse.json({ host });
  } catch (error) {
    return hostErrorResponse(error);
  }
}

/** DELETE /api/terminal/hosts/[id] — remove a host (admins only). */
export async function DELETE(request, { params }) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  const { id } = await params;
  if (!id || typeof id !== 'string' || id.length > 64) {
    return errorResponse('Invalid host id', 400);
  }
  try {
    const identity = requireHostsAdmin(request);
    await deleteHost(id, { identity });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return hostErrorResponse(error);
  }
}
