'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Composer model selector. Reflects the canonical effective model
 * (`currentModel`, fed by session.info / session.bound) or the composer's
 * pre-session `pendingModel`. Selecting a model calls `onSelect(id, provider)`;
 * the parent decides command-vs-pending. Groups come straight from the
 * `model.options` payload (no invented categories).
 *
 * Accessible popover: click-outside + Escape close, ArrowUp/Down move the
 * active option, Enter/Space choose, focus returns to the trigger on close.
 */
export default function ModelPicker({
  models,
  currentModel,
  currentTier,
  pendingModel,
  loading,
  switching,
  onSelect,
  disabled,
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [popoverStyle, setPopoverStyle] = useState(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const popoverId = useId();

  const groups = useMemo(() => models?.groups || [], [models]);
  const flat = useMemo(
    () =>
      groups.flatMap((group) =>
        group.models.map((model) => ({
          ...model,
          provider: model.provider || group.slug,
        })),
      ),
    [groups],
  );

  // Tier rows share a model id across tiers, so disambiguate by tier label.
  const selectedId = pendingModel?.id || currentModel;
  const selectedTier = pendingModel?.label || currentTier;
  const isSelected = (model) =>
    model.id === selectedId &&
    (selectedTier ? (model.tier || model.label) === selectedTier : true);

  const displayed =
    selectedTier ||
    selectedId ||
    (loading ? 'Loading…' : 'default');
  const busy = loading || switching;

  useEffect(() => {
    if (!open) return undefined;
    const index = flat.findIndex((m) => isSelected(m));
    setActiveIndex(index >= 0 ? index : 0);
    // Focus the list so key events are captured without a mouse.
    requestAnimationFrame(() => listRef.current?.focus());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (
        !event.target.closest('[data-model-picker]')
      ) {
        close();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  // Measure the trigger so the popover stays inside the viewport on narrow
  // screens (a left-anchored 280px panel would overflow at ~375px).
  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(280, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const bottom = Math.max(8, window.innerHeight - rect.top + 8);
      setPopoverStyle({ left, bottom, width });
    }
    setOpen(true);
  }

  function choose(index) {
    const model = flat[index];
    if (!model) return;
    onSelect?.(model);
    close();
  }

  function onListKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(flat.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(0, flat.length - 1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Tab') {
      close();
    }
  }

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  let runningIndex = -1;

  return (
    <div className="relative shrink-0" data-model-picker>
      <Button
        ref={triggerRef}
        type="button"
        size="sm"
        variant="ghost"
        className="max-w-[10rem] gap-1 border border-[color:color-mix(in_srgb,var(--outline)_18%,transparent)] font-normal text-[var(--text-secondary)]"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title="Choose model"
        onClick={toggleOpen}
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <ChevronDown size={14} />
        )}
        <span className="truncate">{displayed}</span>
      </Button>

      {open ? (
        <div
          id={popoverId}
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label="Models"
          style={popoverStyle || undefined}
          onKeyDown={onListKeyDown}
          className="fixed z-50 max-h-[min(60vh,360px)] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-card)] p-1 text-sm shadow-xl outline-none"
        >
          {flat.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[var(--text-muted)]">
              {loading ? 'Loading models…' : 'No models available'}
            </div>
          ) : null}
          {groups.map((group) => (
            <div key={group.slug} role="group">
              <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                {group.name}
              </div>
              {group.models.map((model) => {
                runningIndex += 1;
                const index = runningIndex;
                const selected = isSelected(model);
                return (
                  <button
                    key={`${group.slug}:${model.tier || model.id}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-index={index}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(index)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                      index === activeIndex
                        ? 'bg-[var(--surface-container-high)]'
                        : 'hover:bg-[var(--surface-container-low)]',
                      !group.authenticated && 'opacity-60',
                    )}
                  >
                    <Check
                      size={14}
                      className={cn(
                        'shrink-0',
                        selected ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate capitalize">
                      {model.label}
                    </span>
                    {model.sublabel ? (
                      <span className="shrink-0 truncate text-xs text-[var(--text-muted)]">
                        {model.sublabel}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
