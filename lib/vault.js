/**
 * lib/vault.js — Filesystem operations for the gbrain brain.
 *
 * Provides read/write/list/search/hash operations on vault Markdown files.
 * All paths are relative to the vault root (config.vaultPath).
 * Never modifies file body content — only frontmatter patching is supported.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import config from './config.js';

/** Folders and patterns to skip during indexing. */
const SKIP_PATTERNS = [
  /^\.obsidian/,
  /^\.trash/,
  /^\.stversions/,
  /^\.stfolder/,
  /^\.git/,
  /^Secrets\//,
  /^temp\//,
  /^Templates\//,
  /^system\/Templates\//,
  /\/\./, // hidden files/folders
];

/**
 * Resolve an absolute path from a vault-relative path.
 * @param {string} relativePath
 * @returns {string}
 */
export function resolveVaultPath(relativePath) {
  const vaultRoot = path.resolve(config.vaultPath);
  const resolvedPath = path.resolve(vaultRoot, relativePath || '.');
  if (resolvedPath !== vaultRoot && !resolvedPath.startsWith(`${vaultRoot}${path.sep}`)) {
    throw new Error('Path escapes vault root');
  }
  return resolvedPath;
}

/**
 * Convert an absolute path to a vault-relative path.
 * @param {string} absolutePath
 * @returns {string}
 */
export function toRelativePath(absolutePath) {
  return path.relative(config.vaultPath, absolutePath);
}

/**
 * Check whether a file should be skipped during indexing.
 * @param {string} relativePath - Vault-relative path
 * @returns {boolean}
 */
export function shouldSkipFile(relativePath) {
  // Must be .md
  if (!relativePath.endsWith('.md')) return true;

  // Skip known patterns
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(relativePath)) return true;
  }

  // Skip kanban plugin files
  if (relativePath.endsWith(' Kanban.md')) return true;

  return false;
}

/**
 * Read a Markdown file from the vault.
 * @param {string} relativePath
 * @returns {Promise<string>} Raw file content
 */
export async function readNote(relativePath) {
  const fullPath = resolveVaultPath(relativePath);
  return fs.readFile(fullPath, 'utf-8');
}

export async function statNoteMtime(relativePath) {
  try {
    const stats = await fs.stat(resolveVaultPath(relativePath));
    return stats.mtime;
  } catch {
    return null;
  }
}

/**
 * Write content to a vault file (full overwrite — used by editor saves).
 * @param {string} relativePath
 * @param {string} content
 */
export async function writeNote(relativePath, content) {
  const fullPath = resolveVaultPath(relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/**
 * Compute SHA-256 hash of a string (for comparing in-memory content).
 * @param {string} content
 * @returns {string} Hex-encoded hash
 */
export function hashContent(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * List all Markdown files in a directory (recursive).
 * Returns vault-relative paths.
 * @param {string} [dirRelative=''] - Vault-relative directory path
 * @returns {Promise<string[]>}
 */
export async function listMarkdownFiles(dirRelative = '') {
  const dirAbsolute = resolveVaultPath(dirRelative);
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relative = toRelativePath(fullPath);

      if (entry.isDirectory()) {
        // Skip hidden and excluded directories
        if (entry.name.startsWith('.') || entry.name === 'Templates') continue;
        await walk(fullPath);
      } else if (entry.isFile() && !shouldSkipFile(relative)) {
        results.push(relative);
      }
    }
  }

  await walk(dirAbsolute);
  return results;
}

/**
 * List immediate children of a vault directory (non-recursive).
 * @param {string} [dirRelative='']
 * @returns {Promise<Array<{name: string, type: 'file'|'directory', path: string}>>}
 */
export async function listDirectory(dirRelative = '') {
  const dirAbsolute = resolveVaultPath(dirRelative);
  const entries = await fs.readdir(dirAbsolute, { withFileTypes: true });

  return entries
    .filter((entry) => !shouldSkipDirectory(path.join(dirRelative, entry.name), entry))
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      path: path.join(dirRelative, e.name),
    }))
    .sort((a, b) => {
      // Directories first, then alphabetical
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function shouldSkipDirectory(relativePath, entry) {
  if (entry.name.startsWith('.')) return true;
  if (!entry.isDirectory()) return false;
  return SKIP_PATTERNS.some((pattern) => pattern.test(`${relativePath}/`));
}

/**
 * Check if a file exists in the vault.
 * @param {string} relativePath
 * @returns {Promise<boolean>}
 */
export async function fileExists(relativePath) {
  try {
    await fs.access(resolveVaultPath(relativePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a collision-free vault-relative path in the target directory.
 * @param {string} dirRelative
 * @param {string} filename
 * @returns {Promise<string>}
 */
export async function ensureUniqueFilename(dirRelative, filename) {
  const cleanName = filename.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled.md';
  const ext = path.extname(cleanName) || '.md';
  const stem = path.basename(cleanName, ext);
  let candidate = path.join(dirRelative, `${stem}${ext}`);
  let counter = 2;

  while (await fileExists(candidate)) {
    candidate = path.join(dirRelative, `${stem}-${counter}${ext}`);
    counter += 1;
  }

  return candidate;
}
