import prisma from '@/lib/db';

function withoutUndefined(data) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

export async function createMeetingJob(data) {
  return prisma.meetingJob.create({
    data: {
      audioName: data.audioName,
      audioSize: data.audioSize,
      audioKey: data.audioKey ?? null,
      audioFiles: data.audioFiles ?? null,
      supplementaryFiles: data.supplementaryFiles ?? null,
      status: data.status || 'queued',
      step: data.step || null,
      participantsText: data.participantsText ?? null,
      uploadSubmissionId: data.uploadSubmissionId ?? null,
    },
  });
}

export async function updateMeetingJob(id, data) {
  return prisma.meetingJob.update({
    where: { id },
    data:
      Object.keys(withoutUndefined(data)).length > 0
        ? withoutUndefined(data)
        : { updatedAt: new Date() },
  });
}

export async function findMeetingJob(id) {
  return prisma.meetingJob.findUnique({
    where: { id },
    include: { uploads: { orderBy: { kind: 'asc' } } },
  });
}

export async function listMeetingJobs({
  activeOnly = false,
  recentCutoff,
  limit = 100,
} = {}) {
  return prisma.meetingJob.findMany({
    where: activeOnly
      ? {
          OR: [
            {
              status: {
                in: ['queued', 'processing', 'uploading', 'completing'],
              },
            },
            ...(recentCutoff ? [{ createdAt: { gte: recentCutoff } }] : []),
          ],
        }
      : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/**
 * Jobs in 'processing' state (e.g. found at container startup after a crash or
 * mid-job restart). Used by startup recovery to attempt session-based salvage
 * before falling back to marking them failed.
 */
export async function listProcessingMeetingJobs() {
  return prisma.meetingJob.findMany({
    where: { status: 'processing' },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Startup recovery for jobs left in 'processing' by a container restart.
 *
 * - Pre-format interrupts (no opencode session) that are retryable — audio
 *   still in S3, a pending async ASR task, or a persisted pass1 — are
 *   REQUEUED so the worker automatically resumes them (ASR task resume /
 *   pass1 skip) instead of surfacing a failure.
 * - The rest (format-stage interrupts, handled by the session-salvage path,
 *   and unretryable jobs) keep the existing failed marker.
 */
export async function markQueuedJobsFailed() {
  await prisma.meetingJob.updateMany({
    where: {
      status: 'processing',
      opencodeSessionId: null,
      OR: [
        { audioKey: { not: null } },
        { audioFiles: { not: null } },
        { pass1Json: { not: null } },
        { asrTaskId: { not: null } },
        { asrTaskIds: { not: null } },
      ],
    },
    data: {
      status: 'queued',
      step: 'queued',
      error: null,
      finishedAt: null,
    },
  });
  await prisma.meetingJob.updateMany({
    where: { status: 'processing' },
    data: {
      status: 'failed',
      step: 'failed',
      error: 'Container restarted mid-job',
      finishedAt: new Date(),
    },
  });
}

function hasAudioFiles(job) {
  return Array.isArray(job?.audioFiles) && job.audioFiles.length > 0;
}

export async function claimQueuedMeetingJob() {
  const job = await prisma.meetingJob.findFirst({
    where: {
      status: 'queued',
      OR: [
        { audioKey: { not: null } },
        { audioFiles: { not: null } },
        { pass1Json: { not: null } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!job) return null;

  const claimed = await prisma.meetingJob.updateMany({
    where: { id: job.id, status: 'queued' },
    data: {
      status: 'processing',
      step: 'queued',
      startedAt: job.startedAt || new Date(),
      error: null,
    },
  });
  if (claimed.count === 0) return null;
  return findMeetingJob(job.id);
}

export async function cancelMeetingJob(id) {
  const updated = await prisma.meetingJob.updateMany({
    where: {
      id,
      status: { in: ['queued', 'processing', 'uploading', 'completing'] },
    },
    data: {
      status: 'cancelled',
      step: 'cancelled',
      error: 'Cancelled by user',
      finishedAt: new Date(),
    },
  });
  if (updated.count === 0) return null;
  return findMeetingJob(id);
}

/**
 * Requeue a failed/cancelled job back to 'queued' so the worker re-processes
 * it. The audio must still be in S3 (job.audioFiles must be present).
 * Clears error/finishedAt and resets step. Returns the job, or null if the
 * job wasn't in a retryable state or has no audio to reprocess.
 */
export async function requeueMeetingJob(id) {
  const updated = await prisma.meetingJob.updateMany({
    where: {
      id,
      status: { in: ['failed', 'cancelled'] },
      OR: [
        { audioKey: { not: null } },
        { audioFiles: { not: null } },
        { pass1Json: { not: null } },
      ],
    },
    data: {
      status: 'queued',
      step: 'queued',
      error: null,
      finishedAt: null,
      startedAt: null,
    },
  });
  if (updated.count === 0) return null;
  return findMeetingJob(id);
}

export async function listOrphanedAudioJobs(olderThanMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - olderThanMs);
  return prisma.meetingJob.findMany({
    where: {
      status: { in: ['failed', 'cancelled'] },
      OR: [{ audioKey: { not: null } }, { audioFiles: { not: null } }],
      finishedAt: { lte: cutoff },
    },
    orderBy: { createdAt: 'asc' },
  });
}

function audioKeysFromJobs(jobs) {
  const keys = [];
  for (const job of jobs) {
    if (job.audioKey) keys.push(job.audioKey);
    if (hasAudioFiles(job)) {
      for (const file of job.audioFiles) {
        if (file?.key) keys.push(file.key);
      }
    }
  }
  return keys.filter(Boolean);
}

export async function listActiveAudioKeys() {
  const jobs = await prisma.meetingJob.findMany({
    where: {
      status: { in: ['queued', 'processing'] },
      OR: [{ audioKey: { not: null } }, { audioFiles: { not: null } }],
    },
    select: { audioKey: true, audioFiles: true },
  });
  return audioKeysFromJobs(jobs);
}

/**
 * Audio keys for failed/cancelled jobs within the grace window. The startup
 * GC must not delete these: the job is retryable and its audio is the only
 * copy. Mirrors the 24h cutoff used by sweepOrphanedMeetingAudio.
 */
export async function listRecentlyFinishedAudioKeys(
  withinMs = 24 * 60 * 60 * 1000,
) {
  const cutoff = new Date(Date.now() - withinMs);
  const jobs = await prisma.meetingJob.findMany({
    where: {
      status: { in: ['failed', 'cancelled'] },
      OR: [{ audioKey: { not: null } }, { audioFiles: { not: null } }],
      finishedAt: { gt: cutoff },
    },
    select: { audioKey: true, audioFiles: true },
  });
  return audioKeysFromJobs(jobs);
}

// ─── MeetingUpload helpers (autochunking upload lifecycle) ───────────────────

export async function createMeetingUploads(jobId, uploads) {
  return prisma.meetingUpload.createMany({
    data: uploads.map((u) => ({
      jobId,
      kind: u.kind,
      fileIndex: u.fileIndex,
      originalName: u.originalName,
      contentType: u.contentType,
      expectedSize: u.expectedSize,
      s3Key: u.s3Key ?? null,
      multipartUploadId: u.multipartUploadId ?? null,
      mode: u.mode ?? 'single',
      status: u.status ?? 'pending',
      parts: u.parts ?? null,
    })),
  });
}

export async function findMeetingUpload(id) {
  return prisma.meetingUpload.findUnique({ where: { id } });
}

export async function listMeetingUploads(jobId) {
  return prisma.meetingUpload.findMany({
    where: { jobId },
    orderBy: [{ kind: 'asc' }, { fileIndex: 'asc' }],
  });
}

export async function updateMeetingUpload(id, data) {
  return prisma.meetingUpload.update({
    where: { id },
    data: withoutUndefined(data),
  });
}

/**
 * Upsert a part record by partNumber (replace, never append). Retrying a part
 * upload reuses the same S3 part number, so the latest ETag wins.
 */
export async function upsertUploadPart(uploadId, partNumber, etag, size) {
  const upload = await prisma.meetingUpload.findUnique({
    where: { id: uploadId },
    select: { parts: true },
  });
  if (!upload) throw new Error(`MeetingUpload not found: ${uploadId}`);
  const parts = { ...(upload.parts || {}) };
  parts[String(partNumber)] = { partNumber, etag, size };
  return prisma.meetingUpload.update({
    where: { id: uploadId },
    data: {
      parts,
      lastActivityAt: new Date(),
      status: 'uploading',
    },
  });
}

export async function findJobBySubmissionId(submissionId) {
  return prisma.meetingJob.findUnique({
    where: { uploadSubmissionId: submissionId },
    include: { uploads: { orderBy: [{ kind: 'asc' }, { fileIndex: 'asc' }] } },
  });
}

/**
 * Jobs stuck in uploading/completing past the inactivity TTL. Used by the
 * recovery sweeper to abort or reconcile abandoned multipart sessions.
 */
export async function listStaleUploadJobs(ttlMs) {
  const cutoff = new Date(Date.now() - ttlMs);
  return prisma.meetingJob.findMany({
    where: {
      status: { in: ['uploading', 'completing'] },
      uploads: { some: { lastActivityAt: { lt: cutoff } } },
    },
    include: { uploads: true },
    orderBy: { createdAt: 'asc' },
  });
}
