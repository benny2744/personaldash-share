import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createOverrideCandidates,
  isCreateOverrideRejection,
  mirrorRefusedSwitch,
  modelSwitchValue,
  shouldFastSwitch,
} from './modelSwitch.js';

test('modelSwitchValue joins id and provider', () => {
  assert.equal(modelSwitchValue('gpt-6-luna', 'openai-codex'), 'gpt-6-luna --provider openai-codex');
  assert.equal(modelSwitchValue('gpt-6-luna', ''), 'gpt-6-luna');
  assert.equal(modelSwitchValue('gpt-6-luna', undefined), 'gpt-6-luna');
  assert.equal(modelSwitchValue('gpt-6-luna', '  '), 'gpt-6-luna');
  assert.equal(modelSwitchValue('', 'openai-codex'), '');
  assert.equal(modelSwitchValue(undefined, undefined), '');
});

test('isCreateOverrideRejection matches the gateway catalog rejection', () => {
  const rejection = new Error(
    'Model `gpt-6-luna` is not served by provider `alibaba` (Qwen Cloud). Closest Qwen Cloud models: `qwen3.8-max`',
  );
  assert.equal(isCreateOverrideRejection(rejection), true);
  assert.equal(isCreateOverrideRejection({ message: 'NOT SERVED BY PROVIDER `x`' }), true);
  assert.equal(isCreateOverrideRejection(new Error('WebSocket closed')), false);
  assert.equal(isCreateOverrideRejection(new Error('timeout')), false);
  assert.equal(isCreateOverrideRejection(null), false);
  assert.equal(isCreateOverrideRejection(undefined), false);
});

test('mirrorRefusedSwitch treats any non-empty slash warning as not applied', () => {
  assert.equal(mirrorRefusedSwitch('session busy — Hermes is still replying.'), true);
  assert.equal(mirrorRefusedSwitch('live session sync failed: boom'), true);
  assert.equal(mirrorRefusedSwitch(''), false);
  assert.equal(mirrorRefusedSwitch('   '), false);
  assert.equal(mirrorRefusedSwitch(undefined), false);
});

test('createOverrideCandidates orders providers, dedupes, appends attribution', () => {
  assert.deepEqual(
    createOverrideCandidates({
      id: 'gpt-6-luna',
      provider: 'alibaba',
      providers: ['openai-codex', 'alibaba', 'xiaomi'],
    }),
    [
      { id: 'gpt-6-luna', provider: 'openai-codex' },
      { id: 'gpt-6-luna', provider: 'alibaba' },
      { id: 'gpt-6-luna', provider: 'xiaomi' },
    ],
  );
  // No providers list: the attributed provider alone.
  assert.deepEqual(createOverrideCandidates({ id: 'm', provider: 'p' }), [
    { id: 'm', provider: 'p' },
  ]);
  // Attributed provider missing from the list is appended last.
  assert.deepEqual(
    createOverrideCandidates({ id: 'm', provider: 'z', providers: ['a', 'b'] }),
    [
      { id: 'm', provider: 'a' },
      { id: 'm', provider: 'b' },
      { id: 'm', provider: 'z' },
    ],
  );
  assert.deepEqual(createOverrideCandidates({ id: 'm' }), []);
  assert.deepEqual(createOverrideCandidates(null), []);
  assert.deepEqual(createOverrideCandidates({ id: '  ' }), []);
});

test('shouldFastSwitch: running defers, completed turn is fast, pre-first-turn stays slash', () => {
  assert.equal(shouldFastSwitch({ sessionRunning: true, turnRanSinceBind: false }), true);
  assert.equal(shouldFastSwitch({ sessionRunning: false, turnRanSinceBind: true }), true);
  assert.equal(shouldFastSwitch({ sessionRunning: true, turnRanSinceBind: true }), true);
  assert.equal(shouldFastSwitch({ sessionRunning: false, turnRanSinceBind: false }), false);
  assert.equal(shouldFastSwitch({}), false);
});
