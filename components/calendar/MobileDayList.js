'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { toDateStr } from '@/lib/dates';

export default function MobileDayList({
  days,
  tasks,
  meetings,
  externalEvents,
  showExternal,
  emptyLabel = 'No events in this range.',
  onOpenTask,
  onOpenMeeting,
  onOpenExternal,
  onSelectDay,
}) {
  const todayKey = toDateStr(new Date());
  const priorityVariant = (priority) =>
    `priority-${(priority || 'medium').toLowerCase()}`;

  const rows = days
    .map((date) => {
      const dateStr = toDateStr(date);
      const dayTasks = tasks.filter(
        (task) => task.whenDate && toDateStr(task.whenDate) === dateStr,
      );
      const dayMeetings = meetings.filter(
        (meeting) =>
          meeting.meetingDate && toDateStr(meeting.meetingDate) === dateStr,
      );
      const dayExternal = showExternal
        ? externalEvents.filter((event) => toDateStr(event.startAt) === dateStr)
        : [];
      return {
        date,
        dateStr,
        dayTasks,
        dayMeetings,
        dayExternal,
        isToday: dateStr === todayKey,
      };
    })
    .filter(
      (row) =>
        row.dayTasks.length > 0 ||
        row.dayMeetings.length > 0 ||
        row.dayExternal.length > 0,
    );

  if (rows.length === 0) {
    return (
      <p className="py-4 text-sm text-[var(--text-secondary)]">{emptyLabel}</p>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map(
        ({ date, dateStr, dayTasks, dayMeetings, dayExternal, isToday }) => (
          <div
            key={dateStr}
            className={`rounded-xl border p-3 ${
              isToday
                ? 'border-[var(--accent)] bg-[var(--surface-container-low)]'
                : 'border-[var(--border)] bg-[var(--surface-card)]'
            }`}
            onClick={() => onSelectDay?.(date)}
          >
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`text-sm font-semibold ${
                  isToday
                    ? 'text-[var(--accent)]'
                    : 'text-[var(--text-secondary)]'
                }`}
              >
                {date.toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
              {isToday && (
                <Badge variant="secondary" className="text-[10px]">
                  Today
                </Badge>
              )}
            </div>
            <div className="space-y-1.5">
              {dayTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="w-full text-left"
                  onClick={(event) => onOpenTask(event, task)}
                >
                  <Badge
                    variant={priorityVariant(task.priority)}
                    className="line-clamp-2 max-w-full break-words text-left"
                  >
                    {task.title}
                  </Badge>
                </button>
              ))}
              {dayMeetings.map((meeting) => (
                <button
                  key={meeting.id}
                  type="button"
                  className="w-full text-left"
                  onClick={(event) => onOpenMeeting(event, meeting)}
                >
                  <Badge
                    variant="outline"
                    className="line-clamp-2 max-w-full break-words text-left"
                  >
                    {meeting.title}
                  </Badge>
                </button>
              ))}
              {dayExternal.map((event) => (
                <button
                  key={event.id}
                  type="button"
                  className="w-full text-left"
                  onClick={(e) => onOpenExternal(e, event)}
                >
                  <Badge
                    variant="default"
                    className="line-clamp-2 max-w-full break-words text-left bg-[color:color-mix(in_srgb,#38bdf8_22%,transparent)] text-[color:#075985]"
                  >
                    {event.allDay
                      ? event.summary
                      : `${new Date(event.startAt).toLocaleTimeString(
                          undefined,
                          {
                            hour: 'numeric',
                            minute: '2-digit',
                          },
                        )} · ${event.summary}`}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
