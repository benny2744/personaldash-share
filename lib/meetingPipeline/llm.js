import config from '@/lib/config';
import { getTierOverride } from '@/lib/llmTiers';

const LLM_FETCH_ATTEMPTS = 4;
const LLM_FETCH_RETRY_BASE_MS = 1000;
const LLM_FETCH_MAX_RETRY_MS = 30000;
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

function providerName() {
  return String(config.meetingLlmProvider || 'qwen').toLowerCase();
}

function apiKeyForProvider(provider) {
  if (config.meetingLlmApiKey) return config.meetingLlmApiKey;
  if (provider === 'mimo') return config.mimoApiKey;
  if (provider === 'zai') return config.zaiApiKey;
  if (provider === 'qwen') return config.qwenAsrApiKey;
  return '';
}

async function parseJsonResponse(response) {
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
    throw Object.assign(
      new Error(`LLM HTTP ${response.status}: ${raw.slice(0, 800)}`),
      {
        retryableHttp: response.status === 429 || response.status >= 500,
        retryAfter: response.headers.get('retry-after'),
        status: response.status,
      },
    );
  }
  return payload;
}

function describeFetchError(error) {
  const cause = error?.cause;
  if (cause?.code === 'UND_ERR_HEADERS_TIMEOUT') {
    return 'timed out waiting for response headers (UND_ERR_HEADERS_TIMEOUT)';
  }
  if (cause?.code) {
    return `${error.message} (${cause.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

function fetchErrorCode(error) {
  return error?.cause?.code || error?.code || error?.name || '';
}

function isRetryableFetchError(error) {
  const code = fetchErrorCode(error);
  return (
    RETRYABLE_FETCH_CODES.has(code) ||
    code === 'TimeoutError' ||
    error?.name === 'AbortError' ||
    error?.retryableHttp === true
  );
}

function retryAfterMs(value) {
  if (!value) return null;

  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function retryDelayMs(error, attempt) {
  return Math.min(
    retryAfterMs(error?.retryAfter) ??
      LLM_FETCH_RETRY_BASE_MS * 2 ** (attempt - 1),
    LLM_FETCH_MAX_RETRY_MS,
  );
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestLlmJson(url, options, label, validate) {
  let lastError = null;

  for (let attempt = 1; attempt <= LLM_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(config.meetingLlmTimeoutSec * 1000),
      });
      const payload = await parseJsonResponse(response);
      try {
        validate?.(payload);
      } catch (validationError) {
        // Providers occasionally return 200 with empty content (reasoning-only
        // output the adapter doesn't surface). Treat it like any other retryable
        // pathology so a single flaky response can't fail a whole meeting.
        throw Object.assign(validationError, {
          validationError: true,
          retryableHttp: true,
        });
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (!isRetryableFetchError(error) || attempt === LLM_FETCH_ATTEMPTS) {
        break;
      }

      const delayMs = retryDelayMs(error, attempt);
      console.warn(
        `[meeting-pipeline] LLM fetch attempt ${attempt}/${LLM_FETCH_ATTEMPTS} failed; retrying in ${Math.round(delayMs)}ms: ${describeFetchError(error)}`,
      );
      await wait(delayMs);
    }
  }

  if (lastError?.validationError) {
    // Preserve the specific diagnosis (e.g. "missing message content") after
    // retries are exhausted so upstream fallback logic can classify it.
    throw lastError;
  }

  throw new Error(
    `LLM fetch failed for ${label || `${providerName()}/${config.meetingLlmModel}`} after ${LLM_FETCH_ATTEMPTS} attempts: ${describeFetchError(lastError)}`,
  );
}

function messageText(payload) {
  return payload?.choices?.[0]?.message?.content?.trim() || '';
}

function missingContentMessage(payload) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const reasoningLength = String(message.reasoning_content || '').length;
  const finishReason = choice.finish_reason || 'unknown';
  if (reasoningLength > 0 && !message.content) {
    return `LLM produced reasoning only with no answer content (finish_reason=${finishReason}, reasoning_chars=${reasoningLength})`;
  }
  return `LLM response missing message content (finish_reason=${finishReason})`;
}

function authHeaders(apiKey, authHeader = 'authorization') {
  if (authHeader === 'api-key') {
    return { 'api-key': apiKey };
  }

  return { Authorization: `Bearer ${apiKey}` };
}

function tokenField(provider, maxTokens) {
  if (provider === 'mimo') {
    return { max_completion_tokens: maxTokens };
  }

  return { max_tokens: maxTokens };
}

async function completeOpenAiCompatible({
  baseUrl,
  apiKey,
  system,
  user,
  maxTokens,
  temperature,
  authHeader,
  provider = providerName(),
  model = config.meetingLlmModel,
}) {
  const payload = await requestLlmJson(
    `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(apiKey, authHeader),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...tokenField(provider, maxTokens),
        temperature,
      }),
    },
    `${provider}/${model}`,
    (body) => {
      if (!messageText(body)) throw new Error(missingContentMessage(body));
    },
  );

  return messageText(payload);
}

async function completeAnthropic({
  apiKey,
  baseUrl: baseUrlOverride,
  system,
  user,
  maxTokens,
  temperature,
  model = config.meetingLlmModel,
}) {
  const baseUrl = baseUrlOverride || config.meetingLlmBaseUrl || 'https://api.anthropic.com/v1';
  const payload = await requestLlmJson(
    `${baseUrl.replace(/\/$/, '')}/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: maxTokens,
        temperature,
      }),
    },
    `anthropic/${model}`,
    (body) => {
      const text = (body?.content || [])
        .filter((part) => part?.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();
      if (!text)
        throw new Error(
          `Anthropic response missing text content: ${JSON.stringify(body).slice(0, 500)}`,
        );
    },
  );

  return (payload?.content || [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export async function complete({
  system,
  user,
  maxTokens = 8000,
  temperature = 0.2,
  provider: providerOverride,
  model: modelOverride,
  baseUrl,
  apiKey: apiKeyOverride,
  tier = 'balanced',
}) {
  // Settings-page tier override (DB). Absent => env-driven behavior, unchanged.
  const tierCfg = tier ? await getTierOverride(tier) : null;
  const provider = String(providerOverride || (tierCfg ? 'openai' : providerName())).toLowerCase();
  const model = modelOverride || tierCfg?.model || config.meetingLlmModel;
  // Tier backends are LiteLLM — any virtual key works; fall back sensibly.
  const apiKey =
    apiKeyOverride ||
    (tierCfg
      ? config.meetingLlmApiKey || config.zaiApiKey || config.mimoApiKey
      : apiKeyForProvider(provider));
  if (!apiKey)
    throw new Error(`Missing API key for meeting LLM provider: ${provider}`);
  const baseUrlOverride = baseUrl || tierCfg?.baseUrl;

  if (provider === 'anthropic') {
    return completeAnthropic({
      apiKey,
      baseUrl: baseUrlOverride,
      system,
      user,
      maxTokens,
      temperature,
      model,
    });
  }

  function resolveBaseUrl(fallback) {
    return baseUrlOverride || config.meetingLlmBaseUrl || fallback;
  }

  if (provider === 'openai') {
    return completeOpenAiCompatible({
      baseUrl: resolveBaseUrl('https://api.openai.com/v1'),
      apiKey,
      system,
      user,
      maxTokens,
      temperature,
      model,
    });
  }

  if (provider === 'qwen') {
    return completeOpenAiCompatible({
      baseUrl: resolveBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'),
      apiKey,
      system,
      user,
      maxTokens,
      temperature,
      model,
    });
  }

  if (provider === 'mimo') {
    return completeOpenAiCompatible({
      baseUrl: resolveBaseUrl(config.mimoBaseUrl),
      apiKey,
      system,
      user,
      maxTokens,
      temperature,
      authHeader: 'api-key',
      provider,
      model,
    });
  }

  if (provider === 'zai') {
    return completeOpenAiCompatible({
      baseUrl: resolveBaseUrl(config.zaiBaseUrl),
      apiKey,
      system,
      user,
      maxTokens,
      temperature,
      model,
    });
  }

  throw new Error(`Unsupported meeting LLM provider: ${provider}`);
}

/**
 * Light-tier completion for cheap transforms (translation, task normalization).
 * Falls back to the main MEETING_LLM pair when the light env vars are unset.
 * A settings-page override on the `fast` tier wins over both.
 */
export async function completeLight(args) {
  if (await getTierOverride('fast')) {
    return complete({ ...args, tier: 'fast' });
  }
  return complete({
    ...args,
    tier: null,
    provider: config.meetingLlmLightProvider || config.meetingLlmProvider,
    model: config.meetingLlmLightModel || config.meetingLlmModel,
    baseUrl: config.meetingLlmLightBaseUrl || undefined,
    apiKey: config.meetingLlmLightApiKey || undefined,
  });
}
