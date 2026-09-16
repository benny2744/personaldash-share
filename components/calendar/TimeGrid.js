'use client';

import React, { useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  toDateStr,
  minutesSinceMidnight,
  startOfDay,
  addDays,
} from '@/lib/dates';
import { layoutOverlappingEvents } from '@/lib/calendarLayout';
import { cn } from '@/lib/utils';

const HOUR_HEIGHT = 56;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const GRID_HEIGHT = HOUR_HEIGHT * 24;

function formatHour(hour) {
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
}

function formatTimeLabel(iso) {
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function eventsForDay(dateStr, tasks, meetings, externalEvents, showExternal) {
  const dayTasks = tasks
    .filter((task) => task.whenDate && toDateStr(task.whenDate) === dateStr)
    .map((task) => ({
      kind: 'task',
      id: `task:${task.id}`,
      title: task.title,
      allDay: true,
      startAt: `${dateStr}T00:00:00`,
      endAt: `${dateStr}T23:59:59`,
      data: task,
    }));

  const dayMeetings = meetings
    .filter(
      (meeting) =>
        meeting.meetingDate && toDateStr(meeting.meetingDate) === dateStr,
    )
    .map((meeting) => ({
      kind: 'meeting',
      id: `meeting:${meeting.id}`,
      title: meeting.title,
      allDay: true,
      startAt: `${dateStr}T00:00:00`,
      endAt: `${dateStr}T23:59:59`,
      data: meeting,
    }));

  const dayExternal = (showExternal ? externalEvents : [])
    .filter((event) => {
      const startKey = toDateStr(event.startAt);
      const endKey = toDateStr(new Date(new Date(event.endAt).getTime() - 1));
      return startKey <= dateStr && endKey >= dateStr;
    })
    .map((event) => ({
      kind: 'external',
      id: event.id,
      title: event.summary,
      allDay: Boolean(event.allDay),
      startAt: event.startAt,
      endAt: event.endAt,
      data: event,
    }));

  return [...dayTasks, ...dayMeetings, ...dayExternal];
}

function DayColumn({
  date,
  tasks,
  meetings,
  externalEvents,
  showExternal,
  isSelected,
  onSelectDay,
  onDropTask,
  onDragOver,
  onOpenTask,
  onOpenMeeting,
  onOpenExternal,
  showNowLine,
}) {
  const dateStr = toDateStr(date);
  const items = eventsForDay(
    dateStr,
    tasks,
    meetings,
    externalEvents,
    showExternal,
  );
  const allDay = items.filter((item) => item.allDay);
  const timed = items.filter((item) => !item.allDay);
  const laidOut = layoutOverlappingEvents(timed);
  const dayStart = startOfDay(date).getTime();
  const dayEnd = addDays(startOfDay(date), 1).getTime();

  const nowTop = useMemo(() => {
    if (!showNowLine) return null;
    return (minutesSinceMidnight(new Date()) / 60) * HOUR_HEIGHT;
  }, [showNowLine]);

  const priorityVariant = (priority) =>
    `priority-${(priority || 'medium').toLowerCase()}`;

  return (
    <div
      className={cn(
        'min-w-0 flex-1 border-l border-[var(--border)] first:border-l-0',
        isSelected &&
          'bg-[color:color-mix(in_srgb,var(--accent)_6%,transparent)]',
      )}
      onClick={() => onSelectDay(date)}
      onDrop={(event) => onDropTask(event, dateStr)}
      onDragOver={onDragOver}
    >
      <div className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface-card)] px-2 py-2 text-center text-xs font-semibold text-[var(--text-secondary)]">
        {date.toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        })}
      </div>

      <div className="min-h-[3.5rem] space-y-1 border-b border-[var(--border)] p-1.5">
        {allDay.length === 0 ? (
          <p className="px-1 text-[10px] text-[var(--text-secondary)]">
            No all-day
          </p>
        ) : (
          allDay.map((item) => {
            if (item.kind === 'task') {
              return (
                <button
                  key={item.id}
                  type="button"
                  className="w-full"
                  onClick={(e) => onOpenTask(e, item.data)}
                >
                  <Badge
                    variant={priorityVariant(item.data.priority)}
                    className="block max-w-full truncate text-left text-[10px]"
                  >
                    {item.title}
                  </Badge>
                </button>
              );
            }
            if (item.kind === 'meeting') {
              return (
                <button
                  key={item.id}
                  type="button"
                  className="w-full"
                  onClick={(e) => onOpenMeeting(e, item.data)}
                >
                  <Badge
                    variant="outline"
                    className="block max-w-full truncate text-left text-[10px]"
                  >
                    {item.title}
                  </Badge>
                </button>
              );
            }
            return (
              <button
                key={item.id}
                type="button"
                className="w-full"
                onClick={(e) => onOpenExternal(e, item.data)}
              >
                <Badge
                  variant="default"
                  className="block max-w-full truncate text-left text-[10px] bg-[color:color-mix(in_srgb,#38bdf8_22%,transparent)] text-[color:#075985]"
                >
                  {item.title}
                </Badge>
              </button>
            );
          })
        )}
      </div>

      <div className="relative" style={{ height: GRID_HEIGHT }}>
        {HOURS.map((hour) => (
          <div
            key={hour}
            className="absolute left-0 right-0 border-t border-[color:color-mix(in_srgb,var(--outline)_12%,transparent)]"
            style={{ top: hour * HOUR_HEIGHT, height: HOUR_HEIGHT }}
          />
        ))}

        {nowTop != null ? (
          <div
            className="pointer-events-none absolute left-0 right-0 z-20 border-t-2 border-[var(--error)]"
            style={{ top: nowTop }}
          >
            <span className="absolute -left-1 -top-1.5 h-3 w-3 rounded-full bg-[var(--error)]" />
          </div>
        ) : null}

        {laidOut.map(({ event: item, column, columnCount }) => {
          const startMs = Math.max(new Date(item.startAt).getTime(), dayStart);
          const endMs = Math.min(new Date(item.endAt).getTime(), dayEnd);
          const top = ((startMs - dayStart) / (60 * 60 * 1000)) * HOUR_HEIGHT;
          const height = Math.max(
            ((endMs - startMs) / (60 * 60 * 1000)) * HOUR_HEIGHT,
            22,
          );
          const widthPct = 100 / columnCount;
          const leftPct = column * widthPct;

          return (
            <button
              key={item.id}
              type="button"
              className="absolute z-10 overflow-hidden rounded-md border border-[color:color-mix(in_srgb,#0ea5e9_35%,transparent)] bg-[color:color-mix(in_srgb,#38bdf8_28%,var(--surface-card))] px-1.5 py-1 text-left shadow-sm transition hover:brightness-95"
              style={{
                top,
                height,
                left: `calc(${leftPct}% + 2px)`,
                width: `calc(${widthPct}% - 4px)`,
              }}
              onClick={(e) => onOpenExternal(e, item.data)}
              title={`${item.title} · ${formatTimeLabel(item.startAt)}`}
            >
              <div className="truncate text-[11px] font-semibold text-[color:#0c4a6e]">
                {item.title}
              </div>
              <div className="truncate text-[10px] text-[color:#075985]">
                {formatTimeLabel(item.startAt)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function TimeGrid({
  days,
  tasks,
  meetings,
  externalEvents,
  showExternal,
  selectedDay,
  onSelectDay,
  onDropTask,
  onDragOver,
  onOpenTask,
  onOpenMeeting,
  onOpenExternal,
}) {
  const scrollRef = useRef(null);
  const todayKey = toDateStr(new Date());
  const selectedKey = toDateStr(selectedDay);
  const firstDayKey = days?.[0] ? toDateStr(days[0]) : '';

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    // Auto-scroll toward working hours (~8 AM).
    node.scrollTop = HOUR_HEIGHT * 8 - 16;
  }, [firstDayKey]);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-card)]">
      <div ref={scrollRef} className="max-h-[70vh] overflow-auto">
        <div className="flex min-w-[720px]">
          <div className="sticky left-0 z-30 w-16 shrink-0 border-r border-[var(--border)] bg-[var(--surface-card)]">
            <div className="sticky top-0 z-10 h-[2.5rem] border-b border-[var(--border)]" />
            <div className="flex h-[3.5rem] items-end border-b border-[var(--border)] px-1 pb-1 text-[10px] text-[var(--text-secondary)]">
              All day
            </div>
            <div className="relative" style={{ height: GRID_HEIGHT }}>
              {HOURS.map((hour) => (
                <div
                  key={hour}
                  className="absolute right-1 -translate-y-1/2 text-[10px] text-[var(--text-secondary)]"
                  style={{ top: hour * HOUR_HEIGHT }}
                >
                  {formatHour(hour)}
                </div>
              ))}
            </div>
          </div>

          {days.map((date) => (
            <DayColumn
              key={toDateStr(date)}
              date={date}
              tasks={tasks}
              meetings={meetings}
              externalEvents={externalEvents}
              showExternal={showExternal}
              isSelected={selectedKey === toDateStr(date)}
              showNowLine={todayKey === toDateStr(date)}
              onSelectDay={onSelectDay}
              onDropTask={onDropTask}
              onDragOver={onDragOver}
              onOpenTask={onOpenTask}
              onOpenMeeting={onOpenMeeting}
              onOpenExternal={onOpenExternal}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
