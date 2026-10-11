import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { enqueueWriteBack } from '@/lib/syncWorker';
import { fileExists } from '@/lib/vault';
import {
  IDEA_SCORES,
  IDEA_STATUSES,
  TASK_CONTEXTS,
  errorResponse,
  isAllowed,
  parseDate,
} from '@/lib/api';

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

/**
 * Validate an enum-backed nullable score (Impact/Confidence/Effort) and build
 * write-back + DB updates when it changed.
 */
function applyScoreField({
  incoming,
  current,
  field,
  label,
  writebackUpdates,
  dbUpdates,
}) {
  if (incoming === undefined || incoming === current) return null;
  if (
    incoming !== null &&
    incoming !== '' &&
    !isAllowed(incoming, IDEA_SCORES)
  ) {
    return errorResponse(`Invalid idea ${label}`, 400);
  }
  const normalized = incoming || null;
  writebackUpdates[field] = normalized;
  dbUpdates[field] = normalized;
  return null;
}

/**
 * Validate a date field (Created/Reviewed) sent as YYYY-MM-DD (or null to
 * clear) and build write-back + DB updates when it changed.
 */
function applyDateField({
  incoming,
  current,
  field,
  label,
  writebackUpdates,
  dbUpdates,
}) {
  if (incoming === undefined) return null;
  let incomingDate = null;
  if (incoming) {
    const parsed = parseDate(incoming, label);
    if (parsed.error) return errorResponse(parsed.error, 400);
    incomingDate = parsed.value;
  }
  const currentDate = current ? new Date(current) : null;
  const sameDay =
    incomingDate && currentDate
      ? incomingDate.toISOString().slice(0, 10) ===
        currentDate.toISOString().slice(0, 10)
      : !incomingDate && !currentDate;
  if (sameDay) return null;
  writebackUpdates[field] = incoming || null;
  dbUpdates[field] = incomingDate;
  return null;
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

    if (!(await fileExists(idea.note.filepath))) {
      await prisma.$transaction([
        prisma.idea.deleteMany({ where: { id: idea.id } }),
        prisma.note.update({
          where: { id: idea.note.id },
          data: { deletedAt: new Date() },
        }),
      ]);
      return NextResponse.json(
        {
          error: 'Backing note file is missing; stale idea removed',
          stale: true,
        },
        { status: 410 },
      );
    }

    const {
      status,
      domain,
      context,
      impact,
      confidence,
      effort,
      project,
      ideaCreated,
      reviewedAt,
      notesSummary,
      tags,
    } = updates;

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

    if (context !== undefined && (context || null) !== (idea.context || null)) {
      if (
        context !== null &&
        context !== '' &&
        !isAllowed(context, TASK_CONTEXTS)
      ) {
        return errorResponse('Invalid idea context', 400);
      }
      const normalizedContext = context || null;
      writebackUpdates.context = normalizedContext;
      dbUpdates.context = normalizedContext;
    }

    let validationError = applyScoreField({
      incoming: impact,
      current: idea.impact,
      field: 'impact',
      label: 'impact',
      writebackUpdates,
      dbUpdates,
    });
    if (!validationError) {
      validationError = applyScoreField({
        incoming: confidence,
        current: idea.confidence,
        field: 'confidence',
        label: 'confidence',
        writebackUpdates,
        dbUpdates,
      });
    }
    if (!validationError) {
      validationError = applyScoreField({
        incoming: effort,
        current: idea.effort,
        field: 'effort',
        label: 'effort',
        writebackUpdates,
        dbUpdates,
      });
    }
    if (validationError) return validationError;

    if (project !== undefined && (project || null) !== (idea.project || null)) {
      writebackUpdates.project = project || null;
      dbUpdates.project = project || null;
    }

    validationError = applyDateField({
      incoming: ideaCreated,
      current: idea.ideaCreated,
      field: 'ideaCreated',
      label: 'ideaCreated',
      writebackUpdates,
      dbUpdates,
    });
    if (!validationError) {
      validationError = applyDateField({
        incoming: reviewedAt,
        current: idea.reviewedAt,
        field: 'reviewedAt',
        label: 'reviewedAt',
        writebackUpdates,
        dbUpdates,
      });
    }
    if (validationError) return validationError;

    if (
      notesSummary !== undefined &&
      (notesSummary || null) !== (idea.notesSummary || null)
    ) {
      writebackUpdates.notesSummary = notesSummary || null;
      dbUpdates.notesSummary = notesSummary || null;
    }

    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        return errorResponse('tags must be an array', 400);
      }
      const normalizedTags = [
        ...new Set(tags.map((item) => String(item).trim()).filter(Boolean)),
      ];
      if (!normalizedTags.includes('type/idea')) {
        normalizedTags.unshift('type/idea');
      }
      if (JSON.stringify(normalizedTags) !== JSON.stringify(idea.tags || [])) {
        writebackUpdates.tags = normalizedTags;
        dbUpdates.tags = normalizedTags;
      }
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
