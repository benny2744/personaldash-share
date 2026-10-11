import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_RUNTIME = 'nodejs';
const rows = new Map();
let reads = 0;
const upserts = [];
globalThis.__prisma = {
  appSetting: {
    findUnique: async ({ where }) =>
      rows.has(where.key)
        ? { key: where.key, value: rows.get(where.key) }
        : null,
    findMany: async ({ where } = {}) => {
      reads++;
      return [...rows]
        .filter(([key]) => !where || where.key.in.includes(key))
        .map(([key, value]) => ({ key, value }));
    },
    upsert: async ({ create }) => {
      upserts.push(create.key);
      rows.set(create.key, create.value);
      return create;
    },
    deleteMany: async ({ where }) => rows.delete(where.key),
  },
  $transaction: async (operations) => Promise.all(operations),
};
const {
  getSetting,
  getSettings,
  setSetting,
  resetSetting,
  describeSettings,
  invalidateSettingsCache,
} = await import('./resolve.js');

test('DB overrides win, writes invalidate caches, and reset restores env', async () => {
  process.env.DINGTALK_SELF_NAME = 'Environment name';
  invalidateSettingsCache();
  assert.equal(await getSetting('identity.name'), 'Environment name');
  await setSetting('identity.name', 'Override name');
  assert.equal(await getSetting('identity.name'), 'Override name');
  await resetSetting('identity.name');
  assert.equal(await getSetting('identity.name'), 'Environment name');
  await assert.rejects(setSetting('meetings.formatter', 'invalid'), {
    statusCode: 400,
  });
});

test('batch resolution uses a single query and caches values', async () => {
  invalidateSettingsCache();
  reads = 0;
  await getSettings([
    'identity.name',
    'identity.aliases',
    'meetings.formatter',
  ]);
  assert.equal(reads, 1);
  await getSettings(['identity.name', 'identity.aliases']);
  assert.equal(reads, 1);
});

test('setSettings validates everything first and writes atomically', async () => {
  const { setSettings } = await import('./resolve.js');
  rows.set('llm.baseUrl', 'https://original.example');
  upserts.length = 0;
  invalidateSettingsCache();
  // One invalid value aborts the whole save — no partial writes.
  await assert.rejects(
    setSettings([
      ['llm.baseUrl', 'https://new.example'],
      ['llm.model', 'test-model'],
      ['llm.apiKey', 'test-key'],
      ['meetings.formatter', 'invalid'],
    ]),
    /Invalid value/,
  );
  assert.deepEqual(upserts, []);
  assert.equal(rows.get('llm.baseUrl'), 'https://original.example');
  // Happy path: every key written in one transaction, caches refreshed.
  const saved = await setSettings([
    ['llm.baseUrl', 'https://new.example'],
    ['llm.model', 'test-model'],
    ['llm.apiKey', 'test-key'],
  ]);
  assert.equal(saved['llm.baseUrl'], 'https://new.example');
  assert.equal(upserts.length, 3);
  assert.equal(await getSetting('llm.baseUrl'), 'https://new.example');
});

test('secret snapshots mask both DB and env values', async () => {
  process.env.CALDAV_PASSWORD = 'env-secret';
  await setSetting('llm.apiKey', 'db-secret');
  const settings = await describeSettings();
  for (const key of ['llm.apiKey', 'calendar.password']) {
    const row = settings.find((row) => row.key === key);
    assert.equal(row.value, null);
    assert.equal(row.isSet, true);
    assert.equal('default' in row, false);
  }
  assert.equal(JSON.stringify(settings).includes('db-secret'), false);
  assert.equal(JSON.stringify(settings).includes('env-secret'), false);
});
