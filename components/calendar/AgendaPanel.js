'use client';

import React from 'react';
import { PanelLeftOpen, PanelRightClose } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { PriorityIcon, priorityLabel } from '@/components/ui/priority-icon';
import CollapseRail from '@/components/layout/CollapseRail';
import { toDateStr } from '@/lib/dates';

function formatEventTime(event) {
  if (event.allDay) return 'All day';
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  const opts = { hour: 'numeric', minute: '2-digit' };
  return `${start.toLocaleTimeString(undefined, opts)} – ${end.toLocaleTimeString(undefined, opts)}`;
}

export default function AgendaPanel({
  open,
  onToggle,
  selectedDay,
  selectedTasks,
  selectedMeetings,
  selectedExternal,
  upcomingTasks,
  upcomingMeetings,
  upcomingExternal,
  onOpenTask,
  onOpenMeeting,
  onOpenExternal,
}) {
  if (!open) {
    return (
      <div className="hidden lg:block lg:sticky lg:top-20">
        <CollapseRail
          label="Agenda"
          icon={PanelLeftOpen}
          side="right"
          onExpand={() => onToggle(true)}
        />
      </div>
    );
  }

  const priorityVariant = (priority) => `priority-${(priority || 'medium').toLowerCase()}`;

  return (
    <div className="hidden lg:block lg:sticky lg:top-20">
      <Card className="h-fit">
        <CardContent className="p-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="mb-1 text-base font-semibold">Agenda</h3>
              <p className="text-sm text-[var(--text-secondary)]">
                {selectedDay.toLocaleDateString()}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onToggle(false)}
              aria-label="Collapse agenda panel"
              title="Collapse agenda panel"
              className="h-8 w-8"
            >
              <PanelRightClose size={16} />
            </Button>
          </div>

          <div className="space-y-2">
            {selectedTasks.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">No tasks on this day.</p>
            ) : (
              selectedTasks.map((task) => (
                <div key={task.id} className="rounded-md bg-[var(--surface-container-low)] p-2">
                  <button
                    type="button"
                    onClick={(event) => onOpenTask(event, task)}
                    className="text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--accent)]"
                  >
                    {task.title}
                  </button>
                  <div className="mt-1">
                    <Badge variant={priorityVariant(task.priority)}>
                      <PriorityIcon priority={task.priority} size={12} />
                      {priorityLabel(task.priority)}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="mt-4 space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              Meetings
            </h4>
            {selectedMeetings.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">No meetings on this day.</p>
            ) : (
              selectedMeetings.map((meeting) => (
                <div key={meeting.id} className="rounded-md bg-[var(--surface-container-low)] p-2">
                  <button
                    type="button"
                    onClick={(event) => onOpenMeeting(event, meeting)}
                    className="text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--accent)]"
                  >
                    {meeting.title}
                  </button>
                  <div className="mt-1 flex gap-1">
                    {meeting.meetingType && (
                      <Badge variant="secondary">{meeting.meetingType}</Badge>
                    )}
                    <Badge variant="outline">{(meeting.attendees || []).length} attendees</Badge>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="mt-4 space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              DingTalk
            </h4>
            {selectedExternal.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">No DingTalk events.</p>
            ) : (
              selectedExternal.map((event) => (
                <div key={event.id} className="rounded-md bg-[var(--surface-container-low)] p-2">
                  <button
                    type="button"
                    onClick={(e) => onOpenExternal(e, event)}
                    className="text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--accent)]"
                  >
                    {event.summary}
                  </button>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-[var(--text-secondary)]">
                    <span>{formatEventTime(event)}</span>
                    {event.organizer?.name || event.organizer?.email ? (
                      <Badge variant="outline" className="text-[10px]">
                        {event.organizer.name || event.organizer.email}
                      </Badge>
                    ) : null}
                    {(event.attendees || []).length > 0 ? (
                      <Badge variant="outline" className="text-[10px]">
                        {(event.attendees || []).length} attendees
                      </Badge>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="mt-5 rounded-lg bg-[var(--surface-container-low)] p-3">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              Next 7 upcoming
            </h4>
            <div className="space-y-2">
              {upcomingTasks.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">No upcoming scheduled tasks.</p>
              ) : (
                upcomingTasks.map((task) => (
                  <div
                    key={task.id}
                    className="rounded-md bg-[var(--surface-container-lowest)] p-2 shadow-[var(--shadow-sm)]"
                  >
                    <div className="text-xs text-[var(--text-secondary)]">
                      {task.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </div>
                    <button
                      type="button"
                      onClick={(event) => onOpenTask(event, task)}
                      className="text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--accent)]"
                    >
                      {task.title}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-5 rounded-lg bg-[var(--surface-container-low)] p-3">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              Upcoming meetings
            </h4>
            <div className="space-y-2">
              {upcomingMeetings.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">No upcoming meetings.</p>
              ) : (
                upcomingMeetings.map((meeting) => (
                  <div
                    key={meeting.id}
                    className="rounded-md bg-[var(--surface-container-lowest)] p-2 shadow-[var(--shadow-sm)]"
                  >
                    <div className="text-xs text-[var(--text-secondary)]">
                      {meeting.date.toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={(event) => onOpenMeeting(event, meeting)}
                      className="text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--accent)]"
                    >
                      {meeting.title}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {upcomingExternal.length > 0 ? (
            <div className="mt-5 rounded-lg bg-[var(--surface-container-low)] p-3">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                Upcoming DingTalk
              </h4>
              <div className="space-y-2">
                {upcomingExternal.map((event) => (
                  <div
                    key={event.id}
                    className="rounded-md bg-[var(--surface-container-lowest)] p-2 shadow-[var(--shadow-sm)]"
                  >
                    <div className="text-xs text-[var(--text-secondary)]">
                      {toDateStr(event.startAt)} · {formatEventTime(event)}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => onOpenExternal(e, event)}
                      className="text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--accent)]"
                    >
                      {event.summary}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
