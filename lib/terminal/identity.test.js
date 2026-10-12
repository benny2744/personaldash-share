import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TERMINAL_IDENTITY_HEADER = 'Cf-Access-Authenticated-User-Email';
process.env.TERMINAL_LOCAL_IDENTITY = 'alex@local';
process.env.TERMINAL_ADMIN_IDENTITIES = 'admin@example.com, alex@local';

const { resolveTerminalIdentity, isTerminalAdmin } = await import('./identity.js');

function requestWithHeaders(headers) {
  return { headers: { get: (name) => headers[name] ?? null } };
}

test('header identity wins, normalized to lowercase', () => {
  const result = resolveTerminalIdentity(
    requestWithHeaders({ 'Cf-Access-Authenticated-User-Email': 'Alice@Example.com' }),
  );
  assert.deepEqual(result, { identity: 'alice@example.com', source: 'header' });
});

test('local fallback applies when the header is absent', () => {
  const result = resolveTerminalIdentity(requestWithHeaders({}));
  assert.deepEqual(result, { identity: 'alex@local', source: 'local' });
});

test('malformed header values fall through to the local identity', () => {
  const result = resolveTerminalIdentity(
    requestWithHeaders({
      'Cf-Access-Authenticated-User-Email': 'bad value with spaces; drop table',
    }),
  );
  assert.deepEqual(result, { identity: 'alex@local', source: 'local' });
});

test('unidentified caller when no header and no fallback', async () => {
  delete process.env.TERMINAL_LOCAL_IDENTITY;
  const { resolveTerminalIdentity: fresh } = await import('./identity.js');
  assert.deepEqual(fresh(requestWithHeaders({})), {
    identity: null,
    source: 'none',
  });
  process.env.TERMINAL_LOCAL_IDENTITY = 'alex@local';
});

test('admin detection uses the configured list (case-insensitive)', () => {
  assert.equal(isTerminalAdmin('ADMIN@example.com'), true);
  assert.equal(isTerminalAdmin('alex@local'), true);
  assert.equal(isTerminalAdmin('alice@example.com'), false);
  assert.equal(isTerminalAdmin(null), false);
});
