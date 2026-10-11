import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSetting, getSettings, invalidateSettingsCache } from './resolve.js';

/**
 * These tests exercise the env/default legs of the resolver. The DB leg is
 * best-effort by design (falls through on any DB error), and on the test
 * host DATABASE_URL points at a Docker-internal hostname, so the resolver
 * naturally exercises its fallback path here.
 */

const ORIGINAL = { ...process.env };

async function withEnv(vars, fn) {
  process.env.SETTINGS_TEST_VAR = vars.value ?? '';
  try {
    await fn();
  } finally {
    if (ORIGINAL.SETTINGS_TEST_VAR === undefined) {
      delete process.env.SETTINGS_TEST_VAR;
    } else {
      process.env.SETTINGS_TEST_VAR = ORIGINAL.SETTINGS_TEST_VAR;
    }
  }
}

describe('settings resolver', () => {
  beforeEach(() => {
    // The resolver memoizes for 5s; clear between cases so env changes bite.
    invalidateSettingsCache();
    process.env.SETTINGS_TEST_VAR = '';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SETTINGS_TEST_')) delete process.env[key];
    }
  });

  it('throws for unknown keys', async () => {
    await assert.rejects(
      () => getSetting('nope.doesNotExist'),
      /unknown setting/i,
    );
  });

  it('falls back to the registry default when env is unset', async () => {
    await withEnv({ value: '' }, async () => {
      assert.equal(await getSetting('meetings.formatter'), 'code');
      assert.equal(await getSetting('meetings.entityUpdatesMode'), 'off');
      assert.equal(await getSetting('readLater.ttsMaxChars'), 60000);
      assert.equal(await getSetting('readLater.ttsCleaner'), true);
    });
  });

  it('resolves from env with type coercion', async () => {
    // meetings.linkerEnabled: boolean, env MEETING_LINKER_ENABLED.
    process.env.MEETING_LINKER_ENABLED = 'true';
    assert.equal(await getSetting('meetings.linkerEnabled'), true);
    delete process.env.MEETING_LINKER_ENABLED;

    // readLater.ttsCleaner accepts the real-world 'off' spelling.
    process.env.READ_LATER_TTS_CLEANER = 'off';
    assert.equal(await getSetting('readLater.ttsCleaner'), false);
    delete process.env.READ_LATER_TTS_CLEANER;

    // csv splitting.
    process.env.MEETING_KNOWN_PEOPLE = 'Alice, Bob ,,Chen';
    assert.deepEqual(await getSetting('meetings.knownPeople'), [
      'Alice',
      'Bob',
      'Chen',
    ]);
    delete process.env.MEETING_KNOWN_PEOPLE;
  });

  it('caches per key and resolves batches', async () => {
    const first = await getSetting('meetings.formatter');
    const batch = await getSettings([
      'meetings.formatter',
      'readLater.ttsCleaner',
    ]);
    assert.equal(batch['meetings.formatter'], first);
    assert.equal(typeof batch['readLater.ttsCleaner'], 'boolean');
  });

  it('keeps identity defaults empty (first-run friendly)', async () => {
    assert.deepEqual(await getSetting('identity.aliases'), []);
    assert.equal(await getSetting('identity.name'), '');
  });
});
