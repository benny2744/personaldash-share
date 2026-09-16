'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import matter from 'gray-matter';
import { ArrowUpRight, ChevronDown, Users, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MEETING_TYPES } from '@/lib/domain';
import { parseCsv, toCsv, toDateInputValue, wikilinksToMarkdown } from '@/lib/drawerUtils';

export default function MeetingDrawer({ meeting, onClose, onMeetingUpdate, readOnly = false }) {
  const [rawContent, setRawContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metadataForm, setMetadataForm] = useState({
    meetingType: '',
    meetingDate: '',
    attendees: '',
    project: '',
    area: '',
    actionItems: '',
    decisions: '',
  });
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const drawerRef = useRef(null);
  const hasKnownMeetingType = MEETING_TYPES.includes(metadataForm.meetingType);

  useEffect(() => {
    if (!meeting?.note?.filepath) {
      setRawContent(null);
      return;
    }
    setLoading(true);
    setError(null);
    setRawContent(null);
    fetch(`/api/vault/note?path=${encodeURIComponent(meeting.note.filepath)}`)
      .then((r) => {
        if (!r.ok) throw new Error('Note not found');
        return r.json();
      })
      .then((data) => setRawContent(data.content || ''))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [meeting?.id, meeting?.note?.filepath]);

  useEffect(() => {
    if (!meeting) return;
    setMetadataForm({
      meetingType: meeting.meetingType || '',
      meetingDate: toDateInputValue(meeting.meetingDate),
      attendees: toCsv(meeting.attendees),
      project: meeting.project || '',
      area: meeting.area || '',
      actionItems: toCsv(meeting.actionItems),
      decisions: meeting.decisions || '',
    });
    setSaveError(null);
    setSaveSuccess(false);
    setMetadataOpen(false);
  }, [meeting]);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    drawerRef.current?.focus();
  }, [meeting?.id]);

  if (!meeting) return null;

  const parsedMatter = rawContent !== null ? matter(rawContent) : null;
  const body = parsedMatter ? wikilinksToMarkdown(parsedMatter.content || '') : '';

  const handleMetadataChange = (field, value) => {
    setMetadataForm((prev) => ({ ...prev, [field]: value }));
    setSaveSuccess(false);
  };

  const handleSaveMetadata = async () => {
    if (!meeting?.id) return;
    setSavePending(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const payload = {
        meetingType: metadataForm.meetingType.trim() || null,
        meetingDate: metadataForm.meetingDate || null,
        attendees: parseCsv(metadataForm.attendees),
        project: metadataForm.project.trim() || null,
        area: metadataForm.area.trim() || null,
        actionItems: parseCsv(metadataForm.actionItems),
        decisions: metadataForm.decisions.trim() || null,
      };
      const response = await fetch(`/api/meetings/${meeting.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error('Failed to save metadata');
      }
      const updatedMeeting = await response.json();
      onMeetingUpdate?.(updatedMeeting);
      setSaveSuccess(true);
    } catch (err) {
      setSaveError(err.message || 'Failed to save metadata');
    } finally {
      setSavePending(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={drawerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={meeting.title}
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full sm:max-w-[40vw] flex-col',
          'glass-panel rounded-l-xl',
          'shadow-[-20px_0_60px_rgba(44,52,55,0.12)]',
          'outline-none',
          'animate-slide-in-right'
        )}
      >
        <div className="flex shrink-0 items-start gap-3 px-5 py-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold leading-snug text-[var(--text-primary)]">
              {meeting.title}
            </h2>
            {meeting.note?.filepath && (
              <p className="mt-0.5 truncate font-mono text-xs text-[var(--text-muted)]">
                {meeting.note.filepath}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {meeting.note?.filepath && (
              <Link
                href={`/vault/${encodeURIComponent(meeting.note.filepath)}`}
                className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:h-7 md:w-7"
                title="Open full note"
              >
                <ArrowUpRight size={15} />
              </Link>
            )}
            <button
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:h-7 md:w-7"
              aria-label="Close panel"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 py-3">
          {meeting.meetingType && <Badge variant="secondary">{meeting.meetingType}</Badge>}
          {!!meeting.attendees?.length && (
            <Badge variant="outline">
              <Users size={11} />
              {meeting.attendees.length} attendee{meeting.attendees.length === 1 ? '' : 's'}
            </Badge>
          )}
          {meeting.meetingDate && (
            <Badge variant="outline">
              {new Date(meeting.meetingDate).toLocaleDateString()}
            </Badge>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {!readOnly && (
            <div className="mb-5 rounded-xl border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] bg-[var(--surface-container-low)] p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="flex flex-1 items-center justify-between rounded-md px-1 py-1 text-left hover:bg-[var(--surface-container-high)]"
                  onClick={() => setMetadataOpen((prev) => !prev)}
                  aria-expanded={metadataOpen}
                >
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">Front matter</h3>
                  <ChevronDown
                    size={16}
                    className={cn('text-[var(--text-secondary)] transition-transform', metadataOpen && 'rotate-180')}
                  />
                </button>
                <Button size="sm" onClick={handleSaveMetadata} disabled={savePending || !metadataOpen}>
                  {savePending ? 'Saving…' : 'Save'}
                </Button>
              </div>
              {metadataOpen && (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Type</span>
                      <Select value={metadataForm.meetingType} onChange={(event) => handleMetadataChange('meetingType', event.target.value)} className="h-8 text-xs">
                        <option value="">Select type</option>
                        {metadataForm.meetingType && !hasKnownMeetingType && (
                          <option value={metadataForm.meetingType}>{metadataForm.meetingType} (legacy)</option>
                        )}
                        {MEETING_TYPES.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </Select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Date</span>
                      <Input type="date" value={metadataForm.meetingDate} onChange={(event) => handleMetadataChange('meetingDate', event.target.value)} className="h-8 text-xs" />
                    </label>
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Attendees</span>
                      <Input value={metadataForm.attendees} onChange={(event) => handleMetadataChange('attendees', event.target.value)} placeholder="Comma-separated wiki targets" className="h-8 text-xs" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Project</span>
                      <Input value={metadataForm.project} onChange={(event) => handleMetadataChange('project', event.target.value)} placeholder="Project wiki target" className="h-8 text-xs" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Area</span>
                      <Input value={metadataForm.area} onChange={(event) => handleMetadataChange('area', event.target.value)} placeholder="Area wiki target" className="h-8 text-xs" />
                    </label>
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Action Items</span>
                      <Input value={metadataForm.actionItems} onChange={(event) => handleMetadataChange('actionItems', event.target.value)} placeholder="Comma-separated wiki targets" className="h-8 text-xs" />
                    </label>
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Decisions</span>
                      <Textarea value={metadataForm.decisions} onChange={(event) => handleMetadataChange('decisions', event.target.value)} className="min-h-20 text-xs" />
                    </label>
                  </div>
                  {saveError && <p className="mt-2 text-xs text-[var(--error)]">{saveError}</p>}
                  {saveSuccess && <p className="mt-2 text-xs text-[var(--text-secondary)]">Saved.</p>}
                </>
              )}
            </div>
          )}

          {loading && (
            <div className="space-y-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="mt-4 h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          )}
          {error && (
            <p className="text-sm text-[var(--error)]">Could not load note: {error}</p>
          )}
          {!loading && !error && body && (
            <div className="markdown-prose">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
            </div>
          )}
          {!loading && !error && !body && !rawContent && (
            <p className="text-sm text-[var(--text-muted)] italic">No note content attached.</p>
          )}
        </div>
      </div>
    </>
  );
}
