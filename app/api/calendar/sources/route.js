import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

function errorResponse(message, status = 500) {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

/**
 * GET /api/calendar/sources
 * Returns the discovered CalDAV calendar collections (DingTalk calendars).
 */
export async function GET() {
  try {
    const sources = await prisma.calDavSource.findMany({
      where: { enabled: true },
      orderBy: { displayName: 'asc' },
      select: {
        id: true,
        url: true,
        displayName: true,
        enabled: true,
      },
    });

    return NextResponse.json({ sources }, { headers: NO_STORE });
  } catch (error) {
    console.error('[calendar/sources]', error);
    return errorResponse('Failed to load calendar sources');
  }
}
