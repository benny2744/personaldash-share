import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { enqueueWriteBack } from '@/lib/syncWorker';
import { IDEA_SCORES, IDEA_STATUSES, errorResponse, isAllowed } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { id } = await params;

  try {
    const idea = await prisma.idea.findFirst({
      where: { id, note: { deletedAt: null } },
      include: { note: true },
    });

    if (!idea) {
      return NextResponse.json({ error: 'Idea not found' }, { status: 404 });
    }

    return NextResponse.json(idea);
  } catch (error) {
    console.error('Error fetching idea:', error);
    return NextResponse.json({ error: 'Failed to fetch idea' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  const { id } = await params;
  let updates;
  try {
    updates = await request.json();
  } catch (_err) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const idea = await prisma.idea.findFirst({
      where: { id, note: { deletedAt: null } },
      include: { note: true },
    });

    if (!idea) {
      return NextResponse.json({ error: 'Idea not found' }, { status: 404 });
    }

    const { status, domain, impact, effort } = updates;

    const writebackUpdates = {};
    const dbUpdates = {};

    if (status !== undefined && status !== idea.status) {
      if (!isAllowed(status, IDEA_STATUSES)) {
        return errorResponse('Invalid idea status', 400);
      }
      writebackUpdates.status = status;
      dbUpdates.status = status;
    }

    if (domain !== undefined && domain !== idea.domain) {
      writebackUpdates.domain = domain ?? null;
      dbUpdates.domain = domain;
    }

    if (impact !== undefined && impact !== idea.impact) {
      if (impact !== null && impact !== '' && !isAllowed(impact, IDEA_SCORES)) {
        return errorResponse('Invalid idea impact', 400);
      }
      writebackUpdates.impact = impact ?? null;
      dbUpdates.impact = impact;
    }

    if (effort !== undefined && effort !== idea.effort) {
      if (effort !== null && effort !== '' && !isAllowed(effort, IDEA_SCORES)) {
        return errorResponse('Invalid idea effort', 400);
      }
      writebackUpdates.effort = effort ?? null;
      dbUpdates.effort = effort;
    }

    if (Object.keys(dbUpdates).length === 0) {
      return NextResponse.json(idea);
    }

    if (Object.keys(writebackUpdates).length > 0) {
      const syncResult = await enqueueWriteBack({
        noteId: idea.note.id,
        fields: writebackUpdates,
        source: 'webapp',
      });
      if (!syncResult?.success) {
        return NextResponse.json(
          { error: syncResult?.error || 'Write-back failed', conflict: Boolean(syncResult?.conflict) },
          { status: syncResult?.conflict ? 409 : 500 },
        );
      }
    }

    const updatedIdea = await prisma.idea.update({
      where: { id: idea.id },
      data: dbUpdates,
      include: {
        note: {
          select: {
            filepath: true,
            fileModifiedAt: true,
          },
        },
      },
    });

    return NextResponse.json({
      ...updatedIdea,
      fileModifiedAt: updatedIdea.note?.fileModifiedAt ?? null,
    });
  } catch (error) {
    console.error(`Error updating idea ${id}:`, error);
    return NextResponse.json({ error: 'Failed to update idea' }, { status: 500 });
  }
}
