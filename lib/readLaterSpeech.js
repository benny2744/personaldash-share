/**
 * lib/readLaterSpeech.js — Pure speech-text prep + chunking for Read Later
 * read-aloud audio. DashScope realtime TTS rejects a single append over
 * 2000 chars (the sidecar splits appends, but per-request chunks stay at
 * 1800 for sane progress granularity and bounded retries).
 */

import { createHash } from 'node:crypto';
import { markdownToSpeechText } from './hermes/speechText';

// v2: speech text now passes through the cheap-model cleaner (citations,
// references, methods/sources, wiki chrome stripped) before hashing/chunking.
// v1 was the deterministic markdown→prose pass only.
export const SPEECH_VERSION = 2;
export const SPEECH_CHUNK_CHARS = 1_800;

export function getMaxSpeechChars() {
  const raw = Number(process.env.READ_LATER_TTS_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * Normalize a Read Later item into speakable prose, led by its title.
 * @param {{ title?: string|null, markdown?: string|null }} input
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
export function buildSpeechText({ title, markdown }) {
  const heading = String(title || '').trim();
  const body = markdownToSpeechText(
    heading ? `${heading}\n\n${String(markdown || '')}` : String(markdown || ''),
  );
  if (!body) return { ok: false, error: 'Nothing speakable in this item' };
  return { ok: true, text: body };
}

/**
 * Split speakable text into chunks under `maxChars`, preferring paragraph,
 * then sentence, then hard boundaries.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function splitSpeechText(text, maxChars = SPEECH_CHUNK_CHARS) {
  const source = String(text || '').trim();
  if (!source) return [];
  if (source.length <= maxChars) return [source];

  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = '';
  };

  const appendPiece = (piece) => {
    const value = String(piece || '').trim();
    if (!value) return;
    if (!current) {
      current = value;
      return;
    }
    if (current.length + 1 + value.length <= maxChars) {
      current = `${current} ${value}`;
      return;
    }
    pushCurrent();
    current = value;
  };

  const splitHard = (piece) => {
    const parts = [];
    for (let offset = 0; offset < piece.length; offset += maxChars) {
      parts.push(piece.slice(offset, offset + maxChars));
    }
    return parts;
  };

  const sentences = source
    .split(/(?<=[.!?。！？])\s+/)
    .flatMap((sentence) =>
      sentence.length <= maxChars ? [sentence] : splitHard(sentence),
    );

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      pushCurrent();
      for (const part of splitHard(sentence)) chunks.push(part.trim());
      continue;
    }
    appendPiece(sentence);
  }
  pushCurrent();

  return chunks.filter(Boolean);
}

/**
 * Stable identity of one audio generation: text + model + voice + pipeline
 * version. Changing any of these produces a new speechHash.
 * @param {string} text
 * @param {{ model: string, voice: string }} options
 */
export function computeSpeechHash(text, { model, voice }) {
  return createHash('sha256')
    .update(
      `v${SPEECH_VERSION}:${model}:${voice}:${String(text || '').length}:${String(
        text || '',
      )}`,
    )
    .digest('hex');
}
