import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { query } from '../../../../lib/dingtalk/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Path to the dws CLI (https://github.com/DingTalk-Real-AI/dingtalk-workspace-tool).
// Required — no default, so a missing install fails fast with a clear error.
const DWS_PATH = process.env.DWS_PATH || 'dws';
const MEDIA_DIR = process.env.DINGTALK_MEDIA_DIR || '/data/dingtalk-media';
const RESOURCE_RE = /^@?[\w+/=.-]{4,200}$/;

const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  amr: 'audio/amr',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
};

const INLINE_TYPES = new Set(['image', 'audio', 'video', 'application/pdf']);

function dwsRun(args) {
  return new Promise((resolve, reject) => {
    execFile(
      DWS_PATH,
      args,
      { timeout: 90000, env: { ...process.env, HOME: process.env.HOME || '/root' } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function cacheKey(resourceId) {
  return resourceId.replace(/^@/, '').replace(/[^\w.-]/g, '_');
}

async function findCached(key) {
  try {
    const metaPath = path.join(MEDIA_DIR, `${key}.json`);
    if (existsSync(metaPath)) {
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      const filePath = path.join(MEDIA_DIR, meta.file);
      if (existsSync(filePath)) return { filePath, filename: meta.filename };
    }
  } catch {
    // fall through to re-download
  }
  return null;
}

async function downloadToCache({ kind, resourceId, messageId, conversationId, key }) {
  const tmpDir = path.join(MEDIA_DIR, `.tmp-${key}-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  try {
    const args =
      kind === 'file'
        ? ['drive', 'download', '--node', resourceId, '--output', tmpDir]
        : [
            'chat',
            'message',
            'download-media',
            '--type',
            'mediaId',
            '--resource-id',
            resourceId,
            '--message-id',
            messageId,
            '--open-conversation-id',
            conversationId,
            '--output',
            tmpDir,
          ];
    await dwsRun(args);
    const files = (await readdir(tmpDir)).filter((f) => !f.startsWith('.'));
    if (files.length === 0) throw new Error('dws produced no output file');
    const filename = files[0];
    const cachedName = `${key}${path.extname(filename)}`;
    await rename(path.join(tmpDir, filename), path.join(MEDIA_DIR, cachedName));
    await writeFile(
      path.join(MEDIA_DIR, `${key}.json`),
      JSON.stringify({ file: cachedName, filename }),
    );
    return { filePath: path.join(MEDIA_DIR, cachedName), filename };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * GET /api/dingtalk/media?messageId=..&resourceId=..&kind=media|file
 * Downloads a message media asset via dws (cached on disk) and streams it back.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const messageId = searchParams.get('messageId') || '';
    const resourceId = searchParams.get('resourceId') || '';
    const kind = searchParams.get('kind') === 'file' ? 'file' : 'media';

    if (!messageId || !RESOURCE_RE.test(resourceId)) {
      return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
    }

    const { rows } = await query(
      `SELECT c.open_conversation_id
         FROM dingtalk_messages m
         JOIN dingtalk_conversations c ON c.id = m.conversation_id
        WHERE m.open_message_id = $1 AND m.content LIKE '%' || $2 || '%'
        LIMIT 1`,
      [messageId, resourceId],
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Media not found' }, { status: 404 });
    }

    const key = cacheKey(resourceId);
    await mkdir(MEDIA_DIR, { recursive: true });
    let cached = await findCached(key);
    if (!cached) {
      cached = await downloadToCache({
        kind,
        resourceId,
        messageId,
        conversationId: rows[0].open_conversation_id,
        key,
      });
    }

    const ext = path.extname(cached.filePath).slice(1).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
    const baseType = contentType.split('/')[0];
    const disposition = INLINE_TYPES.has(contentType) || INLINE_TYPES.has(baseType)
      ? 'inline'
      : `attachment; filename*=UTF-8''${encodeURIComponent(cached.filename)}`;

    return new Response(createReadStream(cached.filePath), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': disposition,
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (error) {
    console.error('[dingtalk/media]', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch media' },
      { status: 500 },
    );
  }
}
