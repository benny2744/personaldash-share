/**
 * Browser helpers for Qwen realtime voice over the PersonalDash lease + WS proxy.
 * Safe for client components only.
 */

import { prepareSpeechText } from './speechText.js';

export const ASR_SAMPLE_RATE = 16_000;
export const TTS_SAMPLE_RATE = 24_000;

/**
 * @param {'asr'|'tts'} mode
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export async function fetchVoiceLease(mode, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl('/api/hermes/voice/lease', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Voice lease failed (${response.status})`);
  }
  if (!payload.token || !payload.wsPath) {
    throw new Error('Voice lease response missing token');
  }
  return payload;
}

/**
 * Build an absolute same-origin WebSocket URL from a path.
 * @param {string} wsPath
 * @param {{ location?: Location }} [options]
 */
export function voiceWsUrl(wsPath, options = {}) {
  const loc = options.location || globalThis.location;
  if (!loc) throw new Error('No browser location for voice WebSocket');
  const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${loc.host}${wsPath}`;
}

/**
 * Convert Float32 mono samples to little-endian PCM16.
 * @param {Float32Array} float32
 */
export function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

/**
 * Naive downsample from sourceRate to targetRate.
 * @param {Float32Array} input
 * @param {number} sourceRate
 * @param {number} targetRate
 */
export function downsampleToRate(input, sourceRate, targetRate) {
  if (targetRate === sourceRate) return input;
  if (targetRate > sourceRate) {
    throw new Error('Upsampling is not supported');
  }
  const ratio = sourceRate / targetRate;
  const newLength = Math.floor(input.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < input.length; j += 1) {
      sum += input[j];
      count += 1;
    }
    result[i] = count ? sum / count : 0;
  }
  return result;
}

/**
 * @param {ArrayBuffer|Uint8Array|Int16Array} pcm
 */
export function pcmToBase64(pcm) {
  const bytes =
    pcm instanceof ArrayBuffer
      ? new Uint8Array(pcm)
      : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * @param {string} base64
 */
export function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/**
 * Open a leased voice WebSocket and wait for the ready event.
 * @param {'asr'|'tts'} mode
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   WebSocketCtor?: typeof WebSocket,
 *   location?: Location,
 *   onMessage?: (msg: any) => void,
 *   onError?: (err: Error) => void,
 * }} [options]
 */
export async function openVoiceSession(mode, options = {}) {
  const WebSocketCtor = options.WebSocketCtor || globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error('WebSocket is unavailable');

  const lease = await fetchVoiceLease(mode, { fetchImpl: options.fetchImpl });
  const url = voiceWsUrl(lease.wsPath, { location: options.location });
  const ws = new WebSocketCtor(url);

  const ready = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error('Voice session ready timed out'));
      }
    }, 15_000);

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data || ''));
      } catch {
        return;
      }
      options.onMessage?.(msg);
      if (!settled && msg?.type === 'ready') {
        settled = true;
        clearTimeout(timer);
        resolve(msg);
      } else if (!settled && msg?.type === 'error') {
        settled = true;
        clearTimeout(timer);
        reject(new Error(msg.message || 'Voice session error'));
      }
    });
    ws.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Voice WebSocket failed'));
      }
      options.onError?.(new Error('Voice WebSocket failed'));
    });
    ws.addEventListener('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Voice WebSocket closed before ready'));
      }
    });
  });

  return { ws, lease, ready };
}

/**
 * Prepare reply text for streaming TTS.
 * @param {unknown} text
 */
export function prepareStreamSpeechText(text) {
  return prepareSpeechText(text);
}
