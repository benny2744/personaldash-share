'use client';

import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  CloudUpload,
  X,
  GripVertical,
  ArrowUp,
  ArrowDown,
  FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'calculating...';
  if (seconds < 1) return '<1s';
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  if (minutes <= 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, '0')}s`;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_PART_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

/**
 * Legacy single-POST upload (unchanged from original). Used when the total
 * submission is comfortably under the chunk threshold.
 */
function uploadFilesLegacy(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/meetings/process');
    request.responseType = 'json';

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    };

    request.onload = () => {
      const payload = request.response || {};
      if (request.status >= 200 && request.status < 300) {
        resolve(payload);
        return;
      }
      reject(new Error(payload.error || `Upload failed (${request.status})`));
    };

    request.onerror = () =>
      reject(new Error('Upload failed due to a network error'));
    request.onabort = () => reject(new Error('Upload cancelled'));
    request.send(formData);
  });
}

/**
 * PUT a single Blob as raw binary with progress. Retries on network errors and
 * transient (429/5xx) statuses with exponential backoff.
 */
function putBlob(url, blob, { headers = {}, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.responseType = 'json';
    for (const [key, value] of Object.entries(headers)) {
      request.setRequestHeader(key, value);
    }

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded, event.total);
      }
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve({ status: request.status, body: request.response });
      } else {
        const err = new Error(
          (request.response && request.response.error) ||
            `PUT failed (${request.status})`,
        );
        err.status = request.status;
        reject(err);
      }
    };

    request.onerror = () => {
      const err = new Error('Network error');
      err.status = 0;
      reject(err);
    };
    request.onabort = () => reject(new Error('Upload cancelled'));

    if (signal) {
      if (signal.aborted) {
        request.abort();
        return;
      }
      signal.addEventListener('abort', () => request.abort(), { once: true });
    }

    request.send(blob);
  });
}

async function putBlobWithRetry(url, blob, options) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_PART_RETRIES; attempt += 1) {
    try {
      return await putBlob(url, blob, options);
    } catch (error) {
      lastError = error;
      const retryable =
        error.status === 0 || RETRYABLE_STATUS.has(error.status);
      if (!retryable || attempt === MAX_PART_RETRIES) throw error;
      const backoff = BASE_BACKOFF_MS * 2 ** attempt;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastError;
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) =>
    res.json().then((data) => {
      if (!res.ok)
        throw new Error(data.error || `Request failed (${res.status})`);
      return { status: res.status, body: data };
    }),
  );
}

function postEmpty(url) {
  return fetch(url, { method: 'POST' }).then((res) =>
    res.json().then((data) => {
      if (!res.ok)
        throw new Error(data.error || `Request failed (${res.status})`);
      return { status: res.status, body: data };
    }),
  );
}

function FileRow({ file, index, listLength, onMove, onRemove }) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-[var(--outline)] bg-[var(--surface-container-lowest)] px-2 py-1.5 text-xs">
      <GripVertical size={14} className="text-[var(--text-muted)]" />
      <span className="flex-1 truncate text-[var(--text-primary)]">
        {file.name}
      </span>
      <span className="text-[var(--text-muted)]">{formatBytes(file.size)}</span>
      <button
        type="button"
        onClick={() => onMove(index, -1)}
        disabled={index === 0}
        className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30"
        aria-label="Move up"
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        onClick={() => onMove(index, 1)}
        disabled={index >= listLength - 1}
        className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30"
        aria-label="Move down"
      >
        <ArrowDown size={14} />
      </button>
      <button
        type="button"
        onClick={() => onRemove(index)}
        className="p-1 text-[var(--text-muted)] hover:text-[var(--error)]"
        aria-label="Remove"
      >
        <X size={14} />
      </button>
    </li>
  );
}

export default function MeetingUploader({ onJobCreated }) {
  const audioInputRef = useRef(null);
  const supplementaryInputRef = useRef(null);
  const progressRef = useRef({ loaded: 0, time: 0 });
  const cancelRef = useRef(null);
  const [audioFiles, setAudioFiles] = useState([]);
  const [supplementaryFiles, setSupplementaryFiles] = useState([]);
  const [participantsText, setParticipantsText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [chunkConfig, setChunkConfig] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/meetings/uploads/config')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setChunkConfig(data);
      })
      .catch(() => {
        if (!cancelled) setChunkConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const totalBytes = [...audioFiles, ...supplementaryFiles].reduce(
    (sum, file) => sum + (file.size || 0),
    0,
  );

  const useChunked = !!chunkConfig && totalBytes >= chunkConfig.chunkThreshold;

  const moveAudio = useCallback((index, direction) => {
    setAudioFiles((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const removeAudio = useCallback((index) => {
    setAudioFiles((current) => current.filter((_, i) => i !== index));
  }, []);

  const addAudioFiles = useCallback((files) => {
    setAudioFiles((current) => [...current, ...Array.from(files)]);
  }, []);

  const addSupplementaryFiles = useCallback((files) => {
    setSupplementaryFiles((current) => [...current, ...Array.from(files)]);
  }, []);

  const removeSupplementary = useCallback((index) => {
    setSupplementaryFiles((current) => current.filter((_, i) => i !== index));
  }, []);

  const updateProgress = useCallback((loaded, total, label) => {
    const now = Date.now();
    const previous = progressRef.current;
    const elapsed = Math.max((now - previous.time) / 1000, 0.001);
    const delta = Math.max(loaded - previous.loaded, 0);
    const instantSpeed = delta / elapsed;
    progressRef.current = { loaded, time: now };

    setProgress((current) => {
      const previousSpeed = current?.speedBytesPerSec || instantSpeed;
      const speedBytesPerSec = previousSpeed
        ? previousSpeed * 0.7 + instantSpeed * 0.3
        : instantSpeed;
      const remaining = Math.max(total - loaded, 0);
      return {
        loaded,
        total,
        percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
        speedBytesPerSec,
        etaSeconds:
          speedBytesPerSec > 0 && remaining > 0
            ? remaining / speedBytesPerSec
            : 0,
        finalizing: loaded >= total,
        label: label ?? current?.label,
      };
    });
  }, []);

  const initProgress = useCallback((total) => {
    progressRef.current = { loaded: 0, time: Date.now() };
    setProgress({
      loaded: 0,
      total,
      percent: 0,
      speedBytesPerSec: 0,
      etaSeconds: null,
      finalizing: false,
      label: null,
    });
  }, []);

  /**
   * Chunked upload flow: one job for the whole submission.
   * init → (per upload: single PUT or N part PUTs) → complete.
   */
  const submitChunked = useCallback(
    async (allFiles) => {
      const { audioFiles: audios, supplementaryFiles: supps } = allFiles;
      const cfg = chunkConfig;

      for (const file of audios) {
        if (file.size > cfg.maxBytes) {
          throw new Error(
            `${file.name} exceeds the ${formatBytes(cfg.maxBytes)} limit`,
          );
        }
      }

      const submissionId =
        (typeof crypto !== 'undefined' && crypto.randomUUID?.()) ||
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const abortController = new AbortController();
      cancelRef.current = abortController;
      const signal = abortController.signal;

      const initBody = {
        submissionId,
        audioFiles: audios.map((f) => ({
          name: f.name,
          size: f.size,
          type: f.type,
        })),
        supplementaryFiles: supps.map((f) => ({
          name: f.name,
          size: f.size,
          type: f.type,
        })),
        participantsText: participantsText.trim() || undefined,
      };

      const initRes = await postJson('/api/meetings/uploads/init', initBody);
      const { jobId, uploads } = initRes.body;

      try {
        let cumulativeLoaded = 0;

        for (const upload of uploads) {
          if (signal.aborted) throw new Error('Upload cancelled');

          const file =
            upload.kind === 'audio'
              ? audios[upload.fileIndex]
              : supps[upload.fileIndex];
          const fileLabel =
            uploads.length > 1
              ? ` (${upload.kind === 'audio' ? 'audio' : 'supp'} ${upload.fileIndex + 1}/${uploads.length})`
              : '';

          if (upload.mode === 'single') {
            const baseLoaded = cumulativeLoaded;
            await putBlobWithRetry(`/api/meetings/uploads/${upload.id}`, file, {
              headers: {
                'Content-Type': file.type || 'application/octet-stream',
              },
              onProgress: (loaded, _total) => {
                updateProgress(baseLoaded + loaded, totalBytes, fileLabel);
              },
              signal,
            });
            cumulativeLoaded += file.size;
          } else {
            const expectedParts = upload.expectedParts;
            const baseLoaded = cumulativeLoaded;
            for (let n = 1; n <= expectedParts; n += 1) {
              if (signal.aborted) throw new Error('Upload cancelled');
              const start = (n - 1) * cfg.chunkSize;
              const end = Math.min(start + cfg.chunkSize, file.size);
              const chunk = file.slice(start, end);
              const partLabel = `${fileLabel} · part ${n}/${expectedParts}`;
              const partBase = baseLoaded + (n - 1) * cfg.chunkSize;
              await putBlobWithRetry(
                `/api/meetings/uploads/${upload.id}/parts/${n}`,
                chunk,
                {
                  headers: { 'Content-Type': 'application/octet-stream' },
                  onProgress: (loaded, _total) => {
                    updateProgress(partBase + loaded, totalBytes, partLabel);
                  },
                  signal,
                },
              );
            }
            cumulativeLoaded += file.size;
          }
        }

        updateProgress(totalBytes, totalBytes, 'Finalizing...');
        const completeRes = await postEmpty(
          `/api/meetings/uploads/${jobId}/complete`,
        );
        onJobCreated?.(completeRes.body);
        return completeRes.body;
      } catch (err) {
        // Best-effort abort so we don't leave orphaned multipart sessions.
        await postEmpty(`/api/meetings/uploads/${jobId}/abort`).catch(() => {});
        throw err;
      }
    },
    [chunkConfig, onJobCreated, participantsText, totalBytes, updateProgress],
  );

  const submitLegacy = useCallback(
    async (audios, supps) => {
      const formData = new FormData();
      audios.forEach((file, index) => {
        formData.append(index === 0 ? 'audio' : `audio-${index}`, file);
      });
      supps.forEach((file, index) => {
        formData.append(
          index === 0 ? 'supplementary' : `supplementary-${index}`,
          file,
        );
      });
      if (participantsText.trim()) {
        formData.append('participants', participantsText.trim());
      }

      const payload = await uploadFilesLegacy(formData, (loaded, total) =>
        updateProgress(loaded, total),
      );
      onJobCreated?.(payload);
      return payload;
    },
    [onJobCreated, updateProgress, participantsText],
  );

  const submit = async () => {
    if (!audioFiles.length || uploading) return;
    setUploading(true);
    setError(null);
    initProgress(totalBytes);

    try {
      if (useChunked) {
        await submitChunked({ audioFiles, supplementaryFiles });
      } else {
        await submitLegacy(audioFiles, supplementaryFiles);
      }
      setAudioFiles([]);
      setSupplementaryFiles([]);
      setParticipantsText('');
      setProgress(null);
      if (audioInputRef.current) audioInputRef.current.value = '';
      if (supplementaryInputRef.current)
        supplementaryInputRef.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      cancelRef.current = null;
    }
  };

  const cancel = useCallback(() => {
    if (cancelRef.current) {
      cancelRef.current.abort();
    }
  }, []);

  return (
    <div className="rounded-lg border border-dashed border-[var(--outline)] bg-[var(--surface-container-low)] p-4">
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-[var(--surface-container-highest)] p-2">
            <CloudUpload size={18} className="text-[var(--text-secondary)]" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-[var(--text-primary)]">
              Create Meeting Notes From Audio
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              Upload one or more audio files in order, plus optional
              supplementary documents.
            </p>
          </div>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="meeting-participants"
            className="text-xs font-medium text-[var(--text-primary)]"
          >
            Participants / groups (optional)
          </label>
          <input
            id="meeting-participants"
            type="text"
            value={participantsText}
            onChange={(event) => setParticipantsText(event.target.value)}
            placeholder="e.g. Alex, leadership team, IT team"
            disabled={uploading}
            className="w-full rounded-md border border-[var(--outline)] bg-[var(--surface-container-lowest)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
          />
          <p className="text-[0.68rem] text-[var(--text-muted)]">
            Names and team names are used as hints to resolve attendees/people
            more accurately; they do not override the transcript analysis.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium text-[var(--text-primary)]">
              Audio files (merge order)
            </label>
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*"
              multiple
              onChange={(event) => {
                addAudioFiles(event.target.files);
                event.target.value = '';
              }}
              className="w-full text-xs"
              disabled={uploading}
            />
            {audioFiles.length > 0 && (
              <ul className="space-y-1">
                {audioFiles.map((file, index) => (
                  <FileRow
                    key={`${file.name}-${index}`}
                    file={file}
                    index={index}
                    listLength={audioFiles.length}
                    onMove={moveAudio}
                    onRemove={removeAudio}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-[var(--text-primary)]">
              Supplementary materials (optional)
            </label>
            <input
              ref={supplementaryInputRef}
              type="file"
              multiple
              onChange={(event) => {
                addSupplementaryFiles(event.target.files);
                event.target.value = '';
              }}
              className="w-full text-xs"
              disabled={uploading}
            />
            {supplementaryFiles.length > 0 && (
              <ul className="space-y-1">
                {supplementaryFiles.map((file, index) => (
                  <li
                    key={`${file.name}-${index}`}
                    className="flex items-center gap-2 rounded-md border border-[var(--outline)] bg-[var(--surface-container-lowest)] px-2 py-1.5 text-xs"
                  >
                    <FileText size={14} className="text-[var(--text-muted)]" />
                    <span className="flex-1 truncate text-[var(--text-primary)]">
                      {file.name}
                    </span>
                    <span className="text-[var(--text-muted)]">
                      {formatBytes(file.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeSupplementary(index)}
                      className="p-1 text-[var(--text-muted)] hover:text-[var(--error)]"
                      aria-label="Remove"
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {progress && (
          <div className="space-y-1.5">
            <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-container-highest)]">
              <div
                className="h-full rounded-full bg-blue-600 transition-all duration-200"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[0.72rem] text-[var(--text-muted)]">
              <span>
                {progress.percent}% · {formatBytes(progress.loaded)} /{' '}
                {formatBytes(progress.total)}
                {progress.label ? ` · ${progress.label}` : ''}
              </span>
              <span>
                {progress.finalizing
                  ? 'Finalizing upload...'
                  : `${formatBytes(progress.speedBytesPerSec)}/s · ETA ${formatDuration(progress.etaSeconds)}`}
              </span>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {uploading && useChunked && (
            <Button
              type="button"
              variant="outline"
              onClick={cancel}
              className="h-8 text-xs"
            >
              Cancel
            </Button>
          )}
          <Button
            type="button"
            onClick={submit}
            disabled={!audioFiles.length || uploading}
            className="h-8 text-xs"
          >
            {uploading ? 'Uploading...' : 'Upload'}
          </Button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-[var(--error)]">{error}</p>}
    </div>
  );
}
