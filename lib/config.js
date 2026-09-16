/**
 * lib/config.js — Centralized application configuration with env var defaults.
 *
 * Single source of truth for all environment-driven settings.
 * Validates required vars at import time in production.
 */

/** @returns {string} */
function requireEnv(name) {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value || '';
}

function numberEnv(
  name,
  fallback,
  { min = -Infinity, max = Infinity, float = false } = {},
) {
  const raw = process.env[name] ?? String(fallback);
  const value = float ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(
      `Invalid ${name}: expected ${float ? 'number' : 'integer'} between ${min} and ${max}`,
    );
  }
  return value;
}

function csvEnv(name) {
  return (process.env[name] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Normalize CalDAV URLs from DingTalk-style host-only values.
 * `calendar.dingtalk.com` → `https://calendar.dingtalk.com/dav/`
 */
function normalizeCaldavUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let url = value;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  // Bare DingTalk host → published CalDAV base path.
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === 'calendar.dingtalk.com' &&
      (parsed.pathname === '/' || parsed.pathname === '')
    ) {
      parsed.pathname = '/dav/';
      return parsed.toString();
    }
  } catch {
    return url.endsWith('/') ? url : `${url}/`;
  }
  return url.endsWith('/') ? url : `${url}/`;
}

function meetingLlmModelEnv() {
  if (process.env.MEETING_LLM_MODEL) return process.env.MEETING_LLM_MODEL;
  if (process.env.MEETING_LLM_PROVIDER === 'mimo') {
    return process.env.MIMO_MODEL || 'mimo-v2.5-pro';
  }
  return process.env.ZAI_MODEL || 'glm-5';
}

/** 'opencode' | 'code' — which engine drives the summarize/format stage. */
function meetingFormatterEnv() {
  const value = String(process.env.MEETING_FORMATTER || 'code').toLowerCase();
  return value === 'opencode' ? 'opencode' : 'code';
}

/**
 * Optional per-type agent override map: OPENCODE_AGENT_BY_TYPE is a JSON object
 * mapping meeting type -> opencode agent name. Empty object when unset.
 */
function opencodeAgentByTypeEnv() {
  const raw = process.env.OPENCODE_AGENT_BY_TYPE;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

const config = {
  /** PostgreSQL connection string. */
  databaseUrl: requireEnv('DATABASE_URL'),

  /** Absolute path to the Markdown vault root directory. */
  vaultPath: requireEnv('VAULT_PATH'),

  /** Meeting audio upload size cap (whole submission: Σ audio + supplementary). */
  meetingAudioMaxBytes: numberEnv('MEETING_AUDIO_MAX_BYTES', 524288000, {
    min: 1,
  }),

  /**
   * Autochunking config for working around the Cloudflare Tunnel ~100MB
   * per-request ceiling. Submissions whose total bytes meet the threshold are
   * uploaded as a chunked session; each HTTP request stays at or below
   * chunkSize.
   */
  meetingUploadChunkSize: numberEnv('MEETING_AUDIO_CHUNK_SIZE', 52428800, {
    min: 5 * 1024 * 1024,
  }),
  meetingUploadChunkThreshold: numberEnv(
    'MEETING_UPLOAD_CHUNK_THRESHOLD',
    94371840,
    { min: 10 * 1024 * 1024 },
  ),
  /** Inactivity TTL before an in-flight upload is considered abandoned. */
  meetingUploadTtlMs: numberEnv('MEETING_UPLOAD_TTL_MS', 3600000, {
    min: 60000,
  }),

  /** S3-compatible storage used for temporary meeting audio objects. */
  meetingS3Endpoint: requireEnv('MEETING_S3_ENDPOINT'),
  meetingS3PublicBase: requireEnv('MEETING_S3_PUBLIC_BASE'),
  meetingS3Bucket: process.env.MEETING_S3_BUCKET || 'meeting-audio',
  meetingS3Region: process.env.MEETING_S3_REGION || 'us-east-1',
  meetingS3AccessKey: process.env.MEETING_S3_ACCESS_KEY || '',
  meetingS3SecretKey: process.env.MEETING_S3_SECRET_KEY || '',
  meetingS3PresignTtl: numberEnv('MEETING_S3_PRESIGN_TTL', 7200, { min: 60 }),

  /**
   * ASR pre-transcoding. Audio files larger than the threshold are transcoded
   * to a low-bitrate mono MP3 before being submitted to DashScope, which
   * improves reliability for large/long recordings (40 MB default: DashScope's
   * download of larger public-URL files was observed truncated).
   */
  meetingAsrTranscodeThreshold: numberEnv(
    'MEETING_ASR_TRANSCODE_THRESHOLD',
    41943040,
    {
      min: 0,
    },
  ),
  meetingAsrTranscodeBitrate: numberEnv('MEETING_ASR_TRANSCODE_BITRATE', 32, {
    min: 8,
    max: 320,
  }),

  /** DashScope async ASR configuration. */
  qwenFiletransBaseUrl: requireEnv('QWEN_FILETRANS_BASE_URL'),
  qwenFiletransModel:
    process.env.QWEN_FILETRANS_MODEL || 'qwen3-asr-flash-filetrans',
  qwenAsrApiKey: process.env.QWEN_ASR_API_KEY || '',
  qwenAsrBaseTimeoutSec: numberEnv('QWEN_ASR_BASE_TIMEOUT_SEC', 600, {
    min: 60,
  }),
  // Wait-budget multiplier on the estimated audio duration: DashScope
  // filetrans has been observed processing between ~0.7x and ~2.4x realtime,
  // so 1.4 covers the slow end with headroom.
  qwenAsrDurationFactor: numberEnv('QWEN_ASR_DURATION_FACTOR', 1.4, {
    min: 0.1,
    float: true,
  }),
  qwenAsrMaxTimeoutSec: numberEnv('QWEN_ASR_MAX_TIMEOUT_SEC', 14400, {
    min: 600,
  }),

  /**
   * Duration-aware ASR wait budget, capped at qwenAsrMaxTimeoutSec. Audio
   * duration is estimated from bytes ÷ bitrate — exact for our constant-bitrate
   * transcoded files (bitrateKbps = meetingAsrTranscodeBitrate), ~128 kbps
   * assumed for original uploads. Sizing by duration instead of raw MB matters
   * because a 32 kbps mono transcode packs ~4.4 min of audio per MB: a
   * multi-hour meeting compresses small and a per-MB budget times out long
   * before the remote task finishes.
   */
  qwenAsrTimeoutForSize(bytes, { bitrateKbps = 128 } = {}) {
    const durationSec = ((bytes || 0) * 8) / (bitrateKbps * 1000);
    const timeout = Math.ceil(
      config.qwenAsrBaseTimeoutSec + durationSec * config.qwenAsrDurationFactor,
    );
    return Math.min(timeout, config.qwenAsrMaxTimeoutSec);
  },

  /** Z.ai defaults for meeting-note LLM passes. */
  zaiApiKey: process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY || '',
  zaiBaseUrl: process.env.ZAI_BASE_URL || '',
  zaiModel: process.env.ZAI_MODEL || 'glm-5',

  /** Xiaomi MiMo defaults for meeting-note LLM passes. */
  mimoApiKey: process.env.MIMO_API_KEY || '',
  mimoBaseUrl:
    process.env.MIMO_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1',
  mimoModel: process.env.MIMO_MODEL || 'mimo-v2.5-pro',

  /** Meeting-note LLM pass configuration. */
  meetingLlmProvider: process.env.MEETING_LLM_PROVIDER || 'zai',
  meetingLlmModel: meetingLlmModelEnv(),
  meetingLlmApiKey: process.env.MEETING_LLM_API_KEY || '',
  meetingLlmBaseUrl: process.env.MEETING_LLM_BASE_URL || '',
  meetingLlmTimeoutSec: numberEnv('MEETING_LLM_TIMEOUT_SEC', 900, { min: 1 }),
  /**
   * Light-tier model for cheap meeting transforms (ZH translation, task
   * normalization). Empty means "fall back to the main MEETING_LLM pair";
   * resolution happens in llm.js completeLight().
   */
  meetingLlmLightProvider: process.env.MEETING_LLM_LIGHT_PROVIDER || '',
  meetingLlmLightModel: process.env.MEETING_LLM_LIGHT_MODEL || '',
  meetingLlmLightBaseUrl: process.env.MEETING_LLM_LIGHT_BASE_URL || '',
  meetingLlmLightApiKey: process.env.MEETING_LLM_LIGHT_API_KEY || '',
  meetingKnownPeople: csvEnv('MEETING_KNOWN_PEOPLE'),

  /**
   * Meeting summarize/format engine. 'code' keeps the deterministic per-type
   * summary passes; 'opencode' routes the format stage to per-type opencode
   * agents over HTTP (with code fallback on failure). Defaults to 'code'.
   */
  meetingFormatter: meetingFormatterEnv(),

  /** opencode HTTP server the format/linker agents run on (basic-auth protected). */
  opencodeServerUrl: process.env.OPENCODE_SERVER_URL || '',
  opencodeServerUsername: process.env.OPENCODE_SERVER_USERNAME || 'opencode',
  opencodeServerPassword: process.env.OPENCODE_SERVER_PASSWORD || '',
  opencodeTimeoutSec: numberEnv('OPENCODE_TIMEOUT_SEC', 900, { min: 1 }),
  /** Model pinned to the opencode formatter (summarize/format stage). */
  opencodeFormatterModel:
    process.env.OPENCODE_FORMATTER_MODEL ||
    'xiaomi-token-plan-cn/mimo-v2.5-pro',
  /** Model pinned to the opencode linker (name resolution / backlink lint). */
  opencodeLinkerModel:
    process.env.OPENCODE_LINKER_MODEL || 'xiaomi-token-plan-cn/mimo-v2.5',
  /** Model pinned to the opencode document parser (text extraction). Defaults to the formatter model. */
  opencodeParserModel:
    process.env.OPENCODE_PARSER_MODEL ||
    process.env.OPENCODE_FORMATTER_MODEL ||
    'xiaomi-token-plan-cn/mimo-v2.5-pro',
  /** Optional { meetingType: agentName } overrides; default maps type->`meeting-<type>`. */
  opencodeAgentByType: opencodeAgentByTypeEnv(),

  /**
   * Vault root AS SEEN BY THE OPENCODE HOST (not the in-container VAULT_PATH
   * mount). Used when building linker prompts that the host-side agent reads, so
   * it gets a host-absolute path instead of the container's /vault. Defaults to
   * VAULT_PATH when unset (e.g. when opencode runs inside the same namespace).
   */
  opencodeVaultPath:
    process.env.OPENCODE_VAULT_PATH || process.env.VAULT_PATH || '',

  /**
   * Enable the read-only meeting-linker worker independently of the format
   * stage. Defaults to running only when the opencode formatter is active; set
   * MEETING_LINKER_ENABLED=true to force it on while MEETING_FORMATTER=code.
   */
  meetingLinkerEnabled: process.env.MEETING_LINKER_ENABLED === 'true',

  /**
   * Entity-update application mode for meeting_analysis_v1 entity_updates:
   * 'off' (default) | 'dry_run' (logs intended writes) | 'apply' (log updates
   * auto-append to entity notes; profile updates go to the Link Review inbox).
   */
  meetingEntityUpdatesMode: ['dry_run', 'apply'].includes(
    process.env.MEETING_ENTITY_UPDATES_MODE,
  )
    ? process.env.MEETING_ENTITY_UPDATES_MODE
    : 'off',

  /** Headless LibreOffice converter sidecar used for chat attachment extraction. */
  libreofficeConverterUrl: (
    process.env.LIBREOFFICE_CONVERTER_URL || 'http://127.0.0.1:8083'
  ).replace(/\/+$/, ''),

  /** Whether to run the vault indexer on app startup. */
  indexerEnabled: process.env.INDEXER_ENABLED !== 'false',

  /** Debounce interval for file-change events (ms). */
  indexerDebounceMs: numberEnv('INDEXER_DEBOUNCE_MS', 500, { min: 0 }),

  /**
   * Read-only DingTalk (or generic) CalDAV sync. Credentials stay server-side.
   * Default endpoint matches DingTalk's published CalDAV base URL.
   * Host-only values like `calendar.dingtalk.com` are normalized to https://…/dav/.
   */
  caldavEnabled: process.env.CALDAV_ENABLED === 'true',
  caldavUrl: normalizeCaldavUrl(
    process.env.CALDAV_URL || 'https://calendar.dingtalk.com/dav/',
  ),
  caldavUsername: process.env.CALDAV_USERNAME || '',
  caldavPassword: process.env.CALDAV_PASSWORD || '',
  /** Optional direct calendar collection URL when discovery fails. */
  caldavCalendarUrl: normalizeCaldavUrl(process.env.CALDAV_CALENDAR_URL || ''),
  caldavSyncIntervalMs: numberEnv('CALDAV_SYNC_INTERVAL_MS', 3_600_000, {
    min: 60_000,
  }),
  caldavFetchTimeoutMs: numberEnv('CALDAV_FETCH_TIMEOUT_MS', 60_000, {
    min: 5_000,
  }),
};

/** True when CalDAV sync is enabled and credentials are present. */
export function isCaldavConfigured() {
  return Boolean(
    config.caldavEnabled &&
    config.caldavUsername &&
    config.caldavPassword &&
    config.caldavUrl,
  );
}

export default config;
