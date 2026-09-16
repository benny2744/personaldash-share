import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// These tests exercise the pure helpers in uploadHelpers.js that don't touch S3
// or the database: submission validation, part-count math, extension parsing,
// and s3Key construction.

// We import after stubbing config env vars so module load doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub';
process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/vault';
process.env.MEETING_S3_ENDPOINT =
  process.env.MEETING_S3_ENDPOINT || 'http://localhost:9000';
process.env.MEETING_S3_PUBLIC_BASE =
  process.env.MEETING_S3_PUBLIC_BASE || 'http://localhost:9000';
process.env.QWEN_FILETRANS_BASE_URL =
  process.env.QWEN_FILETRANS_BASE_URL || 'http://localhost';

const {
  UPLOAD_KIND_AUDIO,
  UPLOAD_KIND_SUPPLEMENTARY,
  extForUpload,
  s3KeyForUpload,
  isAudioContentType,
  validateInitSubmission,
  expectedPartCount,
  parseContentLength,
  RETRYABLE_STATUS,
} = await import('../../lib/meetingPipeline/uploadHelpers.js');
const config = (await import('../../lib/config.js')).default;

describe('extForUpload', () => {
  it('extracts extension from filename', () => {
    assert.equal(
      extForUpload({ name: 'meeting.m4a', type: 'audio/mp4' }),
      'm4a',
    );
    assert.equal(extForUpload({ name: 'rec.mp3', type: 'audio/mpeg' }), 'mp3');
  });

  it('falls back to content-type subtype when name has no ext', () => {
    assert.equal(extForUpload({ name: 'noext', type: 'audio/mpeg' }), 'mpeg');
  });

  it('falls back to bin when nothing parses', () => {
    assert.equal(extForUpload({ name: '', type: '' }), 'bin');
  });

  it('sanitizes non-alphanumeric characters', () => {
    assert.equal(extForUpload({ name: 'file.M4A!', type: 'audio/mp4' }), 'm4a');
  });
});

describe('s3KeyForUpload', () => {
  it('builds audio keys with audio prefix', () => {
    assert.equal(
      s3KeyForUpload('job123', UPLOAD_KIND_AUDIO, 0, 'm4a'),
      'job123/audio-0.m4a',
    );
    assert.equal(
      s3KeyForUpload('job123', UPLOAD_KIND_AUDIO, 2, 'mp3'),
      'job123/audio-2.mp3',
    );
  });

  it('builds supplementary keys with supp prefix', () => {
    assert.equal(
      s3KeyForUpload('job123', UPLOAD_KIND_SUPPLEMENTARY, 0, 'pdf'),
      'job123/supp-0.pdf',
    );
  });
});

describe('isAudioContentType', () => {
  it('accepts audio/* types', () => {
    assert.equal(isAudioContentType('audio/mpeg'), true);
    assert.equal(isAudioContentType('audio/mp4'), true);
    assert.equal(isAudioContentType('audio/wav'), true);
  });

  it('accepts application/octet-stream', () => {
    assert.equal(isAudioContentType('application/octet-stream'), true);
  });

  it('accepts empty type (trusts extension)', () => {
    assert.equal(isAudioContentType(''), true);
    assert.equal(isAudioContentType(null), true);
  });

  it('rejects non-audio types', () => {
    assert.equal(isAudioContentType('video/mp4'), false);
    assert.equal(isAudioContentType('image/png'), false);
  });
});

describe('expectedPartCount', () => {
  beforeEach(() => {
    // chunkSize default is 50MB = 52428800
  });

  it('returns 1 for files under chunkSize', () => {
    assert.equal(expectedPartCount(1000), 1);
    assert.equal(expectedPartCount(config.meetingUploadChunkSize), 1);
  });

  it('returns ceil(size/chunkSize) for larger files', () => {
    const cs = config.meetingUploadChunkSize;
    assert.equal(expectedPartCount(cs + 1), 2);
    assert.equal(expectedPartCount(cs * 3), 3);
    assert.equal(expectedPartCount(cs * 3 + 1), 4);
  });

  it('handles exact multiples correctly', () => {
    const cs = config.meetingUploadChunkSize;
    assert.equal(expectedPartCount(cs * 5), 5);
  });
});

describe('validateInitSubmission', () => {
  it('accepts a valid submission with audio only', () => {
    const result = validateInitSubmission({
      audioFiles: [{ name: 'a.m4a', size: 50000, type: 'audio/mp4' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.audioFiles.length, 1);
    assert.equal(result.supplementaryFiles.length, 0);
    assert.equal(result.totalBytes, 50000);
  });

  it('accepts audio plus supplementary files', () => {
    const result = validateInitSubmission({
      audioFiles: [{ name: 'a.m4a', size: 50000, type: 'audio/mp4' }],
      supplementaryFiles: [
        { name: 'slides.pdf', size: 20000, type: 'application/pdf' },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.totalBytes, 70000);
  });

  it('rejects empty audioFiles array', () => {
    const result = validateInitSubmission({ audioFiles: [] });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  });

  it('rejects missing audioFiles', () => {
    const result = validateInitSubmission({});
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  });

  it('rejects files missing name or size', () => {
    const result = validateInitSubmission({
      audioFiles: [{ name: 'a.m4a' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  });

  it('rejects zero or negative sizes', () => {
    const result = validateInitSubmission({
      audioFiles: [{ name: 'a.m4a', size: 0, type: 'audio/mp4' }],
    });
    assert.equal(result.ok, false);
  });

  it('rejects submissions exceeding the cap', () => {
    const huge = config.meetingAudioMaxBytes + 1;
    const result = validateInitSubmission({
      audioFiles: [{ name: 'huge.wav', size: huge, type: 'audio/wav' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 413);
  });

  it('rejects when combined audio+supp exceeds the cap', () => {
    const half = Math.ceil(config.meetingAudioMaxBytes / 2) + 1;
    const result = validateInitSubmission({
      audioFiles: [{ name: 'a.wav', size: half, type: 'audio/wav' }],
      supplementaryFiles: [
        { name: 'b.pdf', size: half, type: 'application/pdf' },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 413);
  });
});

describe('parseContentLength', () => {
  it('parses a valid content-length header', () => {
    const req = { headers: new Map([['content-length', '52428800']]) };
    assert.equal(parseContentLength(req), 52428800);
  });

  it('returns null when header is missing', () => {
    const req = { headers: new Map() };
    assert.equal(parseContentLength(req), null);
  });

  it('returns null for non-numeric values', () => {
    const req = { headers: new Map([['content-length', 'abc']]) };
    assert.equal(parseContentLength(req), null);
  });
});

describe('RETRYABLE_STATUS', () => {
  it('includes common transient statuses', () => {
    assert.equal(RETRYABLE_STATUS.has(429), true);
    assert.equal(RETRYABLE_STATUS.has(500), true);
    assert.equal(RETRYABLE_STATUS.has(502), true);
    assert.equal(RETRYABLE_STATUS.has(503), true);
    assert.equal(RETRYABLE_STATUS.has(504), true);
  });

  it('excludes non-retryable client errors', () => {
    assert.equal(RETRYABLE_STATUS.has(400), false);
    assert.equal(RETRYABLE_STATUS.has(401), false);
    assert.equal(RETRYABLE_STATUS.has(403), false);
    assert.equal(RETRYABLE_STATUS.has(404), false);
    assert.equal(RETRYABLE_STATUS.has(413), false);
  });
});
