'use client';

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const PREVIEW_SIZES = ['s', 'm', 'l'];

const SIZE_CLASSES = {
  s: 'md:max-w-[33vw]',
  m: 'md:max-w-[50vw]',
  l: 'md:max-w-[67vw]',
};

const STORAGE_KEY = 'personaldash.preview.size';

export function readStoredPreviewSize() {
  if (typeof window === 'undefined') return 'm';
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return PREVIEW_SIZES.includes(value) ? value : 'm';
  } catch {
    return 'm';
  }
}

function storePreviewSize(size) {
  try {
    window.localStorage.setItem(STORAGE_KEY, size);
  } catch {
    // storage unavailable (private mode) — size stays session-only
  }
}

/**
 * Shared right-side preview drawer for the /files page. Sizing is
 * viewport-relative (S≈⅓, M≈½, L≈⅔ of the page width at md+; full-width on
 * mobile) and persisted in localStorage across drawers.
 */
export default function PreviewDrawerShell({
  title,
  subtitle,
  actions,
  content,
  onClose,
}) {
  const [size, setSize] = useState('m');

  useEffect(() => {
    setSize(readStoredPreviewSize());
  }, []);

  const changeSize = (next) => {
    setSize(next);
    storePreviewSize(next);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex justify-end bg-black/30"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        className="flex-1 cursor-default"
        aria-label="Close preview"
        onClick={onClose}
      />
      <aside
        className={cn(
          'flex h-full w-full flex-col bg-[var(--surface-card)] shadow-2xl',
          SIZE_CLASSES[size],
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[color:color-mix(in_srgb,var(--outline)_14%,transparent)] p-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-[var(--text-primary)]">
              {title}
            </h2>
            {subtitle && (
              <div className="mt-1 truncate font-mono text-xs text-[var(--text-secondary)]">
                {subtitle}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div
              className="mr-1 flex items-center gap-0.5 rounded-lg bg-[var(--surface-container-low)] p-0.5"
              role="group"
              aria-label="Preview size"
            >
              {PREVIEW_SIZES.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => changeSize(option)}
                  aria-pressed={size === option}
                  aria-label={`Preview size ${option.toUpperCase()}`}
                  title={`Preview size ${option.toUpperCase()}`}
                  className={cn(
                    'rounded-md px-2 py-1 text-[11px] font-semibold uppercase transition',
                    size === option
                      ? 'bg-[var(--surface-card)] text-[var(--primary)] shadow-sm'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-container-high)]',
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
            {actions}
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close preview"
            >
              <X size={18} />
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{content}</div>
      </aside>
    </div>
  );
}
