/**
 * lib/indexer.js — Indexer service that watches the vault
 * and syncs Markdown file metadata into Postgres.
 *
 * Uses chokidar for filesystem watching, gray-matter for frontmatter parsing,
 * and the baseTypes module for note type detection. Performs an initial full
 * scan on startup, then processes incremental changes via file events.
 */

import { watch } from 'chokidar';
import config from './config.js';
import prisma from './db.js';
import {
  readNote,
  statNoteMtime,
  shouldSkipFile,
  toRelativePath,
  hashContent,
  listMarkdownFiles,
} from './vault.js';
import {
  parseFrontmatter,
  extractTitle,
  extractTaskFields,
  extractProjectFields,
  extractIdeaFields,
  extractMeetingFields,
} from './frontmatter.js';
import {
  detectNoteType,
  isIndexableType,
  hasTypedModel,
} from './baseTypes.js';

/** Debounce timers for file-change events. */
const debounceTimers = new Map();

/** Reference to the chokidar watcher instance. */
let watcher = null;

/** Whether the initial scan has completed. */
let initialScanDone = false;

/**
 * Start the vault indexer: run initial scan, then watch for changes.
 */
export async function startIndexer() {
  if (!config.indexerEnabled) {
    console.log('[indexer] Disabled via INDEXER_ENABLED=false');
    return;
  }

  console.log(`[indexer] Starting — vault: ${config.vaultPath}`);

  // Initial full scan
  await runInitialScan();

  // Watch for changes
  watcher = watch(config.vaultPath, {
    ignored:
      /(^|[/\\])\.|\.obsidian|\.trash|\.stversions|\.stfolder|\.git|Secrets|Templates/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher.on('add', (absPath) => debouncedIndex(absPath, 'add'));
  watcher.on('change', (absPath) => debouncedIndex(absPath, 'change'));
  watcher.on('unlink', (absPath) => handleDelete(absPath));
  watcher.on('error', (err) => console.error('[indexer] Watch error:', err));

  console.log('[indexer] Watching for changes');
}

/**
 * Stop the vault indexer and close the file watcher.
 */
export async function stopIndexer() {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
  debounceTimers.forEach((timer) => clearTimeout(timer));
  debounceTimers.clear();
  console.log('[indexer] Stopped');
}

/**
 * Scan the entire vault and index all Markdown files.
 */
async function runInitialScan() {
  console.log('[indexer] Running initial scan...');
  const files = await listMarkdownFiles();
  const fileSet = new Set(files);
  let indexed = 0;
  let skipped = 0;

  for (const filepath of files) {
    try {
      const wasIndexed = await indexFile(filepath);
      if (wasIndexed) indexed++;
      else skipped++;
    } catch (err) {
      console.error(`[indexer] Error indexing ${filepath}:`, err.message);
      skipped++;
    }
  }

  const reconciled = await reconcileMissingFiles(fileSet);
  initialScanDone = true;
  console.log(
    `[indexer] Initial scan complete: ${indexed} indexed, ${skipped} skipped, ${reconciled} reconciled`,
  );
}

async function reconcileMissingFiles(existingFilepaths) {
  const liveNotes = await prisma.note.findMany({
    where: { deletedAt: null },
    select: { id: true, filepath: true },
  });
  let reconciled = 0;

  for (const note of liveNotes) {
    if (existingFilepaths.has(note.filepath) || shouldSkipFile(note.filepath))
      continue;

    try {
      await prisma.note.update({
        where: { id: note.id },
        data: { deletedAt: new Date() },
      });
      await deleteTypedRecords(note.id);
      reconciled++;
    } catch (err) {
      console.error(
        `[indexer] Error reconciling missing ${note.filepath}:`,
        err.message,
      );
    }
  }

  if (reconciled > 0) {
    console.log(`[indexer] Reconciled ${reconciled} missing files`);
  }

  return reconciled;
}

/**
 * Debounce file-change events to avoid processing rapid successive writes.
 * @param {string} absPath - Absolute file path
 * @param {('add'|'change')} [kind] - Event kind (used for new-entity triggers)
 */
function debouncedIndex(absPath, kind = 'change') {
  const existing = debounceTimers.get(absPath);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    absPath,
    setTimeout(async () => {
      debounceTimers.delete(absPath);
      const relativePath = toRelativePath(absPath);
      if (shouldSkipFile(relativePath)) return;

      try {
        await indexFile(relativePath);
      } catch (err) {
        console.error(`[indexer] Error indexing ${relativePath}:`, err.message);
      }

      // A new Person/Project/Area note is a linker trigger: re-lint recent
      // meetings that mention it but don't yet link it. (People notes aren't
      // indexed into a typed model, so this filesystem hook is the signal.)
      if (kind === 'add') {
        notifyNewEntityNote(relativePath).catch((err) => {
          console.error('[indexer] new-entity trigger failed:', err.message);
        });
      }
    }, config.indexerDebounceMs),
  );
}

/** Map a vault-relative entity-note path to {name,type} and fire the linker trigger. */
async function notifyNewEntityNote(relativePath) {
  let type = null;
  if (relativePath.startsWith('people/')) type = 'person';
  else if (relativePath.startsWith('projects/')) type = 'project';
  else if (relativePath.startsWith('areas/')) type = 'area';
  if (!type || !relativePath.endsWith('.md')) return;
  const name = (relativePath.split('/').pop() || '').replace(/\.md$/i, '');
  if (!name) return;
  const { relintForNewEntity } = await import('./meetingPipeline/linker.js');
  await relintForNewEntity(name, type);
}

async function syncFileModifiedAt(note, fileModifiedAt) {
  if (!note || !fileModifiedAt) return;
  const existing = note.fileModifiedAt?.getTime() ?? 0;
  if (Math.abs(existing - fileModifiedAt.getTime()) > 1000) {
    await prisma.note.update({
      where: { id: note.id },
      data: { fileModifiedAt },
    });
  }
}

/**
 * Index a single Markdown file: parse frontmatter, detect type, upsert DB records.
 * Returns true if the file was indexed, false if skipped.
 * @param {string} relativePath - Vault-relative file path
 * @returns {Promise<boolean>}
 */
async function indexFile(relativePath) {
  const raw = await readNote(relativePath);
  const fileHash = hashContent(raw);
  const fileModifiedAt = await statNoteMtime(relativePath);
  const { data: fm, content } = parseFrontmatter(raw);

  // Detect note type from `Type:` frontmatter + path (gbrain schema)
  const baseType = detectNoteType(fm, relativePath);
  if (!isIndexableType(baseType)) return false;

  const title =
    baseType === 'meeting'
      ? (relativePath.split('/').pop() || '').replace(/\.md$/i, '') ||
        'Untitled'
      : extractTitle(fm, content, relativePath);

  // Check if file has changed since last index
  const existingNote = await prisma.note.findUnique({
    where: { filepath: relativePath },
    include: { syncState: true },
  });

  const existingNoteNeedsRefresh = Boolean(
    existingNote &&
    (existingNote.deletedAt ||
      existingNote.baseType !== baseType ||
      existingNote.title !== title),
  );

  // Skip if hash matches and was our own write-back
  if (
    !existingNoteNeedsRefresh &&
    existingNote?.syncState?.lastWrittenHash === fileHash
  ) {
    await syncFileModifiedAt(existingNote, fileModifiedAt);
    return false;
  }

  // Skip if hash hasn't changed at all
  if (!existingNoteNeedsRefresh && existingNote?.fileHash === fileHash) {
    await syncFileModifiedAt(existingNote, fileModifiedAt);
    return false;
  }

  // Upsert note record
  const note = await prisma.note.upsert({
    where: { filepath: relativePath },
    create: {
      filepath: relativePath,
      fileHash,
      baseType,
      title,
      frontmatterJson: fm,
      fileModifiedAt,
      indexedAt: new Date(),
    },
    update: {
      fileHash,
      baseType,
      title,
      frontmatterJson: fm,
      fileModifiedAt,
      indexedAt: new Date(),
      deletedAt: null, // Un-delete if re-appeared
    },
  });

  // Upsert sync state
  await prisma.syncState.upsert({
    where: { noteId: note.id },
    create: {
      noteId: note.id,
      lastSeenHash: fileHash,
      syncStatus: 'clean',
    },
    update: {
      lastSeenHash: fileHash,
      syncStatus: 'clean',
    },
  });

  // Drop stale typed rows if the note changed type, then upsert current type.
  await deleteTypedRecords(note.id, baseType);

  // Upsert typed record if applicable
  if (hasTypedModel(baseType)) {
    await upsertTypedRecord(note.id, baseType, title, fm, relativePath);
  }

  return true;
}

/**
 * Upsert a typed record (Task, Project, Idea, or Meeting) from frontmatter data.
 * @param {string} noteId
 * @param {string} baseType
 * @param {string} title
 * @param {Object} fm - Raw frontmatter data
 */
async function upsertTypedRecord(noteId, baseType, title, fm) {
  if (baseType === 'task') {
    const fields = extractTaskFields(fm);
    await prisma.task.upsert({
      where: { noteId },
      create: { noteId, title, ...fields },
      update: { title, ...fields },
    });
  } else if (baseType === 'project') {
    const fields = extractProjectFields(fm);
    await prisma.project.upsert({
      where: { noteId },
      create: { noteId, title, ...fields },
      update: { title, ...fields },
    });
  } else if (baseType === 'idea') {
    const fields = extractIdeaFields(fm);
    await prisma.idea.upsert({
      where: { noteId },
      create: { noteId, title, ...fields },
      update: { title, ...fields },
    });
  } else if (baseType === 'meeting') {
    const fields = extractMeetingFields(fm);
    await prisma.meeting.upsert({
      where: { noteId },
      create: { noteId, title, ...fields },
      update: { title, ...fields },
    });
  }
}

async function deleteTypedRecords(noteId, exceptBaseType = null) {
  const deletes = [];
  if (exceptBaseType !== 'task')
    deletes.push(prisma.task.deleteMany({ where: { noteId } }));
  if (exceptBaseType !== 'project')
    deletes.push(prisma.project.deleteMany({ where: { noteId } }));
  if (exceptBaseType !== 'idea')
    deletes.push(prisma.idea.deleteMany({ where: { noteId } }));
  if (exceptBaseType !== 'meeting')
    deletes.push(prisma.meeting.deleteMany({ where: { noteId } }));
  await prisma.$transaction(deletes);
}

/**
 * Handle a file deletion event: soft-delete the note in DB.
 * @param {string} absPath - Absolute file path
 */
async function handleDelete(absPath) {
  const relativePath = toRelativePath(absPath);
  if (shouldSkipFile(relativePath)) return;

  try {
    const note = await prisma.note.update({
      where: { filepath: relativePath },
      data: { deletedAt: new Date() },
    });
    await deleteTypedRecords(note.id);
    console.log(`[indexer] Soft-deleted: ${relativePath}`);
  } catch (err) {
    // Note may not exist in DB — that's fine
    if (err.code !== 'P2025') {
      console.error(`[indexer] Error deleting ${relativePath}:`, err.message);
    }
  }
}

/**
 * Get indexer status for health checks.
 * @returns {{ running: boolean, initialScanDone: boolean }}
 */
export function getIndexerStatus() {
  return {
    running: watcher !== null,
    initialScanDone,
  };
}
