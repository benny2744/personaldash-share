'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import matter from 'gray-matter';
import {
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  FolderOpen,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { PriorityIcon, priorityLabel } from '@/components/ui/priority-icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TASK_CONTEXTS, TASK_PRIORITIES, TASK_STATUSES } from '@/lib/domain';
import {
  parseCsv,
  toCsv,
  toDateInputValue,
  wikilinksToMarkdown,
} from '@/lib/drawerUtils';

const MilkdownEditor = dynamic(
  () => import('@/components/vault/MilkdownEditor'),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center gap-2 py-2 text-sm text-[var(--text-muted)]">
        <Skeleton className="h-4 w-3/4" />
      </div>
    ),
  },
);

const STATUS_VARIANT = {
  proposed: 'status-todo',
  todo: 'status-todo',
  doing: 'status-doing',
  done: 'status-done',
  archived: 'status-done',
};

const EDITABLE_STATUS_OPTIONS = TASK_STATUSES;
const EDITABLE_PRIORITY_OPTIONS = TASK_PRIORITIES;

export default function TaskDrawer({
  task,
  onClose,
  onTaskUpdate,
  readOnly = false,
}) {
  const [rawContent, setRawContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metadataForm, setMetadataForm] = useState({
    status: 'Todo',
    priority: 'Medium',
    context: '',
    whenDate: '',
    project: '',
    area: '',
    domain: '',
    people: '',
    courses: '',
    tags: '',
  });
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const drawerRef = useRef(null);

  // Fetch note content whenever the task changes
  useEffect(() => {
    if (!task?.note?.filepath) {
      setRawContent(null);
      return;
    }
    setLoading(true);
    setError(null);
    setRawContent(null);
    fetch(`/api/vault/note?path=${encodeURIComponent(task.note.filepath)}`)
      .then((r) => {
        if (!r.ok) throw new Error('Note not found');
        return r.json();
      })
      .then((data) => setRawContent(data.content || ''))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [task?.id, task?.note?.filepath]);

  useEffect(() => {
    if (!task) return;
    setMetadataForm({
      status: task.status || 'Todo',
      priority: task.priority || 'Medium',
      context: task.context || '',
      whenDate: toDateInputValue(task.whenDate),
      project: task.project || '',
      area: task.area || '',
      domain: task.domain || '',
      people: toCsv(task.people),
      courses: toCsv(task.courses),
      tags: toCsv((task.tags || []).filter((tag) => tag !== 'type/task')),
    });
    setSaveError(null);
    setSaveSuccess(false);
    setMetadataOpen(false);
  }, [task]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Focus trap: focus the drawer on open
  useEffect(() => {
    drawerRef.current?.focus();
  }, [task?.id]);

  if (!task) return null;

  const parsedMatter = rawContent !== null ? matter(rawContent) : null;
  const body = parsedMatter
    ? wikilinksToMarkdown(parsedMatter.content || '')
    : '';
  const priority = (task.priority || '').toLowerCase();
  const status = (task.status || 'todo').toLowerCase();
  const statusVariant = STATUS_VARIANT[status] || 'secondary';
  const priorityVariant = priority ? `priority-${priority}` : null;

  const dateStr = task.whenDate
    ? new Date(task.whenDate).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;
  const isOverdue =
    task.whenDate &&
    new Date(task.whenDate) < new Date() &&
    !['done', 'archived'].includes(status);

  const handleMetadataChange = (field, value) => {
    setMetadataForm((previous) => ({ ...previous, [field]: value }));
    setSaveSuccess(false);
  };

  const handleSaveMetadata = async () => {
    if (!task?.id) return;
    setSavePending(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const payload = {
        status: metadataForm.status,
        priority: metadataForm.priority,
        context: metadataForm.context || null,
        whenDate: metadataForm.whenDate || null,
        project: metadataForm.project.trim() || null,
        area: metadataForm.area.trim() || null,
        domain: metadataForm.domain.trim() || null,
        people: parseCsv(metadataForm.people),
        courses: parseCsv(metadataForm.courses),
        tags: parseCsv(metadataForm.tags),
      };
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'Failed to save metadata');
      }
      const updatedTask = await response.json();
      onTaskUpdate?.(updatedTask);
      setSaveSuccess(true);
    } catch (err) {
      setSaveError(err.message || 'Failed to save metadata');
    } finally {
      setSavePending(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full sm:max-w-[40vw] flex-col',
          'glass-panel rounded-l-xl',
          'shadow-[-20px_0_60px_rgba(44,52,55,0.12)]',
          'outline-none',
          'animate-slide-in-right',
        )}
      >
        {/* ── Header ─────────────────────────────────────────── */}
        <div className="flex shrink-0 items-start gap-3 px-5 py-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold leading-snug text-[var(--text-primary)]">
              {task.title}
            </h2>
            {task.note?.filepath && (
              <p className="mt-0.5 truncate font-mono text-xs text-[var(--text-muted)]">
                {task.note.filepath}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {task.note?.filepath && (
              <Link
                href={`/vault?path=${encodeURIComponent(task.note.filepath)}`}
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

        {/* ── Meta chips ─────────────────────────────────────── */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 py-3">
          {task.status && (
            <Badge variant={statusVariant} dot>
              {task.status}
            </Badge>
          )}
          {priorityVariant && (
            <Badge variant={priorityVariant}>
              <PriorityIcon priority={priority} size={11} />
              {priorityLabel(priority)}
            </Badge>
          )}
          {task.project && (
            <Badge variant="outline">
              <FolderOpen size={11} />
              {task.project}
            </Badge>
          )}
          {task.context && <Badge variant="secondary">{task.context}</Badge>}
          {task.area && <Badge variant="outline">{task.area}</Badge>}
          {dateStr && (
            <Badge variant={isOverdue ? 'destructive' : 'secondary'}>
              <CalendarDays size={11} />
              {dateStr}
              {isOverdue && ' · Overdue'}
            </Badge>
          )}
        </div>

        {/* ── Note body ──────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {!readOnly && (
            <div className="mb-5 rounded-xl border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] bg-[var(--surface-container-low)] p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="flex flex-1 items-center justify-between rounded-md px-1 py-1 text-left hover:bg-[var(--surface-container-high)]"
                  onClick={() => setMetadataOpen((previous) => !previous)}
                  aria-expanded={metadataOpen}
                >
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    Front matter
                  </h3>
                  <ChevronDown
                    size={16}
                    className={cn(
                      'text-[var(--text-secondary)] transition-transform',
                      metadataOpen && 'rotate-180',
                    )}
                  />
                </button>
                <Button
                  size="sm"
                  onClick={handleSaveMetadata}
                  disabled={savePending || !metadataOpen}
                >
                  {savePending ? 'Saving…' : 'Save'}
                </Button>
              </div>
              {metadataOpen && (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        Context
                      </span>
                      <Select
                        value={metadataForm.context}
                        onChange={(event) =>
                          handleMetadataChange('context', event.target.value)
                        }
                        className="h-8 text-xs"
                      >
                        <option value="">Unclassified</option>
                        {TASK_CONTEXTS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        Status
                      </span>
                      <Select
                        value={metadataForm.status}
                        onChange={(event) =>
                          handleMetadataChange('status', event.target.value)
                        }
                        className="h-8 text-xs"
                      >
                        {EDITABLE_STATUS_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        Priority Level
                      </span>
                      <Select
                        value={metadataForm.priority}
                        onChange={(event) =>
                          handleMetadataChange('priority', event.target.value)
                        }
                        className="h-8 text-xs"
                      >
                        {EDITABLE_PRIORITY_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        When
                      </span>
                      <Input
                        type="date"
                        value={metadataForm.whenDate}
                        onChange={(event) =>
                          handleMetadataChange('whenDate', event.target.value)
                        }
                        className="h-8 text-xs"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        Project
                      </span>
                      <Input
                        value={metadataForm.project}
                        onChange={(event) =>
                          handleMetadataChange('project', event.target.value)
                        }
                        placeholder="Project name"
                        className="h-8 text-xs"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        Area
                      </span>
                      <Input
                        value={metadataForm.area}
                        onChange={(event) =>
                          handleMetadataChange('area', event.target.value)
                        }
                        placeholder="Ongoing responsibility"
                        className="h-8 text-xs"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        Domain
                      </span>
                      <Input
                        value={metadataForm.domain}
                        onChange={(event) =>
                          handleMetadataChange('domain', event.target.value)
                        }
                        placeholder="Domain"
                        className="h-8 text-xs"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        People
                      </span>
                      <Input
                        value={metadataForm.people}
                        onChange={(event) =>
                          handleMetadataChange('people', event.target.value)
                        }
                        placeholder="Comma-separated wiki targets"
                        className="h-8 text-xs"
                      />
                    </label>
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        Courses
                      </span>
                      <Input
                        value={metadataForm.courses}
                        onChange={(event) =>
                          handleMetadataChange('courses', event.target.value)
                        }
                        placeholder="Comma-separated wiki targets"
                        className="h-8 text-xs"
                      />
                    </label>
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        Tags
                      </span>
                      <Input
                        value={metadataForm.tags}
                        onChange={(event) =>
                          handleMetadataChange('tags', event.target.value)
                        }
                        placeholder="Comma-separated labels"
                        className="h-8 text-xs"
                      />
                    </label>
                  </div>
                  {saveError && (
                    <p className="mt-2 text-xs text-[var(--error)]">
                      {saveError}
                    </p>
                  )}
                  {saveSuccess && (
                    <p className="mt-2 text-xs text-[var(--text-secondary)]">
                      Saved.
                    </p>
                  )}
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
            <p className="text-sm text-[var(--error)]">
              Could not load note: {error}
            </p>
          )}
          {!loading && !error && body && (
            <MilkdownEditor content={body} readOnly compact />
          )}
          {!loading && !error && !body && !rawContent && (
            <p className="text-sm text-[var(--text-muted)] italic">
              No note content attached.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
