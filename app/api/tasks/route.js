import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  
  const status = searchParams.getAll('status');
  const project = searchParams.get('project');
  const priority = searchParams.getAll('priority');
  const overdue = searchParams.get('overdue') === 'true';
  const filepath = searchParams.get('filepath');

  const where = { note: { deletedAt: null } };

  if (status.length > 0) {
    where.status = { in: status };
  }

  if (project) {
    where.project = project;
  }

  if (priority.length > 0) {
    where.priority = { in: priority };
  }

  if (overdue) {
    where.whenDate = { lt: new Date() };
    where.status = { notIn: ['Done', 'done', 'Archived', 'archived'] };
  }

  if (filepath) {
    where.note = { filepath, deletedAt: null };
  }

  try {
    const tasks = await prisma.task.findMany({
      where,
      orderBy: [
        { whenDate: 'asc' },
        { priority: 'desc' },
        { updatedAt: 'desc' },
      ],
      include: {
        note: {
          select: {
            filepath: true,
            fileModifiedAt: true,
          }
        }
      }
    });

    const result = tasks.map((task) => ({
      ...task,
      fileModifiedAt: task.note?.fileModifiedAt ?? null,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching tasks:', error);
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}
