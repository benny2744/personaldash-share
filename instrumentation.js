/**
 * Server bootstrap: starts the background workers exactly once per process.
 *
 * NOTE: keep the per-step boot logging. Beyond making startup observable, the
 * exact module shape this file compiles into affects webpack chunk splitting
 * for the instrumentation graph — with the previous (log-free) shape, the
 * built server hung at boot with the event loop idle (requests accepted but
 * never served, no worker logs; reproduced across clean rebuilds of identical
 * source, resolved by this shape). If you refactor this file, verify a
 * production build actually boots and serves before shipping it.
 */

const dlog = (m) =>
  process._rawDebug(`[boot] ${m} @${Date.now() - globalThis.__bootT0}ms`);

export async function register() {
  globalThis.__bootT0 = Date.now();
  dlog('enter');
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    dlog('importing startup.js');
    const { recoverMeetingJobs } =
      await import('./lib/meetingPipeline/startup.js');
    dlog('startup.js imported');
    const { startIndexer } = await import('./lib/indexer.js');
    dlog('indexer.js imported');
    const { startTaskReminder } = await import('./lib/taskReminder.js');
    const { startAutoArchiver } = await import('./lib/autoArchiver.js');
    const { startMeetingLinker } =
      await import('./lib/meetingPipeline/linker.js');
    const { startEntityUpdateWorker } =
      await import('./lib/meetingPipeline/entityUpdates.js');
    const { startCaldavSyncWorker } = await import('./lib/caldav/sync.js');
    dlog('all modules imported');
    await recoverMeetingJobs();
    dlog('recoverMeetingJobs done');
    await startIndexer();
    dlog('startIndexer done');
    startTaskReminder();
    startAutoArchiver();
    startMeetingLinker();
    startEntityUpdateWorker();
    startCaldavSyncWorker();
    dlog('register complete');
  }
}
