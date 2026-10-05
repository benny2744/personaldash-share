/**
 * lib/syncWorker.js — Write-back sync worker that patches vault Markdown files
 * when task fields are changed via the web UI.
 *
 * Uses p-queue for sequential processing to prevent race conditions.
 * Compares file hashes before writing to detect external changes (conflicts).
 * Updates sync_state after each write to prevent indexer re-processing loops.
 */

import PQueue from 'p-queue';
import prisma from './db.js';
import { readNote, writeNote, hashContent } from './vault.js';
import { triggerGbrainSync } from './gbrainSync.js';
import {
  patchAttendeesSection,
  patchFrontmatterFields,
  patchTaskRelatedSection,
  parseFrontmatter,
  buildIdeaWriteBackUpdates,
  buildMeetingWriteBackUpdates,
  buildProjectWriteBackUpdates,
  buildWriteBackUpdates,
} from './frontmatter.js';

/** Sequential queue — only one write-back at a time to prevent races. */
const queue = new PQueue({ concurrency: 1 });

/**
 * Enqueue a field-level write-back to a vault Markdown file.
 *
 * @param {Object} params
 * @param {string} params.noteId - Database note ID
 * @param {Object} params.fields - API-style field updates (e.g. { status: 'Doing' })
 * @param {string} params.source - Change source for audit log ('webapp' | 'bot' | 'auto-archive' | 'linter')
 * @returns {Promise<{ success: boolean, conflict?: boolean, error?: string }>}
 */
export function enqueueWriteBack(params) {
  return queue.add(() => executeWriteBack(params));
}

/**
 * Execute a single write-back operation with conflict detection.
 * @param {Object} params
 * @returns {Promise<{ success: boolean, conflict?: boolean, error?: string }>}
 */
async function executeWriteBack({ noteId, fields, source }) {
  try {
    // Look up the note and its sync state
    const note = await prisma.note.findUnique({
      where: { id: noteId },
      include: { syncState: true },
    });

    if (!note) {
      return { success: false, error: 'Note not found' };
    }

    // Read current file content
    let raw;
    try {
      raw = await readNote(note.filepath);
    } catch (err) {
      return { success: false, error: `File read failed: ${err.message}` };
    }

    const currentHash = hashContent(raw);

    // Conflict detection: if the file changed since we last saw it,
    // and it wasn't our own write, there's a conflict
    if (note.syncState && note.syncState.lastSeenHash !== currentHash) {
      await prisma.syncState.update({
        where: { noteId },
        data: {
          syncStatus: 'conflict',
          lastError: `File modified externally. Expected hash ${note.syncState.lastSeenHash.slice(0, 8)}, got ${currentHash.slice(0, 8)}`,
        },
      });
      return {
        success: false,
        conflict: true,
        error: 'File modified externally',
      };
    }

    // Build YAML-compatible updates from API field names
    const yamlUpdates =
      note.baseType === 'idea'
        ? buildIdeaWriteBackUpdates(fields)
        : note.baseType === 'meeting'
          ? buildMeetingWriteBackUpdates(fields)
          : note.baseType === 'project'
            ? buildProjectWriteBackUpdates(fields)
            : buildWriteBackUpdates(fields);
    if (Object.keys(yamlUpdates).length === 0) {
      return { success: true }; // Nothing to update
    }

    // Patch the frontmatter
    let updated = patchFrontmatterFields(raw, yamlUpdates);
    // Meeting attendees also go into the body `## Attendees` section as
    // `- [[Name]]` wikilinks — gbrain extracts backlinks from body wikilinks
    // only, so a frontmatter-only update never reaches the person notes.
    if (note.baseType === 'meeting' && fields.attendees !== undefined) {
      updated = patchAttendeesSection(updated, fields.attendees);
    }
    if (note.baseType === 'task') {
      updated = patchTaskRelatedSection(updated, fields);
    }
    const newHash = hashContent(updated);

    // Re-check immediately before writing so an external save cannot slip between
    // the first conflict check and the file overwrite.
    const latestRaw = await readNote(note.filepath);
    const latestHash = hashContent(latestRaw);
    if (latestHash !== currentHash) {
      await prisma.syncState.update({
        where: { noteId },
        data: {
          syncStatus: 'conflict',
          lastError: `File modified during write-back. Expected hash ${currentHash.slice(0, 8)}, got ${latestHash.slice(0, 8)}`,
        },
      });
      return {
        success: false,
        conflict: true,
        error: 'File modified during write-back',
      };
    }

    await writeNote(note.filepath, updated);

    await prisma.$transaction([
      prisma.syncState.upsert({
        where: { noteId },
        create: {
          noteId,
          lastSeenHash: newHash,
          lastWrittenHash: newHash,
          syncStatus: 'clean',
        },
        update: {
          lastSeenHash: newHash,
          lastWrittenHash: newHash,
          syncStatus: 'clean',
          lastError: null,
        },
      }),
      prisma.note.update({
        where: { id: noteId },
        data: {
          fileHash: newHash,
          frontmatterJson: parseFrontmatter(updated).data,
        },
      }),
    ]);

    console.log(
      `[sync] Write-back complete: ${note.filepath} [${Object.keys(yamlUpdates).join(', ')}]`,
    );
    triggerGbrainSync('write-back');
    return { success: true };
  } catch (err) {
    console.error(`[sync] Write-back error for note ${noteId}:`, err.message);

    // Record the error in sync state
    try {
      await prisma.syncState.update({
        where: { noteId },
        data: {
          syncStatus: 'error',
          lastError: err.message,
        },
      });
    } catch (syncErr) {
      console.error(
        `[sync] Failed to record sync error for note ${noteId}:`,
        syncErr.message,
      );
    }

    return { success: false, error: err.message };
  }
}

/**
 * Get sync queue status for health checks.
 * @returns {{ pending: number, isPaused: boolean }}
 */
export function getSyncQueueStatus() {
  return {
    pending: queue.size + queue.pending,
    isPaused: queue.isPaused,
  };
}

/**
 * Retry all notes with sync errors or conflicts.
 * Re-indexes them from the current file state.
 * @returns {Promise<{ retried: number, errors: number }>}
 */
export async function retryFailedSyncs() {
  const failed = await prisma.syncState.findMany({
    where: {
      syncStatus: { in: ['conflict', 'error'] },
    },
    include: { note: true },
  });

  let retried = 0;
  let errors = 0;

  for (const sync of failed) {
    try {
      // Reset sync state to clean — next indexer pass will re-read the file
      await prisma.syncState.update({
        where: { id: sync.id },
        data: {
          syncStatus: 'clean',
          lastError: null,
          lastWrittenHash: null,
        },
      });
      retried++;
    } catch (err) {
      console.error(
        `[sync] Failed to reset sync state for note ${sync.noteId}:`,
        err.message,
      );
      errors++;
    }
  }

  return { retried, errors };
}
