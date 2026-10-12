/**
 * services/terminal-gateway/lib/db.js — raw pg access to the terminal tables.
 * The sidecar shares WorkDash's Postgres (raw SQL precedent:
 * services/dingtalk-bridge, lib/gbrain/db.js). SELECT-only on reads; writes
 * are status/counter updates scoped to terminal_sessions.
 *
 * `pg` is imported lazily so the query helpers stay unit-testable with a
 * stubbed pool (no sidecar node_modules needed).
 */

/** Create the pool (exported factory so tests can inject stubs). */
export async function createDbPool(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for terminal-gateway');
  }
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: databaseUrl, max: 4 });
}

/** Session row joined with its host. */
export async function getSessionWithHost(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.identity, s.status, s.host_id, s.created_at,
            h.slug AS host_slug, h.display_name, h.ssh_host, h.ssh_port,
            h.ssh_user, h.credential_ref, h.host_key_sha256,
            h.allowed_identities, h.enabled AS host_enabled
       FROM terminal_sessions s
       JOIN terminal_hosts h ON h.id = s.host_id
      WHERE s.id = $1`,
    [sessionId],
  );
  return rows[0] || null;
}

/**
 * Transition status with an optimistic guard. Returns true when applied.
 * @param {string[]} fromStates
 */
export async function transitionSession(
  pool,
  sessionId,
  fromStates,
  toState,
  extra = {},
) {
  const sets = ['status = $3'];
  const values = [sessionId, fromStates, toState];
  let idx = 4;
  if (extra.connectedAt) {
    sets.push(`connected_at = COALESCE(connected_at, $${idx})`);
    values.push(extra.connectedAt);
    idx += 1;
  }
  if (extra.closedAt) {
    sets.push(`closed_at = $${idx}`);
    values.push(extra.closedAt);
    idx += 1;
  }
  if (extra.closeReason !== undefined) {
    sets.push(`close_reason = $${idx}`);
    values.push(String(extra.closeReason).slice(0, 64));
    idx += 1;
  }
  const { rowCount } = await pool.query(
    `UPDATE terminal_sessions SET ${sets.join(', ')}
      WHERE id = $1 AND status = ANY($2)`,
    values,
  );
  return rowCount === 1;
}

/** Flush byte counters + last activity (deltas, not absolutes). */
export async function flushCounters(pool, sessionId, bytesIn, bytesOut) {
  await pool.query(
    `UPDATE terminal_sessions
        SET bytes_in = bytes_in + $2,
            bytes_out = bytes_out + $3,
            last_activity_at = now()
      WHERE id = $1`,
    [sessionId, bytesIn, bytesOut],
  );
}

function readNumber(rows, key, envName, fallback) {
  for (const row of rows) {
    if (row.key === key) {
      const value = row.value?.value ?? row.value;
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) return Math.floor(num);
    }
  }
  const env = Number(process.env[envName]);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return fallback;
}

/**
 * Read terminal limits with the app's precedence: app_settings > env > default.
 * app_settings.value is JSONB; booleans/numbers are stored as JSON scalars or
 * { value: ... } wrappers depending on writer — both handled.
 */
export async function getLimits(pool, defaults, cache) {
  const now = Date.now();
  if (cache.rows && now - cache.at < cache.ttlMs) return cache.rows;
  let rows = [];
  try {
    const result = await pool.query(
      `SELECT key, value FROM app_settings WHERE key LIKE 'terminal.%'`,
    );
    rows = {
      idleTimeoutSeconds: readNumber(
        result.rows,
        'terminal.idleTimeoutSeconds',
        'TERMINAL_IDLE_TIMEOUT_SECONDS',
        defaults['terminal.idleTimeoutSeconds'],
      ),
      maxSessionSeconds: readNumber(
        result.rows,
        'terminal.maxSessionSeconds',
        'TERMINAL_MAX_SESSION_SECONDS',
        defaults['terminal.maxSessionSeconds'],
      ),
      graceSeconds: readNumber(
        result.rows,
        'terminal.graceSeconds',
        'TERMINAL_GRACE_SECONDS',
        defaults['terminal.graceSeconds'],
      ),
    };
  } catch {
    rows = {
      idleTimeoutSeconds: defaults['terminal.idleTimeoutSeconds'],
      maxSessionSeconds: defaults['terminal.maxSessionSeconds'],
      graceSeconds: defaults['terminal.graceSeconds'],
    };
  }
  cache.rows = rows;
  cache.at = now;
  return rows;
}
