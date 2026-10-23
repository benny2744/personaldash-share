import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import {
  contentTypeForPath,
  isHidden,
  normalizeExchangePath,
  resolveExchangePath,
} from '@/lib/exchange';
import { createDirZipStream, zipDownloadName } from '@/lib/files/zipDir';
import { parseRangeHeader } from '@/lib/readLaterAudio';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function contentDisposition(filename) {
  const fallback = filename.replace(/[^\w. -]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function fileStream(fullPath, range) {
  return createReadStream(
    fullPath,
    range ? { start: range.start, end: range.end } : undefined,
  );
}

/**
 * GET /api/exchange/download?path=…
 * Streams an exchange file as an attachment, with Range support so media
 * players can seek. Directories stream as a zip archive (entry-by-entry,
 * flat memory; hidden entries and symlinks skipped).
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const relativePath = normalizeExchangePath(searchParams.get('path'));

  if (!relativePath) {
    return NextResponse.json(
      { error: 'Missing path parameter' },
      { status: 400 },
    );
  }

  if (isHidden(relativePath)) {
    return NextResponse.json({ error: 'Forbidden path' }, { status: 403 });
  }

  let fullPath;
  try {
    fullPath = resolveExchangePath(relativePath);
  } catch {
    return NextResponse.json({ error: 'Forbidden path' }, { status: 403 });
  }

  let stats;
  try {
    stats = await fs.stat(fullPath);
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  if (stats.isDirectory()) {
    const zipName = zipDownloadName(relativePath);
    const zipStream = await createDirZipStream(
      resolveExchangePath(''),
      relativePath,
    );
    return new Response(Readable.toWeb(zipStream), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(zipName),
        'Cache-Control': 'no-store',
      },
    });
  }

  if (!stats.isFile()) {
    return NextResponse.json(
      { error: 'Not a file or directory' },
      { status: 400 },
    );
  }

  const filename = path.basename(fullPath);
  const contentType = contentTypeForPath(filename);
  const range = parseRangeHeader(request.headers.get('range'), stats.size);

  if (range?.invalid) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${stats.size}` },
    });
  }

  if (range) {
    return new NextResponse(fileStream(fullPath, range), {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': contentDisposition(filename),
        'Cache-Control': 'no-store',
      },
    });
  }

  return new NextResponse(fileStream(fullPath), {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stats.size),
      'Content-Disposition': contentDisposition(filename),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  });
}
