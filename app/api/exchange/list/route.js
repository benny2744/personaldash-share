import { NextResponse } from 'next/server';
import {
  isHidden,
  listExchangeDirectory,
  normalizeExchangePath,
} from '@/lib/exchange';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/exchange/list?path=…
 * Lists immediate children of an exchange directory.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const relativePath = normalizeExchangePath(searchParams.get('path'));

  if (isHidden(relativePath)) {
    return NextResponse.json({ error: 'Forbidden path' }, { status: 403 });
  }

  try {
    const entries = await listExchangeDirectory(relativePath);
    return NextResponse.json({ path: relativePath, entries });
  } catch (error) {
    if (/escapes exchange root/i.test(error?.message || '')) {
      return NextResponse.json({ error: 'Forbidden path' }, { status: 403 });
    }
    console.error('Error listing exchange directory:', error);
    return NextResponse.json(
      { error: 'Failed to list directory' },
      { status: 500 },
    );
  }
}
