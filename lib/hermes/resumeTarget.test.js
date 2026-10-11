import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findBranchMarker, resolveResumeTarget } from './resumeTarget.js';

describe('findBranchMarker', () => {
  it('detects delegate/branch/reset markers in a JSON string', () => {
    assert.equal(
      findBranchMarker('{"_delegate_from": "parent-1"}'),
      '_delegate_from',
    );
    assert.equal(
      findBranchMarker('{"max_tokens": 1, "_branched_from": "p"}'),
      '_branched_from',
    );
    assert.equal(findBranchMarker('{"_reset_from": "p"}'), '_reset_from');
  });

  it('accepts an already-parsed object', () => {
    assert.equal(findBranchMarker({ _delegate_from: 'p' }), '_delegate_from');
  });

  it('returns null for plain config, garbage, or empty input', () => {
    assert.equal(findBranchMarker('{"max_iterations": 50}'), null);
    assert.equal(findBranchMarker('not json'), null);
    assert.equal(findBranchMarker(null), null);
    assert.equal(findBranchMarker(undefined), null);
    assert.equal(findBranchMarker(''), null);
  });

  it('ignores markers explicitly set to null', () => {
    assert.equal(findBranchMarker('{"_delegate_from": null}'), null);
  });
});

describe('resolveResumeTarget', () => {
  const sessionDetail = (modelConfig) => async (id) => ({
    id,
    model_config: modelConfig,
  });

  it('keeps the original id when no descendant exists', async () => {
    let detailFetches = 0;
    const target = await resolveResumeTarget('s-1', {
      getLatestDescendant: async () => ({ session_id: 's-1' }),
      getSession: async () => {
        detailFetches += 1;
        return {};
      },
    });
    assert.equal(target, 's-1');
    assert.equal(detailFetches, 0);
  });

  it('follows a compression continuation (no branch markers)', async () => {
    const target = await resolveResumeTarget('s-1', {
      getLatestDescendant: async () => ({
        session_id: 'tip-1',
        path: ['s-1', 'tip-1'],
      }),
      getSession: sessionDetail('{"max_iterations": 50}'),
    });
    assert.equal(target, 'tip-1');
  });

  it('refuses a delegate child and stays on the original id', async () => {
    const target = await resolveResumeTarget('s-1', {
      getLatestDescendant: async () => ({ session_id: 'delegate-1' }),
      getSession: sessionDetail(
        '{"max_iterations": 50, "_delegate_from": "s-1"}',
      ),
    });
    assert.equal(target, 's-1');
  });

  it('refuses branched and reset children', async () => {
    for (const config of [
      '{"_branched_from": "s-1"}',
      '{"_reset_from": "s-1"}',
    ]) {
      const target = await resolveResumeTarget('s-1', {
        getLatestDescendant: async () => ({ session_id: 'child-1' }),
        getSession: sessionDetail(config),
      });
      assert.equal(target, 's-1', config);
    }
  });

  it('fails closed to the original id when the tip detail is unavailable', async () => {
    const target = await resolveResumeTarget('s-1', {
      getLatestDescendant: async () => ({ session_id: 'tip-1' }),
      getSession: async () => {
        throw new Error('404');
      },
    });
    assert.equal(target, 's-1');
  });

  it('fails closed when latest-descendant itself errors', async () => {
    const target = await resolveResumeTarget('s-1', {
      getLatestDescendant: async () => {
        throw new Error('network');
      },
      getSession: async () => ({}),
    });
    assert.equal(target, 's-1');
  });

  it('passes through a null/empty session id', async () => {
    let called = 0;
    const target = await resolveResumeTarget('', {
      getLatestDescendant: async () => {
        called += 1;
        return null;
      },
      getSession: async () => ({}),
    });
    assert.equal(target, '');
    assert.equal(called, 0);
  });
});
