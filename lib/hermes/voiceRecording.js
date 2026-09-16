/**
 * Pure helpers for browser microphone recording state.
 */

export const VOICE_MAX_SECONDS = 120;

/**
 * @param {'idle'|'recording'|'transcribing'|'error'} state
 * @param {{ offline?: boolean, disabled?: boolean, busy?: boolean }} [flags]
 */
export function canStartRecording(state, flags = {}) {
  if (flags.offline || flags.disabled || flags.busy) return false;
  return state === 'idle' || state === 'error';
}

/**
 * Prefer a MediaRecorder MIME type the browser can produce.
 * @param {{ isTypeSupported?: (mime: string) => boolean } | null | undefined} mediaRecorder
 */
export function pickRecorderMimeType(mediaRecorder = globalThis.MediaRecorder) {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  if (!mediaRecorder?.isTypeSupported) return '';
  for (const type of candidates) {
    if (mediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/**
 * @param {string} mimeType
 */
export function extensionForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}

/**
 * @param {BlobPart[]} chunks
 * @param {string} mimeType
 */
export function buildRecordingBlob(chunks, mimeType) {
  return new Blob(chunks, { type: mimeType || 'audio/webm' });
}
