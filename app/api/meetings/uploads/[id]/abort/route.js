import { abortMultipartUpload } from '@/lib/meetingPipeline/storage';
import {
  findMeetingJob,
  listMeetingUploads,
  updateMeetingJob,
  updateMeetingUpload,
} from '@/lib/meetingPipeline/jobsDb';
import { jsonError } from '@/lib/meetingPipeline/uploadHelpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/meetings/uploads/[id]/abort
 * Bodyless. Aborts every live multipart upload belonging to the job and marks
 * the job cancelled. Idempotent: safe to call repeatedly. Here [id] is a
 * MeetingJob id.
 */
export async function POST(request, { params }) {
  const { id: jobId } = await params;

  const job = await findMeetingJob(jobId);
  if (!job) return jsonError('Job not found', 404);

  const uploads = await listMeetingUploads(jobId);
  await Promise.all(
    uploads
      .filter((u) => u.mode === 'multipart' && u.multipartUploadId && u.s3Key)
      .map((u) =>
        abortMultipartUpload({
          key: u.s3Key,
          uploadId: u.multipartUploadId,
        }).catch((error) => {
          // NoSuchUpload is expected on repeat aborts — not an error.
          if (
            error?.name === 'NoSuchUpload' ||
            error?.$metadata?.httpStatusCode === 404
          ) {
            return;
          }
          console.error('[meeting-upload] abort failed', {
            jobId,
            meetingUploadId: u.id,
            error: error.message,
          });
        }),
      ),
  );

  await Promise.all(
    uploads
      .filter((u) => u.status !== 'uploaded')
      .map((u) =>
        updateMeetingUpload(u.id, {
          status: 'aborted',
          lastActivityAt: new Date(),
        }).catch(() => {}),
      ),
  );

  await updateMeetingJob(jobId, {
    status: 'cancelled',
    step: 'cancelled',
    error: 'Upload cancelled',
    finishedAt: new Date(),
  }).catch(() => {});

  console.log('[meeting-upload] submission aborted', { jobId });

  return Response.json({ jobId, status: 'cancelled' }, { status: 200 });
}
