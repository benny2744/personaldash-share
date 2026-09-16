'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Filter, Inbox, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import MeetingDrawer from './MeetingDrawer';
import MeetingUploader from './MeetingUploader';
import MeetingJobCard from './MeetingJobCard';
import LinkReviewInbox from './LinkReviewInbox';

function dateKey(value) {
  if (!value) return 'No date';
  return new Date(value).toLocaleDateString();
}

export default function MeetingsClient({ initialMeetings }) {
  const [meetings, setMeetings] = useState(initialMeetings);
  const [jobs, setJobs] = useState([]);
  const [dismissedJobIds, setDismissedJobIds] = useState(() => new Set());
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [attendee, setAttendee] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [drawerMeeting, setDrawerMeeting] = useState(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [linkReviewOpen, setLinkReviewOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const refreshMeetings = useCallback(async () => {
    const response = await fetch('/api/meetings');
    if (response.ok) {
      setMeetings(await response.json());
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    const response = await fetch('/api/meetings/process?active=1');
    if (response.ok) {
      const nextJobs = await response.json();
      setJobs(nextJobs.filter((job) => !dismissedJobIds.has(job.id)));
      if (nextJobs.some((job) => job.status === 'done')) {
        refreshMeetings();
      }
    }
  }, [dismissedJobIds, refreshMeetings]);

  useEffect(() => {
    refreshJobs();
    const interval = setInterval(refreshJobs, 4000);
    return () => clearInterval(interval);
  }, [refreshJobs]);

  const allTypes = useMemo(
    () => [
      'all',
      ...new Set(meetings.map((item) => item.meetingType).filter(Boolean)),
    ],
    [meetings],
  );
  const allAttendees = useMemo(() => {
    const values = new Set();
    meetings.forEach((meeting) => {
      (meeting.attendees || []).forEach((name) => values.add(name));
    });
    return ['all', ...values];
  }, [meetings]);

  const filtered = useMemo(() => {
    return meetings.filter((meeting) => {
      const term = search.trim().toLowerCase();
      const titleMatch =
        !term || (meeting.title || '').toLowerCase().includes(term);
      const decisionMatch =
        !term || (meeting.decisions || '').toLowerCase().includes(term);
      const typeMatch = type === 'all' || meeting.meetingType === type;
      const attendeeMatch =
        attendee === 'all' || (meeting.attendees || []).includes(attendee);
      const when = meeting.meetingDate ? new Date(meeting.meetingDate) : null;
      const fromMatch =
        !dateFrom || (when && when >= new Date(`${dateFrom}T00:00:00`));
      const toMatch =
        !dateTo || (when && when <= new Date(`${dateTo}T23:59:59`));
      return (
        (titleMatch || decisionMatch) &&
        typeMatch &&
        attendeeMatch &&
        fromMatch &&
        toMatch
      );
    });
  }, [meetings, search, type, attendee, dateFrom, dateTo]);

  const grouped = useMemo(() => {
    const map = new Map();
    [...filtered]
      .sort((a, b) => {
        const aTs = a.meetingDate ? new Date(a.meetingDate).getTime() : 0;
        const bTs = b.meetingDate ? new Date(b.meetingDate).getTime() : 0;
        return bTs - aTs;
      })
      .forEach((meeting) => {
        const key = dateKey(meeting.meetingDate);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(meeting);
      });
    return [...map.entries()];
  }, [filtered]);

  const handleMeetingUpdate = (updatedMeeting) => {
    setMeetings((current) =>
      current.map((meeting) =>
        meeting.id === updatedMeeting.id
          ? { ...meeting, ...updatedMeeting }
          : meeting,
      ),
    );
    setDrawerMeeting((current) =>
      current?.id === updatedMeeting.id
        ? { ...current, ...updatedMeeting }
        : current,
    );
  };

  const dismissJob = (jobId) => {
    setDismissedJobIds((current) => new Set([...current, jobId]));
    setJobs((current) => current.filter((job) => job.id !== jobId));
  };

  const cancelJob = async (jobId) => {
    try {
      await fetch(`/api/meetings/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
    } catch {}
    setJobs((current) => current.filter((job) => job.id !== jobId));
  };

  return (
    <div className="space-y-5">
      <MeetingUploader
        onJobCreated={(job) => {
          setJobs((current) => [
            job,
            ...current.filter((item) => item.id !== job.id),
          ]);
          refreshJobs();
        }}
      />

      <div className="flex items-center justify-end">
        <Button
          variant={linkReviewOpen ? 'default' : 'outline'}
          className="h-8 px-3 text-xs"
          onClick={() => setLinkReviewOpen((prev) => !prev)}
        >
          <Inbox size={13} />
          Link Review
          {pendingCount > 0 && (
            <Badge variant="destructive" pill>
              {pendingCount}
            </Badge>
          )}
        </Button>
      </div>

      {linkReviewOpen && (
        <LinkReviewInbox
          open={linkReviewOpen}
          onClose={() => setLinkReviewOpen(false)}
          onPendingCount={setPendingCount}
        />
      )}

      {jobs.length > 0 && (
        <div className="grid gap-3">
          {jobs.map((job) => (
            <MeetingJobCard
              key={job.id}
              job={job}
              onDismiss={dismissJob}
              onCancel={cancelJob}
            />
          ))}
        </div>
      )}

      <div className="rounded-lg bg-[var(--surface-container-low)] p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
            <Filter size={13} />
            Filters
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[0.72rem] text-[var(--text-muted)]">
              {filtered.length}/{meetings.length}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] hover:bg-[var(--surface-container-high)] md:hidden"
              onClick={() => setMobileFiltersOpen((prev) => !prev)}
            >
              {mobileFiltersOpen ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <div
          className={`grid gap-2 md:grid-cols-2 lg:grid-cols-6 ${mobileFiltersOpen ? '' : 'hidden md:grid'}`}
        >
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search title or decisions..."
            className="h-8 text-xs lg:col-span-2"
          />
          <Select
            value={type}
            onChange={(event) => setType(event.target.value)}
            className="h-8 text-xs"
          >
            {allTypes.map((item) => (
              <option key={item} value={item}>
                {item === 'all' ? 'All types' : item}
              </option>
            ))}
          </Select>
          <Select
            value={attendee}
            onChange={(event) => setAttendee(event.target.value)}
            className="h-8 text-xs"
          >
            {allAttendees.map((item) => (
              <option key={item} value={item}>
                {item === 'all' ? 'All attendees' : item}
              </option>
            ))}
          </Select>
          <Input
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
            className="h-8 text-xs"
          />
          <Input
            type="date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-[0.72rem] text-[var(--text-muted)]">
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => {
              setSearch('');
              setType('all');
              setAttendee('all');
              setDateFrom('');
              setDateTo('');
            }}
          >
            Clear
          </Button>
        </div>
      </div>

      {grouped.length === 0 ? (
        <p className="empty-state">No meetings match your filters.</p>
      ) : (
        <div className="space-y-5">
          {grouped.map(([groupDate, items]) => (
            <section key={groupDate} className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-secondary)]">
                <CalendarDays size={14} />
                {groupDate}
              </div>
              <div className="grid gap-3">
                {items.map((meeting) => (
                  <button
                    key={meeting.id}
                    type="button"
                    onClick={() => setDrawerMeeting(meeting)}
                    className="block w-full min-w-0 text-left active:scale-[0.99] transition-transform"
                  >
                    <Card data-interactive="true">
                      <CardContent className="p-4">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate text-sm font-semibold text-[var(--text-primary)]">
                              {meeting.title}
                            </h3>
                            <p className="mt-1 line-clamp-2 text-xs text-[var(--text-secondary)]">
                              {meeting.decisions || 'No decisions summary.'}
                            </p>
                          </div>
                          <div className="shrink-0 text-xs text-[var(--text-muted)]">
                            {meeting.meetingDate
                              ? new Date(
                                  meeting.meetingDate,
                                ).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })
                              : 'No time'}
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {meeting.meetingType && (
                            <Badge variant="secondary">
                              {meeting.meetingType}
                            </Badge>
                          )}
                          <Badge variant="outline">
                            <Users size={11} />
                            {(meeting.attendees || []).length} attendees
                          </Badge>
                          <Badge variant="outline">
                            {(meeting.actionItems || []).length} action items
                          </Badge>
                          {meeting.project && (
                            <Badge variant="outline">{meeting.project}</Badge>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {drawerMeeting && (
        <MeetingDrawer
          meeting={drawerMeeting}
          onClose={() => setDrawerMeeting(null)}
          onMeetingUpdate={handleMeetingUpdate}
        />
      )}
    </div>
  );
}
