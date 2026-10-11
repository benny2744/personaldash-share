'use client';

import React from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

function formatRange(event) {
  if (event.allDay) {
    const start = new Date(event.startAt).toLocaleDateString();
    const endDate = new Date(new Date(event.endAt).getTime() - 1);
    const end = endDate.toLocaleDateString();
    return start === end ? `${start} · All day` : `${start} → ${end} · All day`;
  }
  const opts = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  return `${new Date(event.startAt).toLocaleString(undefined, opts)} – ${new Date(event.endAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function personLabel(person) {
  if (!person) return '';
  return person.name || person.email || 'Unknown';
}

function statusLabel(status) {
  if (!status) return null;
  const map = {
    ACCEPTED: 'Accepted',
    DECLINED: 'Declined',
    TENTATIVE: 'Tentative',
    'NEEDS-ACTION': 'Pending',
  };
  return map[status] || status;
}

export default function ExternalEventDrawer({ event, onClose }) {
  if (!event) return null;

  const attendees = Array.isArray(event.attendees) ? event.attendees : [];
  const organizer = event.organizer || null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <Card
        className="h-full w-full max-w-md rounded-none border-y-0 border-r-0 shadow-xl sm:max-w-[28rem]"
        onClick={(e) => e.stopPropagation()}
      >
        <CardContent className="flex h-full flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <Badge
                variant="default"
                className="bg-[color:color-mix(in_srgb,#38bdf8_22%,transparent)] text-[color:#075985]"
              >
                DingTalk
              </Badge>
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">{event.summary}</h2>
              <p className="text-sm text-[var(--text-secondary)]">{formatRange(event)}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X size={16} />
            </Button>
          </div>

          <dl className="space-y-3 text-sm">
            {event.calendarName ? (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  Calendar
                </dt>
                <dd className="mt-1 text-[var(--text-primary)]">{event.calendarName}</dd>
              </div>
            ) : null}
            {event.location ? (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  Location
                </dt>
                <dd className="mt-1 text-[var(--text-primary)]">{event.location}</dd>
              </div>
            ) : null}
            {event.status ? (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  Status
                </dt>
                <dd className="mt-1 text-[var(--text-primary)]">{event.status}</dd>
              </div>
            ) : null}
            {organizer ? (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  Organizer
                </dt>
                <dd className="mt-1 text-[var(--text-primary)]">
                  <div>{personLabel(organizer)}</div>
                  {organizer.email && organizer.name ? (
                    <div className="text-xs text-[var(--text-secondary)]">{organizer.email}</div>
                  ) : null}
                </dd>
              </div>
            ) : null}
            {attendees.length > 0 ? (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  Attendees ({attendees.length})
                </dt>
                <dd className="mt-2 space-y-2">
                  {attendees.map((person, index) => (
                    <div
                      key={`${person.email || person.name || 'attendee'}-${index}`}
                      className="flex items-start justify-between gap-2 rounded-md bg-[var(--surface-container-low)] px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[var(--text-primary)]">
                          {personLabel(person)}
                        </div>
                        {person.email && person.name ? (
                          <div className="truncate text-xs text-[var(--text-secondary)]">
                            {person.email}
                          </div>
                        ) : null}
                      </div>
                      {statusLabel(person.status) ? (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {statusLabel(person.status)}
                        </Badge>
                      ) : null}
                    </div>
                  ))}
                </dd>
              </div>
            ) : (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  Attendees
                </dt>
                <dd className="mt-1 text-xs text-[var(--text-secondary)]">
                  DingTalk CalDAV did not include an attendee list for this event.
                </dd>
              </div>
            )}
            {event.description ? (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  Description
                </dt>
                <dd className="mt-1 whitespace-pre-wrap text-[var(--text-primary)]">
                  {event.description}
                </dd>
              </div>
            ) : null}
          </dl>

          <p className="mt-auto text-xs text-[var(--text-secondary)]">
            Read-only import from DingTalk CalDAV. Edit this event in DingTalk.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
