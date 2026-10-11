import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api';
import { prepareSpeechText } from '@/lib/hermes/speechText';
import {
  getVoiceLeaseConfig,
  voiceServiceFetch,
} from '@/lib/hermes/voiceLease';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

/**
 * HTTP fallback TTS for Hermes chat replies.
 * Streaming playback uses the leased WebSocket path; this route asks the
 * voice sidecar for a complete WAV when streaming is unavailable.
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

  const prepared = prepareSpeechText(body?.text);
  if (!prepared.ok) {
    return errorResponse(prepared.error, prepared.status);
  }

  try {
    const response = await voiceServiceFetch('/v1/speak', {
      body: { text: prepared.text },
    });
    if (!response.ok) {
      let detail = `Speech synthesis failed (${response.status})`;
      try {
        const payload = await response.json();
        detail = payload.detail || payload.error || detail;
      } catch {
        // ignore
      }
      return NextResponse.json(
        { error: detail },
        { status: response.status >= 500 ? 502 : response.status, headers: NO_STORE },
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': 'audio/wav',
        'Content-Length': String(buffer.byteLength),
        'X-Hermes-TTS-Provider': 'qwen',
        'X-Hermes-TTS-Model': config.ttsModel,
        'X-Hermes-TTS-Voice': config.ttsVoice,
      },
    });
  } catch (error) {
    const status = Number(error?.status) || 502;
    return NextResponse.json(
      { error: error?.message || 'Speech synthesis failed' },
      { status, headers: NO_STORE },
    );
  }
}
