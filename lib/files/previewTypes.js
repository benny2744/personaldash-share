/**
 * lib/files/previewTypes.js — what the /files page previews inline.
 *
 * Shared by ExchangeBrowser and VaultBrowser so both tabs agree on which
 * entries open the preview sidecar. Text/markdown/images are fetched and
 * rendered in FilePreviewDrawer; PDF/audio/video render straight from the
 * download URL (HTTP Range streaming, no full-file blob download).
 */

const PREVIEWABLE_EXTENSIONS = [
  // text / markdown
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.json',
  '.html',
  // images (fetched as blob)
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  // rendered from the download URL directly
  '.pdf',
  '.mp3',
  '.m4a',
  '.wav',
  '.ogg',
  '.mp4',
  '.webm',
  '.mov',
];

export function isPreviewableName(name) {
  const lower = String(name ?? '').toLowerCase();
  return PREVIEWABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isPdfPath(name) {
  return String(name ?? '')
    .toLowerCase()
    .endsWith('.pdf');
}

const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg'];

export function isAudioPath(name) {
  const lower = String(name ?? '').toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov'];

export function isVideoPath(name) {
  const lower = String(name ?? '').toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
