import path from 'path';
import config from '@/lib/config';

/**
 * Shared helpers for the autochunking meeting upload routes
 * (/api/meetings/uploads/*). Kept here so every route validates consistently.
 */

export const UPLOAD_KIND_AUDIO = 'audio';
export const UPLOAD_KIND_SUPPLEMENTARY = 'supplementary';

export function jsonError(message, status = 400) {
  return Response.json({ error: message }, { status });
}

export function sanitizeExt(nameOrType) {
  const fromName = path.extname(nameOrType || '').replace(/^\./, '');
  if (fromName) return fromName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return 'bin';
}

export function extForUpload({ name, type }) {
  const fromName = path.extname(name || '').replace(/^\./, '');
  if (fromName) {
    const clean = fromName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (clean) return clean;
  }
  const subtype = (type || '').split('/')[1] || '';
  const clean = subtype.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return clean || 'bin';
}

export function s3KeyForUpload(jobId, kind, fileIndex, ext) {
  const prefix = kind === UPLOAD_KIND_SUPPLEMENTARY ? 'supp' : 'audio';
  return `${jobId}/${prefix}-${fileIndex}.${ext}`;
}

export function isAudioContentType(type) {
  if (!type) return true;
  return type.startsWith('audio/') || type === 'application/octet-stream';
}

/**
 * Validate a /init submission descriptor.
 * @returns {{ ok: true, audioFiles: object[], supplementaryFiles: object[], participantsText: string|null } | { ok: false, error: string, status: number }}
 */
export function validateInitSubmission({
  audioFiles,
  supplementaryFiles,
  participantsText,
}) {
  if (!Array.isArray(audioFiles) || audioFiles.length === 0) {
    return {
      ok: false,
      error: 'Missing or empty "audioFiles" array',
      status: 400,
    };
  }
  const supp = Array.isArray(supplementaryFiles) ? supplementaryFiles : [];
  const participants =
    typeof participantsText === 'string'
      ? participantsText.trim() || null
      : null;

  let totalBytes = 0;
  for (const file of audioFiles) {
    if (!file?.name || !Number.isFinite(file?.size)) {
      return {
        ok: false,
        error: 'Each audio file needs name and size',
        status: 400,
      };
    }
    if (file.size <= 0) {
      return {
        ok: false,
        error: `Audio file has invalid size: ${file.name}`,
        status: 400,
      };
    }
    totalBytes += file.size;
  }
  for (const file of supp) {
    if (!file?.name || !Number.isFinite(file?.size)) {
      return {
        ok: false,
        error: 'Each supplementary file needs name and size',
        status: 400,
      };
    }
    totalBytes += file.size;
  }

  if (totalBytes > config.meetingAudioMaxBytes) {
    return {
      ok: false,
      error: `Submission exceeds ${config.meetingAudioMaxBytes} byte limit`,
      status: 413,
    };
  }
  return {
    ok: true,
    audioFiles,
    supplementaryFiles: supp,
    participantsText: participants,
    totalBytes,
  };
}

export function expectedPartCount(fileSize) {
  return Math.max(1, Math.ceil(fileSize / config.meetingUploadChunkSize));
}

export function serializeUpload(upload) {
  return {
    id: upload.id,
    kind: upload.kind,
    fileIndex: upload.fileIndex,
    originalName: upload.originalName,
    contentType: upload.contentType,
    expectedSize: upload.expectedSize,
    mode: upload.mode,
    status: upload.status,
    chunkSize: config.meetingUploadChunkSize,
    expectedParts:
      upload.mode === 'multipart' ? expectedPartCount(upload.expectedSize) : 1,
  };
}

export function parseContentLength(request) {
  const raw = request.headers.get('content-length');
  const value = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(value) ? value : null;
}

/**
 * Retryable HTTP status codes for client-side part upload retries.
 * Only network errors and these transient statuses should be retried.
 */
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
