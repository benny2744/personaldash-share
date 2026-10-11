/**
 * lib/settings/resolve.js — runtime resolution of app settings.
 *
 * Precedence: app_settings DB row > env var (registry envVar) > registry
 * default. Values are read at call time (never import time) so Settings-page
 * edits apply without a process restart for hot-scope settings. A short TTL
 * cache bounds DB load in loops; writes invalidate explicitly.
 */

import { SETTINGS_BY_KEY, validateSettingValue } from './registry.js';

const CACHE_TTL_MS = 5000;
const cache = new Map(); // key -> { value, at }

async function db() {
  const { default: prisma } = await import('@/lib/db');
  return prisma;
}

/** Coerce a raw env string to the setting's type; undefined when unusable. */
function envValue(def) {
  if (!def.envVar) return undefined;
  const raw = process.env[def.envVar];
  if (raw === undefined || raw === '') return undefined;
  switch (def.type) {
    case 'boolean': {
      const value = raw.trim().toLowerCase();
      if (['true', '1', 'on', 'yes'].includes(value)) return true;
      if (['false', '0', 'off', 'no'].includes(value)) return false;
      return undefined;
    }
    case 'number': {
      const num = Number(raw);
      return Number.isFinite(num) ? num : undefined;
    }
    case 'csv':
      return raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    default:
      return raw;
  }
}

/**
 * Resolve one setting at call time. Throws for unknown keys (registry is the
 * contract); never throws on DB issues (falls back to env/default).
 * @param {string} key
 * @returns {Promise<unknown>}
 */
export async function getSetting(key) {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) throw new Error(`getSetting: unknown setting '${key}'`);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let value;
  try {
    const row = await (await db()).appSetting.findUnique({ where: { key } });
    if (row && row.value !== null && row.value !== undefined) {
      value = row.value;
    }
  } catch {
    // table missing pre-migration — env/default still apply
  }
  if (value === undefined) value = envValue(def);
  if (value === undefined) value = def.default;

  cache.set(key, { value, at: Date.now() });
  return value;
}

/** Resolve many settings at once (single DB query). */
export async function getSettings(keys) {
  const missing = [...new Set(keys)].filter((key) => {
    if (!SETTINGS_BY_KEY.has(key))
      throw new Error(`getSetting: unknown setting '${key}'`);
    const cached = cache.get(key);
    return !cached || Date.now() - cached.at >= CACHE_TTL_MS;
  });
  if (missing.length) {
    let rows = [];
    try {
      rows = await (
        await db()
      ).appSetting.findMany({ where: { key: { in: missing } } });
    } catch {
      /* env/default fallback */
    }
    const overrides = new Map(rows.map((row) => [row.key, row.value]));
    for (const key of missing) {
      const def = SETTINGS_BY_KEY.get(key);
      cache.set(key, {
        value: overrides.get(key) ?? envValue(def) ?? def.default,
        at: Date.now(),
      });
    }
  }
  return Object.fromEntries(keys.map((key) => [key, cache.get(key).value]));
}

/**
 * Validate + persist an override. @returns {Promise<{value: unknown}>}
 */
export async function setSetting(key, value) {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) throw new Error(`setSetting: unknown setting '${key}'`);
  const result = validateSettingValue(def, value);
  if (!result.ok) {
    const error = new Error(`Invalid value for '${key}': ${result.error}`);
    error.statusCode = 400;
    throw error;
  }
  await (
    await db()
  ).appSetting.upsert({
    where: { key },
    update: { value: result.value },
    create: { key, value: result.value },
  });
  cache.delete(key);
  return { value: result.value };
}

/**
 * Validate + persist SEVERAL overrides atomically (one transaction; a
 * failure leaves every previous value untouched). Used for grouped saves
 * like the AI-connection triple.
 * @param {[string, unknown][]} entries
 * @returns {Promise<Record<string, unknown>>} saved key → value
 */
export async function setSettings(entries) {
  const prepared = entries.map(([key, value]) => {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) throw new Error(`setSettings: unknown setting '${key}'`);
    const result = validateSettingValue(def, value);
    if (!result.ok) {
      const error = new Error(`Invalid value for '${key}': ${result.error}`);
      error.statusCode = 400;
      throw error;
    }
    return { key, value: result.value };
  });
  const prisma = await db();
  await prisma.$transaction(
    prepared.map(({ key, value }) =>
      prisma.appSetting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      }),
    ),
  );
  for (const { key } of prepared) cache.delete(key);
  return Object.fromEntries(prepared.map(({ key, value }) => [key, value]));
}

/** Remove an override (falls back to env/default). */
export async function resetSetting(key) {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) throw new Error(`resetSetting: unknown setting '${key}'`);
  await (await db()).appSetting.deleteMany({ where: { key } });
  cache.delete(key);
}

export function invalidateSettingsCache() {
  cache.clear();
}

/** Registry-safe snapshot for UI and AI tools. Secrets never leave this function. */
export async function describeSettings() {
  const { SETTINGS } = await import('./registry.js');
  let rows = [];
  try {
    rows = await (await db()).appSetting.findMany();
  } catch {
    /* bootstrap */
  }
  const overrides = new Map(rows.map((row) => [row.key, row.value]));
  return SETTINGS.map((def) => {
    const override = overrides.has(def.key);
    const fromEnv = envValue(def);
    const value = override ? overrides.get(def.key) : (fromEnv ?? def.default);
    const result = {
      ...def,
      source: override ? 'override' : fromEnv !== undefined ? 'env' : 'default',
    };
    if (def.type === 'secret') {
      delete result.default;
      return { ...result, value: null, isSet: Boolean(value) };
    }
    return { ...result, value };
  });
}
