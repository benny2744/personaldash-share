'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { toDateStr } from '@/lib/dates';

export default function MonthGrid({
  year,
  month,
  tasks,
  meetings,
  externalEvents,
  showExternal,
  selectedDay,
  onSelectDay,
  onDropTask,
  onDragOver,
  onDragStart,
  onOpenTask,
  onOpenMeeting,
  onOpenExternal,
}) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const monthDays = [];
  for (let i = 0; i < firstDay; i++) monthDays.push(null);
  for (let i = 1; i <= daysInMonth; i++) monthDays.push(i);

  const priorityVariant = (priority) =>
    `priority-${(priority || 'medium').toLowerCase()}`;
  const todayKey = toDateStr(new Date());
  const selectedKey = toDateStr(selectedDay);

  return (
    <div className="overflow-x-auto" data-scroll-region>
      <div className="grid min-w-[840px] grid-cols-7 gap-px overflow-hidden rounded-xl bg-[var(--surface-container-high)]">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => (
          <div
            key={label}
            className="bg-[var(--surface-container-low)] p-2 text-center text-xs font-semibold text-[var(--text-secondary)]"
          >
            {label}
          </div>
        ))}
        {monthDays.map((day, index) => {
          if (!day) {
            return (
              <div
                key={`empty-${index}`}
                className="min-h-[140px] bg-[var(--surface-container-low)]"
              />
            );
          }
          const date = new Date(year, month, day, 12, 0, 0, 0);
          const dateStr = toDateStr(date);
          const dayTasks = tasks.filter(
            (task) => task.whenDate && toDateStr(task.whenDate) === dateStr,
          );
          const dayMeetings = meetings.filter(
            (meeting) =>
              meeting.meetingDate && toDateStr(meeting.meetingDate) === dateStr,
          );
          const dayExternal = showExternal
            ? externalEvents.filter(
                (event) => toDateStr(event.startAt) === dateStr,
              )
            : [];
          const isToday = todayKey === dateStr;
          const isSelected = selectedKey === dateStr;

          return (
            <div
              key={dateStr}
              className={`min-h-[140px] cursor-pointer rounded-sm bg-[var(--surface-card)] p-2 transition ${
                isSelected
                  ? 'ring-2 ring-[var(--accent)]'
                  : isToday
                    ? 'ring-1 ring-[var(--accent)]'
                    : ''
              }`}
              onDrop={(event) => onDropTask(event, dateStr)}
              onDragOver={onDragOver}
              onClick={() => onSelectDay(date)}
            >
              <div className="mb-2 text-right text-xs text-[var(--text-secondary)]">
                {day}
              </div>
              <div className="space-y-1">
                {dayTasks.slice(0, 2).map((task) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={(e) => onDragStart(e, task.id)}
                  >
                    <button
                      type="button"
                      className="w-full"
                      onClick={(e) => onOpenTask(e, task)}
                    >
                      <Badge
                        variant={priorityVariant(task.priority)}
                        className="block max-w-full cursor-grab truncate text-left"
                      >
                        {task.title}
                      </Badge>
                    </button>
                  </div>
                ))}
                {dayMeetings.slice(0, 1).map((meeting) => (
                  <button
                    key={meeting.id}
                    type="button"
                    className="w-full"
                    onClick={(e) => onOpenMeeting(e, meeting)}
                  >
                    <Badge
                      variant="outline"
                      className="block max-w-full truncate text-left"
                    >
                      {meeting.title}
                    </Badge>
                  </button>
                ))}
                {dayExternal.slice(0, 2).map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className="w-full"
                    onClick={(e) => onOpenExternal(e, event)}
                  >
                    <Badge
                      variant="default"
                      className="block max-w-full truncate text-left bg-[color:color-mix(in_srgb,#38bdf8_22%,transparent)] text-[color:#075985]"
                    >
                      {event.summary}
                    </Badge>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
