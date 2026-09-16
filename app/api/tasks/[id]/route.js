import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { enqueueWriteBack } from '@/lib/syncWorker';
import { fileExists } from '@/lib/vault';
import { TASK_PRIORITIES, TASK_STATUSES, errorResponse, isAllowed, parseDate } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { id } = await params; // Database ID (cuid)

  try {
    const task = await prisma.task.findFirst({
      where: { id, note: { deletedAt: null } },
      include: { note: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error('Error fetching task:', error);
    return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  const { id } = await params;
  let updates;
  try {
    updates = await request.json();
  } catch (err) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const task = await prisma.task.findFirst({
      where: { id, note: { deletedAt: null } },
      include: { note: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!(await fileExists(task.note.filepath))) {
      await prisma.$transaction([
        prisma.task.deleteMany({ where: { id: task.id } }),
        prisma.note.update({
          where: { id: task.note.id },
          data: { deletedAt: new Date() },
        }),
      ]);
      return NextResponse.json(
        { error: 'Backing note file is missing; stale task removed', stale: true },
        { status: 410 },
      );
    }

    const { status, whenDate, priority, project, domain, people, courses } = updates;

    // Build update payload for DB and writeback
    const writebackUpdates = {};
    const dbUpdates = {};
    const events = [];

    if (status !== undefined && status !== task.status) {
      if (!isAllowed(status, TASK_STATUSES)) {
        return errorResponse('Invalid task status', 400);
      }
      writebackUpdates.status = status;
      dbUpdates.status = status;
      events.push({ eventType: 'status_change', field: 'status', oldValue: task.status || '', newValue: status });
    }

    if (whenDate !== undefined) {
      const parsedDate = whenDate ? parseDate(whenDate, 'whenDate') : { value: null };
      if (parsedDate.error) return errorResponse(parsedDate.error, 400);
      const incomingDate = parsedDate.value ? parsedDate.value.toISOString() : null;
      const currentDate = task.whenDate ? new Date(task.whenDate).toISOString() : null;
      if (incomingDate !== currentDate) {
        writebackUpdates.when = whenDate;
        dbUpdates.whenDate = parsedDate.value;
        events.push({ eventType: 'date_change', field: 'when_date', oldValue: task.whenDate ? task.whenDate.toISOString() : '', newValue: whenDate });
      }
    }

    if (priority !== undefined && priority !== task.priority) {
      if (!isAllowed(priority, TASK_PRIORITIES)) {
        return errorResponse('Invalid task priority', 400);
      }
      writebackUpdates.priority = priority;
      dbUpdates.priority = priority;
      events.push({ eventType: 'priority_change', field: 'priority', oldValue: task.priority || '', newValue: priority });
    }

    if (project !== undefined && project !== task.project) {
      writebackUpdates.project = project ?? null;
      dbUpdates.project = project;
      events.push({ eventType: 'project_change', field: 'project', oldValue: task.project || '', newValue: project });
    }

    if (domain !== undefined && domain !== task.domain) {
      writebackUpdates.domain = domain ?? null;
      dbUpdates.domain = domain;
      events.push({ eventType: 'domain_change', field: 'domain', oldValue: task.domain || '', newValue: domain });
    }

    if (people !== undefined) {
      if (!Array.isArray(people)) {
        return NextResponse.json({ error: 'people must be an array' }, { status: 400 });
      }
      const normalizedPeople = people.map((item) => String(item).trim()).filter(Boolean);
      if (JSON.stringify(normalizedPeople) !== JSON.stringify(task.people || [])) {
        writebackUpdates.people = normalizedPeople;
        dbUpdates.people = normalizedPeople;
        events.push({
          eventType: 'people_change',
          field: 'people',
          oldValue: JSON.stringify(task.people || []),
          newValue: JSON.stringify(normalizedPeople),
        });
      }
    }

    if (courses !== undefined) {
      if (!Array.isArray(courses)) {
        return NextResponse.json({ error: 'courses must be an array' }, { status: 400 });
      }
      const normalizedCourses = courses.map((item) => String(item).trim()).filter(Boolean);
      if (JSON.stringify(normalizedCourses) !== JSON.stringify(task.courses || [])) {
        writebackUpdates.courses = normalizedCourses;
        dbUpdates.courses = normalizedCourses;
        events.push({
          eventType: 'courses_change',
          field: 'courses',
          oldValue: JSON.stringify(task.courses || []),
          newValue: JSON.stringify(normalizedCourses),
        });
      }
    }

    if (Object.keys(dbUpdates).length === 0) {
      // Nothing changed
      return NextResponse.json(task);
    }

    if (Object.keys(writebackUpdates).length > 0) {
      const syncResult = await enqueueWriteBack({
        noteId: task.note.id,
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

    const [updatedTask] = await prisma.$transaction([
      prisma.task.update({
        where: { id: task.id },
        data: dbUpdates,
        include: {
          note: {
            select: {
              filepath: true,
              fileModifiedAt: true,
            },
          },
        },
      }),
      ...(events.length > 0
        ? [
            prisma.taskEvent.createMany({
              data: events.map((e) => ({
                taskId: task.id,
                eventType: e.eventType,
                field: e.field,
                oldValue: e.oldValue,
                newValue: e.newValue,
                source: 'webapp',
              })),
            }),
          ]
        : []),
    ]);

    return NextResponse.json({
      ...updatedTask,
      fileModifiedAt: updatedTask.note?.fileModifiedAt ?? null,
    });
  } catch (error) {
    console.error(`Error updating task ${id}:`, error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}
