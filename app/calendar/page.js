export const dynamic = 'force-dynamic';

import React from 'react';
import prisma from '@/lib/db';
import { Card, CardContent } from '@/components/ui/card';
import CalendarClient from './CalendarClient';
import { listExpandedEvents } from '@/lib/caldav/events';
import { getCaldavSyncStatus } from '@/lib/caldav/sync';
import { visibleRangeForView, toDateStr } from '@/lib/dates';
import { isCaldavConfigured } from '@/lib/config';

export const metadata = {
  title: 'Calendar - WorkDash',
};

export default async function CalendarPage() {
  const today = new Date();
  const initialRange = visibleRangeForView('month', today);

  const [tasks, meetings, syncStatus] = await Promise.all([
    prisma.task.findMany({
      where: { note: { deletedAt: null } },
      orderBy: [{ whenDate: 'asc' }, { updatedAt: 'desc' }],
      include: {
        note: {
          select: {
            filepath: true,
          },
        },
      },
    }),
    prisma.meeting.findMany({
      where: { note: { deletedAt: null } },
      orderBy: [{ meetingDate: 'asc' }, { updatedAt: 'desc' }],
      include: {
        note: {
          select: {
            filepath: true,
          },
        },
      },
    }),
    getCaldavSyncStatus().catch(() => ({
      configured: isCaldavConfigured(),
      enabled: false,
      lastSyncAt: null,
      lastSyncError: null,
      lastStatus: 'idle',
      sourceCount: 0,
      objectCount: 0,
      syncing: false,
    })),
  ]);

  let initialExternalEvents = [];
  try {
    const feed = await listExpandedEvents(initialRange.from, initialRange.to);
    initialExternalEvents = feed.events;
  } catch (error) {
    console.error('[calendar] Failed to load initial CalDAV events:', error);
  }

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1>Calendar</h1>
        <p className="subtitle">
          Tasks, meetings, and read-only DingTalk events
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <CalendarClient
            initialTasks={tasks}
            initialMeetings={meetings}
            initialExternalEvents={initialExternalEvents}
            initialSyncStatus={syncStatus}
            initialRange={initialRange}
            initialDateKey={toDateStr(today)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
