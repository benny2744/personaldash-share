import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/link-suggestions/clear-all
 * Dismisses every pending entity suggestion in one shot. Dismissed rows stay
 * queryable via ?status=dismissed, so this is recoverable at the data layer.
 */
export async function POST() {
  try {
    const result = await prisma.entitySuggestion.updateMany({
      where: { status: 'pending' },
      data: { status: 'dismissed', resolvedAt: new Date() },
    });
    return NextResponse.json({ cleared: result.count });
  } catch (error) {
    console.error('Error clearing link suggestions:', error);
    return errorResponse('Failed to clear suggestions', 500);
  }
}
