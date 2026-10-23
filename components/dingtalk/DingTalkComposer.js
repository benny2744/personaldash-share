'use client';

import { useEffect, useRef } from 'react';
import { SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import ComposerGrip from '@/components/chat/ComposerGrip';
import { cn } from '@/lib/utils';

/**
 * DingTalk thread composer. Sizing matches the Hermes composer: auto-grow up
 * to a cap by default, or a manual height set by dragging the grip (persisted
 * separately per composer via panelState `dingtalkComposerHeight`).
 */
export default function DingTalkComposer({
  value,
  onChange,
  onSend,
  sending,
  disabled,
  error,
  composerHeight,
  onComposerHeightChange,
}) {
  const textareaRef = useRef(null);
  // null = auto-grow with content (CSS-capped); a number = manual height.
  const manualHeight =
    typeof composerHeight === 'number' ? composerHeight : null;

  // Auto-grow: recompute the box height from content on every draft change,
  // capped by max-h-40. Skipped in manual mode (the saved height owns the box).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || manualHeight != null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, manualHeight]);

  return (
    <div className="border-t border-[var(--border)] bg-[var(--surface-container-low)]/80 px-4 py-3 backdrop-blur-xl">
      <ComposerGrip
        targetRef={textareaRef}
        height={manualHeight}
        onChange={onComposerHeightChange}
        onReset={() => onComposerHeightChange?.(null)}
      />
      {error ? (
        <div className="mx-auto mb-2 max-w-[min(72rem,100%)] text-xs text-[var(--error)]">
          {error}
        </div>
      ) : null}
      <div className="mx-auto flex max-w-[min(72rem,100%)] items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSend?.();
            }
          }}
          placeholder={
            disabled ? 'Select a conversation to reply' : 'Message (Enter to send, Shift+Enter for newline)'
          }
          disabled={disabled || sending}
          rows={2}
          className={cn(
            'flex-1 resize-none overflow-y-auto',
            manualHeight != null ? 'min-h-0' : 'min-h-[44px] max-h-40',
          )}
          style={
            manualHeight != null
              ? { height: `min(${manualHeight}px, 55dvh)` }
              : undefined
          }
        />
        <Button
          size="icon"
          onClick={() => onSend?.()}
          disabled={disabled || sending || !value.trim()}
          title="Send"
        >
          <SendHorizontal size={16} />
        </Button>
      </div>
    </div>
  );
}
