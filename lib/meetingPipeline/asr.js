import config from '@/lib/config';
import { getTierOverride } from '@/lib/llmTiers';

/** ASR tier override (settings page) — null keeps env-driven QWEN_FILETRANS_* values. */
async function asrTierConfig() {
  const t = await getTierOverride('asr');
  return t
    ? {
        baseUrl: t.baseUrl.replace(/\/$/, ''),
        model: t.model,
      }
    : {
        baseUrl: config.qwenFiletransBaseUrl.replace(/\/$/, ''),
        model: config.qwenFiletransModel,
      };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (!bytes) return 'unknown';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(2)} MB` : `${bytes} bytes`;
}

function logAsr(message, meta = {}) {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[meeting-pipeline][asr] ${message}${metaStr}`);
}

function requireAsrConfig() {
  if (!config.qwenAsrApiKey) {
    throw new Error('Missing QWEN_ASR_API_KEY for meeting ASR');
  }
}

const ASR_FETCH_ATTEMPTS = 4;
const ASR_RETRY_BASE_MS = 1000;
const ASR_RETRY_MAX_MS = 15000;
const RETRYABLE_FETCH_CODES = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

function fetchErrorCode(error) {
  return error?.cause?.code || error?.code || error?.name || '';
}

/** True for transient transport/HTTP errors worth retrying (exported for tests). */
export function isRetryableAsrFetchError(error) {
  if (error?.retryableHttp === true) return true;
  const code = fetchErrorCode(error);
  return RETRYABLE_FETCH_CODES.has(code) || code === 'TimeoutError';
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

/** Backoff delay for an attempt, honoring Retry-After (exported for tests). */
export function asrRetryDelayMs(error, attempt) {
  return Math.min(
    retryAfterMs(error?.retryAfter) ?? ASR_RETRY_BASE_MS * 2 ** (attempt - 1),
    ASR_RETRY_MAX_MS,
  );
}

function describeError(error) {
  const cause = error?.cause;
  if (cause?.code) return `${error?.message || error}: ${cause.code}`;
  return error instanceof Error ? error.message : String(error);
}

async function requestJson(url, options) {
  let lastError = null;
  for (let attempt = 1; attempt <= ASR_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const raw = await response.text();
      let payload = {};
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = { raw };
        }
      }
      if (!response.ok) {
        lastError = Object.assign(
          new Error(`ASR HTTP ${response.status}: ${raw.slice(0, 500)}`),
          {
            retryableHttp: RETRYABLE_HTTP_STATUSES.has(response.status),
            retryAfter: response.headers.get('retry-after'),
            status: response.status,
          },
        );
        if (!lastError.retryableHttp || attempt === ASR_FETCH_ATTEMPTS) {
          throw lastError;
        }
      } else {
        return payload;
      }
    } catch (error) {
      if (error === lastError) throw error; // already thrown above
      lastError = error;
      if (!isRetryableAsrFetchError(error) || attempt === ASR_FETCH_ATTEMPTS) {
        throw error;
      }
    }
    const delayMs = asrRetryDelayMs(lastError, attempt);
    logAsr(
      `fetch attempt ${attempt}/${ASR_FETCH_ATTEMPTS} failed; retrying in ${Math.round(delayMs)}ms: ${describeError(lastError)}`,
    );
    await sleep(delayMs);
  }
  throw lastError;
}

export async function submitAsrTask(
  fileUrl,
  { language, audioSize, bitrateKbps } = {},
) {
  requireAsrConfig();
  const tier = await asrTierConfig();

  const body = {
    model: tier.model,
    input: { file_url: fileUrl },
    parameters: {
      enable_itn: false,
      channel_id: [0],
    },
  };
  if (language) body.parameters.language = language;

  const payload = await requestJson(
    `${tier.baseUrl}/services/audio/asr/transcription`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.qwenAsrApiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(body),
    },
  );

  const taskId = payload?.output?.task_id;
  if (!taskId) {
    throw new Error(
      `ASR submit response missing task_id: ${JSON.stringify(payload).slice(0, 500)}`,
    );
  }
  logAsr('submitted ASR task', {
    taskId,
    audioSize: formatBytes(audioSize),
    timeoutSec: config.qwenAsrTimeoutForSize(audioSize, { bitrateKbps }),
  });
  return taskId;
}

export async function pollAsrTask(
  taskId,
  { audioSize, bitrateKbps, onPoll, throwIfCancelled } = {},
) {
  requireAsrConfig();

  const timeoutSec = config.qwenAsrTimeoutForSize(audioSize, { bitrateKbps });
  const startedAt = Date.now();
  const { baseUrl } = await asrTierConfig();
  let pollCount = 0;
  let firstPollAt = null;
  let lastStatus = null;

  while (Date.now() - startedAt < timeoutSec * 1000) {
    const payload = await requestJson(
      `${baseUrl}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.qwenAsrApiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
        },
      },
    );

    pollCount += 1;
    if (firstPollAt === null) firstPollAt = Date.now();
    const status = payload?.output?.task_status;
    lastStatus = status;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    await onPoll?.({ status, pollCount, elapsedSec, timeoutSec });

    if (status === 'SUCCEEDED') {
      logAsr('ASR task succeeded', {
        taskId,
        elapsedSec,
        pollCount,
        queueSec: Math.round((firstPollAt - startedAt) / 1000),
      });
      return { ...payload, elapsedSec, pollCount };
    }
    if (status === 'FAILED') {
      const code = payload?.output?.code || 'UNKNOWN';
      const message = payload?.output?.message || '';
      logAsr('ASR task failed', {
        taskId,
        elapsedSec,
        pollCount,
        code,
        message,
      });
      throw new Error(`ASR task failed: ${code} ${message}`.trim());
    }

    await throwIfCancelled?.();

    await sleep(3000);
  }

  logAsr('ASR task timed out locally', {
    taskId,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    pollCount,
    lastStatus,
    timeoutSec,
  });
  throw new Error(`Timed out waiting for ASR task ${taskId}`);
}

export async function fetchTranscriptPayload(transcriptionUrl) {
  return requestJson(transcriptionUrl, { method: 'GET' });
}

export function transcriptText(payload) {
  const transcripts = payload?.transcripts || [];
  return transcripts
    .map((item) => item?.text?.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function finalizeAsrResult(taskId, taskPayload) {
  const transcriptionUrl = taskPayload?.output?.result?.transcription_url;
  if (!transcriptionUrl) {
    throw new Error(
      `ASR succeeded without transcription_url: ${JSON.stringify(taskPayload).slice(0, 500)}`,
    );
  }

  return { taskId, taskPayload, transcriptionUrl };
}

async function transcriptFromTask(taskId, taskPayload) {
  const { transcriptionUrl } = finalizeAsrResult(taskId, taskPayload);
  const transcriptPayload = await fetchTranscriptPayload(transcriptionUrl);
  const text = transcriptText(transcriptPayload);
  if (!text) {
    throw new Error('ASR result contained no transcript text');
  }

  return {
    taskId,
    text,
    transcriptionUrl,
    elapsedSec: taskPayload.elapsedSec,
    pollCount: taskPayload.pollCount,
  };
}

/**
 * Resume an already-submitted async ASR task (poll only, no re-submit).
 * Used when a job is retried after a local poll timeout or container restart
 * while the remote task kept running. Throws if the task itself failed.
 */
export async function runAsrFromTask(
  taskId,
  { audioSize, bitrateKbps, onPoll, throwIfCancelled } = {},
) {
  const taskPayload = await pollAsrTask(taskId, {
    audioSize,
    bitrateKbps,
    onPoll,
    throwIfCancelled,
  });
  return transcriptFromTask(taskId, taskPayload);
}

export async function runAsr(
  fileUrl,
  { language, audioSize, bitrateKbps, onTaskId, onPoll, throwIfCancelled } = {},
) {
  const taskId = await submitAsrTask(fileUrl, {
    language,
    audioSize,
    bitrateKbps,
  });
  await onTaskId?.(taskId);

  const taskPayload = await pollAsrTask(taskId, {
    audioSize,
    bitrateKbps,
    onPoll,
    throwIfCancelled,
  });
  return transcriptFromTask(taskId, taskPayload);
}
