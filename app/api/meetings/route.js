import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { errorResponse, parseDate } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  const type = searchParams.get('type');
  const attendee = searchParams.get('attendee');
  const dateFrom = searchParams.get('dateFrom');
  const dateTo = searchParams.get('dateTo');

  const where = { note: { deletedAt: null } };

  if (type) {
    where.meetingType = type;
  }
  if (attendee) {
    where.attendees = { has: attendee };
  }
  if (dateFrom || dateTo) {
    where.meetingDate = {};
    if (dateFrom) {
      const parsed = parseDate(dateFrom, 'dateFrom');
      if (parsed.error) return errorResponse(parsed.error, 400);
      where.meetingDate.gte = parsed.value;
    }
    if (dateTo) {
      const parsed = parseDate(dateTo, 'dateTo');
      if (parsed.error) return errorResponse(parsed.error, 400);
      where.meetingDate.lte = parsed.value;
    }
  }

  try {
    const meetings = await prisma.meeting.findMany({
      where,
      orderBy: [{ meetingDate: 'desc' }, { updatedAt: 'desc' }],
      include: {
        note: {
          select: {
            filepath: true,
          },
        },
      },
    });

    return NextResponse.json(meetings);
  } catch (error) {
    console.error('Error fetching meetings:', error);
    return NextResponse.json({ error: 'Failed to fetch meetings' }, { status: 500 });
  }
}
