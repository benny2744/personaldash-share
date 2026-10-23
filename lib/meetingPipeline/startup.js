import { listAudioKeys, deleteObject } from './storage';
import {
  listActiveAudioKeys,
  listRecentlyFinishedAudioKeys,
  listProcessingMeetingJobs,
  listFailedJobsSince,
  findMeetingJob,
  markQueuedJobsFailed,
  updateMeetingJob,
  requeueMeetingJob,
} from './jobsDb';
import {
  startMeetingJobWorker,
  startOrphanAudioSweeper,
  startStaleUploadSweeper,
} from './job';
import {
  recoverProcessingMeetingJobs,
  requeueTransientFailedJobs,
} from './recover';

export async function markStaleJobsFailed() {
  await markQueuedJobsFailed();
}

export async function sweepOrphanAudio() {
  const [keys, activeAudioKeys, recentlyFinishedKeys] = await Promise.all([
    listAudioKeys(),
    listActiveAudioKeys(),
    listRecentlyFinishedAudioKeys(),
  ]);
  const protectedKeys = new Set([...activeAudioKeys, ...recentlyFinishedKeys]);

  const toDelete = keys.filter((key) => !protectedKeys.has(key));
  await Promise.all(
    toDelete.map((key) =>
      deleteObject(key).catch((error) => {
        console.error(
          '[meeting-pipeline] orphan audio cleanup failed',
          key,
          error,
        );
      }),
    ),
  );
  if (toDelete.length > 0) {
    console.log(
      `[meeting-pipeline] orphan audio cleanup: ${toDelete.length} object(s) deleted, ${protectedKeys.size} key(s) protected`,
    );
  }
}

export async function recoverMeetingJobs() {
  try {
    // Kick off (non-blocking) salvage of processing jobs whose opencode format
    // session may have finished on the host. Must run before the stale-job
    // marking below; each salvage re-checks job state before writing anything
    // and the final done-write only applies to failed/processing rows.
    await recoverProcessingMeetingJobs({
      listProcessingMeetingJobs,
      findMeetingJob,
      updateMeetingJob,
    });
    await markStaleJobsFailed();
    // Failed by a transient outage (gateway down / upstream 5xx), audio and
    // mid-pipeline state preserved: put them back on the queue so the worker
    // (started below) resumes them once the estate is healthy again.
    await requeueTransientFailedJobs({
      listFailedJobsSince,
      requeueMeetingJob,
    });
    await sweepOrphanAudio();
    startMeetingJobWorker();
    startOrphanAudioSweeper();
    startStaleUploadSweeper();
  } catch (error) {
    console.error('[meeting-pipeline] startup recovery failed', error);
  }
}
