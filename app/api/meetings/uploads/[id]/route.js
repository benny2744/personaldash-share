import config from '@/lib/config';
import { putObject, headObject } from '@/lib/meetingPipeline/storage';
import {
  findMeetingUpload,
  updateMeetingUpload,
} from '@/lib/meetingPipeline/jobsDb';
import {
  jsonError,
  parseContentLength,
} from '@/lib/meetingPipeline/uploadHelpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PUT /api/meetings/uploads/[id]
 * Raw binary body (application/octet-stream). Used for files ≤ chunkSize within
 * a chunked submission — streamed straight to a single S3 PutObject.
 * Here [id] is a MeetingUpload id.
 */
export async function PUT(request, { params }) {
  const { id: meetingUploadId } = await params;

  const upload = await findMeetingUpload(meetingUploadId);
  if (!upload) return jsonError('Upload not found', 404);
  if (upload.status === 'uploaded') {
    return Response.json({ id: upload.id, status: 'uploaded', accepted: true });
  }
  if (upload.mode !== 'single') {
    return jsonError(
      'This upload requires multipart parts (use /parts/:partNumber)',
      400,
    );
  }
  if (!upload.s3Key) return jsonError('Upload has no s3Key', 400);

  const contentLength = parseContentLength(request);
  if (contentLength != null && contentLength > config.meetingUploadChunkSize) {
    return jsonError(
      `Single-PUT body exceeds chunk size (${config.meetingUploadChunkSize})`,
      413,
    );
  }
  if (contentLength != null && contentLength !== upload.expectedSize) {
    return jsonError(
      `Content-Length ${contentLength} does not match expected ${upload.expectedSize}`,
      400,
    );
  }

  const startedAt = Date.now();
  try {
    await putObject({
      key: upload.s3Key,
      stream: request.body,
      contentType: upload.contentType || 'application/octet-stream',
      contentLength: contentLength ?? undefined,
    });
  } catch (error) {
    console.error('[meeting-upload] single PUT failed', {
      meetingUploadId,
      s3Key: upload.s3Key,
      error: error.message,
    });
    await updateMeetingUpload(upload.id, {
      retryCount: upload.retryCount + 1,
      lastActivityAt: new Date(),
    });
    return jsonError(`Upload failed: ${error.message}`, 502);
  }

  // Verify the object landed at the expected size.
  const head = await headObject({ key: upload.s3Key });
  if (
    !head.exists ||
    (head.contentLength != null && head.contentLength !== upload.expectedSize)
  ) {
    return jsonError('Uploaded object size mismatch', 500);
  }

  await updateMeetingUpload(upload.id, {
    status: 'uploaded',
    lastActivityAt: new Date(),
  });

  console.log('[meeting-upload] single PUT complete', {
    meetingUploadId,
    s3Key: upload.s3Key,
    bytes: upload.expectedSize,
    durationMs: Date.now() - startedAt,
  });

  return Response.json({
    id: upload.id,
    status: 'uploaded',
    accepted: true,
  });
}
