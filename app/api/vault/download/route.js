import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { resolveVaultPath } from '@/lib/vault';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CONTENT_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
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
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function normalizeVaultPath(value) {
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isBlockedPath(relativePath) {
  return (
    relativePath === 'Secrets' ||
    relativePath.startsWith('Secrets/') ||
    /\/\./.test(relativePath)
  );
}

function contentDisposition(filename) {
  const fallback = filename.replace(/[^\w. -]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * GET /api/vault/download?path=…
 * Streams any vault file as an attachment download.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const relativePath = normalizeVaultPath(searchParams.get('path'));

  if (!relativePath) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 });
  }

  if (isBlockedPath(relativePath)) {
    return NextResponse.json({ error: 'Forbidden path' }, { status: 403 });
  }

  let fullPath;
  try {
    fullPath = resolveVaultPath(relativePath);
  } catch {
    return NextResponse.json({ error: 'Forbidden path' }, { status: 403 });
  }

  let stats;
  try {
    stats = await fs.stat(fullPath);
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  if (!stats.isFile()) {
    return NextResponse.json(
      { error: 'Directory download is not supported' },
      { status: 400 },
    );
  }

  const filename = path.basename(fullPath);
  const contentType =
    CONTENT_TYPES[path.extname(filename).toLowerCase()] ||
    'application/octet-stream';

  const stream = new ReadableStream({
    start(controller) {
      const nodeStream = createReadStream(fullPath);
      nodeStream.on('data', (chunk) => controller.enqueue(chunk));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (error) => controller.error(error));
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stats.size),
      'Content-Disposition': contentDisposition(filename),
      'Cache-Control': 'no-store',
    },
  });
}
