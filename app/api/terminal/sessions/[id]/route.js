import { NextResponse } from 'next/server';
import { configurationRequestError } from '@/lib/settings/requestGuard';
import { errorStatus } from '@/lib/terminal/errors';
import { closeSession } from '@/lib/terminal/sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** DELETE /api/terminal/sessions/[id] — close a session (owner or admin). */
export async function DELETE(request, { params }) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  const { id } = await params;
  if (!id || typeof id !== 'string' || id.length > 128) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  try {
    return NextResponse.json(await closeSession(request, id, 'user'));
  } catch (error) {
    const status = errorStatus(error, {
      logEvent: 'terminal.session.close.error',
    });
    return NextResponse.json({ error: error.message }, { status });
  }
}
