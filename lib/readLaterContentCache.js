/**
 * lib/readLaterContentCache.js — DB-backed cache of Read Later preview bodies.
 *
 * The vault file stays canonical. A `ReadLaterContent` row keyed by the
 * preview target's noteId holds the frontmatter-stripped Markdown body plus
 * the `notes.file_hash` it was read from. When the hashes match, content is
 * served from Postgres without touching the filesystem; stale or missing rows
 * are re-read from the vault once and upserted.
 */

import matter from 'gray-matter';
import prisma from './db';
import { readNote, hashContent } from './vault';
import {
  buildSummaryStemMap,
  linkStem,
  resolveSummaryFilepath,
  synthesizedIntoTargets,
} from './readLater';

const DIGEST_TYPES = new Set(['Digest', 'digest']);

export function stripFrontmatter(raw) {
  try {
    return matter(String(raw || '')).content || '';
  } catch {
    return String(raw || '');
  }
}

export function isSelfContainedPreview(item) {
  if (item?.knowledgeType === 'Research Report') return true;
  const fm = item?.note?.frontmatterJson || {};
  return String(fm['Source Type'] || '') === 'Deep Research Report';
}

export function isDigestType(knowledgeType) {
  return DIGEST_TYPES.has(String(knowledgeType || ''));
}

async function loadSummaryStemMap() {
  const summaries = await prisma.knowledgeNote.findMany({
    where: { knowledgeType: 'SourceSummary', note: { deletedAt: null } },
    select: { id: true, title: true, note: { select: { filepath: true } } },
  });
  return buildSummaryStemMap(summaries);
}

/**
 * Resolve which note body a Read Later card should display/speak.
 * @param {string} id - KnowledgeNote id
 * @returns {Promise<{item: object, target: {filepath: string, noteId: string, fileHash: string, label: string}} | {error: string, status: number, title?: string}>}
 */
export async function resolveReadLaterPreview(id) {
  const item = await prisma.knowledgeNote.findFirst({
    where: { id, note: { deletedAt: null } },
    include: {
      note: {
        select: {
          id: true,
          filepath: true,
          fileHash: true,
          frontmatterJson: true,
        },
      },
    },
  });
  if (!item) return { error: 'not-found', status: 404 };

  const knowledgeType = String(item.knowledgeType || '');
  if (isDigestType(knowledgeType)) {
    return {
      item,
      target: {
        filepath: item.note.filepath,
        noteId: item.note.id,
        fileHash: item.note.fileHash,
        label: 'Digest',
      },
    };
  }
  if (knowledgeType === 'Research Report' || isSelfContainedPreview(item)) {
    return {
      item,
      target: {
        filepath: item.note.filepath,
        noteId: item.note.id,
        fileHash: item.note.fileHash,
        label: 'Research report',
      },
    };
  }
  if (knowledgeType === 'Raw') {
    const stemMap = await loadSummaryStemMap();
    const summaryFilepath = resolveSummaryFilepath(item, stemMap);
    if (!summaryFilepath) {
      return { error: 'summary-missing', status: 404, title: item.title };
    }
    const summaryNote = await prisma.note.findUnique({
      where: { filepath: summaryFilepath },
      select: { id: true, filepath: true, fileHash: true },
    });
    if (!summaryNote) {
      return { error: 'summary-missing', status: 404, title: item.title };
    }
    return {
      item,
      target: {
        filepath: summaryNote.filepath,
        noteId: summaryNote.id,
        fileHash: summaryNote.fileHash,
        label: 'Source summary',
      },
    };
  }
  return { error: 'unsupported-type', status: 400, title: item.title };
}

/**
 * Get the preview body for a Read Later item, serving from the DB cache when
 * fresh and backfilling from the vault otherwise.
 */
export async function getReadLaterContent(id) {
  const resolved = await resolveReadLaterPreview(id);
  if (resolved.error) return resolved;
  const { item, target } = resolved;

  const cached = await prisma.readLaterContent.findUnique({
    where: { noteId: target.noteId },
  });
  if (cached && cached.sourceHash === target.fileHash) {
    return {
      content: cached.bodyMarkdown,
      contentHash: cached.contentHash,
      label: target.label,
      title: item.title,
      source: 'db',
    };
  }

  let body;
  try {
    body = stripFrontmatter(await readNote(target.filepath));
  } catch {
    if (cached) {
      return {
        content: cached.bodyMarkdown,
        contentHash: cached.contentHash,
        label: target.label,
        title: item.title,
        source: 'db-stale',
      };
    }
    return { error: 'source-missing', status: 410, title: item.title };
  }
  if (!body.trim()) {
    if (cached) {
      return {
        content: cached.bodyMarkdown,
        contentHash: cached.contentHash,
        label: target.label,
        title: item.title,
        source: 'db-stale',
      };
    }
    return { error: 'empty-content', status: 404, title: item.title };
  }

  const contentHash = hashContent(body);
  await prisma.readLaterContent.upsert({
    where: { noteId: target.noteId },
    create: {
      noteId: target.noteId,
      knowledgeType: String(item.knowledgeType || 'Knowledge'),
      sourceHash: target.fileHash,
      contentHash,
      bodyMarkdown: body,
    },
    update: {
      knowledgeType: String(item.knowledgeType || 'Knowledge'),
      sourceHash: target.fileHash,
      contentHash,
      bodyMarkdown: body,
    },
  });
  return {
    content: body,
    contentHash,
    label: target.label,
    title: item.title,
    source: 'vault',
  };
}

/**
 * Cleanup after a Read Later item transitions to read/skipped: drop its own
 * cache row, then drop linked-summary rows that no remaining unread item
 * references. Best-effort — callers wrap in try/catch.
 */
export async function pruneReadLaterContent(knowledgeNoteId) {
  const item = await prisma.knowledgeNote.findUnique({
    where: { id: knowledgeNoteId },
    include: { note: { select: { id: true, frontmatterJson: true } } },
  });
  if (!item) return { removed: 0 };
  await prisma.readLaterContent.deleteMany({ where: { noteId: item.note.id } });

  if (item.knowledgeType !== 'Raw' || isSelfContainedPreview(item)) {
    return { removed: 1 };
  }

  const unreadRaws = await prisma.knowledgeNote.findMany({
    where: {
      knowledgeType: 'Raw',
      OR: [{ readStatus: null }, { readStatus: 'unread' }],
      note: { deletedAt: null },
    },
    include: { note: { select: { frontmatterJson: true } } },
  });
  const summaries = await prisma.knowledgeNote.findMany({
    where: { knowledgeType: 'SourceSummary', note: { deletedAt: null } },
    select: { title: true, note: { select: { id: true, filepath: true } } },
  });
  const stemToNoteId = new Map();
  for (const summary of summaries) {
    const filepath = summary.note?.filepath;
    if (!filepath) continue;
    const fileStem = linkStem(filepath).toLowerCase();
    if (fileStem && !stemToNoteId.has(fileStem)) {
      stemToNoteId.set(fileStem, summary.note.id);
    }
    const titleStem = linkStem(summary.title).toLowerCase();
    if (titleStem && !stemToNoteId.has(titleStem)) {
      stemToNoteId.set(titleStem, summary.note.id);
    }
  }
  const referenced = new Set();
  for (const raw of unreadRaws) {
    for (const link of synthesizedIntoTargets(raw)) {
      const noteId = stemToNoteId.get(linkStem(link).toLowerCase());
      if (noteId) referenced.add(noteId);
    }
  }
  const orphanIds = summaries
    .map((summary) => summary.note?.id)
    .filter((noteId) => noteId && !referenced.has(noteId));
  if (orphanIds.length) {
    await prisma.readLaterContent.deleteMany({
      where: { noteId: { in: orphanIds } },
    });
  }
  return { removed: 1 + orphanIds.length };
}
