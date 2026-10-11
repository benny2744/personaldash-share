'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { createReplyPlaybackController } from '@/lib/hermes/voicePlayback';
import { groupTranscriptRows } from '@/lib/hermes/transcriptGrouper';
import MessageBubble from './MessageBubble';
import WorkTrace from './WorkTrace';

const BOTTOM_THRESHOLD_PX = 80;

export default function Transcript({
  messages,
  tools,
  title,
  model,
  connectionState,
  error,
  sessionKey = '',
}) {
  const endRef = useRef(null);
  const scrollRef = useRef(null);
  const followRef = useRef(true);
  const lastUserRowIdRef = useRef(null);
  const controllerRef = useRef(null);
  const [playback, setPlayback] = useState({ state: 'idle', activeId: null });
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const rows = useMemo(
    () => groupTranscriptRows(messages, tools),
    [messages, tools],
  );

  useEffect(() => {
    const controller = createReplyPlaybackController();
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setPlayback);
    return () => {
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  // Stop playback and resume following when the active session changes.
  useEffect(() => {
    controllerRef.current?.stop();
    followRef.current = true;
    lastUserRowIdRef.current = null;
    setHasNewBelow(false);
  }, [sessionKey]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const following = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
    followRef.current = following;
    if (following) setHasNewBelow(false);
  }, []);

  const scrollToBottom = useCallback((behavior = 'smooth') => {
    endRef.current?.scrollIntoView({ behavior, block: 'end' });
    followRef.current = true;
    setHasNewBelow(false);
  }, []);

  useEffect(() => {
    const lastUserRow = [...rows].reverse().find((row) => row.type === 'user');
    const isNewUserRow =
      lastUserRow && lastUserRow.id !== lastUserRowIdRef.current;
    if (lastUserRow) lastUserRowIdRef.current = lastUserRow.id;

    const streaming = rows.some(
      (row) =>
        (row.type === 'assistant' && row.message?.streaming) ||
        (row.type === 'work' && row.running),
    );

    if (isNewUserRow || followRef.current) {
      scrollToBottom(streaming ? 'auto' : 'smooth');
    } else {
      setHasNewBelow(true);
    }
  }, [rows, connectionState, scrollToBottom]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">
            {title || 'Hermes Chat'}
          </h2>
          <p className="truncate text-xs text-[var(--text-muted)]">
            {model || 'model unset'} · {connectionState}
          </p>
        </div>
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <ScrollArea
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 px-3 py-4 sm:px-6"
        >
          <div className="mx-auto flex max-w-[min(72rem,100%)] flex-col gap-3">
            {rows.length === 0 ? (
              <div className="rounded-2xl bg-[var(--surface-container-low)] px-6 py-10 text-center">
                <h3 className="text-base font-semibold text-[var(--text-primary)]">
                  Ask Hermes anything
                </h3>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">
                  Your tasks, calendar, meetings, and notes in one thread. Tool
                  calls and reasoning show as a compact summary above each
                  answer.
                </p>
              </div>
            ) : null}

            {rows.map((row) => {
              if (row.type === 'work') {
                return (
                  <div key={row.id} className="flex justify-start">
                    <WorkTrace
                      summary={row.summary}
                      reasoning={row.reasoning}
                      tools={row.tools}
                      running={row.running}
                      interrupted={row.interrupted}
                    />
                  </div>
                );
              }
              if (
                row.type === 'user' ||
                row.type === 'assistant' ||
                row.type === 'other'
              ) {
                return (
                  <MessageBubble
                    key={row.id}
                    message={row.message}
                    playbackActiveId={playback.activeId}
                    playbackState={playback.state}
                    onTogglePlayback={(messageId, text) =>
                      controllerRef.current?.toggle(messageId, text)
                    }
                  />
                );
              }
              return null;
            })}

            {error ? (
              <div className="rounded-xl border border-[var(--error)]/30 bg-[color:color-mix(in_srgb,var(--error-container)_18%,transparent)] px-3 py-2 text-sm text-[var(--on-error-container)]">
                {error}
              </div>
            ) : null}
            <div ref={endRef} />
          </div>
        </ScrollArea>

        {hasNewBelow ? (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-card)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] shadow-md transition-colors hover:bg-[var(--surface-container-low)]"
          >
            <ArrowDown size={13} />
            New messages
          </button>
        ) : null}
      </div>
    </div>
  );
}
