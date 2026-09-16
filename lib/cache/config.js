// Central cache configuration. All budgets, weights, and thresholds live here.

export const CACHE_SCHEMA_VERSION = 1;
export const CACHE_DB_NAME = 'pdash-cache';
export const DEFAULT_NAMESPACE = 'default';

// Desired application budget — a target, never a promise.
export const CONFIGURED_BUDGET_BYTES = 3 * 1024 * 1024 * 1024;

// Never consume everything the browser reports: leave room for IDB overhead,
// other origin data, and quota jitter.
export const QUOTA_SAFE_FRACTION = 0.8;
export const QUOTA_RESERVE_BYTES = 512 * 1024 * 1024;

// Soft category weights. Preference, not quota: unused weight is reusable.
export const CATEGORY_WEIGHTS = {
  kb: 0.6,
  dingtalk: 0.15,
  agent: 0.15,
  other: 0.1,
};

// Pressure levels as a fraction of the effective budget.
export const PRESSURE = {
  LIGHT: 0.7,
  ACTIVE: 0.85,
  AGGRESSIVE: 0.95,
};

// Retention priorities. Higher survives longer.
export const PRIORITY = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  PINNED: 3,
};

// Eviction scoring knobs (see eviction.js).
export const SCORING = {
  PRIORITY_BONUS: [0, 40, 80, Infinity],
  RECENCY_FULL_BONUS: 60,
  RECENCY_HALF_LIFE_MS: 7 * 24 * 60 * 60 * 1000,
  AGE_PENALTY_PER_DAY: 0.5,
  AGE_PENALTY_MAX: 30,
  SIZE_PENALTY_PER_GB: 20,
};

// Rolling chat retention floors — text bodies newer than this are protected
// regardless of score; attachments get a shorter floor.
export const RETENTION = {
  CHAT_TEXT_PROTECT_MS: 7 * 24 * 60 * 60 * 1000,
  CHAT_ATTACHMENT_PROTECT_MS: 48 * 60 * 60 * 1000,
  CONVERSATION_META_PROTECT_MS: 30 * 24 * 60 * 60 * 1000,
  KB_TEXT_PROTECT_MS: 30 * 24 * 60 * 60 * 1000,
  TEMP_TTL_MS: 60 * 60 * 1000,
};
