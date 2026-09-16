/**
 * lib/meetingPipeline/linker.js — Re-runnable meeting link-lint worker.
 *
 * Entity resolution/backlinking is split OUT of note creation because its value
 * is time-dependent: a meeting may mention an entity whose note doesn't exist
 * yet, and links should improve as the vault grows.
 *
 * Design (see deploy-opencode-meeting-pipeline.md + the plan):
 *  - The opencode `meeting-linker` agent stays READ-ONLY (edit/bash denied). It
 *    only PROPOSES a JSON resolution + lint report.
 *  - CODE validates every returned name against the real vault lists, then
 *    applies exact matches via enqueueWriteBack({ source: 'linter' }) — reusing
 *    the race-safe, hash-checked write-back path. The agent never edits files.
 *  - Unresolved/fuzzy items + brand-new entities are persisted as EntitySuggestion
 *    rows for the dashboard Link Review inbox; nothing fuzzy is auto-applied.
 *  - Idempotent: each meeting tracks linkedAt + a lint-hash of (note content +
 *    vault entity lists), so unchanged notes are skipped.
 */

import path from 'path';
import crypto from 'crypto';
import matter from 'gray-matter';
import prisma from '@/lib/db';
import config from '@/lib/config';
import {
  runAgent,
  createSession,
  abortSession,
  opencodeTimeoutSignal,
} from './opencodeClient';
import { enqueueWriteBack } from '@/lib/syncWorker';
import { readNote, writeNote, ensureUniqueFilename } from '@/lib/vault';
import { triggerGbrainSync } from '@/lib/gbrainSync';
import { parseFrontmatter, patchFrontmatterFields } from '@/lib/frontmatter';
import { loadMeetingVaultContext } from './vaultContext';
import { repairAndParseJson } from './jsonExtract';

const LINKER_AGENT = 'meeting-linker';
/** Re-lint window for the daily sweep + new-entity triggers. */
const RECENT_WINDOW_DAYS = 30;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_SWEEP_PER_CYCLE = 50;

/** Pending lint requests: deduped set of meeting IDs drained by the worker. */
const lintQueue = new Set();
let workerStarted = false;
let sweepTimer = null;

const ENTITY_TYPE_TO_DIR = {
  person: 'people',
  project: 'projects',
  area: 'areas',
};

function contextList(values) {
  return values?.length ? values.join(', ') : '(none found)';
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Directory (vault-relative) where an entity type's notes live. */
export function entityDirForType(type) {
  return ENTITY_TYPE_TO_DIR[type] || null;
}

/**
 * Hash the inputs to a lint pass so we can skip meetings whose note content and
 * vault entity universe haven't changed since the last lint.
 */
function computeLintHash(noteContent, vaultContext) {
  const parts = [
    noteContent || '',
    (vaultContext.people || []).join(','),
    (vaultContext.projects || []).join(','),
    (vaultContext.areas || []).join(','),
  ];
  return crypto.createHash('sha1').update(parts.join('\n\u0000')).digest('hex');
}

function buildLinkerPrompt({ meeting, vaultContext, noteBody }) {
  const absPath = path.join(config.opencodeVaultPath, meeting.note.filepath);
  return `Meeting note absolute path (read this path directly — do NOT search, glob the workspace, or guess the vault root): ${absPath}
Meeting title: ${meeting.title}

Current frontmatter People: ${contextList(meeting.attendees)}
Current frontmatter Project: ${meeting.project || '(none)'}
Current frontmatter Area: ${meeting.area || '(none)'}

Authoritative People notes in the vault (exact titles): ${contextList(vaultContext.people)}
Authoritative Project notes: ${contextList(vaultContext.projects)}
Authoritative Area notes: ${contextList(vaultContext.areas)}

Full note body (resolve entities from this; you may also read/grep the absolute path above to confirm a name exists or to lint [[links]]):

${noteBody}

Resolve and lint per your instructions. Every name you return in attendees/project/area/extra_links must EXACTLY match an existing note title from the authoritative lists.`;
}

/** Parse + shape-validate the linker agent's JSON contract. */
export function parseLinkerContract(text) {
  const json = repairAndParseJson(text, { array: false });
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('linker contract is not a JSON object');
  }
  const strArray = (value) =>
    Array.isArray(value)
      ? value.map((v) => String(v).trim()).filter(Boolean)
      : [];
  return {
    attendees: strArray(json.attendees),
    project:
      typeof json.project === 'string' && json.project.trim()
        ? json.project.trim()
        : null,
    area:
      typeof json.area === 'string' && json.area.trim()
        ? json.area.trim()
        : null,
    extra_links: Array.isArray(json.extra_links)
      ? json.extra_links.filter(
          (item) =>
            item && typeof item === 'object' && item.mention && item.note,
        )
      : [],
    new_entities: Array.isArray(json.new_entities)
      ? json.new_entities.filter(
          (item) => item && typeof item === 'object' && item.name,
        )
      : [],
    lint: Array.isArray(json.lint)
      ? json.lint.filter(
          (item) => item && typeof item === 'object' && item.issue,
        )
      : [],
  };
}

/**
 * Apply confirmed exact-match links via the race-safe write-back path.
 * Attendees are merged with existing; project/area are set only when currently
 * unset (never clobber an intentional existing link).
 *
 * @returns {Promise<{ applied:{attendees:string[], project:string|null, area:string|null}, writeBack?: Object }>}
 */
async function applyExactLinks(meeting, contract, vaultContext) {
  const validPeople = new Set(
    (vaultContext.people || []).map((n) => n.toLowerCase()),
  );
  const validProjects = new Set(
    (vaultContext.projects || []).map((n) => n.toLowerCase()),
  );
  const validAreas = new Set(
    (vaultContext.areas || []).map((n) => n.toLowerCase()),
  );

  const newAttendees = contract.attendees.filter((name) =>
    validPeople.has(name.toLowerCase()),
  );
  const fields = {};

  const existingAttendees = meeting.attendees || [];
  const lowerExisting = new Set(existingAttendees.map((a) => a.toLowerCase()));
  const mergedAttendees = [...existingAttendees];
  for (const name of newAttendees) {
    if (!lowerExisting.has(name.toLowerCase())) {
      mergedAttendees.push(name);
      lowerExisting.add(name.toLowerCase());
    }
  }
  if (mergedAttendees.length !== existingAttendees.length) {
    fields.attendees = mergedAttendees;
  }

  if (
    !meeting.project &&
    contract.project &&
    validProjects.has(contract.project.toLowerCase())
  ) {
    fields.project = contract.project;
  }
  if (
    !meeting.area &&
    contract.area &&
    validAreas.has(contract.area.toLowerCase())
  ) {
    fields.area = contract.area;
  }

  if (Object.keys(fields).length === 0) {
    return {
      applied: {
        attendees: newAttendees,
        project: fields.project || null,
        area: fields.area || null,
      },
    };
  }

  const result = await enqueueWriteBack({
    noteId: meeting.noteId,
    fields,
    source: 'linter',
  });

  return {
    applied: {
      attendees: newAttendees,
      project: fields.project || null,
      area: fields.area || null,
    },
    writeBack: result,
  };
}

/**
 * Persist unresolved/fuzzy items as EntitySuggestion rows (pending). Idempotent:
 * skip mentions that already have a pending suggestion for this note.
 */
async function persistSuggestions(meeting, contract, sessionID) {
  const filepath = meeting.note.filepath;
  const existing = await prisma.entitySuggestion.findMany({
    where: { filepath, status: 'pending' },
    select: { mention: true, suggestedType: true },
  });
  const have = new Set(
    existing.map((row) => `${row.suggestedType}\u0000${row.mention}`),
  );

  const rows = [];
  for (const entity of contract.new_entities) {
    const type = ['person', 'project', 'area'].includes(entity.type)
      ? entity.type
      : 'person';
    const key = `${type}\u0000${entity.name}`;
    if (have.has(key)) continue;
    have.add(key);
    rows.push({
      noteId: meeting.noteId,
      filepath,
      mention: String(entity.name).slice(0, 200),
      suggestedType: type,
      evidence: String(entity.evidence || '').slice(0, 500),
      status: 'pending',
      opencodeSessionId: sessionID,
    });
  }
  for (const link of contract.extra_links) {
    const key = `fuzzy\u0000${link.mention}`;
    if (have.has(key)) continue;
    have.add(key);
    rows.push({
      noteId: meeting.noteId,
      filepath,
      mention: String(link.mention).slice(0, 200),
      suggestedType: 'fuzzy',
      evidence: `near-match: ${link.note}`,
      suggestedExistingNote: String(link.note).slice(0, 200),
      status: 'pending',
      opencodeSessionId: sessionID,
    });
  }

  if (rows.length) {
    await prisma.entitySuggestion.createMany({ data: rows });
  }
  return rows.length;
}

/**
 * Lint a single meeting note: call the linker agent, validate, apply exact
 * matches via write-back, persist the rest as suggestions. Idempotent unless
 * `force` is set.
 *
 * @param {string} meetingId - Meeting row id (not Note id).
 * @param {Object} [options]
 * @param {boolean} [options.force] - Re-lint even if the lint-hash is unchanged.
 * @returns {Promise<{ skipped:boolean, applied:Object, suggestions:number, sessionID:string|null, error?:string }>}
 */
export async function lintMeetingNote(meetingId, { force = false } = {}) {
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, note: { deletedAt: null } },
    include: { note: { select: { id: true, filepath: true } } },
  });
  if (!meeting || !meeting.note) {
    return {
      skipped: true,
      applied: {},
      suggestions: 0,
      sessionID: null,
      error: 'meeting not found',
    };
  }

  const vaultContext = await loadMeetingVaultContext();

  let raw;
  try {
    raw = await readNote(meeting.note.filepath);
  } catch (error) {
    return {
      skipped: true,
      applied: {},
      suggestions: 0,
      sessionID: null,
      error: `read failed: ${describeError(error)}`,
    };
  }

  const lintHash = computeLintHash(raw, vaultContext);
  if (!force && meeting.lintHash === lintHash && meeting.linkedAt) {
    return { skipped: true, applied: {}, suggestions: 0, sessionID: null };
  }

  if (config.meetingFormatter !== 'opencode' && !config.meetingLinkerEnabled) {
    // Default: the linker agent needs the opencode server. Skip silently unless
    // the opencode formatter is on or MEETING_LINKER_ENABLED=true, but still
    // record the hash so we don't keep retrying in the disabled state.
    await prisma.meeting
      .update({
        where: { id: meetingId },
        data: { linkedAt: new Date(), lintHash },
      })
      .catch(() => {});
    return {
      skipped: true,
      applied: {},
      suggestions: 0,
      sessionID: null,
      error: 'linker disabled (no opencode)',
    };
  }

  const title = `Linker: ${meeting.title}`;
  let sessionID = null;
  try {
    sessionID = (
      await createSession(
        title,
        config.opencodeLinkerModel,
        config.opencodeVaultPath,
      )
    ).sessionID;
    const { text, sessionID: sid } = await runAgent({
      agent: LINKER_AGENT,
      model: config.opencodeLinkerModel,
      title,
      prompt: buildLinkerPrompt({ meeting, vaultContext, noteBody: raw }),
      sessionID,
      signal: opencodeTimeoutSignal(),
    });
    sessionID = sid;
    const contract = parseLinkerContract(text);

    const { applied, writeBack } = await applyExactLinks(
      meeting,
      contract,
      vaultContext,
    );
    const suggestions = await persistSuggestions(meeting, contract, sessionID);

    await prisma.meeting.update({
      where: { id: meetingId },
      data: { linkedAt: new Date(), lintHash },
    });

    return { skipped: false, applied, suggestions, sessionID, writeBack };
  } catch (error) {
    // Record the attempt so a transient agent failure doesn't hot-loop; the
    // hash is still advanced. Pending suggestions are left untouched.
    await prisma.meeting
      .update({
        where: { id: meetingId },
        data: { linkedAt: new Date(), lintHash },
      })
      .catch(() => {});
    await abortSession(sessionID);
    return {
      skipped: false,
      applied: {},
      suggestions: 0,
      sessionID,
      error: describeError(error),
    };
  }
}

// ─── Entity-stub + alias helpers (used by the Link Review API actions) ────────

/**
 * Create a stub note for a brand-new entity in {people|projects|areas}/.
 * @param {{ name:string, type:'person'|'project'|'area' }} args
 * @returns {Promise<{ filepath:string, name:string }>}
 */
export async function createEntityStub({ name, type }) {
  const dir = entityDirForType(type);
  if (!dir) throw new Error(`Unknown entity type: ${type}`);
  const cleanName = String(name)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanName) throw new Error('Entity name is empty');
  const filepath = await ensureUniqueFilename(dir, `${cleanName}.md`);
  const typeMap = {
    person: 'person',
    project: 'project',
    area: 'area',
  };
  const frontmatter = {
    Type: typeMap[type],
    tags: [`type/${type}`],
    aliases: [cleanName === name ? null : name].filter(Boolean),
  };
  const body = `# ${cleanName}\n\n## Notes\n\nCreated from a meeting link review.\n`;
  await writeNote(filepath, matter.stringify(body, frontmatter));
  triggerGbrainSync('entity-stub');
  return { filepath, name: cleanName };
}

/**
 * Merge an entity name into a meeting's frontmatter and enqueue a race-safe
 * write-back. People merge into attendees (dedup); project/area set when unset.
 * @returns {Promise<Object>} write-back result
 */
export async function linkEntityToMeeting({ meetingNoteId, name, type }) {
  const meeting = await prisma.meeting.findFirst({
    where: { noteId: meetingNoteId },
  });
  if (!meeting) throw new Error('meeting not found for note');

  const fields = {};
  if (type === 'person') {
    const lower = new Set(
      (meeting.attendees || []).map((a) => String(a).toLowerCase()),
    );
    if (!lower.has(name.toLowerCase())) {
      fields.attendees = [...(meeting.attendees || []), name];
    }
  } else if (type === 'project' && !meeting.project) {
    fields.project = name;
  } else if (type === 'area' && !meeting.area) {
    fields.area = name;
  }

  if (Object.keys(fields).length === 0) return { success: true, noop: true };
  return enqueueWriteBack({ noteId: meetingNoteId, fields, source: 'linter' });
}

/**
 * Append `alias` to a note's Obsidian `aliases:` frontmatter (idempotent).
 * Works by vault-relative filepath so it covers People notes (which aren't
 * indexed into a typed model). Used by "Map to existing" so the deterministic
 * resolver + future linter runs auto-resolve that mention variant next time.
 */
export async function addAliasToNote({ filepath, alias }) {
  const raw = await readNote(filepath);
  const { data } = parseFrontmatter(raw);
  const existing = Array.isArray(data.aliases)
    ? data.aliases.map((a) => String(a))
    : data.aliases
      ? [String(data.aliases)]
      : [];
  if (existing.some((a) => a.toLowerCase() === String(alias).toLowerCase())) {
    return { added: false, aliases: existing };
  }
  const aliases = [...existing, alias];
  const updated = patchFrontmatterFields(raw, { aliases });
  await writeNote(filepath, updated);
  triggerGbrainSync('entity-link');
  return { added: true, aliases };
}

/** Resolve a vault-relative filepath for an entity name + type. */
export function entityFilepathFor({ name, type }) {
  const dir = entityDirForType(type);
  if (!dir) return null;
  const cleanName = String(name)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${dir}/${cleanName}.md`;
}

// ─── Worker: queue + triggers + daily sweep ───────────────────────────────────

/** Enqueue a meeting for link-lint (deduped; processed by the worker loop). */
export function enqueueMeetingLint(meetingId) {
  if (!meetingId) return;
  lintQueue.add(meetingId);
}

/**
 * Resolve a freshly-written meeting note (by vault-relative filepath) to its
 * Meeting row and enqueue it for lint. The indexer may not have indexed the new
 * note yet at job-completion time, so poll briefly for the row to appear.
 */
export async function enqueueMeetingLintByFilepath(
  filepath,
  { timeoutMs = 30_000, stepMs = 3_000 } = {},
) {
  if (!filepath) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meeting = await prisma.meeting.findFirst({
      where: { note: { filepath } },
      select: { id: true },
    });
    if (meeting) {
      enqueueMeetingLint(meeting.id);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  console.warn(
    `[meeting-linker] Meeting row not found for ${filepath}; lint not enqueued`,
  );
}

/**
 * When a new Person/Project/Area note appears, re-lint recent meetings that do
 * not yet link it. Scoped to a recency window to avoid re-linting the vault.
 */
export async function relintForNewEntity(name, type) {
  if (!name) return;
  const cutoff = new Date(
    Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const candidates = await prisma.meeting.findMany({
    where: { meetingDate: { gte: cutoff }, note: { deletedAt: null } },
    take: MAX_SWEEP_PER_CYCLE,
    orderBy: { meetingDate: 'desc' },
    select: { id: true, attendees: true, project: true, area: true },
  });
  const lower = String(name).toLowerCase();
  for (const meeting of candidates) {
    const linked =
      type === 'person'
        ? (meeting.attendees || []).some(
            (a) => String(a).toLowerCase() === lower,
          )
        : type === 'project'
          ? meeting.project?.toLowerCase() === lower
          : type === 'area'
            ? meeting.area?.toLowerCase() === lower
            : false;
    if (!linked) enqueueMeetingLint(meeting.id);
  }
}

async function drainLintQueue() {
  if (lintQueue.size === 0) return;
  const ids = [...lintQueue];
  lintQueue.clear();
  for (const id of ids) {
    try {
      await lintMeetingNote(id);
    } catch (error) {
      console.error(
        `[meeting-linker] lint failed for ${id}:`,
        describeError(error),
      );
    }
  }
}

/** Daily sweep: re-lint recent meetings that still look unresolved. */
async function runSweep() {
  const cutoff = new Date(
    Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const pendingCount = await prisma.entitySuggestion.count({
    where: { status: 'pending' },
  });
  if (pendingCount > 200) {
    // Don't pile on while the inbox is already backlogged; let the user clear it.
    return;
  }
  const candidates = await prisma.meeting.findMany({
    where: {
      meetingDate: { gte: cutoff },
      note: { deletedAt: null },
      // Unresolved heuristic: no attendees resolved yet, or pending suggestions.
      OR: [
        { attendees: { isEmpty: true } },
        { note: { suggestions: { some: { status: 'pending' } } } },
      ],
    },
    take: MAX_SWEEP_PER_CYCLE,
    orderBy: { meetingDate: 'desc' },
    select: { id: true },
  });
  for (const { id } of candidates) enqueueMeetingLint(id);
  await drainLintQueue();
}

/**
 * Start the meeting-linker background worker. Idempotent. Registered in
 * instrumentation.js alongside the other workers.
 */
export function startMeetingLinker() {
  if (workerStarted) return;
  workerStarted = true;
  console.log('[meeting-linker] Starting link-lint worker');
  // Drain the queue periodically.
  setInterval(() => {
    drainLintQueue().catch((error) =>
      console.error('[meeting-linker] drain failed:', describeError(error)),
    );
  }, 60_000).unref?.();
  // Daily sweep.
  const runOnce = () =>
    runSweep().catch((error) =>
      console.error('[meeting-linker] sweep failed:', describeError(error)),
    );
  setTimeout(runOnce, 2 * 60_000);
  sweepTimer = setInterval(runOnce, SWEEP_INTERVAL_MS);
}
