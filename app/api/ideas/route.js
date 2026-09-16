import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  const status = searchParams.getAll('status');
  const domain = searchParams.get('domain');

  const where = { note: { deletedAt: null } };

  if (status.length > 0) {
    where.status = { in: status };
  }

  if (domain) {
    where.domain = domain;
  }

  try {
    const ideas = await prisma.idea.findMany({
      where,
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      include: {
        note: {
          select: {
            filepath: true,
            fileModifiedAt: true,
          },
        },
      },
    });

    const result = ideas.map((idea) => ({
      ...idea,
      fileModifiedAt: idea.note?.fileModifiedAt ?? null,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching ideas:', error);
    return NextResponse.json({ error: 'Failed to fetch ideas' }, { status: 500 });
  }
}
