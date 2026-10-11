import { enqueueMeetingJob } from '@/lib/meetingPipeline/job';
import {
  completeMultipartUpload,
  headObject,
  listParts,
  reconcileUpload,
} from '@/lib/meetingPipeline/storage';
import {
  findMeetingJob,
  listMeetingUploads,
  updateMeetingJob,
  updateMeetingUpload,
} from '@/lib/meetingPipeline/jobsDb';
import {
  UPLOAD_KIND_AUDIO,
  UPLOAD_KIND_SUPPLEMENTARY,
  expectedPartCount,
  jsonError,
} from '@/lib/meetingPipeline/uploadHelpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TERMINAL_STATUSES = new Set([
  'queued',
  'processing',
  'cancelled',
  'failed',
]);

function serializeJob(job) {
  return {
    id: job.id,
    audioName: job.audioName,
    audioSize: job.audioSize,
    audioFiles: job.audioFiles ?? null,
    supplementaryFiles: job.supplementaryFiles ?? null,
    participantsText: job.participantsText ?? null,
    status: job.status,
    step: job.step,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * Complete a single multipart upload using S3-authoritative part list.
 * Returns the reconciled status. Idempotent: if already uploaded, no-ops.
 */
async function completeOneMultipartUpload(upload) {
  if (upload.status === 'uploaded') return upload;

  // A prior CompleteMultipartUpload may have won — check for the final object.
  const head = await headObject({ key: upload.s3Key });
  if (
    head.exists &&
    (head.contentLength == null || head.contentLength === upload.expectedSize)
  ) {
    const updated = await updateMeetingUpload(upload.id, {
      status: 'uploaded',
      lastActivityAt: new Date(),
    });
    return { ...updated, _finalSize: head.contentLength };
  }

  // ListParts is authoritative — the DB parts may have a stale ETag from a retry race.
  const parts = await listParts({
    key: upload.s3Key,
    uploadId: upload.multipartUploadId,
  });

  const expected = expectedPartCount(upload.expectedSize);
  if (
    parts.length !== expected ||
    !parts.every((p, i) => p.partNumber === i + 1)
  ) {
    throw new Error(
      `Incomplete multipart upload ${upload.id}: ${parts.length}/${expected} parts`,
    );
  }

  await completeMultipartUpload({
    key: upload.s3Key,
    uploadId: upload.multipartUploadId,
    parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
  });

  // Sync DB parts from S3's authoritative list (fixes retry-race ETag skew).
  const partsJson = {};
  for (const p of parts) {
    partsJson[String(p.partNumber)] = {
      partNumber: p.partNumber,
      etag: p.etag,
      size: p.size,
    };
  }
  const updated = await updateMeetingUpload(upload.id, {
    status: 'uploaded',
    parts: partsJson,
    lastActivityAt: new Date(),
  });
  return { ...updated };
}

/**
 * POST /api/meetings/uploads/[id]/complete
 * Bodyless. Validates every upload, completes multipart sessions using S3's
 * ListParts as authoritative, then flips the job to queued + enqueues.
 * Terminal-idempotent: a job already queued/processed/cancelled/failed is
 * returned as-is without re-enqueuing. Here [id] is a MeetingJob id.
 */
export async function POST(request, { params }) {
  const { id: jobId } = await params;

  const job = await findMeetingJob(jobId);
  if (!job) return jsonError('Job not found', 404);

  // Terminal idempotency: never re-enqueue a job that already moved on.
  if (TERMINAL_STATUSES.has(job.status)) {
    return Response.json(serializeJob(job), { status: 200 });
  }

  const uploads = await listMeetingUploads(jobId);
  if (!uploads.length) {
    return jsonError('Job has no uploads to complete', 400);
  }

  // Move the job to completing. Child statuses change individually: single-PUT
  // uploads stay `uploaded`; only multipart uploads in `uploading` transit
  // through `completing` → `uploaded`.
  await updateMeetingJob(jobId, { status: 'completing', step: 'completing' });

  try {
    for (const upload of uploads) {
      if (upload.mode === 'multipart') {
        await updateMeetingUpload(upload.id, {
          status: 'completing',
          lastActivityAt: new Date(),
        });
        await completeOneMultipartUpload(upload);
      } else {
        // Single-PUT uploads must already be `uploaded`; reconcile if unsure.
        if (upload.status !== 'uploaded') {
          const verdict = await reconcileUpload(upload);
          if (verdict.status === 'uploaded') {
            await updateMeetingUpload(upload.id, { status: 'uploaded' });
          } else {
            throw new Error(
              `Single upload ${upload.id} not ready (status: ${verdict.status})`,
            );
          }
        }
      }
    }

    // Build the JSON arrays the existing ASR pipeline reads.
    const refreshed = await listMeetingUploads(jobId);
    const audioFiles = refreshed
      .filter((u) => u.kind === UPLOAD_KIND_AUDIO)
      .sort((a, b) => a.fileIndex - b.fileIndex)
      .map((u) => ({
        key: u.s3Key,
        name: u.originalName,
        size: u.expectedSize,
        type: u.contentType,
        index: u.fileIndex,
      }));
    const supplementaryFiles = refreshed
      .filter((u) => u.kind === UPLOAD_KIND_SUPPLEMENTARY)
      .sort((a, b) => a.fileIndex - b.fileIndex)
      .map((u) => ({
        key: u.s3Key,
        name: u.originalName,
        size: u.expectedSize,
        type: u.contentType,
        index: u.fileIndex,
      }));

    const updated = await updateMeetingJob(jobId, {
      audioFiles,
      supplementaryFiles,
      status: 'queued',
      step: 'queued',
    });

    enqueueMeetingJob();

    console.log('[meeting-upload] submission completed', {
      jobId,
      audioCount: audioFiles.length,
      suppCount: supplementaryFiles.length,
    });

    return Response.json(serializeJob(updated), { status: 202 });
  } catch (error) {
    console.error('[meeting-upload] complete failed', {
      jobId,
      error: error.message,
    });
    await updateMeetingJob(jobId, {
      status: 'failed',
      step: 'failed',
      error: `Completion failed: ${error.message}`,
      finishedAt: new Date(),
    });
    return jsonError(`Completion failed: ${error.message}`, 500);
  }
}
