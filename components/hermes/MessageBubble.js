'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Check,
  Copy,
  File,
  FileSpreadsheet,
  FileText,
  Image,
  Loader2,
  Presentation,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  canSpeakReply,
  playbackButtonLabel,
  playbackButtonState,
} from '@/lib/hermes/voicePlayback';
import { vaultViewerHref } from '@/lib/hermes/markdownLinks';
import { cn } from '@/lib/utils';

function attachmentIcon(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '');
  if (type.startsWith('image/')) return Image;
  if (/\.(xls|xlsx|ods|csv)$/.test(name)) return FileSpreadsheet;
  if (/\.(ppt|pptx|odp)$/.test(name)) return Presentation;
  if (
    type === 'application/pdf' ||
    /\.(pdf|doc|docx|odt|rtf|txt|md|html?)$/.test(name)
  ) {
    return FileText;
  }
  return File;
}

/**
 * User / assistant answer bubble.
 * Tool/reasoning activity is rendered separately via WorkTrace.
 */

const markdownComponents = {
  a({ href, children, title }) {
    return (
      <a href={vaultViewerHref(href)} title={title}>
        {children}
      </a>
    );
  },
};

export default function MessageBubble({
  message,
  playbackActiveId = null,
  playbackState = 'idle',
  onTogglePlayback,
}) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const [localError, setLocalError] = useState('');
  const [copyState, setCopyState] = useState('idle');
  const copyTimerRef = useRef(null);
  const speakable = canSpeakReply(message);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  async function handleCopyClick() {
    try {
      await navigator.clipboard.writeText(message.content || '');
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyState('idle'), 1500);
  }
  const buttonState = playbackButtonState(
    playbackState,
    playbackActiveId,
    message.id,
  );
  const label = playbackButtonLabel(buttonState);

  async function handleSpeakClick() {
    if (!speakable || !onTogglePlayback) return;
    setLocalError('');
    try {
      await onTogglePlayback(message.id, message.content || '');
    } catch (error) {
      setLocalError(error?.message || 'Speech failed');
    }
  }

  if (message.role === 'tool') {
    // History tool rows are folded into WorkTrace; keep a silent fallback.
    return null;
  }

  return (
    <div
      className={cn(
        'flex w-full flex-col',
        isUser ? 'items-end' : 'items-start',
      )}
    >
      <div
        className={cn(
          'max-w-[min(1000px,92%)] rounded-2xl px-4 py-3 text-sm shadow-sm',
          isUser
            ? 'bg-[var(--primary)] text-white'
            : 'bg-[var(--surface-card)] text-[var(--text-primary)] border border-[var(--border)]',
        )}
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider opacity-70">
            {isUser
              ? 'You'
              : message.role === 'assistant'
                ? 'Hermes'
                : message.role}
          </span>
          {message.streaming && (
            <Badge
              variant="secondary"
              className="bg-white/20 text-[10px] text-inherit"
            >
              streaming
            </Badge>
          )}
          {message.interrupted && (
            <Badge variant="destructive" className="text-[10px]">
              interrupted
            </Badge>
          )}
          {speakable ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="ml-auto h-7 w-7 shrink-0"
              onClick={handleSpeakClick}
              aria-label={label}
              title={label}
            >
              {buttonState === 'synthesizing' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : buttonState === 'playing' ? (
                <VolumeX size={14} />
              ) : (
                <Volume2 size={14} />
              )}
            </Button>
          ) : null}
        </div>

        {isUser ? (
          <div className="whitespace-pre-wrap break-words">
            {message.content}
          </div>
        ) : (
          <div className="prose prose-sm max-w-none break-words prose-p:my-2 prose-pre:bg-[var(--surface-container-low)] prose-pre:text-[var(--text-primary)]">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {message.content || (message.streaming ? '…' : '')}
            </ReactMarkdown>
          </div>
        )}

        {(buttonState === 'error' || localError) && speakable ? (
          <p className="mt-2 text-xs text-[var(--on-error-container)]">
            {localError || 'Could not play speech. Tap the speaker to retry.'}
          </p>
        ) : null}

        {Array.isArray(message.attachments) &&
        message.attachments.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.attachments.map((file) => {
              const Icon = attachmentIcon(file);
              return (
                <Badge key={`${file.name}-${file.size}`} variant="secondary">
                  <Icon size={12} className="mr-1" />
                  {file.name || 'attachment'}
                </Badge>
              );
            })}
          </div>
        ) : null}
      </div>

      {isAssistant && message.content && !message.streaming ? (
        <div className="mt-1 flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-[var(--text-muted)]"
            onClick={handleCopyClick}
            aria-label="Copy message"
            title={
              copyState === 'copied'
                ? 'Copied'
                : copyState === 'error'
                  ? 'Copy failed'
                  : 'Copy message'
            }
          >
            {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
          </Button>
          {copyState === 'error' ? (
            <span className="text-xs text-[var(--on-error-container)]">
              Copy failed — clipboard unavailable
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
