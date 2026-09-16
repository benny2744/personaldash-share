import config from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/meetings/uploads/config
 * Returns the chunking parameters the client needs to decide whether to use
 * the chunked flow and how to slice files. Intended for pre-upload validation.
 */
export async function GET() {
  return Response.json({
    chunkSize: config.meetingUploadChunkSize,
    chunkThreshold: config.meetingUploadChunkThreshold,
    maxBytes: config.meetingAudioMaxBytes,
  });
}
