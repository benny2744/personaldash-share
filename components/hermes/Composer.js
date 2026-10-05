'use client';

import { useRef, useState } from 'react';
import {
  AudioLines,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  SendHorizontal,
  Square,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { VOICE_MAX_SECONDS } from '@/lib/hermes/voiceRecording';
import useVoiceDictation from '@/hooks/useVoiceDictation';
import ModelPicker from './ModelPicker';
import { cn } from '@/lib/utils';

const ATTACH_ACCEPT =
  'image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.txt,.md,.markdown,.log,.csv,.tsv,.json,.xml,.yaml,.yml,.html,.htm';
const MAX_ATTACH_BYTES = 50 * 1024 * 1024;
const MAX_ATTACH_COUNT = 5;

export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  disabled,
  offline,
  statusText,
  models,
  currentModel,
  currentTier,
  pendingModel,
  modelsLoading,
  modelSwitching,
  onSwitchModel,
  liveVoice,
}) {
  const fileRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [fileError, setFileError] = useState('');
  const [processingFiles, setProcessingFiles] = useState([]);

  const voice = useVoiceDictation({
    offline,
    disabled,
    busy: running,
    onPartial: ({ merged }) => onChange?.(merged),
    onReset: (baseText) => onChange?.(baseText),
  });
  const { voiceState, voiceError, elapsed, micEnabled } = voice;

  const canSend =
    !disabled &&
    !offline &&
    !running &&
    voiceState !== 'recording' &&
    processingFiles.length === 0 &&
    (Boolean(value.trim()) || files.length > 0);

  async function handleSend() {
    if (!canSend) return;
    voice.freeze();
    const pending = files.slice();
    setFiles([]);
    setFileError('');
    setProcessingFiles(pending);
    try {
      await onSend?.(value, pending);
    } catch (error) {
      if (error?.code === 'ATTACHMENT_ABORT') {
        setFiles(pending);
      }
    } finally {
      setProcessingFiles([]);
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  function handleDraftChange(nextValue) {
    if (voice.isLive() && nextValue !== voice.getLastApplied()) {
      // User edited away from the latest ASR hypothesis — stop overwriting.
      voice.freeze();
    }
    onChange?.(nextValue);
  }

  return (
    <div className="border-t border-[var(--border)] bg-[var(--surface-card)] px-3 py-3 sm:px-4">
      {(statusText || offline || voiceError || fileError || voiceState === 'recording' || liveVoice?.active || liveVoice?.error) && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
          {offline ? <span>Offline — sending disabled</span> : null}
          {!offline && statusText ? <span>{statusText}</span> : null}
          {voiceState === 'recording' ? (
            <Badge variant="destructive" pill>
              Recording {elapsed}s / {VOICE_MAX_SECONDS}s
            </Badge>
          ) : null}
          {liveVoice?.active ? (
            <Badge variant="secondary" pill>
              Live voice: {liveVoice.status}
              {liveVoice.status !== 'idle' ? (
                <button
                  type="button"
                  className="ml-1 underline"
                  onClick={liveVoice.toggleMute}
                >
                  {liveVoice.muted ? 'unmute' : 'mute'}
                </button>
              ) : null}
            </Badge>
          ) : null}
          {liveVoice?.error ? (
            <span className="text-[var(--error)]">{liveVoice.error}</span>
          ) : null}
          {voiceError ? (
            <span className="text-[var(--error)]">{voiceError}</span>
          ) : null}
          {fileError ? (
            <span className="text-[var(--error)]">{fileError}</span>
          ) : null}
        </div>
      )}
      {processingFiles.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {processingFiles.map((file, index) => (
            <Badge key={`processing-${file.name}-${index}`} variant="secondary">
              <Loader2 size={12} className="mr-1 animate-spin" />
              {file.name}
            </Badge>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((file, index) => (
            <Badge key={`${file.name}-${index}`} variant="secondary">
              {file.name}
              <button
                type="button"
                className="ml-1 opacity-70 hover:opacity-100"
                onClick={() =>
                  setFiles((current) => current.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <input
          ref={fileRef}
          type="file"
          accept={ATTACH_ACCEPT}
          className="hidden"
          multiple
          onChange={(event) => {
            const selected = Array.from(event.target.files || []);
            const oversized = selected.filter(
              (file) => file.size > MAX_ATTACH_BYTES,
            );
            if (oversized.length > 0) {
              setFileError(
                `Too large (max 50 MB): ${oversized.map((file) => file.name).join(', ')}`,
              );
            } else {
              setFileError('');
            }
            const allowed = selected.filter(
              (file) => file.size <= MAX_ATTACH_BYTES,
            );
            if (allowed.length) {
              setFiles((current) =>
                [...current, ...allowed].slice(0, MAX_ATTACH_COUNT),
              );
            }
            event.target.value = '';
          }}
        />
        <Textarea
          value={value}
          onChange={(event) => handleDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || offline || voiceState === 'recording'}
          placeholder={
            offline
              ? 'Reconnect to send messages…'
              : voiceState === 'recording'
                ? 'Listening… transcript appears here'
                : 'Message Hermes… (Enter to send, Shift+Enter for newline)'
          }
          className={cn(
            'min-h-[52px] max-h-40 w-full resize-none bg-[var(--surface-container-low)]',
          )}
          rows={2}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="shrink-0"
            disabled={disabled || offline || voiceState === 'recording'}
            onClick={() => fileRef.current?.click()}
            aria-label="Attach file"
            title="Attach file (image, PDF, Office document, text)"
          >
            <Paperclip size={18} />
          </Button>
          {voiceState === 'recording' ? (
            <>
              <Button
                type="button"
                size="icon"
                variant="destructive"
                className="shrink-0"
                onClick={voice.stop}
                aria-label="Stop recording"
                title="Stop recording"
              >
                <Square size={16} />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={voice.cancel}
                aria-label="Cancel recording"
                title="Cancel recording"
              >
                <MicOff size={18} />
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="shrink-0"
              disabled={!micEnabled || liveVoice?.active}
              onClick={() => voice.start(value)}
              aria-label="Voice input"
              title="Voice input (Qwen realtime ASR)"
            >
              <Mic size={18} />
            </Button>
          )}
          {liveVoice ? (
            <Button
              type="button"
              size="icon"
              variant={liveVoice.active ? 'destructive' : 'ghost'}
              className={cn(
                'shrink-0',
                liveVoice.active && liveVoice.status === 'listening' && 'animate-pulse',
              )}
              disabled={disabled || offline || voiceState === 'recording'}
              onClick={liveVoice.onToggle}
              aria-label={liveVoice.active ? 'End live voice' : 'Start live voice'}
              title={
                liveVoice.active
                  ? `End live voice (${liveVoice.status})`
                  : 'Live voice — full-duplex Qwen realtime, delegates to Hermes'
              }
            >
              <AudioLines size={18} />
            </Button>
          ) : null}
          <div
            className="mx-0.5 h-5 w-px shrink-0 bg-[var(--border)]"
            aria-hidden="true"
          />
          <ModelPicker
            models={models}
            currentModel={currentModel}
            currentTier={currentTier}
            pendingModel={pendingModel}
            loading={modelsLoading}
            switching={modelSwitching}
            disabled={disabled || offline}
            onSelect={onSwitchModel}
          />
          <div className="flex-1" />
          {running ? (
            <Button
              type="button"
              variant="destructive"
              className="shrink-0"
              onClick={() => onStop?.()}
            >
              <Square size={16} />
              Stop
            </Button>
          ) : (
            <Button
              type="button"
              className="shrink-0"
              disabled={!canSend}
              onClick={handleSend}
            >
              <SendHorizontal size={16} />
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
