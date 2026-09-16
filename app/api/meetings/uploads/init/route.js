import config from '@/lib/config';
import { createMultipartUpload } from '@/lib/meetingPipeline/storage';
import {
  createMeetingJob,
  createMeetingUploads,
  findJobBySubmissionId,
  updateMeetingJob,
} from '@/lib/meetingPipeline/jobsDb';
import {
  UPLOAD_KIND_AUDIO,
  UPLOAD_KIND_SUPPLEMENTARY,
  extForUpload,
  jsonError,
  s3KeyForUpload,
  serializeUpload,
  validateInitSubmission,
} from '@/lib/meetingPipeline/uploadHelpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/meetings/uploads/init
 * Body: { submissionId: string, audioFiles: [{name,size,type}], supplementaryFiles: [{name,size,type}] }
 *
 * Idempotent: a retry with the same submissionId returns the existing job and
 * its uploads (without recreating S3 multipart sessions). Creates one MeetingJob
 * for the whole submission plus one MeetingUpload per file.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body');
  }

  const submissionId =
    typeof body?.submissionId === 'string' && body.submissionId;
  if (!submissionId) {
    return jsonError('Missing "submissionId"');
  }

  const result = validateInitSubmission(body);
  if (!result.ok) {
    return jsonError(result.error, result.status);
  }

  // Idempotency: return the existing session if this submissionId was seen.
  const existing = await findJobBySubmissionId(submissionId);
  if (existing) {
    return Response.json(
      {
        jobId: existing.id,
        uploads: existing.uploads.map(serializeUpload),
        resumed: true,
      },
      { status: 200 },
    );
  }

  const { audioFiles, supplementaryFiles, totalBytes } = result;

  const job = await createMeetingJob({
    audioName: audioFiles[0].name || 'meeting-audio',
    audioSize: totalBytes,
    status: 'uploading',
    step: 'upload',
    uploadSubmissionId: submissionId,
    participantsText: result.participantsText,
  });

  const uploads = [];
  const uploadRecords = [];

  for (let index = 0; index < audioFiles.length; index += 1) {
    const file = audioFiles[index];
    const ext = extForUpload(file);
    const s3Key = s3KeyForUpload(job.id, UPLOAD_KIND_AUDIO, index, ext);
    const mode =
      file.size > config.meetingUploadChunkSize ? 'multipart' : 'single';

    let multipartUploadId = null;
    if (mode === 'multipart') {
      try {
        const created = await createMultipartUpload({
          key: s3Key,
          contentType: file.type || 'application/octet-stream',
        });
        multipartUploadId = created.uploadId;
      } catch (error) {
        console.error('[meeting-upload] createMultipartUpload failed', {
          jobId: job.id,
          s3Key,
          error: error.message,
        });
        await updateMeetingJob(job.id, {
          status: 'failed',
          step: 'failed',
          error: `Upload init failed: ${error.message}`,
          finishedAt: new Date(),
        });
        return jsonError(
          `Failed to start multipart upload for ${file.name}`,
          500,
        );
      }
    }

    uploads.push({
      kind: UPLOAD_KIND_AUDIO,
      fileIndex: index,
      originalName: file.name,
      contentType: file.type || 'application/octet-stream',
      expectedSize: file.size,
      s3Key,
      multipartUploadId,
      mode,
      status: 'uploading',
    });
    uploadRecords.push({
      kind: UPLOAD_KIND_AUDIO,
      fileIndex: index,
      originalName: file.name,
      contentType: file.type || 'application/octet-stream',
      expectedSize: file.size,
      s3Key,
      multipartUploadId,
      mode,
      status: 'uploading',
    });
  }

  for (let index = 0; index < supplementaryFiles.length; index += 1) {
    const file = supplementaryFiles[index];
    const ext = extForUpload(file);
    const s3Key = s3KeyForUpload(job.id, UPLOAD_KIND_SUPPLEMENTARY, index, ext);
    const mode =
      file.size > config.meetingUploadChunkSize ? 'multipart' : 'single';

    let multipartUploadId = null;
    if (mode === 'multipart') {
      try {
        const created = await createMultipartUpload({
          key: s3Key,
          contentType: file.type || 'application/octet-stream',
        });
        multipartUploadId = created.uploadId;
      } catch (error) {
        console.error('[meeting-upload] createMultipartUpload (supp) failed', {
          jobId: job.id,
          s3Key,
          error: error.message,
        });
        await updateMeetingJob(job.id, {
          status: 'failed',
          step: 'failed',
          error: `Upload init failed: ${error.message}`,
          finishedAt: new Date(),
        });
        return jsonError(
          `Failed to start multipart upload for ${file.name}`,
          500,
        );
      }
    }

    uploadRecords.push({
      kind: UPLOAD_KIND_SUPPLEMENTARY,
      fileIndex: index,
      originalName: file.name,
      contentType: file.type || 'application/octet-stream',
      expectedSize: file.size,
      s3Key,
      multipartUploadId,
      mode,
      status: 'uploading',
    });
  }

  await createMeetingUploads(job.id, uploadRecords);

  const created = await findJobBySubmissionId(submissionId);
  return Response.json(
    {
      jobId: job.id,
      uploads: created ? created.uploads.map(serializeUpload) : [],
      resumed: false,
    },
    { status: 202 },
  );
}
