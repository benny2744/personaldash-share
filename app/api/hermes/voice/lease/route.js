import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api';
import {
  getVoiceLeaseConfig,
  issueVoiceLease,
} from '@/lib/hermes/voiceLease';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

/**
 * Issue a short-lived lease for the Qwen realtime voice sidecar.
 * Credentials never leave the server.
 */
export async function POST(request) {
  const config = getVoiceLeaseConfig();
  if (!config.configured) {
    return errorResponse(
      'VOICE_LEASE_SECRET is not configured for chat voice',
      503,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const mode = String(body?.mode || '').trim();
  if (mode !== 'asr' && mode !== 'tts') {
    return errorResponse('mode must be asr or tts', 400);
  }

  try {
    const lease = issueVoiceLease(mode);
    return NextResponse.json(lease, { headers: NO_STORE });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return errorResponse(error?.message || 'Failed to issue voice lease', status);
  }
}
