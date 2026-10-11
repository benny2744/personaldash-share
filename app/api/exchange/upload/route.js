import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import {
  isHidden,
  normalizeExchangePath,
  resolveExchangePath,
  sanitizeExchangeFilename,
  statExchangePath,
  writeExchangeStream,
} from '@/lib/exchange';
import config from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024;

/**
 * POST /api/exchange/upload?path=<target dir>
 * multipart/form-data with a `file` field. Stores the file in the exchange
 * (never overwrites — collisions get a -2 suffix). No processing: pure drop.
 */
export async function POST(request) {
  const { searchParams } = new URL(request.url);
  const targetDir = normalizeExchangePath(searchParams.get('path') || 'inbox');

  if (!targetDir || targetDir.endsWith('/')) {
    return NextResponse.json(
      { error: 'Invalid target directory' },
      { status: 400 },
    );
  }
  if (isHidden(targetDir)) {
    return NextResponse.json({ error: 'Forbidden path' }, { status: 403 });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: 'Expected multipart form data' },
      { status: 400 },
    );
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'Missing file field' }, { status: 400 });
  }
  if (file.size > config.exchangeUploadMaxBytes) {
    return NextResponse.json(
      {
        error: `File exceeds the ${Math.round(config.exchangeUploadMaxBytes / 1048576)}MB upload cap`,
      },
      { status: 413 },
    );
  }

  // Reject a target dir that exists as a file before writing.
  try {
    const dirStats = await statExchangePath(targetDir);
    if (!dirStats.isDirectory()) {
      return NextResponse.json(
        { error: 'Target is not a directory' },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'Target directory not found' },
      { status: 404 },
    );
  }

  let relativePath;
  try {
    // Safe filename: basename only, no directory components from the client,
    // sanitized like every other upload path.
    const cleanName = sanitizeExchangeFilename(
      path.basename(file.name || 'file'),
    );
    relativePath = path.posix.join(targetDir, cleanName);
    resolveExchangePath(relativePath); // escape guard before writing

    let savedPath;
    if (file.size > STREAM_THRESHOLD_BYTES) {
      // Large uploads: stream the web File body to disk instead of buffering
      // it in the formData blob.
      savedPath = await writeExchangeStream(
        relativePath,
        Readable.fromWeb(file.stream()),
      );
    } else {
      const buffer = Buffer.from(await file.arrayBuffer());
      savedPath = await writeExchangeStream(
        relativePath,
        Readable.from(buffer),
      );
    }
    // writeExchangeStream never overwrites: concurrent racers get suffixed
    // names, so always report the path actually written.
    relativePath = savedPath;
  } catch (error) {
    if (/escapes exchange root/i.test(error?.message || '')) {
      return NextResponse.json({ error: 'Forbidden path' }, { status: 403 });
    }
    console.error('Exchange upload failed:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, path: relativePath, size: file.size });
}
