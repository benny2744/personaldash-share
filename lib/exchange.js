/**
 * lib/exchange.js — Filesystem operations for the exchange dir.
 *
 * The exchange dir (config.exchangePath, host ~/exchange) holds uploaded
 * materials (inbox/) and Hermes binary task outputs (outputs/). All paths are
 * relative to the exchange root; escape attempts throw like lib/vault.js.
 */

import fs from 'fs/promises';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import path from 'path';
import config from './config.js';

/** Extension → MIME map for downloads/previews (superset of vault download). */
export const CONTENT_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** File extensions the UI previews inline (text/md/images; others download). */
export function contentTypeForPath(filename) {
  return (
    CONTENT_TYPES[path.extname(filename).toLowerCase()] ||
    'application/octet-stream'
  );
}

export function isPreviewablePath(filename) {
  const ext = path.extname(filename).toLowerCase();
  return (
    ['.md', '.markdown', '.txt', '.csv', '.json', '.html'].includes(ext) ||
    ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)
  );
}

/** Normalize user-supplied relative paths: backslashes, leading slashes. */
export function normalizeExchangePath(value) {
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Hidden files/dirs are never listed or writable. */
export function isHidden(relativePath) {
  return relativePath.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Resolve an absolute path from an exchange-relative path.
 * @param {string} relativePath
 * @returns {string}
 */
export function resolveExchangePath(relativePath) {
  const root = path.resolve(config.exchangePath);
  const resolved = path.resolve(root, relativePath || '.');
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Path escapes exchange root');
  }
  return resolved;
}

/**
 * List immediate children of an exchange directory (non-recursive).
 * Returns entries with size/mtime for the UI.
 * @param {string} [dirRelative='']
 */
export async function listExchangeDirectory(dirRelative = '') {
  const dirAbsolute = resolveExchangePath(dirRelative);
  const entries = await fs.readdir(dirAbsolute, { withFileTypes: true });

  const listed = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(dirRelative, entry.name);
    if (isHidden(entryPath)) continue;
    let stats = null;
    try {
      stats = await fs.stat(path.join(dirAbsolute, entry.name));
    } catch {
      // Entry vanished between readdir and stat — list without metadata.
    }
    listed.push({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file',
      path: entryPath.split(path.sep).join('/'),
      size: stats?.size ?? null,
      modifiedAt: stats?.mtime?.toISOString() ?? null,
    });
  }

  listed.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return listed;
}

/** Stat an exchange file (already-escaped relative path). */
export async function statExchangePath(relativePath) {
  return fs.stat(resolveExchangePath(relativePath));
}

/** Sanitize a client-supplied filename the same way for all upload paths. */
export function sanitizeExchangeFilename(filename) {
  const cleanName =
    filename
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'file';
  const ext = path.extname(cleanName);
  const stem = path.basename(cleanName, ext) || 'file';
  return `${stem}${ext}`;
}

/** Suffixed candidate (`report.txt` → `report-2.txt`) for collision retries. */
function suffixedName(dirRelative, filename, counter) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext) || 'file';
  return path.posix.join(
    dirRelative,
    counter === 0 ? `${stem}${ext}` : `${stem}-${counter + 1}${ext}`,
  );
}

/**
 * Create an exclusively-owned temp file in the target directory (O_EXCL, so
 * concurrent uploads of the same name can never share/truncate one tmp file).
 * @returns {Promise<{handle: import('fs/promises').FileHandle, tmpPath: string}>}
 */
async function createExclusiveTemp(fullPath) {
  const dir = path.dirname(fullPath);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const tmpPath = `${fullPath}.upload-${process.pid}-${crypto
      .randomBytes(8)
      .toString('hex')}`;
    try {
      const handle = await fs.open(tmpPath, 'wx', 0o644);
      return { handle, tmpPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not create a unique upload temp file');
}

/**
 * Atomically publish the temp file at `destPath` WITHOUT overwriting:
 * hardlink fails with EEXIST when the destination already exists, so two
 * racers can never clobber each other's completed upload. The temp file is
 * unlinked after a successful link.
 * @returns {Promise<boolean>} false when the destination exists
 */
async function linkNoOverwrite(tmpPath, destPath) {
  try {
    await fs.link(tmpPath, destPath);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Persist an uploaded file: stream to an exclusive temp file in the target
 * directory, then atomically publish it. NEVER overwrites — when the
 * destination already exists (including races with concurrent uploads), the
 * publish step retries with -2/-3… suffixes and returns the path actually
 * saved.
 * @param {string} relativePath exchange-relative destination (may collide)
 * @param {import('stream').Readable} nodeStream
 * @returns {Promise<string>} exchange-relative path actually written
 */
export async function writeExchangeStream(relativePath, nodeStream) {
  const fullPath = resolveExchangePath(relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const { handle, tmpPath } = await createExclusiveTemp(fullPath);
  try {
    await pipeline(nodeStream, handle.createWriteStream());
    await handle.close();
    const dirRelative = path.posix.dirname(
      relativePath.split(path.sep).join('/'),
    );
    const filename = path.basename(fullPath);
    const maxTries = 100;
    for (let counter = 0; counter < maxTries; counter += 1) {
      const candidate = suffixedName(dirRelative, filename, counter);
      if (await linkNoOverwrite(tmpPath, resolveExchangePath(candidate))) {
        return candidate.split(path.sep).join('/');
      }
    }
    throw new Error('Could not find a non-colliding destination name');
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

/**
 * Return a collision-free exchange-relative path in the target directory.
 * @param {string} dirRelative
 * @param {string} filename
 */
export async function ensureUniqueExchangeFilename(dirRelative, filename) {
  const cleanName =
    filename
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'file';
  const ext = path.extname(cleanName);
  const stem = path.basename(cleanName, ext) || 'file';
  let candidate = path.posix.join(dirRelative, `${stem}${ext}`);
  let counter = 2;
  while (await exchangeFileExists(candidate)) {
    candidate = path.posix.join(dirRelative, `${stem}-${counter}${ext}`);
    counter += 1;
  }
  return candidate;
}

export async function exchangeFileExists(relativePath) {
  try {
    await fs.access(resolveExchangePath(relativePath));
    return true;
  } catch {
    return false;
  }
}
