'use client';

import React from 'react';
import Link from 'next/link';
import { Ban, CircleAlert, CircleCheckBig, Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const STEP_LABELS = {
  upload: 'Uploading audio',
  queued: 'Queued',
  asr: 'Transcribing with Qwen ASR',
  clean: 'Cleaning transcript',
  clean_metadata: 'Extracting meeting metadata',
  parse_supplementary: 'Reading supplementary documents',
  format: 'Formatting with opencode agent',
  summary_zh: 'Writing 中文总结',
  summary_zh_synthesize: 'Synthesizing 中文总结',
  summary_en: 'Writing English summary',
  summary_en_synthesize: 'Synthesizing English summary',
  tasks: 'Creating task notes',
  assemble: 'Assembling note',
  write: 'Writing to vault',
  done: 'Done',
  failed: 'Failed',
};

const STEP_ORDER = [
  'upload',
  'queued',
  'asr',
  'clean',
  'parse_supplementary',
  'format',
  'summary_zh',
  'summary_en',
  'tasks',
  'assemble',
  'write',
  'done',
];

function stepFamily(step) {
  if (step?.startsWith('clean_')) return 'clean';
  if (step?.startsWith('summary_zh_')) return 'summary_zh';
  if (step?.startsWith('summary_en_')) return 'summary_en';
  return step;
}

function labelForStep(step, status) {
  const chunkMatch = step?.match(
    /^(clean|summary_zh|summary_en)_chunk_(\d+)_of_(\d+)$/,
  );
  if (chunkMatch) {
    const label = STEP_LABELS[chunkMatch[1]] || status;
    return `${label} chunk ${chunkMatch[2]}/${chunkMatch[3]}`;
  }
  const retryMatch = step?.match(
    /^clean_chunk_(\d+)_of_(\d+)_retry_(\d+)_(\d+)_of_(\d+)$/,
  );
  if (retryMatch) {
    return `Cleaning transcript chunk ${retryMatch[1]}/${retryMatch[2]} retry ${retryMatch[3]} part ${retryMatch[4]}/${retryMatch[5]}`;
  }
  return STEP_LABELS[step] || status;
}

function progressFor(job) {
  if (job.status === 'failed') return 100;
  const idx = Math.max(0, STEP_ORDER.indexOf(stepFamily(job.step)));
  return Math.round(((idx + 1) / STEP_ORDER.length) * 100);
}

function elapsed(job) {
  const start = new Date(
    job.startedAt || job.createdAt || Date.now(),
  ).getTime();
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function noteName(outputPath) {
  if (!outputPath) return '';
  return outputPath.split('/').pop() || outputPath;
}

function fileCounts(job) {
  const audio = Array.isArray(job.audioFiles) ? job.audioFiles.length : 0;
  const supp = Array.isArray(job.supplementaryFiles)
    ? job.supplementaryFiles.length
    : 0;
  const parts = [];
  if (audio > 1) parts.push(`${audio} audio parts`);
  else if (audio === 1) parts.push('1 audio part');
  if (supp > 0) parts.push(`${supp} supplementary`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

export default function MeetingJobCard({ job, onDismiss, onCancel }) {
  const failed = job.status === 'failed';
  const done = job.status === 'done';
  const cancelled = job.status === 'cancelled';
  const active = !failed && !done && !cancelled;
  const label = labelForStep(job.step, job.status);
  const percent = progressFor(job);

  return (
    <Card data-interactive="true">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {failed ? (
                <CircleAlert size={15} className="text-[var(--error)]" />
              ) : cancelled ? (
                <Ban size={15} className="text-[var(--text-muted)]" />
              ) : done ? (
                <CircleCheckBig size={15} />
              ) : (
                <Loader2 size={15} className="animate-spin" />
              )}
              <h3 className="truncate text-sm font-semibold text-[var(--text-primary)]">
                {job.audioName}
              </h3>
            </div>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              {label} · elapsed {elapsed(job)}
              {job.asrChars
                ? ` · ${job.asrChars.toLocaleString()} transcript chars`
                : ''}
              {fileCounts(job)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant={
                failed
                  ? 'destructive'
                  : cancelled
                    ? 'outline'
                    : done
                      ? 'status-done'
                      : 'secondary'
              }
            >
              {job.status}
            </Badge>
            {active && (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 px-3 text-xs text-[var(--error)] hover:text-[var(--error)]"
                onClick={() => onCancel?.(job.id)}
                aria-label={`Cancel ${job.audioName}`}
              >
                <Ban size={13} />
              </Button>
            )}
            {(failed || done || cancelled) && (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 min-w-11 px-3"
                onClick={() => onDismiss?.(job.id)}
                aria-label={`Dismiss ${job.audioName}`}
              >
                <X size={13} />
              </Button>
            )}
          </div>
        </div>

        <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-container)]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>

        {job.error && (
          <p className="mt-2 text-xs text-[var(--error)]">{job.error}</p>
        )}
        {job.outputPath && (
          <div className="mt-2 text-xs">
            <span className="text-[var(--text-secondary)]">Saved note: </span>
            <Link
              href={`/vault?path=${encodeURIComponent(job.outputPath)}`}
              className="font-semibold text-[var(--accent)]"
            >
              {noteName(job.outputPath)}
            </Link>
            <div className="mt-1 font-mono text-xs text-[var(--text-muted)]">
              {job.outputPath}
            </div>
          </div>
        )}
        {job.opencodeShareUrl && (
          <div className="mt-1 text-xs">
            <span className="text-[var(--text-secondary)]">
              opencode session:{' '}
            </span>
            <Link
              href={job.opencodeShareUrl}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-[var(--accent)]"
            >
              view run
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
