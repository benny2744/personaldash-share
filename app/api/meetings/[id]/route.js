import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { enqueueWriteBack } from '@/lib/syncWorker';
import { MEETING_TYPES, errorResponse, isAllowed, parseDate } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { id } = await params;

  try {
    const meeting = await prisma.meeting.findFirst({
      where: { id, note: { deletedAt: null } },
      include: { note: true },
    });

    if (!meeting) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }

    return NextResponse.json(meeting);
  } catch (error) {
    console.error('Error fetching meeting:', error);
    return NextResponse.json({ error: 'Failed to fetch meeting' }, { status: 500 });
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
    const meeting = await prisma.meeting.findFirst({
      where: { id, note: { deletedAt: null } },
      include: { note: true },
    });

    if (!meeting) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }

    const { meetingType, meetingDate, attendees, project, area, actionItems, decisions } = updates;

    const writebackUpdates = {};
    const dbUpdates = {};

    if (meetingType !== undefined && meetingType !== meeting.meetingType) {
      if (meetingType !== null && meetingType !== '' && !isAllowed(meetingType, MEETING_TYPES)) {
        return errorResponse('Invalid meeting type', 400);
      }
      writebackUpdates.meetingType = meetingType ?? null;
      dbUpdates.meetingType = meetingType;
    }

    if (meetingDate !== undefined) {
      const parsedDate = meetingDate ? parseDate(meetingDate, 'meetingDate') : { value: null };
      if (parsedDate.error) return errorResponse(parsedDate.error, 400);
      const incomingDate = parsedDate.value ? parsedDate.value.toISOString() : null;
      const currentDate = meeting.meetingDate ? new Date(meeting.meetingDate).toISOString() : null;
      if (incomingDate !== currentDate) {
        writebackUpdates.meetingDate = meetingDate ?? null;
        dbUpdates.meetingDate = parsedDate.value;
      }
    }

    if (attendees !== undefined) {
      if (!Array.isArray(attendees)) {
        return NextResponse.json({ error: 'attendees must be an array' }, { status: 400 });
      }
      const normalizedAttendees = attendees.map((item) => String(item).trim()).filter(Boolean);
      if (JSON.stringify(normalizedAttendees) !== JSON.stringify(meeting.attendees || [])) {
        writebackUpdates.attendees = normalizedAttendees;
        dbUpdates.attendees = normalizedAttendees;
      }
    }

    if (project !== undefined && project !== meeting.project) {
      writebackUpdates.project = project ?? null;
      dbUpdates.project = project;
    }

    if (area !== undefined && area !== meeting.area) {
      writebackUpdates.area = area ?? null;
      dbUpdates.area = area;
    }

    if (actionItems !== undefined) {
      if (!Array.isArray(actionItems)) {
        return NextResponse.json({ error: 'actionItems must be an array' }, { status: 400 });
      }
      const normalizedActionItems = actionItems.map((item) => String(item).trim()).filter(Boolean);
      if (JSON.stringify(normalizedActionItems) !== JSON.stringify(meeting.actionItems || [])) {
        writebackUpdates.actionItems = normalizedActionItems;
        dbUpdates.actionItems = normalizedActionItems;
      }
    }

    if (decisions !== undefined && decisions !== meeting.decisions) {
      writebackUpdates.decisions = decisions ?? null;
      dbUpdates.decisions = decisions;
    }

    if (Object.keys(dbUpdates).length === 0) {
      return NextResponse.json(meeting);
    }

    if (Object.keys(writebackUpdates).length > 0) {
      const syncResult = await enqueueWriteBack({
        noteId: meeting.note.id,
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

    const updatedMeeting = await prisma.meeting.update({
      where: { id: meeting.id },
      data: dbUpdates,
      include: {
        note: {
          select: {
            filepath: true,
          },
        },
      },
    });

    return NextResponse.json(updatedMeeting);
  } catch (error) {
    console.error(`Error updating meeting ${id}:`, error);
    return NextResponse.json({ error: 'Failed to update meeting' }, { status: 500 });
  }
}
