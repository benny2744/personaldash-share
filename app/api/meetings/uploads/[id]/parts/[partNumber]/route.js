import config from '@/lib/config';
import { uploadPart } from '@/lib/meetingPipeline/storage';
import {
  findMeetingUpload,
  updateMeetingUpload,
  upsertUploadPart,
} from '@/lib/meetingPipeline/jobsDb';
import {
  expectedPartCount,
  jsonError,
  parseContentLength,
} from '@/lib/meetingPipeline/uploadHelpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PUT /api/meetings/uploads/[id]/parts/[partNumber]
 * Raw binary body (application/octet-stream). Streams one chunk to S3
 * UploadPart. Parts are upserted by partNumber (a retry replaces the old part).
 * Here [id] is a MeetingUpload id.
 */
export async function PUT(request, { params }) {
  const { id: meetingUploadId, partNumber: partNumberRaw } = await params;
  const partNumber = Number.parseInt(partNumberRaw, 10);

  if (!Number.isFinite(partNumber) || partNumber < 1) {
    return jsonError('partNumber must be a positive integer', 400);
  }

  const upload = await findMeetingUpload(meetingUploadId);
  if (!upload) return jsonError('Upload not found', 404);
  if (upload.status === 'uploaded') {
    return Response.json({ partNumber, accepted: true, resumed: true });
  }
  if (
    upload.mode !== 'multipart' ||
    !upload.multipartUploadId ||
    !upload.s3Key
  ) {
    return jsonError('Upload is not a multipart upload', 400);
  }

  const expectedParts = expectedPartCount(upload.expectedSize);
  if (partNumber > expectedParts) {
    return jsonError(
      `partNumber ${partNumber} exceeds expected ${expectedParts} parts`,
      400,
    );
  }

  const contentLength = parseContentLength(request);
  if (contentLength != null && contentLength > config.meetingUploadChunkSize) {
    return jsonError(
      `Part body exceeds chunk size (${config.meetingUploadChunkSize})`,
      413,
    );
  }

  // Non-final parts must be exactly chunkSize; the final part is the remainder.
  const isFinal = partNumber === expectedParts;
  if (
    contentLength != null &&
    !isFinal &&
    contentLength !== config.meetingUploadChunkSize
  ) {
    return jsonError(
      `Non-final part ${partNumber} must be exactly ${config.meetingUploadChunkSize} bytes`,
      400,
    );
  }

  const startedAt = Date.now();
  let etag;
  try {
    const result = await uploadPart({
      key: upload.s3Key,
      uploadId: upload.multipartUploadId,
      partNumber,
      stream: request.body,
      contentLength: contentLength ?? undefined,
    });
    etag = result.etag;
  } catch (error) {
    console.error('[meeting-upload] part upload failed', {
      meetingUploadId,
      partNumber,
      s3Key: upload.s3Key,
      error: error.message,
    });
    await updateMeetingUpload(upload.id, {
      retryCount: upload.retryCount + 1,
      lastActivityAt: new Date(),
    });
    return jsonError(`Part upload failed: ${error.message}`, 502);
  }

  await upsertUploadPart(upload.id, partNumber, etag, contentLength);

  console.log('[meeting-upload] part accepted', {
    meetingUploadId,
    partNumber,
    expectedParts,
    bytes: contentLength,
    durationMs: Date.now() - startedAt,
  });

  return Response.json({ partNumber, accepted: true });
}
