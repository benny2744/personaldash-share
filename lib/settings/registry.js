/**
 * lib/settings/registry.js — declarative catalog of runtime-editable settings.
 *
 * Single source of truth for the Settings UI, the /api/settings validation,
 * and (later) the conversational setup agent's tool schema. Each entry:
 *   key       dotted identifier, stable forever (stored in app_settings.key)
 *   label     short human label
 *   description one-line help text shown in the UI
 *   group     card grouping on the Settings page
 *   type      text | textarea | number | boolean | select | csv | json | secret
 *   options   for select: [{value, label}]
 *   min/max   for number
 *   envVar    deployment-default env var name (optional)
 *   default   code default (last fallback)
 *   scope     'hot' (applies immediately) | 'boot' (requires restart)
 *   placeholder example value for empty inputs
 *
 * Precedence everywhere: DB row > env var > default.
 * Secrets are write-only: the API never returns their stored value.
 */

/**
 * @typedef {Object} SettingDef
 * @property {string} key
 * @property {string} label
 * @property {string} description
 * @property {string} group
 * @property {'text'|'textarea'|'number'|'boolean'|'select'|'csv'|'json'|'secret'} type
 * @property {Array<{value: string, label: string}>} [options]
 * @property {number} [min]
 * @property {number} [max]
 * @property {boolean} [integer] reject fractional numbers (counts, budgets)
 * @property {string} [envVar]
 * @property {string|number|boolean|array} [default]
 * @property {'hot'|'boot'} scope
 * @property {string} [placeholder]
 */

/** @type {SettingDef[]} */
export const SETTINGS = [
  // ── General ────────────────────────────────────────────────────────────
  {
    key: 'app.name',
    label: 'App name',
    description: 'Display name used in the browser tab and app manifest.',
    group: 'General',
    type: 'text',
    envVar: 'NEXT_PUBLIC_APP_NAME',
    default: 'WorkDash',
    scope: 'boot',
    placeholder: 'WorkDash',
  },
  {
    key: 'app.timezone',
    label: 'Timezone',
    description:
      'IANA timezone for day bucketing, digests, and scheduler windows. Some subsystems pick this up on their next run.',
    group: 'General',
    type: 'text',
    envVar: 'APP_TIMEZONE',
    default: 'Asia/Shanghai',
    scope: 'hot',
    placeholder: 'Asia/Shanghai',
  },

  // ── Meetings pipeline ──────────────────────────────────────────────────
  {
    key: 'meetings.formatter',
    label: 'Format engine',
    description:
      "'code' = deterministic per-type passes; 'opencode' = per-type agents over HTTP (falls back to code on failure).",
    group: 'Meetings',
    type: 'select',
    options: [
      { value: 'code', label: 'code (built-in)' },
      { value: 'opencode', label: 'opencode (agents)' },
    ],
    envVar: 'MEETING_FORMATTER',
    default: 'code',
    scope: 'hot',
  },
  {
    key: 'meetings.entityUpdatesMode',
    label: 'Entity updates',
    description:
      'Apply extracted entity updates to notes: off, dry_run (log only), or apply.',
    group: 'Meetings',
    type: 'select',
    options: [
      { value: 'off', label: 'off' },
      { value: 'dry_run', label: 'dry run' },
      { value: 'apply', label: 'apply' },
    ],
    envVar: 'MEETING_ENTITY_UPDATES_MODE',
    default: 'off',
    scope: 'hot',
  },
  {
    key: 'meetings.linkerEnabled',
    label: 'Meeting linker',
    description:
      'Run the read-only entity-linking worker independently of the format stage.',
    group: 'Meetings',
    type: 'boolean',
    envVar: 'MEETING_LINKER_ENABLED',
    default: false,
    scope: 'hot',
  },
  {
    key: 'meetings.knownPeople',
    label: 'Known people',
    description:
      'Comma-separated attendee names that improve metadata extraction.',
    group: 'Meetings',
    type: 'csv',
    envVar: 'MEETING_KNOWN_PEOPLE',
    default: [],
    scope: 'hot',
    placeholder: 'Alice, Bob, …',
  },

  // ── Read-aloud (TTS) ───────────────────────────────────────────────────
  {
    key: 'readLater.ttsCleaner',
    label: 'TTS transcript cleaning',
    description:
      'LLM-clean transcripts before read-aloud (strip citations, tables, URLs).',
    group: 'Read aloud',
    type: 'boolean',
    envVar: 'READ_LATER_TTS_CLEANER',
    default: true,
    scope: 'hot',
  },
  {
    key: 'readLater.ttsMaxChars',
    label: 'TTS max characters',
    description: 'Cap on cleaned text length sent to speech synthesis.',
    group: 'Read aloud',
    type: 'number',
    min: 1000,
    max: 500000,
    integer: true,
    envVar: 'READ_LATER_TTS_MAX_CHARS',
    default: 60000,
    scope: 'hot',
  },

  // ── Calendar ───────────────────────────────────────────────────────────
  {
    key: 'calendar.caldavEnabled',
    label: 'CalDAV sync enabled',
    description:
      'Read-only calendar sync. Configure credentials below or use CALDAV_* deployment defaults.',
    group: 'Calendar',
    type: 'boolean',
    envVar: 'CALDAV_ENABLED',
    default: false,
    scope: 'hot',
  },

  // ── Identity (consumed by later phases; safe defaults) ─────────────────
  {
    key: 'identity.name',
    label: 'Your name',
    description: 'Display name used in digests and AI prompts.',
    group: 'Identity',
    type: 'text',
    envVar: 'DINGTALK_SELF_NAME',
    default: '',
    scope: 'hot',
    placeholder: 'Your name',
  },
  {
    key: 'identity.aliases',
    label: 'Name aliases',
    description:
      'Comma-separated names/mentions that count as "you" (e.g. in @mentions).',
    group: 'Identity',
    type: 'csv',
    envVar: 'DINGTALK_SELF_ALIASES',
    default: [],
    scope: 'hot',
    placeholder: '@you, @yourname',
  },
];

function setting(key, label, group, type, envVar, fallback, extra = {}) {
  return {
    key,
    label,
    group,
    type,
    envVar,
    default: fallback,
    scope: 'hot',
    description: label,
    ...extra,
  };
}

SETTINGS.push(
  setting(
    'llm.baseUrl',
    'AI server URL',
    'AI connection',
    'text',
    'MEETING_LLM_LIGHT_BASE_URL',
    '',
    { format: 'url' },
  ),
  setting(
    'llm.model',
    'AI model',
    'AI connection',
    'text',
    'MEETING_LLM_LIGHT_MODEL',
    '',
  ),
  setting(
    'llm.apiKey',
    'AI API key',
    'AI connection',
    'secret',
    'MEETING_LLM_LIGHT_API_KEY',
    '',
  ),
  setting(
    'identity.openId',
    'DingTalk open ID',
    'Identity',
    'text',
    'DINGTALK_SELF_OPEN_ID',
    '',
  ),
  setting(
    'identity.userId',
    'DingTalk user ID',
    'Identity',
    'text',
    'DINGTALK_SELF_USER_ID',
    '',
  ),
  setting(
    'intel.enabled',
    'Scheduled attention digests',
    'Attention',
    'boolean',
    'DINGTALK_INTEL_SCHEDULER',
    false,
  ),
  setting(
    'intel.pipeline',
    'Attention pipeline',
    'Attention',
    'select',
    'DINGTALK_INTEL_PIPELINE',
    'v1',
    {
      options: [
        { value: 'v1', label: 'Single analysis' },
        { value: 'v2', label: 'Secretary / clusters' },
      ],
    },
  ),
  setting(
    'intel.runTimes',
    'Daily digest times',
    'Attention',
    'csv',
    'DINGTALK_INTEL_RUNS',
    ['07:00', '12:00', '17:00'],
    { format: 'times' },
  ),
  setting(
    'intel.autoResolve',
    'Clear answered items automatically',
    'Attention',
    'boolean',
    'DINGTALK_INTEL_AUTO_RESOLVE',
    true,
  ),
  setting(
    'intel.coverage',
    'Include all active conversations',
    'Attention',
    'boolean',
    'DINGTALK_INTEL_COVERAGE',
    true,
  ),
  setting(
    'intel.studentSync',
    'People activity summaries',
    'Attention',
    'boolean',
    'DINGTALK_INTEL_STUDENT_SYNC',
    false,
  ),
  setting(
    'intel.studentThreshold',
    'Messages before a people summary',
    'Attention',
    'number',
    'STUDENT_SYNC_THRESHOLD',
    8,
    { min: 1, max: 1000, integer: true },
  ),
  setting(
    'intel.dmActiveDays',
    'Direct-message lookback days',
    'Attention',
    'number',
    'DINGTALK_INTEL_DM_ACTIVE_DAYS',
    30,
    { min: 1, max: 365, integer: true },
  ),
  setting(
    'intel.clusterTokenBudget',
    'Analysis token budget',
    'Attention',
    'number',
    'DINGTALK_INTEL_CLUSTER_TOKEN_BUDGET',
    6000,
    { min: 1000, max: 100000, integer: true },
  ),
  setting(
    'intel.dmBatchSize',
    'Direct messages per batch',
    'Attention',
    'number',
    'DINGTALK_INTEL_DM_BATCH_SIZE',
    8,
    { min: 1, max: 100, integer: true },
  ),
  setting(
    'intel.maxBatches',
    'Maximum analysis batches',
    'Attention',
    'number',
    'DINGTALK_INTEL_MAX_BATCHES',
    24,
    { min: 1, max: 1000, integer: true },
  ),
  setting(
    'attention.directory',
    'Attention configuration folder in vault',
    'Attention',
    'text',
    'ATTENTION_CONFIG_DIR',
    'system/attention',
    { format: 'vaultPath' },
  ),
  setting(
    'meetings.sopPath',
    'Meeting instructions note',
    'Templates',
    'text',
    'MEETING_SOP_PATH',
    'system/Rules & SOPs/Bases/Meetings SOP.md',
    { format: 'vaultPath' },
  ),
  setting(
    'meetings.templatePath',
    'Meeting template note',
    'Templates',
    'text',
    'MEETING_TEMPLATE_PATH',
    'system/Templates/Meeting.md',
    { format: 'vaultPath' },
  ),
  setting(
    'meetings.teamsPath',
    'Team roster note',
    'Templates',
    'text',
    'MEETING_TEAMS_PATH',
    'system/Teams.md',
    { format: 'vaultPath' },
  ),
  setting(
    'calendar.url',
    'CalDAV server URL',
    'Calendar',
    'text',
    'CALDAV_URL',
    'https://calendar.dingtalk.com/dav/',
    { format: 'url' },
  ),
  setting(
    'calendar.username',
    'CalDAV username',
    'Calendar',
    'text',
    'CALDAV_USERNAME',
    '',
  ),
  setting(
    'calendar.password',
    'CalDAV password',
    'Calendar',
    'secret',
    'CALDAV_PASSWORD',
    '',
  ),
  setting(
    'calendar.collectionUrl',
    'Calendar collection URL',
    'Calendar',
    'text',
    'CALDAV_CALENDAR_URL',
    '',
    { format: 'url' },
  ),
  setting(
    'voice.ttsVoice',
    'Read-aloud voice',
    'Voice',
    'text',
    'QWEN_TTS_VOICE',
    'Chelsie',
  ),
);

// ── Terminal (web terminal via terminal-gateway sidecar) ────────────────────
SETTINGS.push(
  setting(
    'terminal.enabled',
    'Web terminal enabled',
    'Terminal',
    'boolean',
    'TERMINAL_ENABLED',
    false,
  ),
  setting(
    'terminal.maxSessionsPerIdentity',
    'Max sessions per user',
    'Terminal',
    'number',
    'TERMINAL_MAX_SESSIONS_PER_IDENTITY',
    3,
    { min: 1, max: 50, integer: true },
  ),
  setting(
    'terminal.idleTimeoutSeconds',
    'Idle timeout (seconds)',
    'Terminal',
    'number',
    'TERMINAL_IDLE_TIMEOUT_SECONDS',
    900,
    { min: 30, max: 86400, integer: true },
  ),
  setting(
    'terminal.maxSessionSeconds',
    'Absolute session cap (seconds)',
    'Terminal',
    'number',
    'TERMINAL_MAX_SESSION_SECONDS',
    28800,
    { min: 60, max: 604800, integer: true },
  ),
  setting(
    'terminal.graceSeconds',
    'Reconnect grace (seconds)',
    'Terminal',
    'number',
    'TERMINAL_GRACE_SECONDS',
    60,
    { min: 5, max: 600, integer: true },
  ),
  setting(
    'terminal.leaseTtlSeconds',
    'Attach lease TTL (seconds)',
    'Terminal',
    'number',
    'TERMINAL_LEASE_TTL_SECONDS',
    30,
    { min: 5, max: 300, integer: true },
  ),
);

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((def) => [def.key, def]));

export const SETTINGS_GROUPS = [...new Set(SETTINGS.map((def) => def.group))];

/**
 * Validate + coerce an incoming value against a registry entry.
 * @param {SettingDef} def
 * @param {unknown} value
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
export function validateSettingValue(def, value) {
  if (typeof value === 'string' && value.length > 32000)
    return { ok: false, error: 'value is too long' };
  if (def.format === 'url' && value) {
    try {
      const u = new URL(value);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
        throw new Error();
    } catch {
      return {
        ok: false,
        error: 'use an http or https URL without embedded credentials',
      };
    }
  }
  if (
    def.format === 'vaultPath' &&
    (typeof value !== 'string' ||
      !value.trim() ||
      value.startsWith('/') ||
      value.split(/[\\/]/).some((p) => p === '..' || p.startsWith('.')))
  )
    return {
      ok: false,
      error: 'use a vault-relative path without hidden folders or ..',
    };
  if (def.key === 'app.timezone') {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
    } catch {
      return { ok: false, error: 'use a valid IANA timezone' };
    }
  }
  switch (def.type) {
    case 'text':
    case 'textarea':
    case 'secret': {
      if (typeof value !== 'string')
        return { ok: false, error: 'expected a string' };
      return { ok: true, value };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      if (value === 'true' || value === '1') return { ok: true, value: true };
      if (value === 'false' || value === '0') return { ok: true, value: false };
      return { ok: false, error: 'expected true or false' };
    }
    case 'number': {
      const num =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim()
            ? Number(value)
            : NaN;
      if (!Number.isFinite(num))
        return { ok: false, error: 'expected a number' };
      if (def.integer && !Number.isInteger(num)) {
        return { ok: false, error: 'must be a whole number' };
      }
      if (def.min !== undefined && num < def.min) {
        return { ok: false, error: `must be ≥ ${def.min}` };
      }
      if (def.max !== undefined && num > def.max) {
        return { ok: false, error: `must be ≤ ${def.max}` };
      }
      return { ok: true, value: num };
    }
    case 'select': {
      const allowed = (def.options || []).map((option) => option.value);
      if (!allowed.includes(value)) {
        return { ok: false, error: `must be one of: ${allowed.join(', ')}` };
      }
      return { ok: true, value };
    }
    case 'csv': {
      const list = Array.isArray(value)
        ? value
        : String(value ?? '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
      if (!list.every((item) => typeof item === 'string'))
        return { ok: false, error: 'expected a list of strings' };
      if (
        def.format === 'times' &&
        (!list.length || list.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))
      )
        return { ok: false, error: 'use times like 07:00, 12:00, 17:00' };
      return {
        ok: true,
        value: list.map((item) => item.trim()).filter(Boolean),
      };
    }
    case 'json': {
      if (value === undefined || value === null) {
        return { ok: false, error: 'expected a JSON value' };
      }
      return { ok: true, value };
    }
    default:
      return { ok: false, error: `unsupported type ${def.type}` };
  }
}
