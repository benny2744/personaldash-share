/**
 * lib/readLaterAudio.js — Generated read-aloud audio for Read Later items.
 *
 * One ReadLaterAudio row per (item, speech-text generation). The worker
 * synthesizes each chunk through the pipecat-voice sidecar, concatenates the
 * chunk WAVs with ffmpeg into a single mono AAC file (~48 kbps), and promotes
 * it atomically into READ_LATER_AUDIO_DIR. Rows and files are deleted when
 * the item is marked read or skipped.
 */

import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import prisma from './db';
import { getVoiceLeaseConfig, voiceServiceFetch } from './hermes/voiceLease';
import { getReadLaterContent } from './readLaterContentCache';
import {
  SPEECH_CHUNK_CHARS,
  buildSpeechText,
  computeSpeechHash,
  splitSpeechText,
} from './readLaterSpeech';
import { cleanForSpeech } from './readLaterTtsClean';

const execFileAsync = promisify(execFile);

// Outer guard: refuse to pay cleaning cost on absurd inputs. The speakable
// limit (getMaxSpeechChars) applies to the CLEANED text, which is shorter.
const RAW_SPEECH_MAX_CHARS = 150_000;

export const AUDIO_DIR =
  process.env.READ_LATER_AUDIO_DIR || '/data/read-later-audio';
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';
const STALE_PROCESSING_MS = 30 * 60 * 1000;
const STORAGE_KEY_RE = /^readlater-[\w-]+\.m4a$/;

let workerStarted = false;
let draining = false;

export function isReadLaterAudioEnabled() {
  return process.env.READ_LATER_AUDIO_ENABLED !== 'false';
}

function fail(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function chunkFileName(index) {
  return `chunk-${String(index).padStart(4, '0')}.wav`;
}

function isWavBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length > 44 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

async function isValidWavFile(filePath) {
  try {
    const header = await readFile(filePath);
    return isWavBuffer(header);
  } catch {
    return false;
  }
}

export function resolveAudioFilePath(storageKey) {
  if (!STORAGE_KEY_RE.test(String(storageKey || ''))) return null;
  return path.join(AUDIO_DIR, storageKey);
}

export function serializeAudioStatus(row) {
  if (!row) return { status: 'none' };
  return {
    status: row.status,
    chunkCount: row.chunkCount,
    chunksDone: row.chunksDone,
    bytes: row.bytes,
    durationMs: row.durationMs,
    error: row.error || null,
    speechHash: row.speechHash,
    requestedAt: row.requestedAt,
    readyAt: row.readyAt,
  };
}

export async function getReadLaterAudioStatus(knowledgeNoteId) {
  const row = await prisma.readLaterAudio.findFirst({
    where: { knowledgeNoteId },
    orderBy: { requestedAt: 'desc' },
  });
  return serializeAudioStatus(row);
}

async function deleteGenerationRows(rows) {
  for (const row of rows) {
    if (row.storageKey) {
      const filePath = resolveAudioFilePath(row.storageKey);
      if (filePath) await rm(filePath, { force: true });
    }
    await rm(path.join(AUDIO_DIR, `.tmp-${row.id}`), {
      recursive: true,
      force: true,
    });
  }
  if (rows.length) {
    await prisma.readLaterAudio.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
  }
}

async function deleteGenerationsExcept(knowledgeNoteId, speechHash) {
  const stale = await prisma.readLaterAudio.findMany({
    where: { knowledgeNoteId, speechHash: { not: speechHash } },
  });
  await deleteGenerationRows(stale);
}

export async function deleteReadLaterAudio(knowledgeNoteId) {
  const rows = await prisma.readLaterAudio.findMany({
    where: { knowledgeNoteId },
  });
  await deleteGenerationRows(rows);
  return { removed: rows.length };
}

export async function enqueueReadLaterAudio(knowledgeNoteId) {
  const { getSetting } = await import('@/lib/settings/resolve');
  if (!isReadLaterAudioEnabled()) {
    throw fail('Read Later audio is disabled', 503);
  }
  const config = getVoiceLeaseConfig();
  config.ttsVoice = await getSetting('voice.ttsVoice');
  if (!config.configured) {
    throw fail(
      'VOICE_LEASE_SECRET is not configured for Read Later audio',
      503,
    );
  }

  const content = await getReadLaterContent(knowledgeNoteId);
  if (content.error) {
    throw fail(content.error, content.status || 404);
  }
  const speech = buildSpeechText({
    title: content.title,
    markdown: content.content,
  });
  if (!speech.ok) {
    throw fail(speech.error, 400);
  }
  if (speech.text.length > RAW_SPEECH_MAX_CHARS) {
    throw fail(
      `Source text exceeds ${RAW_SPEECH_MAX_CHARS} character cleaning limit (${speech.text.length} chars)`,
      413,
    );
  }
  // Cheap-model cleaning (citations / references / methods / wiki chrome) is
  // computed ONCE here and stored on the row — the worker synthesizes the
  // stored text, so non-deterministic cleaning can never trip the
  // content-changed hash guard. Falls back to raw text on cleaner failure.
  const cleaned = await cleanForSpeech(speech.text);
  if (!cleaned.ok) {
    throw fail(cleaned.error, 400);
  }
  const maxSpeechChars = await getSetting('readLater.ttsMaxChars');
  if (cleaned.text.length > maxSpeechChars) {
    throw fail(
      `Speech text exceeds ${maxSpeechChars} character limit (${cleaned.text.length} chars)`,
      413,
    );
  }
  const chunks = splitSpeechText(cleaned.text, SPEECH_CHUNK_CHARS);
  const speechHash = computeSpeechHash(cleaned.text, {
    model: config.ttsModel,
    voice: config.ttsVoice,
  });

  let row = await prisma.readLaterAudio.findUnique({
    where: {
      knowledgeNoteId_speechHash: { knowledgeNoteId, speechHash },
    },
  });
  if (!row) {
    row = await prisma.readLaterAudio
      .create({
        data: {
          knowledgeNoteId,
          speechHash,
          voice: config.ttsVoice,
          model: config.ttsModel,
          speechText: cleaned.text,
          status: 'queued',
          chunkCount: chunks.length,
        },
      })
      .catch(async (error) => {
        if (error?.code === 'P2002') {
          return prisma.readLaterAudio.findUnique({
            where: {
              knowledgeNoteId_speechHash: { knowledgeNoteId, speechHash },
            },
          });
        }
        throw error;
      });
  } else if (row.status === 'failed') {
    row = await prisma.readLaterAudio.update({
      where: { id: row.id },
      data: { status: 'queued', error: null, requestedAt: new Date() },
    });
  }
  if (row.status !== 'processing' && row.chunkCount !== chunks.length) {
    row = await prisma.readLaterAudio.update({
      where: { id: row.id },
      data: { chunkCount: chunks.length },
    });
  }

  await deleteGenerationsExcept(knowledgeNoteId, speechHash);
  kickReadLaterAudioWorker();
  return serializeAudioStatus(row);
}

async function probeDurationMs(filePath) {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v',
      'quiet',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      filePath,
    ]);
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
}

async function runAudioJob(rowId) {
  const row = await prisma.readLaterAudio.findUnique({
    where: { id: rowId },
    include: {
      knowledgeNote: { include: { note: { select: { deletedAt: true } } } },
    },
  });
  if (!row || row.status !== 'processing') return;
  if (row.knowledgeNote?.note?.deletedAt) {
    await deleteReadLaterAudio(row.knowledgeNoteId);
    return;
  }

  try {
    const content = await getReadLaterContent(row.knowledgeNoteId);
    if (content.error) {
      throw fail(content.error, content.status || 404);
    }
    // Prefer the cleaned text stored at enqueue; only legacy rows (created
    // before the cleaning stage) re-derive raw speech text and keep the old
    // content-changed hash guard.
    let speakText = row.speechText;
    if (!speakText) {
      const speech = buildSpeechText({
        title: content.title,
        markdown: content.content,
      });
      if (!speech.ok) throw new Error(speech.error);
      const config = getVoiceLeaseConfig();
      const speechHash = computeSpeechHash(speech.text, {
        model: config.ttsModel,
        voice: config.ttsVoice,
      });
      if (speechHash !== row.speechHash) {
        throw new Error(
          'Content changed since this audio was queued; prepare it again',
        );
      }
      speakText = speech.text;
    }
    const chunks = splitSpeechText(speakText, SPEECH_CHUNK_CHARS);
    await prisma.readLaterAudio.update({
      where: { id: row.id },
      data: { chunkCount: chunks.length },
    });

    await mkdir(AUDIO_DIR, { recursive: true });
    const tmpDir = path.join(AUDIO_DIR, `.tmp-${row.id}`);
    await mkdir(tmpDir, { recursive: true });

    for (let index = 0; index < chunks.length; index += 1) {
      const chunkPath = path.join(tmpDir, chunkFileName(index));
      if (!(await isValidWavFile(chunkPath))) {
        // The row's stored voice/model is the cache identity — it MUST drive
        // the synthesis request, or voice-setting changes regenerate audio
        // in the sidecar's default voice instead.
        const response = await voiceServiceFetch('/v1/speak', {
          body: {
            text: chunks[index],
            ...(row.voice ? { voice: row.voice } : {}),
            ...(row.model ? { model: row.model } : {}),
          },
        });
        if (!response.ok) {
          let detail = `TTS chunk failed (${response.status})`;
          try {
            const payload = await response.json();
            detail = payload.detail || payload.error || detail;
          } catch {
            // non-JSON error body
          }
          throw new Error(detail);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!isWavBuffer(buffer)) {
          throw new Error('TTS chunk was not a WAV payload');
        }
        const partPath = `${chunkPath}.part`;
        await writeFile(partPath, buffer);
        await rename(partPath, chunkPath);
      }
      await prisma.readLaterAudio.update({
        where: { id: row.id },
        data: { chunksDone: index + 1 },
      });
    }

    const listPath = path.join(tmpDir, 'list.txt');
    await writeFile(
      listPath,
      chunks
        .map((_, index) => `file '${path.join(tmpDir, chunkFileName(index))}'`)
        .join('\n') + '\n',
    );
    const outPath = path.join(tmpDir, 'out.m4a');
    await execFileAsync(FFMPEG_BIN, [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c:a',
      'aac',
      '-b:a',
      '48k',
      '-ac',
      '1',
      '-ar',
      '24000',
      '-movflags',
      '+faststart',
      outPath,
    ]);

    const storageKey = `readlater-${row.id}.m4a`;
    const finalPath = path.join(AUDIO_DIR, storageKey);
    await rename(outPath, finalPath);
    const stats = await stat(finalPath);
    const durationMs = await probeDurationMs(finalPath);
    await prisma.readLaterAudio.update({
      where: { id: row.id },
      data: {
        status: 'ready',
        storageKey,
        mimeType: 'audio/mp4',
        bytes: stats.size,
        durationMs,
        error: null,
        readyAt: new Date(),
      },
    });
    await rm(tmpDir, { recursive: true, force: true });
    await deleteGenerationsExcept(row.knowledgeNoteId, row.speechHash);
  } catch (error) {
    await prisma.readLaterAudio.updateMany({
      where: { id: row.id, status: 'processing' },
      data: { status: 'failed', error: String(error?.message || error) },
    });
  }
}

async function claimQueuedRow() {
  const row = await prisma.readLaterAudio.findFirst({
    where: { status: 'queued' },
    orderBy: { requestedAt: 'asc' },
  });
  if (!row) return null;
  const claimed = await prisma.readLaterAudio.updateMany({
    where: { id: row.id, status: 'queued' },
    data: { status: 'processing', startedAt: new Date(), error: null },
  });
  return claimed.count ? row : null;
}

async function drainQueuedJobs() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const row = await claimQueuedRow();
      if (!row) return;
      try {
        await runAudioJob(row.id);
      } catch (error) {
        console.error('[read-later-audio] job failed', row.id, error);
      }
    }
  } finally {
    draining = false;
  }
}

export function kickReadLaterAudioWorker() {
  if (!isReadLaterAudioEnabled()) return;
  setImmediate(() => {
    drainQueuedJobs().catch((error) => {
      console.error('[read-later-audio] queue drain failed', error);
    });
  });
}

export function startReadLaterAudioWorker() {
  if (!isReadLaterAudioEnabled() || workerStarted) return;
  workerStarted = true;
  setInterval(() => {
    drainQueuedJobs().catch((error) => {
      console.error('[read-later-audio] queue drain failed', error);
    });
  }, 5000).unref?.();
  setTimeout(() => {
    sweepOrphanReadLaterAudio().catch((error) => {
      console.error('[read-later-audio] orphan sweep failed', error);
    });
  }, 60_000).unref?.();
  kickReadLaterAudioWorker();
}

export async function recoverReadLaterAudioJobs() {
  if (!isReadLaterAudioEnabled()) return;
  const result = await prisma.readLaterAudio.updateMany({
    where: { status: 'processing' },
    data: { status: 'queued', error: null },
  });
  if (result.count) {
    console.log(
      `[read-later-audio] recovered ${result.count} interrupted job(s)`,
    );
  }
}

export async function sweepOrphanReadLaterAudio() {
  if (!isReadLaterAudioEnabled()) return { removed: 0 };
  await mkdir(AUDIO_DIR, { recursive: true });

  const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  const requeued = await prisma.readLaterAudio.updateMany({
    where: { status: 'processing', startedAt: { lt: staleCutoff } },
    data: { status: 'queued', error: null },
  });

  const rows = await prisma.readLaterAudio.findMany({
    select: { id: true, status: true, storageKey: true },
  });
  const referenced = new Set(
    rows.flatMap((row) => [row.storageKey, `.tmp-${row.id}`].filter(Boolean)),
  );
  let removed = 0;
  for (const entry of await readdir(AUDIO_DIR)) {
    if (referenced.has(entry)) continue;
    await rm(path.join(AUDIO_DIR, entry), { recursive: true, force: true });
    removed += 1;
  }
  for (const row of rows) {
    if (row.status !== 'ready' || !row.storageKey) continue;
    const filePath = resolveAudioFilePath(row.storageKey);
    if (filePath && !existsSync(filePath)) {
      await prisma.readLaterAudio.update({
        where: { id: row.id },
        data: { status: 'failed', error: 'Audio file missing' },
      });
    }
  }
  return { removed, requeued: requeued.count };
}

export async function streamReadLaterAudioHeaders(knowledgeNoteId) {
  const row = await prisma.readLaterAudio.findFirst({
    where: { knowledgeNoteId, status: 'ready' },
    orderBy: { requestedAt: 'desc' },
  });
  if (!row?.storageKey) {
    const active = await prisma.readLaterAudio.findFirst({
      where: { knowledgeNoteId, status: { in: ['queued', 'processing'] } },
      select: { status: true, chunkCount: true, chunksDone: true },
    });
    if (active) {
      return {
        error: 'audio-not-ready',
        status: 409,
        payload: serializeAudioStatus({ ...row, ...active }),
      };
    }
    return { error: 'audio-not-found', status: 404 };
  }
  const filePath = resolveAudioFilePath(row.storageKey);
  if (!filePath || !existsSync(filePath)) {
    return { error: 'audio-file-missing', status: 410 };
  }
  const stats = await stat(filePath);
  return {
    filePath,
    size: stats.size,
    row,
    serialize: () => serializeAudioStatus(row),
  };
}

export function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return { invalid: true };
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { invalid: true };
  let start = rawStart ? Number.parseInt(rawStart, 10) : 0;
  let end = rawEnd ? Number.parseInt(rawEnd, 10) : size - 1;
  if (!rawStart && rawEnd) {
    start = Math.max(0, size - Number.parseInt(rawEnd, 10));
    end = size - 1;
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

export function audioFileStream(filePath, range) {
  return createReadStream(
    filePath,
    range ? { start: range.start, end: range.end } : undefined,
  );
}
