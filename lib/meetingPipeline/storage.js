import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream as fsCreateWriteStream } from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '@/lib/config';

function required(value, name) {
  if (!value)
    throw new Error(`Missing required meeting storage config: ${name}`);
  return value;
}

function createClient(endpoint) {
  return new S3Client({
    endpoint,
    region: config.meetingS3Region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: required(config.meetingS3AccessKey, 'MEETING_S3_ACCESS_KEY'),
      secretAccessKey: required(
        config.meetingS3SecretKey,
        'MEETING_S3_SECRET_KEY',
      ),
    },
  });
}

const internalClient = createClient(config.meetingS3Endpoint);
const publicClient = createClient(config.meetingS3PublicBase);
const MAX_S3_STREAM_CHUNK_BYTES = 8 * 1024 * 1024;

function sanitizeExt(ext) {
  const clean = String(ext || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return clean || 'audio';
}

export function audioKeyForJob(jobId, ext) {
  return `${jobId}.${sanitizeExt(ext)}`;
}

function splitLargeChunks(stream) {
  return stream.pipe(
    new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (
          let offset = 0;
          offset < bytes.length;
          offset += MAX_S3_STREAM_CHUNK_BYTES
        ) {
          this.push(bytes.subarray(offset, offset + MAX_S3_STREAM_CHUNK_BYTES));
        }
        callback();
      },
    }),
  );
}

export async function putObject({ key, stream, contentType, contentLength }) {
  const source =
    typeof stream?.getReader === 'function' ? Readable.fromWeb(stream) : stream;
  const body = splitLargeChunks(source);

  await internalClient.send(
    new PutObjectCommand({
      Bucket: config.meetingS3Bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
      ContentLength: Number.isFinite(contentLength) ? contentLength : undefined,
    }),
  );

  return key;
}

/**
 * Transcode an audio object in S3 to a low-bitrate mono MP3 using ffmpeg.
 * Downloads the source to a temp file (so ffmpeg has full format detection and
 * seeking), transcodes to MP3, uploads the result with explicit ContentLength.
 *
 * @param {object} params
 * @param {string} params.sourceKey — S3 key of the original audio
 * @param {string} params.destKey — S3 key for the transcoded MP3
 * @param {number} params.bitrate — target bitrate in kbps (e.g. 32)
 * @returns {Promise<{ key: string, size: number }>}
 */
export async function transcodeAudioToMp3({ sourceKey, destKey, bitrate }) {
  const tmpDir = `/tmp/transcode-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsPromises.mkdir(tmpDir, { recursive: true });
  const sourcePath = path.join(tmpDir, 'source');
  const ext = path.extname(sourceKey).slice(1) || 'audio';
  const sourcePathWithExt = `${sourcePath}.${ext}`;

  try {
    // 1. Download S3 object to a temp file.
    const response = await internalClient.send(
      new GetObjectCommand({ Bucket: config.meetingS3Bucket, Key: sourceKey }),
    );
    const sourceStream =
      typeof response.Body?.getReader === 'function'
        ? Readable.fromWeb(response.Body)
        : Readable.from(response.Body);
    await pipeline(sourceStream, fsCreateWriteStream(sourcePathWithExt));

    // 2. Verify the file downloaded correctly.
    const stat = await fsPromises.stat(sourcePathWithExt);
    if (stat.size === 0) {
      throw new Error(`Downloaded source is empty: ${sourceKey}`);
    }

    // 3. Transcode with ffmpeg reading from the temp file (full format detection).
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      sourcePathWithExt,
      '-codec:a',
      'libmp3lame',
      '-b:a',
      `${bitrate}k`,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'mp3',
      'pipe:1',
    ]);

    const chunks = [];
    let stderrBuffer = '';
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (data) => {
      stderrBuffer += data.toString().slice(-2000);
    });

    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `ffmpeg exited with code ${code}: ${stderrBuffer.slice(-500)}`,
            ),
          );
      });
      ffmpeg.on('error', reject);
    });

    const mp3Buffer = Buffer.concat(chunks);
    if (!mp3Buffer.length) {
      throw new Error(
        `ffmpeg produced no output for ${sourceKey}: ${stderrBuffer.slice(-500)}`,
      );
    }

    // 4. Upload MP3 with explicit ContentLength.
    await internalClient.send(
      new PutObjectCommand({
        Bucket: config.meetingS3Bucket,
        Key: destKey,
        Body: mp3Buffer,
        ContentType: 'audio/mpeg',
        ContentLength: mp3Buffer.length,
      }),
    );

    console.log('[meeting-storage] transcode size check', {
      sourceBytes: stat.size,
      mp3Bytes: mp3Buffer.length,
      ratio: `${((mp3Buffer.length / stat.size) * 100).toFixed(1)}%`,
    });

    return { key: destKey, size: mp3Buffer.length };
  } finally {
    await fsPromises
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {});
  }
}

export async function presignObject(
  key,
  ttlSeconds = config.meetingS3PresignTtl,
) {
  const command = new GetObjectCommand({
    Bucket: config.meetingS3Bucket,
    Key: key,
  });
  return getSignedUrl(publicClient, command, { expiresIn: ttlSeconds });
}

export async function deleteObject(key) {
  if (!key) return;
  await internalClient.send(
    new DeleteObjectCommand({
      Bucket: config.meetingS3Bucket,
      Key: key,
    }),
  );
}

export async function deleteObjects(keys) {
  const unique = [...new Set((keys || []).filter(Boolean))];
  if (!unique.length) return;

  // AWS SDK DeleteObjects accepts max 1000 keys per call.
  const chunkSize = 1000;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    await internalClient.send(
      new DeleteObjectsCommand({
        Bucket: config.meetingS3Bucket,
        Delete: { Objects: chunk.map((key) => ({ Key: key })) },
      }),
    );
  }
}

export async function putAudio({
  jobId,
  ext,
  stream,
  contentType,
  contentLength,
}) {
  const key = audioKeyForJob(jobId, ext);
  await putObject({ key, stream, contentType, contentLength });
  return key;
}

export async function presignAudio(
  key,
  ttlSeconds = config.meetingS3PresignTtl,
) {
  return presignObject(key, ttlSeconds);
}

export async function deleteAudio(key) {
  return deleteObject(key);
}

// ─── S3 multipart upload primitives ──────────────────────────────────────────
// Used by the autochunking meeting upload flow to assemble one valid audio
// object from many <100MB HTTP requests (working around Cloudflare Tunnel's
// ~100MB per-request ceiling). S3 (MinIO) is authoritative for part state at
// completion time; the DB mirrors it only for observability/progress.

export async function createMultipartUpload({ key, contentType }) {
  const result = await internalClient.send(
    new CreateMultipartUploadCommand({
      Bucket: config.meetingS3Bucket,
      Key: key,
      ContentType: contentType || 'application/octet-stream',
    }),
  );
  if (!result.UploadId) {
    throw new Error(
      `S3 CreateMultipartUpload did not return an UploadId for ${key}`,
    );
  }
  return { uploadId: result.UploadId, key };
}

export async function uploadPart({
  key,
  uploadId,
  partNumber,
  stream,
  contentLength,
}) {
  const source =
    typeof stream?.getReader === 'function' ? Readable.fromWeb(stream) : stream;
  const body = splitLargeChunks(source);
  const result = await internalClient.send(
    new UploadPartCommand({
      Bucket: config.meetingS3Bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: Number.isFinite(contentLength) ? contentLength : undefined,
    }),
  );
  if (!result.ETag) {
    throw new Error(
      `S3 UploadPart did not return an ETag for part ${partNumber} of ${key}`,
    );
  }
  return { etag: result.ETag, partNumber, size: contentLength };
}

export async function listParts({ key, uploadId }) {
  const parts = [];
  let continuation;
  do {
    const result = await internalClient.send(
      new ListPartsCommand({
        Bucket: config.meetingS3Bucket,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: continuation,
      }),
    );
    for (const part of result.Parts || []) {
      parts.push({
        partNumber: part.PartNumber,
        etag: part.ETag,
        size: part.Size,
      });
    }
    continuation = result.IsTruncated ? result.NextPartNumberMarker : undefined;
  } while (continuation);
  parts.sort((a, b) => a.partNumber - b.partNumber);
  return parts;
}

export async function completeMultipartUpload({ key, uploadId, parts }) {
  // parts: [{ partNumber, etag }] — must come from ListParts (S3-authoritative).
  await internalClient.send(
    new CompleteMultipartUploadCommand({
      Bucket: config.meetingS3Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p) => ({ ETag: p.etag, PartNumber: p.partNumber })),
      },
    }),
  );
  return key;
}

export async function abortMultipartUpload({ key, uploadId }) {
  if (!uploadId) return;
  await internalClient.send(
    new AbortMultipartUploadCommand({
      Bucket: config.meetingS3Bucket,
      Key: key,
      UploadId: uploadId,
    }),
  );
}

export async function headObject({ key }) {
  try {
    const result = await internalClient.send(
      new HeadObjectCommand({ Bucket: config.meetingS3Bucket, Key: key }),
    );
    return { exists: true, contentLength: result.ContentLength ?? null };
  } catch (error) {
    if (
      error?.name === 'NotFound' ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return { exists: false, contentLength: null };
    }
    throw error;
  }
}

export async function listAudioKeys() {
  const keys = [];
  let ContinuationToken;
  do {
    const result = await internalClient.send(
      new ListObjectsV2Command({
        Bucket: config.meetingS3Bucket,
        ContinuationToken,
      }),
    );
    for (const item of result.Contents || []) {
      if (item.Key) keys.push(item.Key);
    }
    ContinuationToken = result.NextContinuationToken;
  } while (ContinuationToken);
  return keys;
}

/**
 * Reconcile an upload's S3 state against its DB record. Used for crash recovery
 * on jobs stuck in `uploading`/`completing`. S3 is authoritative.
 *
 * @param {object} upload — { mode: 'single'|'multipart', s3Key, multipartUploadId, expectedSize }
 * @returns {Promise<{status: 'uploaded'|'completing'|'incomplete'|'failed', parts?: object[], finalSize?: number}>}
 */
export async function reconcileUpload(upload) {
  const { mode, s3Key, multipartUploadId, expectedSize } = upload;
  if (!s3Key) return { status: 'failed' };

  // Single-PUT uploads: the final object is the only artifact.
  if (mode === 'single' || !multipartUploadId) {
    const head = await headObject({ key: s3Key });
    if (
      head.exists &&
      (head.contentLength == null || head.contentLength === expectedSize)
    ) {
      return { status: 'uploaded', finalSize: head.contentLength };
    }
    return { status: 'incomplete' };
  }

  // Multipart uploads: a prior CompleteMultipartUpload may have won already.
  const head = await headObject({ key: s3Key });
  if (
    head.exists &&
    (head.contentLength == null || head.contentLength === expectedSize)
  ) {
    return { status: 'uploaded', finalSize: head.contentLength };
  }

  // Otherwise inspect the live multipart upload.
  let parts;
  try {
    parts = await listParts({ key: s3Key, uploadId: multipartUploadId });
  } catch (error) {
    // NoSuchUpload → the multipart session is gone but no final object exists.
    if (
      error?.name === 'NoSuchUpload' ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return { status: 'failed' };
    }
    throw error;
  }

  const expectedParts = Math.max(
    1,
    Math.ceil((expectedSize || 0) / config.meetingUploadChunkSize),
  );
  const hasAllParts =
    parts.length === expectedParts &&
    parts.every((p, i) => p.partNumber === i + 1) &&
    parts.slice(0, -1).every((p) => p.size === config.meetingUploadChunkSize);

  if (hasAllParts) {
    return { status: 'completing', parts };
  }
  return { status: 'incomplete', parts };
}
