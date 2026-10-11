import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeGbrainHealth } from './gbrainHealth.js';

function baseStatus(overrides = {}) {
  const { host: hostOverride, ...restOverrides } = overrides;
  const host = {
    ok: true,
    sync_failures: 0,
    write_through: { 'sync.write_through': 'false' },
    include_working_tree: 'true',
    invariant: {
      checked_at: '2026-09-14T03:00:05+08:00',
      ok: true,
      mutations_during_probe: 0,
      file_count: 3681,
      age_hours: 2,
      stale: false,
    },
    dream_profile: {
      profile: 'safe',
      phases: ['sync', 'purge'],
      timer_enabled: true,
    },
    dream: {
      last_run: '2026-09-14T02:31:00',
      duration_s: 1492.7,
      slow_phases: { propose_takes: 1489 },
    },
    jobs: { pending: 4, running: 0, failed: 0 },
    stats: { pages: 3649, chunks: 10549, embedded: 10549, links: 7442 },
    propose_takes: {
      window_start: '2026-09-13T17:22:23',
      window_end: '2026-09-13T17:47:12',
      duration_s: 1489,
      llm: [
        {
          model: 'litellm:qwen3.8-flash',
          calls: 8,
          input_tokens: 16702,
          output_tokens: 17286,
        },
      ],
      proposals: { pending: 14, rejected: 4 },
    },
    ...(hostOverride || {}),
  };
  return { host, syncQueue: { pending: 0, isPaused: false }, indexer: { running: true, initialScanDone: true }, retrievalOnly: true, ...restOverrides };
}

describe('computeGbrainHealth', () => {
  it('reports clean integrity and healthy status on the happy path', () => {
    const h = computeGbrainHealth(baseStatus());
    assert.equal(h.status, 'healthy');
    assert.equal(h.canonicalIntegrity, 'clean');
    assert.deepEqual(h.integrityReasons, []);
    assert.equal(h.writeThrough, 'false');
    assert.equal(h.workingTreeSync, 'true');
    assert.equal(h.dream.profile, 'safe');
    assert.equal(h.dream.timerEnabled, true);
    assert.equal(h.embeddings, 'current');
    assert.equal(h.unexpectedVaultWrites, 0);
    assert.equal(h.canonicalAuthority, 'Personal Dash / Hermes');
    assert.equal(h.jobs.pending, 4);
    assert.equal(h.jobs.failed, 0);
  });

  it('fails integrity when write_through is not false', () => {
    const s = baseStatus();
    s.host.write_through = { 'sync.write_through': 'true' };
    s.retrievalOnly = false;
    const h = computeGbrainHealth(s);
    assert.equal(h.canonicalIntegrity, 'fail');
    assert.ok(h.integrityReasons.some((r) => r.includes('write_through')));
    assert.equal(h.status, 'unhealthy');
  });

  it('fails integrity on unexpected vault writes during the probe', () => {
    const s = baseStatus();
    s.host.invariant.ok = false;
    s.host.invariant.mutations_during_probe = 2;
    const h = computeGbrainHealth(s);
    assert.equal(h.canonicalIntegrity, 'fail');
    assert.equal(h.unexpectedVaultWrites, 2);
    assert.ok(h.integrityReasons.some((r) => r.includes('unexpected vault write')));
  });

  it('warns (degraded) when only the invariant check is stale', () => {
    const s = baseStatus();
    s.host.invariant.stale = true;
    s.host.invariant.age_hours = 40;
    const h = computeGbrainHealth(s);
    assert.equal(h.canonicalIntegrity, 'warn');
    assert.equal(h.status, 'degraded');
    assert.ok(h.integrityReasons.some((r) => r.includes('stale')));
  });

  it('fails integrity when the invariant probe has never run', () => {
    const s = baseStatus();
    s.host.invariant = { missing: true };
    const h = computeGbrainHealth(s);
    assert.equal(h.canonicalIntegrity, 'fail');
    assert.ok(h.integrityReasons.some((r) => r.includes('never run')));
  });

  it('fails integrity when the dream profile is not the safe set', () => {
    const s = baseStatus();
    s.host.dream_profile.profile = 'custom';
    s.host.dream_profile.phases = ['lint', 'sync'];
    const h = computeGbrainHealth(s);
    assert.equal(h.canonicalIntegrity, 'fail');
    assert.ok(h.integrityReasons.some((r) => r.includes('dream profile custom')));
  });

  it('fails integrity when working-tree sync is disabled', () => {
    const s = baseStatus();
    s.host.include_working_tree = 'false';
    const h = computeGbrainHealth(s);
    assert.equal(h.canonicalIntegrity, 'fail');
    assert.ok(h.integrityReasons.some((r) => r.includes('include_working_tree')));
  });

  it('reports unhealthy for failed jobs or sync failures even with clean integrity', () => {
    const withJobs = computeGbrainHealth(baseStatus({ host: { jobs: { pending: 0, running: 0, failed: 3 } } }));
    assert.equal(withJobs.status, 'unhealthy');
    assert.equal(withJobs.canonicalIntegrity, 'clean');

    const withFailures = computeGbrainHealth(baseStatus({ host: { sync_failures: 5 } }));
    assert.equal(withFailures.status, 'unhealthy');
    assert.equal(withFailures.syncFailures, 5);
  });

  it('marks unreachable when the host is down and degrades gracefully', () => {
    const s = baseStatus();
    s.host.ok = false;
    s.host.write_through = { error: 'boom' };
    const h = computeGbrainHealth(s);
    assert.equal(h.status, 'unreachable');
    assert.equal(h.writeThrough, 'unknown');
  });

  it('reports pending embeddings when coverage lags chunks', () => {
    const s = baseStatus();
    s.host.stats.embedded = 10500;
    const h = computeGbrainHealth(s);
    assert.equal(h.embeddings, '49 pending');
  });

  it('maps propose_takes watch metrics through unchanged', () => {
    const h = computeGbrainHealth(baseStatus());
    assert.equal(h.proposeTakes.durationS, 1489);
    assert.equal(h.proposeTakes.llm[0].model, 'litellm:qwen3.8-flash');
    assert.equal(h.proposeTakes.llm[0].input_tokens, 16702);
    assert.equal(h.proposeTakes.llm[0].output_tokens, 17286);
    assert.equal(h.proposeTakes.proposalsPending, 14);
    assert.equal(h.proposeTakes.proposalsRejected, 4);
    assert.equal(h.dream.slowPhases.propose_takes, 1489);
  });

  it('handles an entirely empty payload without throwing', () => {
    const h = computeGbrainHealth({});
    assert.equal(h.canonicalIntegrity, 'fail');
    assert.equal(h.status, 'unreachable');
    assert.equal(h.writeThrough, 'unknown');
  });
});
