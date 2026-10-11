'use client';

import { useEffect } from 'react';
import { Download, X } from 'lucide-react';
import { useCachedMediaSrc } from '@/lib/cache/useCachedMediaSrc';

export default function MediaLightbox({ preview, onClose }) {
  const src = useCachedMediaSrc(preview?.media || (preview?.url ? { url: preview.url } : null));

  useEffect(() => {
    if (!preview) return undefined;
    function onKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preview, onClose]);

  if (!preview) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={preview.name || 'Media preview'}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close preview"
        onClick={onClose}
      />
      <div className="relative z-10 flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-[var(--surface-card)] shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5">
          <span className="truncate text-sm font-medium text-[var(--text-primary)]">
            {preview.name || 'Preview'}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <a
              href={src || preview.url || '#'}
              download={preview.name || true}
              aria-label="Download"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-all hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
            >
              <Download size={16} />
            </a>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close preview"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-all hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
            >
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/20 p-2">
          {preview.kind === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={preview.name || 'Image'}
              className="max-h-[82vh] max-w-full rounded-lg object-contain"
            />
          ) : null}
          {preview.kind === 'video' ? (
            <video
              src={src}
              controls
              autoPlay
              className="max-h-[82vh] max-w-full rounded-lg"
            />
          ) : null}
          {preview.kind === 'pdf' ? (
            <iframe
              src={src}
              title={preview.name || 'Document preview'}
              className="h-[82vh] w-full rounded-lg bg-white"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
