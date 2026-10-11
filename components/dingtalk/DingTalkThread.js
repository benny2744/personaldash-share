'use client';

import { useEffect, useRef, useState } from 'react';
import { Expand } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  dingTalkMediaUrl,
  parseMediaSegments,
} from '@/lib/dingtalk/mediaContent';
import { useCachedMediaSrc } from '@/lib/cache/useCachedMediaSrc';
import MediaLightbox from './MediaLightbox';

function formatTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function isOwnMessage(message, self) {
  if (!self) return false;
  return (
    (self.openDingTalkId &&
      message.senderOpenDingTalkId === self.openDingTalkId) ||
    (self.userId && message.senderId === self.userId) ||
    (self.name && message.senderName === self.name)
  );
}

function isPdfName(name) {
  return /\.pdf$/i.test(String(name || ''));
}

function CachedImage({ media, label, onPreview }) {
  const src = useCachedMediaSrc(media);
  return (
    <button
      type="button"
      onClick={() => onPreview({ kind: 'image', name: label, media })}
      className="my-1 block"
      aria-label={`Preview ${label}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={label}
        loading="lazy"
        className="max-h-64 max-w-full cursor-zoom-in rounded-lg border border-[var(--border-subtle)]"
      />
    </button>
  );
}

function CachedAudio({ media }) {
  const src = useCachedMediaSrc(media);
  return <audio controls preload="none" src={src} className="my-1 h-9 w-60" />;
}

function CachedVideo({ media, label, onPreview }) {
  const src = useCachedMediaSrc(media);
  return (
    <span className="relative my-1 inline-block max-w-full">
      <video
        controls
        preload="metadata"
        src={src}
        className="max-h-64 max-w-full rounded-lg"
      />
      <button
        type="button"
        onClick={() => onPreview({ kind: 'video', name: label, media })}
        aria-label="Expand video"
        className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white transition-all hover:bg-black/70"
      >
        <Expand size={14} />
      </button>
    </span>
  );
}

function MessageContent({ message, onPreview }) {
  const segments = parseMediaSegments(message.content);
  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {segments.map((seg, index) => {
        if (seg.type === 'text') return <span key={index}>{seg.text}</span>;
        if (seg.type === 'file') {
          const fileMedia = {
            messageId: message.openMessageId,
            resourceId: seg.fileId,
            kind: 'file',
          };
          const url = dingTalkMediaUrl(
            message.openMessageId,
            seg.fileId,
            'file',
          );
          if (isPdfName(seg.name)) {
            return (
              <button
                key={index}
                type="button"
                onClick={() =>
                  onPreview({ kind: 'pdf', name: seg.name, media: fileMedia })
                }
                className="my-1 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-container)] px-2.5 py-1.5 text-xs underline-offset-2 hover:underline"
              >
                <span aria-hidden>📄</span>
                {seg.name}
              </button>
            );
          }
          return (
            <a
              key={index}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="my-1 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-container)] px-2.5 py-1.5 text-xs underline-offset-2 hover:underline"
            >
              <span aria-hidden>📄</span>
              {seg.name}
            </a>
          );
        }
        const media = {
          messageId: message.openMessageId,
          resourceId: seg.resourceId,
          kind: 'media',
        };
        const url = dingTalkMediaUrl(
          message.openMessageId,
          seg.resourceId,
          'media',
        );
        if (seg.label.includes('图片')) {
          return (
            <CachedImage
              key={index}
              media={media}
              label={seg.label}
              onPreview={onPreview}
            />
          );
        }
        if (seg.label.includes('语音')) {
          return <CachedAudio key={index} media={media} />;
        }
        if (seg.label.includes('视频')) {
          return (
            <CachedVideo
              key={index}
              media={media}
              label={seg.label}
              onPreview={onPreview}
            />
          );
        }
        return (
          <a
            key={index}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            [{seg.label}]
          </a>
        );
      })}
    </div>
  );
}

export default function DingTalkThread({
  messages,
  loading,
  olderLoading,
  hasMoreOlder,
  onLoadOlder,
  self,
}) {
  const endRef = useRef(null);
  const countRef = useRef(0);
  const lastMessageIdRef = useRef(null);
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    if (messages.length !== countRef.current) {
      countRef.current = messages.length;
    }
    const lastId = messages[messages.length - 1]?.openMessageId;
    if (lastId && lastId !== lastMessageIdRef.current) {
      lastMessageIdRef.current = lastId;
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-[min(72rem,100%)] flex-col gap-3 px-4 py-4">
        {loading && messages.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--text-muted)]">
            Loading messages…
          </div>
        ) : null}
        {!loading && messages.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--text-muted)]">
            Select a conversation to start reading
          </div>
        ) : null}
        {messages.length > 0 && (
          <div className="flex justify-center py-2">
            {hasMoreOlder ? (
              <button
                type="button"
                onClick={onLoadOlder}
                disabled={olderLoading}
                className="rounded-full bg-[var(--surface-container-high)] px-4 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-container)] disabled:opacity-50"
              >
                {olderLoading
                  ? 'Loading older messages…'
                  : 'Load older messages'}
              </button>
            ) : (
              <span className="text-xs text-[var(--text-muted)]">
                No older messages
              </span>
            )}
          </div>
        )}
        {messages.map((message) => {
          const own = isOwnMessage(message, self);
          return (
            <div
              key={message.openMessageId}
              className={cn('flex', own ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[75%] rounded-2xl px-3.5 py-2.5',
                  own
                    ? 'bg-[var(--primary)] text-white'
                    : 'bg-[var(--surface-container-high)]',
                  message.recalled ? 'opacity-50' : '',
                )}
              >
                {!own ? (
                  <div className="mb-0.5 text-[11px] font-semibold text-[var(--text-secondary)]">
                    {message.senderName}
                  </div>
                ) : null}
                {message.recalled ? (
                  <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    (message recalled)
                  </div>
                ) : (
                  <MessageContent message={message} onPreview={setPreview} />
                )}
                <div
                  className={cn(
                    'mt-1 text-[10px]',
                    own ? 'text-white/70' : 'text-[var(--text-muted)]',
                  )}
                >
                  {formatTime(message.createdAt)}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <MediaLightbox preview={preview} onClose={() => setPreview(null)} />
    </ScrollArea>
  );
}
