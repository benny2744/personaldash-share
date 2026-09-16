'use client';

import { SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export default function DingTalkComposer({
  value,
  onChange,
  onSend,
  sending,
  disabled,
  error,
}) {
  return (
    <div className="border-t border-[var(--border)] bg-[var(--surface-container-low)]/80 px-4 py-3 backdrop-blur-xl">
      {error ? (
        <div className="mx-auto mb-2 max-w-[min(72rem,100%)] text-xs text-[var(--error)]">
          {error}
        </div>
      ) : null}
      <div className="mx-auto flex max-w-[min(72rem,100%)] items-end gap-2">
        <Textarea
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
          className="min-h-[44px] flex-1 resize-none"
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
