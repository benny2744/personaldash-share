export const dynamic = 'force-dynamic';

import React from 'react';
import prisma from '@/lib/db';
import { Card, CardContent } from '@/components/ui/card';
import MeetingsClient from '@/components/meetings/MeetingsClient';

export const metadata = {
  title: 'Meetings - WorkDash',
};

export default async function MeetingsPage() {
  const meetings = await prisma.meeting.findMany({
    where: { note: { deletedAt: null } },
    orderBy: [{ meetingDate: 'desc' }, { updatedAt: 'desc' }],
    include: {
      note: {
        select: {
          filepath: true,
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1>Meetings</h1>
        <p className="subtitle">Review meeting notes, attendees, and action items from your vault</p>
      </div>

      <Card>
        <CardContent className="p-4">
          <MeetingsClient initialMeetings={meetings} />
        </CardContent>
      </Card>
    </div>
  );
}
