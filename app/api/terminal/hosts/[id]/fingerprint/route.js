import { NextResponse } from 'next/server';
import { configurationRequestError } from '@/lib/settings/requestGuard';
import prisma from '@/lib/db';
import { errorResponse } from '@/lib/api';
import { errorStatus } from '@/lib/terminal/errors';
import { learnFingerprint, requireHostsAdmin } from '@/lib/terminal/hosts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

/**
 * POST /api/terminal/hosts/[id]/fingerprint — ask the sidecar to dial the
 * registered host and report its SSH key fingerprint. The caller must pin the
 * result via PATCH (explicit two-step enrollment; never auto-trusted).
 */
export async function POST(request, { params }) {
  const denied = configurationRequestError(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 403 });
  const { id } = await params;
  if (!id || typeof id !== 'string' || id.length > 64) {
    return errorResponse('Invalid host id', 400);
  }
  try {
    requireHostsAdmin(request);
    const host = await prisma.terminalHost.findUnique({ where: { id } });
    if (!host) return errorResponse('Host not found', 404);
    const result = await learnFingerprint({
      host: host.sshHost,
      port: host.sshPort,
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    const status = errorStatus(error, {
      logEvent: 'terminal.fingerprint.error',
    });
    return errorResponse(error.message, status);
  }
}
