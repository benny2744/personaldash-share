'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import matter from 'gray-matter';
import { ArrowUpRight, ChevronDown, Lightbulb, Target, TrendingUp, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { IDEA_STATUSES } from '@/lib/domain';
import { wikilinksToMarkdown } from '@/lib/drawerUtils';

const STATUS_VARIANT = {
  backburner: 'status-backburner',
  exploring: 'status-exploring',
  inprogress: 'status-doing',
  done: 'status-done',
  abandoned: 'status-abandoned',
};

const EDITABLE_STATUS_OPTIONS = IDEA_STATUSES;

export default function IdeaDrawer({ idea, onClose, onIdeaUpdate }) {
  const [rawContent, setRawContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metadataForm, setMetadataForm] = useState({
    status: 'Backburner',
    domain: '',
    impact: '',
    effort: '',
  });
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const drawerRef = useRef(null);

  useEffect(() => {
    if (!idea?.note?.filepath) {
      setRawContent(null);
      return;
    }
    setLoading(true);
    setError(null);
    setRawContent(null);
    fetch(`/api/vault/note?path=${encodeURIComponent(idea.note.filepath)}`)
      .then((r) => { if (!r.ok) throw new Error('Note not found'); return r.json(); })
      .then((data) => setRawContent(data.content || ''))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [idea?.id]);

  useEffect(() => {
    if (!idea) return;
    setMetadataForm({
      status: idea.status || 'Backburner',
      domain: idea.domain || '',
      impact: idea.impact || '',
      effort: idea.effort || '',
    });
    setSaveError(null);
    setSaveSuccess(false);
    setMetadataOpen(false);
  }, [idea]);

  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => { drawerRef.current?.focus(); }, [idea?.id]);

  if (!idea) return null;

  const parsedMatter = rawContent !== null ? matter(rawContent) : null;
  const body = parsedMatter ? wikilinksToMarkdown(parsedMatter.content || '') : '';
  const statusKey = (idea.status || 'backburner').toLowerCase().replace(/\s+/g, '');
  const statusVariant = STATUS_VARIANT[statusKey] || 'secondary';

  const handleMetadataChange = (field, value) => {
    setMetadataForm((previous) => ({ ...previous, [field]: value }));
    setSaveSuccess(false);
  };

  const handleSaveMetadata = async () => {
    if (!idea?.id) return;
    setSavePending(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const payload = {
        status: metadataForm.status,
        domain: metadataForm.domain.trim() || null,
        impact: metadataForm.impact.trim() || null,
        effort: metadataForm.effort.trim() || null,
      };
      const response = await fetch(`/api/ideas/${idea.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error('Failed to save metadata');
      }
      const updatedIdea = await response.json();
      onIdeaUpdate?.(updatedIdea);
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
        aria-label={idea.title}
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
              {idea.title}
            </h2>
            {idea.note?.filepath && (
              <p className="mt-0.5 truncate font-mono text-xs text-[var(--text-muted)]">
                {idea.note.filepath}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {idea.note?.filepath && (
              <Link
                href={`/vault/${encodeURIComponent(idea.note.filepath)}`}
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
          <Badge variant={statusVariant} dot>{idea.status || 'Backburner'}</Badge>
          {idea.domain && (
            <Badge variant="outline">
              <Lightbulb size={11} />
              {idea.domain}
            </Badge>
          )}
          {idea.impact && (
            <Badge variant="secondary">
              <TrendingUp size={11} />
              {idea.impact}
            </Badge>
          )}
          {idea.effort && (
            <Badge variant="secondary">
              <Target size={11} />
              {idea.effort}
            </Badge>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="mb-5 rounded-xl border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] bg-[var(--surface-container-low)] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <button
                type="button"
                className="flex flex-1 items-center justify-between rounded-md px-1 py-1 text-left hover:bg-[var(--surface-container-high)]"
                onClick={() => setMetadataOpen((previous) => !previous)}
                aria-expanded={metadataOpen}
              >
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">Front matter</h3>
                <ChevronDown
                  size={16}
                  className={cn(
                    'text-[var(--text-secondary)] transition-transform',
                    metadataOpen && 'rotate-180'
                  )}
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
                    <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Status</span>
                    <Select value={metadataForm.status} onChange={(event) => handleMetadataChange('status', event.target.value)} className="h-8 text-xs">
                      {EDITABLE_STATUS_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </Select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Domain</span>
                    <Input value={metadataForm.domain} onChange={(event) => handleMetadataChange('domain', event.target.value)} placeholder="Domain" className="h-8 text-xs" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Impact</span>
                    <Input value={metadataForm.impact} onChange={(event) => handleMetadataChange('impact', event.target.value)} placeholder="Impact" className="h-8 text-xs" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Effort</span>
                    <Input value={metadataForm.effort} onChange={(event) => handleMetadataChange('effort', event.target.value)} placeholder="Effort" className="h-8 text-xs" />
                  </label>
                </div>
                {saveError && <p className="mt-2 text-xs text-[var(--error)]">{saveError}</p>}
                {saveSuccess && <p className="mt-2 text-xs text-[var(--text-secondary)]">Saved.</p>}
              </>
            )}
          </div>

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
