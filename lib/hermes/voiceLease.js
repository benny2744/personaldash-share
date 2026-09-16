/**
 * Short-lived HMAC leases for the Qwen realtime voice sidecar.
 * Secret stays server-side; browser only receives the opaque token.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const VOICE_LEASE_TTL_ASR_SEC = 120;
export const VOICE_LEASE_TTL_TTS_SEC = 180;

function stripEnvQuotes(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function b64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlJson(object) {
  return b64url(Buffer.from(JSON.stringify(object), 'utf8'));
}

/**
 * @returns {{
 *   secret: string,
 *   voiceServiceUrl: string,
 *   publicWsPath: string,
 *   configured: boolean,
 *   asrModel: string,
 *   ttsModel: string,
 *   ttsVoice: string,
 * }}
 */
export function getVoiceLeaseConfig() {
  const secret = stripEnvQuotes(process.env.VOICE_LEASE_SECRET || '');
  const voiceServiceUrl = stripEnvQuotes(
    process.env.VOICE_SERVICE_URL || 'http://pipecat-voice:3015',
  ).replace(/\/+$/, '');
  const publicWsPath = stripEnvQuotes(
    process.env.VOICE_PUBLIC_WS_PATH || '/api/hermes/voice/ws',
  );
  return {
    secret,
    voiceServiceUrl,
    publicWsPath,
    configured: Boolean(secret),
    asrModel: stripEnvQuotes(
      process.env.QWEN_ASR_REALTIME_MODEL || 'qwen3-asr-flash-realtime',
    ),
    ttsModel: stripEnvQuotes(
      process.env.QWEN_TTS_REALTIME_MODEL || 'qwen3-tts-flash-realtime',
    ),
    ttsVoice: stripEnvQuotes(process.env.QWEN_TTS_VOICE || 'Cherry'),
  };
}

/**
 * @param {'asr'|'tts'} mode
 * @param {{ now?: number, jti?: string, ttlSeconds?: number }} [options]
 */
export function issueVoiceLease(mode, options = {}) {
  const config = getVoiceLeaseConfig();
  if (!config.configured) {
    const error = new Error(
      'VOICE_LEASE_SECRET is not configured for chat voice',
    );
    error.status = 503;
    throw error;
  }
  if (mode !== 'asr' && mode !== 'tts') {
    const error = new Error('mode must be asr or tts');
    error.status = 400;
    throw error;
  }

  const now = Number.isFinite(options.now) ? options.now : Math.floor(Date.now() / 1000);
  const ttlSeconds =
    options.ttlSeconds ||
    (mode === 'asr' ? VOICE_LEASE_TTL_ASR_SEC : VOICE_LEASE_TTL_TTS_SEC);
  const payload = {
    v: 1,
    mode,
    iat: now,
    exp: now + ttlSeconds,
    jti: options.jti || randomUUID(),
  };
  const body = b64urlJson(payload);
  const sig = b64url(
    createHmac('sha256', config.secret).update(body).digest(),
  );
  return {
    token: `${body}.${sig}`,
    expiresAt: payload.exp,
    mode,
    wsPath: `${config.publicWsPath}?token=${encodeURIComponent(`${body}.${sig}`)}`,
    model: mode === 'asr' ? config.asrModel : config.ttsModel,
    voice: mode === 'tts' ? config.ttsVoice : undefined,
    provider: 'qwen',
  };
}

/**
 * @param {string} token
 * @param {{ expectedMode?: 'asr'|'tts', now?: number }} [options]
 */
export function verifyVoiceLease(token, options = {}) {
  const config = getVoiceLeaseConfig();
  if (!config.configured) {
    throw Object.assign(new Error('VOICE_LEASE_SECRET is not configured'), {
      status: 503,
    });
  }
  const raw = String(token || '');
  const idx = raw.lastIndexOf('.');
  if (idx <= 0) {
    throw Object.assign(new Error('Malformed lease token'), { status: 401 });
  }
  const body = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = b64url(
    createHmac('sha256', config.secret).update(body).digest(),
  );
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error('Invalid lease signature'), { status: 401 });
  }

  let payload;
  try {
    const json = Buffer.from(
      body.replace(/-/g, '+').replace(/_/g, '/') +
        '='.repeat((4 - (body.length % 4)) % 4),
      'base64',
    ).toString('utf8');
    payload = JSON.parse(json);
  } catch {
    throw Object.assign(new Error('Malformed lease payload'), { status: 401 });
  }

  const mode = String(payload?.mode || '');
  if (mode !== 'asr' && mode !== 'tts') {
    throw Object.assign(new Error('Lease mode is invalid'), { status: 401 });
  }
  if (options.expectedMode && mode !== options.expectedMode) {
    throw Object.assign(new Error('Lease mode mismatch'), { status: 401 });
  }
  const now = Number.isFinite(options.now)
    ? options.now
    : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= now) {
    throw Object.assign(new Error('Lease expired'), { status: 401 });
  }
  return payload;
}

/**
 * Call the internal voice sidecar HTTP API.
 * @param {string} path
 * @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} [options]
 */
export async function voiceServiceFetch(path, options = {}) {
  const config = getVoiceLeaseConfig();
  if (!config.configured) {
    const error = new Error('VOICE_LEASE_SECRET is not configured');
    error.status = 503;
    throw error;
  }
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`${config.voiceServiceUrl}${path}`, {
    method: options.method || 'POST',
    headers: {
      Authorization: `Bearer ${config.secret}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  return response;
}
