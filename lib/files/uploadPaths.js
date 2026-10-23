/**
 * lib/files/uploadPaths.js — pure path helpers for folder/zip uploads.
 *
 * Shared by the client (folder picker, drag-drop traversal, zip extraction)
 * and the server (`?createDirs=1` upload validation), so what the client
 * sends is exactly what the server accepts. No node imports: this module
 * runs in the browser bundle.
 *
 * Rules mirror lib/exchange.js's guards: illegal filename characters are
 * replaced (same charset as sanitizeExchangeFilename), hidden segments
 * (leading `.`) are rejected, and any traversal attempt (`..`) rejects the
 * whole path rather than silently rewriting it.
 */

const UNSAFE_CHARS = /[\\/:*?"<>|]/g;

function sanitizeSegment(segment) {
  return segment.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Split a client-supplied relative path into safe upload segments.
 * Returns null when the path cannot be made safe: traversal (`..`), a
 * hidden segment, or nothing usable after sanitization.
 * @param {string} relativePath e.g. "MyFolder/sub/a.txt"
 * @returns {string[]|null} sanitized segments, or null
 */
export function uploadPathSegments(relativePath) {
  const raw = String(relativePath ?? '').split(/[\\/]+/);
  const segments = [];
  for (const part of raw) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    const segment = sanitizeSegment(part);
    if (!segment || segment.startsWith('.')) return null;
    segments.push(segment);
  }
  return segments.length ? segments : null;
}

/**
 * Posix-joined safe relative path, or null (see uploadPathSegments).
 * @param {string} relativePath
 * @returns {string|null}
 */
export function sanitizeRelativeUploadPath(relativePath) {
  const segments = uploadPathSegments(relativePath);
  return segments ? segments.join('/') : null;
}

/**
 * Safe directory name for an extracted zip: stem of the zip filename.
 * @param {string} zipName e.g. "photos 2026.zip"
 * @returns {string} sanitized stem, or "archive"
 */
export function zipRootDirName(zipName) {
  const stem = String(zipName ?? '').replace(/\.zip$/i, '');
  const segments = uploadPathSegments(stem);
  return segments ? segments[segments.length - 1] : 'archive';
}
