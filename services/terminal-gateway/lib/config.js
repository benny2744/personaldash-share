/**
 * services/terminal-gateway/lib/config.js — environment configuration.
 * Secrets (TERMINAL_LEASE_SECRET) stay inside the sidecar + app.
 */

function stripEnvQuotes(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function getConfig() {
  return {
    port: Number(process.env.PORT) || 3016,
    host: process.env.HOST || '0.0.0.0',
    databaseUrl: stripEnvQuotes(process.env.DATABASE_URL || ''),
    leaseSecret: stripEnvQuotes(process.env.TERMINAL_LEASE_SECRET || ''),
    keyDir: stripEnvQuotes(process.env.TERMINAL_KEY_DIR || '/run/terminal-keys'),
    // Settings fallbacks when app_settings has no row (mirrors the app's
    // registry defaults; lib/settings/registry.js is the source of truth).
    defaults: {
      'terminal.idleTimeoutSeconds': 900,
      'terminal.maxSessionSeconds': 28800,
      'terminal.graceSeconds': 60,
    },
    envFallbacks: {
      'terminal.idleTimeoutSeconds': 'TERMINAL_IDLE_TIMEOUT_SECONDS',
      'terminal.maxSessionSeconds': 'TERMINAL_MAX_SESSION_SECONDS',
      'terminal.graceSeconds': 'TERMINAL_GRACE_SECONDS',
    },
    settingsCacheMs: 30_000,
    maxFrameBytes: 96 * 1024,
    maxInputBytes: 64 * 1024,
    maxBufferedOutputBytes: 4 * 1024 * 1024,
    counterFlushMs: 5_000,
  };
}
