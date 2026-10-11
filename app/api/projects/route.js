import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  const status = searchParams.getAll('status');
  const area = searchParams.get('area');
  const domain = searchParams.get('domain');

  const where = { note: { deletedAt: null } };

  if (status.length > 0) {
    where.status = { in: status };
  }

  if (area) {
    where.area = area;
  }

  if (domain) {
    where.domain = domain;
  }

  try {
    const projects = await prisma.project.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        note: {
          select: {
            filepath: true,
          },
        },
      },
    });

    return NextResponse.json(projects);
  } catch (error) {
    console.error('Error fetching projects:', error);
    return NextResponse.json({ error: 'Failed to fetch projects' }, { status: 500 });
  }
}
