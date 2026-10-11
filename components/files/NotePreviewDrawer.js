'use client';

import React, { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import matter from 'gray-matter';
import { Download, ExternalLink, Loader2 } from 'lucide-react';
import { getLocalStore } from '@/lib/cache/localStore';
import { readNoteBody, writeNoteBody } from '@/lib/cache/kbCache';
import PreviewDrawerShell from '@/components/files/PreviewDrawerShell';

const MilkdownEditor = dynamic(
  () => import('@/components/vault/MilkdownEditor'),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center text-[var(--text-secondary)]">
        <Loader2 size={20} className="mr-2 animate-spin" />
        Loading preview...
      </div>
    ),
  },
);

function titleFromPath(filepath = '') {
  const name = filepath.split('/').pop() || 'Note';
  return name.replace(/\.md$/i, '');
}

/**
 * Read-only note preview drawer for vault notes (search results + vault
 * browser). Local-first body load (IndexedDB cache revalidated by
 * contentHash), sized via PreviewDrawerShell.
 */
export default function NotePreviewDrawer({ filepath, onClose }) {
  const [rawContent, setRawContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!filepath) return undefined;

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    (async () => {
      const store = getLocalStore();
      const cached = await readNoteBody(store, filepath);
      if (cached?.content && !controller.signal.aborted) {
        setRawContent(cached.content);
        setLoading(false);
      }
      try {
        const res = await fetch(
          `/api/vault/note?path=${encodeURIComponent(filepath)}`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error('Unable to load note');
        const data = await res.json();
        if (controller.signal.aborted) return;
        if (!cached || cached.contentHash !== data.contentHash) {
          setRawContent(data.content || '');
        }
        await writeNoteBody(store, filepath, {
          content: data.content || '',
          contentHash: data.contentHash || null,
        });
      } catch (err) {
        if (err.name === 'AbortError') return;
        if (!cached) setError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [filepath]);

  const { content, title } = useMemo(() => {
    if (!rawContent) return { content: '', title: titleFromPath(filepath) };
    const parsed = matter(rawContent);
    const h1 = parsed.content.match(/^#\s+(.+)$/m);
    return {
      content: parsed.content,
      title: h1?.[1]?.trim() || titleFromPath(filepath),
    };
  }, [filepath, rawContent]);

  if (!filepath) return null;

  return (
    <PreviewDrawerShell
      title={title}
      subtitle={filepath}
      onClose={onClose}
      actions={
        <>
          <a
            href={`/api/vault/download?path=${encodeURIComponent(filepath)}`}
            download
            aria-label="Download note"
            title={`Download ${filepath}`}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-all hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
          >
            <Download size={18} />
          </a>
          <a
            href={`/vault?path=${encodeURIComponent(filepath)}`}
            aria-label="Open in editor"
            title="Open in editor"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-all hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
          >
            <ExternalLink size={18} />
          </a>
        </>
      }
      content={
        loading && !content ? (
          <div className="flex h-64 items-center justify-center text-[var(--text-secondary)]">
            <Loader2 size={20} className="mr-2 animate-spin" />
            Loading note...
          </div>
        ) : error ? (
          <p className="rounded-lg bg-[var(--error-container)]/20 p-4 text-sm text-[var(--on-error-container)]">
            {error}
          </p>
        ) : (
          <MilkdownEditor content={content} readOnly compact />
        )
      }
    />
  );
}
