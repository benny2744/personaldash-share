/**
 * lib/files/zipDir.js — stream a directory tree as a zip archive.
 *
 * Used by the exchange and vault download routes when the requested path is
 * a directory: the archive is built entry-by-entry with fflate's streaming
 * Zip, so memory stays flat regardless of tree size. Hidden entries (leading
 * `.`) and symlinks are skipped — symlinks are never followed, matching the
 * escape paranoia of resolveExchangePath/resolveVaultPath. Empty directories
 * are preserved as directory entries.
 */

import { Zip, ZipDeflate } from 'fflate';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const CHUNK_SIZE = 1 << 18; // 256KB read batches per file

/**
 * Build a zip of `dirRelative` (root-relative) as a Node Readable.
 * @param {string} rootAbsolute absolute root dir (exchange path / vault root)
 * @param {string} dirRelative root-relative dir to zip ('' = whole root)
 * @param {{ excludeRelative?: (relativePath: string) => boolean }} [options]
 *   excludeRelative receives each entry's posix path relative to the zip
 *   root; returning true for a directory skips its whole subtree.
 * @returns {Promise<Readable>} node Readable emitting zip bytes
 */
export async function createDirZipStream(
  rootAbsolute,
  dirRelative = '',
  { excludeRelative } = {},
) {
  const rootDir = path.resolve(rootAbsolute);
  const baseDir = path.resolve(rootDir, dirRelative || '.');
  if (baseDir !== rootDir && !baseDir.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error('Path escapes root');
  }

  async function* generate() {
    const buffered = [];
    let zipError = null;
    const zip = new Zip((err, data) => {
      if (err) {
        zipError = err;
        return;
      }
      buffered.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    });

    // ondata fires synchronously during entry.push(); drain into the
    // generator between file reads so the consumer's backpressure applies.
    function* flush() {
      while (buffered.length) yield buffered.shift();
    }

    async function* addFile(relativePath, absolutePath) {
      const entry = new ZipDeflate(relativePath, { level: 6 });
      zip.add(entry);
      const fileStream = createReadStream(absolutePath, {
        highWaterMark: CHUNK_SIZE,
      });
      for await (const chunk of fileStream) {
        if (zipError) throw zipError;
        entry.push(chunk, false);
        yield* flush();
      }
      entry.push(new Uint8Array(0), true);
      yield* flush();
    }

    function addDirectoryEntry(relativePath) {
      const entry = new ZipDeflate(`${relativePath}/`, { level: 6 });
      zip.add(entry);
      entry.push(new Uint8Array(0), true);
    }

    async function* walk(dirAbsolute, prefix) {
      const dirents = await fs.readdir(dirAbsolute, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.') || dirent.isSymbolicLink()) continue;
        const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
        if (excludeRelative?.(relativePath)) continue;
        const absolutePath = path.join(dirAbsolute, dirent.name);
        if (dirent.isDirectory()) {
          const children = await fs.readdir(absolutePath, {
            withFileTypes: true,
          });
          const visibleChild = children.some(
            (child) => !child.name.startsWith('.') && !child.isSymbolicLink(),
          );
          if (!visibleChild) {
            // Leaf (or hidden-only) directory: keep it as an explicit entry.
            addDirectoryEntry(relativePath);
            yield* flush();
          } else {
            yield* walk(absolutePath, relativePath);
          }
        } else if (dirent.isFile()) {
          yield* addFile(relativePath, absolutePath);
        }
      }
    }

    yield* walk(baseDir, '');
    zip.end();
    if (zipError) throw zipError;
    yield* flush();
  }

  return Readable.from(generate());
}

/**
 * Attachment filename for a zipped directory ('' root → fallback).
 * @param {string} dirRelative
 * @returns {string}
 */
export function zipDownloadName(dirRelative) {
  const basename = path.posix.basename(dirRelative || '').trim();
  return `${basename || 'archive'}.zip`;
}
