import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { sortVaultEntries } = await import('./vaultSort.js');

const ENTRIES = [
  {
    name: 'zeta.txt',
    type: 'file',
    size: 30,
    modifiedAt: '2026-10-01T00:00:00Z',
  },
  {
    name: 'Alpha',
    type: 'directory',
    size: 4096,
    modifiedAt: '2026-09-01T00:00:00Z',
  },
  {
    name: 'beta.md',
    type: 'file',
    size: 10,
    modifiedAt: '2026-10-09T00:00:00Z',
  },
  { name: 'Beta', type: 'directory', size: null, modifiedAt: null },
  {
    name: 'gamma.md',
    type: 'file',
    size: 20,
    modifiedAt: '2026-10-05T00:00:00Z',
  },
];

const names = (rows) => rows.map((row) => row.name);

describe('sortVaultEntries', () => {
  it('pins directories first and sorts by name (asc, case-insensitive)', () => {
    const rows = sortVaultEntries(ENTRIES, { key: 'name', dir: 'asc' });
    assert.deepEqual(names(rows), [
      'Alpha',
      'Beta',
      'beta.md',
      'gamma.md',
      'zeta.txt',
    ]);
  });

  it('reverses name order within groups on desc', () => {
    const rows = sortVaultEntries(ENTRIES, { key: 'name', dir: 'desc' });
    assert.deepEqual(names(rows), [
      'Beta',
      'Alpha',
      'zeta.txt',
      'gamma.md',
      'beta.md',
    ]);
  });

  it('sorts by size, null sizes last (both directions), dirs still pinned', () => {
    const rows = sortVaultEntries(ENTRIES, { key: 'size', dir: 'asc' });
    // dirs: Alpha (4096) then Beta (null); files: 10, 20, 30
    assert.deepEqual(names(rows), [
      'Alpha',
      'Beta',
      'beta.md',
      'gamma.md',
      'zeta.txt',
    ]);
    const desc = sortVaultEntries(ENTRIES, { key: 'size', dir: 'desc' });
    // dirs: Alpha first (Beta null sorts last even on desc); files: 30, 20, 10
    assert.deepEqual(names(desc), [
      'Alpha',
      'Beta',
      'zeta.txt',
      'gamma.md',
      'beta.md',
    ]);
  });

  it('sorts by modified date desc, missing dates last', () => {
    const rows = sortVaultEntries(ENTRIES, { key: 'modified', dir: 'desc' });
    // dirs: Alpha (has date) then Beta (null); files: Oct 9, Oct 5, Oct 1
    assert.deepEqual(names(rows), [
      'Alpha',
      'Beta',
      'beta.md',
      'gamma.md',
      'zeta.txt',
    ]);
  });

  it('defaults to name asc and does not mutate the input', () => {
    const input = [...ENTRIES];
    const rows = sortVaultEntries(input);
    assert.deepEqual(names(rows), [
      'Alpha',
      'Beta',
      'beta.md',
      'gamma.md',
      'zeta.txt',
    ]);
    assert.deepEqual(names(input), names(ENTRIES));
  });
});
