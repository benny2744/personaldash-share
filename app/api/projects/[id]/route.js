import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { enqueueWriteBack } from '@/lib/syncWorker';
import { fileExists, readNote } from '@/lib/vault';
import { PROJECT_STATUSES, errorResponse, isAllowed, parseDate } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { id } = await params;

  try {
    const project = await prisma.project.findFirst({
      where: { id, note: { deletedAt: null } },
      include: { note: { select: { filepath: true } } },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    let content = null;
    if (project.note?.filepath && (await fileExists(project.note.filepath))) {
      content = await readNote(project.note.filepath);
    }

    return NextResponse.json({ ...project, content });
  } catch (error) {
    console.error(`Error fetching project ${id}:`, error);
    return NextResponse.json({ error: 'Failed to fetch project' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  const { id } = await params;
  let updates;
  try {
    updates = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const project = await prisma.project.findFirst({
      where: { id, note: { deletedAt: null } },
      include: { note: true },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    if (!(await fileExists(project.note.filepath))) {
      await prisma.$transaction([
        prisma.project.deleteMany({ where: { id: project.id } }),
        prisma.note.update({
          where: { id: project.note.id },
          data: { deletedAt: new Date() },
        }),
      ]);
      return NextResponse.json(
        { error: 'Backing note file is missing; stale project removed', stale: true },
        { status: 410 },
      );
    }

    const { status, targetDate, area, domain, people } = updates;

    const writebackUpdates = {};
    const dbUpdates = {};

    if (status !== undefined && status !== project.status) {
      if (!isAllowed(status, PROJECT_STATUSES)) {
        return errorResponse('Invalid project status', 400);
      }
      writebackUpdates.status = status;
      dbUpdates.status = status;
    }

    if (targetDate !== undefined) {
      const parsedDate = targetDate ? parseDate(targetDate, 'targetDate') : { value: null };
      if (parsedDate.error) return errorResponse(parsedDate.error, 400);
      const incomingDate = parsedDate.value ? parsedDate.value.toISOString() : null;
      const currentDate = project.targetDate ? new Date(project.targetDate).toISOString() : null;
      if (incomingDate !== currentDate) {
        writebackUpdates.targetDate = targetDate;
        dbUpdates.targetDate = parsedDate.value;
      }
    }

    if (area !== undefined && area !== (project.area ?? null)) {
      writebackUpdates.area = area ?? null;
      dbUpdates.area = area;
    }

    if (domain !== undefined && domain !== (project.domain ?? null)) {
      writebackUpdates.domain = domain ?? null;
      dbUpdates.domain = domain;
    }

    if (people !== undefined) {
      if (!Array.isArray(people)) {
        return NextResponse.json({ error: 'people must be an array' }, { status: 400 });
      }
      const normalizedPeople = people.map((item) => String(item).trim()).filter(Boolean);
      if (JSON.stringify(normalizedPeople) !== JSON.stringify(project.people || [])) {
        writebackUpdates.people = normalizedPeople;
        dbUpdates.people = normalizedPeople;
      }
    }

    if (Object.keys(dbUpdates).length === 0) {
      return NextResponse.json(project);
    }

    if (Object.keys(writebackUpdates).length > 0) {
      const syncResult = await enqueueWriteBack({
        noteId: project.note.id,
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

    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: dbUpdates,
      include: {
        note: {
          select: {
            filepath: true,
          },
        },
      },
    });

    return NextResponse.json(updatedProject);
  } catch (error) {
    console.error(`Error updating project ${id}:`, error);
    return NextResponse.json({ error: 'Failed to update project' }, { status: 500 });
  }
}
