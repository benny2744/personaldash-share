import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { triggerGbrainSyncUrl, triggerGbrainSync } from './gbrainSync.js';

/**
 * gbrain-sync trigger contract:
 * - No GBRAIN_SYNC_HOOK_URL => triggerGbrainSync is a safe no-op and
 *   triggerGbrainSyncUrl returns null (callers never branch on config).
 * - Configured => URL helpers resolve against the hook origin and the
 *   fire-and-forget POST never throws, even when the target is offline.
 */

describe('gbrain sync trigger', () => {
  it('is a no-op when GBRAIN_SYNC_HOOK_URL is unset', () => {
    // This test process has no GBRAIN_SYNC_HOOK_URL, so HOOK_URL === ''.
    assert.equal(triggerGbrainSyncUrl('/sync'), null);
    assert.doesNotThrow(() => triggerGbrainSync('test'));
  });

  it('resolves paths against the hook origin when configured', async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const modPath = fileURLToPath(import.meta.url).replace(/\.test\.js$/, '.js');
    const script = `
      const { triggerGbrainSyncUrl } = await import(${JSON.stringify(modPath)});
      console.log(triggerGbrainSyncUrl('/status'));
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GBRAIN_SYNC_HOOK_URL: 'http://indexer:9103/sync',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'http://indexer:9103/status');
  });
});
