import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS,
  SETTINGS_BY_KEY,
  SETTINGS_GROUPS,
  validateSettingValue,
} from './registry.js';
describe('settings registry', () => {
  it('has unique keys with required fields', () => {
    const keys = new Set();
    for (const def of SETTINGS) {
      assert.ok(!keys.has(def.key), `duplicate key ${def.key}`);
      keys.add(def.key);
      assert.equal(SETTINGS_BY_KEY.get(def.key), def);
      assert.ok(def.label && def.description && def.group);
      assert.ok(['hot', 'boot'].includes(def.scope), `bad scope on ${def.key}`);
    }
    assert.ok(SETTINGS_GROUPS.length >= 1);
  });

  it('validates text values', () => {
    const def = { type: 'text' };
    assert.deepEqual(validateSettingValue(def, 'hello'), {
      ok: true,
      value: 'hello',
    });
    assert.equal(validateSettingValue(def, 5).ok, false);
  });

  it('validates booleans including string forms', () => {
    const def = { type: 'boolean' };
    assert.deepEqual(validateSettingValue(def, true), {
      ok: true,
      value: true,
    });
    assert.deepEqual(validateSettingValue(def, 'false'), {
      ok: true,
      value: false,
    });
    assert.equal(validateSettingValue(def, 'maybe').ok, false);
  });

  it('validates numbers with min/max', () => {
    const def = { type: 'number', min: 10, max: 20 };
    assert.deepEqual(validateSettingValue(def, '15'), { ok: true, value: 15 });
    assert.equal(validateSettingValue(def, 5).ok, false);
    assert.equal(validateSettingValue(def, 25).ok, false);
    assert.equal(validateSettingValue(def, 'abc').ok, false);
  });

  it('rejects fractional values for integer settings', () => {
    const def = { type: 'number', min: 1, max: 100, integer: true };
    assert.deepEqual(validateSettingValue(def, 8), { ok: true, value: 8 });
    assert.deepEqual(validateSettingValue(def, '8'), { ok: true, value: 8 });
    assert.equal(validateSettingValue(def, 1.5).ok, false);
    assert.equal(validateSettingValue(def, '2.5').ok, false);
    assert.equal(
      validateSettingValue(SETTINGS_BY_KEY.get('intel.dmBatchSize'), 1.5).ok,
      false,
    );
  });

  it('validates select values against options', () => {
    const def = {
      type: 'select',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    };
    assert.deepEqual(validateSettingValue(def, 'a'), { ok: true, value: 'a' });
    assert.equal(validateSettingValue(def, 'c').ok, false);
  });

  it('normalizes csv strings into trimmed arrays', () => {
    const def = { type: 'csv' };
    assert.deepEqual(validateSettingValue(def, 'a, b ,,c'), {
      ok: true,
      value: ['a', 'b', 'c'],
    });
    assert.deepEqual(validateSettingValue(def, ['x']), {
      ok: true,
      value: ['x'],
    });
  });

  it('rejects undefined json values', () => {
    const def = { type: 'json' };
    assert.equal(validateSettingValue(def, undefined).ok, false);
    assert.deepEqual(validateSettingValue(def, { a: 1 }).ok, true);
  });
});
