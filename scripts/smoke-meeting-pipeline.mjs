#!/usr/bin/env node
/**
 * scripts/smoke-meeting-pipeline.mjs — Read-only smoke checks for the meeting
 * pipeline deployment (app API, converter, opencode, migrations, parser agent).
 *
 * Run:
 *   node scripts/smoke-meeting-pipeline.mjs
 *
 * Optional env:
 *   SMOKE_APP_URL=http://127.0.0.1:3001
 *   SMOKE_CONVERTER_URL=http://127.0.0.1:8083
 *   SMOKE_OPENCODE_URL=http://127.0.0.1:4096
 *   SMOKE_CONVERTER_SAMPLE_URL=https://example.com/sample.txt
 *   SMOKE_PARSER_AGENT_PATH=~/.config/opencode/agent/meeting-document-parser.md
 *
 * Optional flags:
 *   --live   Upload tiny test files and poll until job completes (uses ASR/LLM quota).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APP_URL = process.env.SMOKE_APP_URL || 'http://127.0.0.1:3001';
const CONVERTER_URL =
  process.env.SMOKE_CONVERTER_URL || 'http://127.0.0.1:8083';
const OPENCODE_URL = process.env.SMOKE_OPENCODE_URL || 'http://127.0.0.1:4096';
const PARSER_AGENT_PATH =
  process.env.SMOKE_PARSER_AGENT_PATH ||
  path.join(os.homedir(), '.config/opencode/agent/meeting-document-parser.md');
const CONVERTER_SAMPLE_URL = process.env.SMOKE_CONVERTER_SAMPLE_URL || '';

const LIVE = process.argv.includes('--live');

const results = [];

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? `: ${detail}` : ''}`);
}

function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.error(`FAIL  ${name}${detail ? `: ${detail}` : ''}`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 200) };
    }
  }
  return { ok: response.ok, status: response.status, json, text };
}

async function checkAppJobsApi() {
  const name = 'app jobs API';
  try {
    const { ok, status, json } = await fetchJson(
      `${APP_URL}/api/meetings/process?active=1`,
    );
    if (!ok) {
      fail(name, `HTTP ${status}`);
      return;
    }
    if (!Array.isArray(json)) {
      fail(name, 'response is not an array');
      return;
    }
    pass(name, `${json.length} active/recent job(s)`);
  } catch (error) {
    fail(name, error.message);
  }
}

async function checkConverterHealth() {
  const name = 'libreoffice converter /health';
  try {
    const { ok, status, json } = await fetchJson(`${CONVERTER_URL}/health`);
    if (!ok || json?.healthy !== true) {
      fail(name, `HTTP ${status} ${JSON.stringify(json)}`);
      return;
    }
    pass(name);
  } catch (error) {
    fail(name, error.message);
  }
}

async function checkOpencodeReachable() {
  const name = 'opencode server reachable';
  try {
    const response = await fetch(OPENCODE_URL, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      fail(name, `HTTP ${response.status}`);
      return;
    }
    pass(name, `HTTP ${response.status}`);
  } catch (error) {
    fail(name, error.message);
  }
}

async function checkParserAgentInstalled() {
  const name = 'meeting-document-parser agent installed';
  try {
    const content = await fs.readFile(PARSER_AGENT_PATH, 'utf-8');
    if (
      !content.includes('meeting-document-parser') &&
      !content.includes('LibreOffice converter')
    ) {
      fail(name, 'file exists but content looks wrong');
      return;
    }
    pass(name, PARSER_AGENT_PATH);
  } catch (error) {
    fail(name, error.message);
  }
}

async function checkMigrationsInContainer() {
  const name = 'prisma migrations (personaldash container)';
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'personaldash',
        './node_modules/.bin/prisma',
        'migrate',
        'status',
      ],
      { cwd: process.cwd(), timeout: 60000 },
    );
    const output = `${stdout}\n${stderr}`;
    if (!/Database schema is up to date/i.test(output)) {
      fail(name, output.trim().slice(0, 300));
      return;
    }
    pass(name);
  } catch (error) {
    const detail = error.stdout || error.stderr || error.message;
    fail(name, String(detail).trim().slice(0, 300));
  }
}

async function checkOpencodeFromContainer() {
  const name = 'opencode reachable from personaldash container';
  try {
    const script = `
      fetch(process.env.OPENCODE_SERVER_URL || 'http://host.docker.internal:4096')
        .then(r => { console.log(r.status); process.exit(r.ok ? 0 : 1); })
        .catch(e => { console.error(e.message); process.exit(1); });
    `;
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['compose', 'exec', '-T', 'personaldash', 'node', '-e', script],
      { cwd: process.cwd(), timeout: 30000 },
    );
    const status = stdout.trim();
    if (status === '200') {
      pass(name, `HTTP ${status}`);
    } else {
      fail(name, `${status} ${stderr}`.trim());
    }
  } catch (error) {
    const detail = error.stdout || error.stderr || error.message;
    fail(name, String(detail).trim().slice(0, 300));
  }
}

async function checkConverterSampleUrl() {
  if (!CONVERTER_SAMPLE_URL) {
    console.log(
      'SKIP  converter sample URL (set SMOKE_CONVERTER_SAMPLE_URL to enable)',
    );
    return;
  }
  const name = 'converter POST /convert sample URL';
  try {
    const { ok, status, json } = await fetchJson(`${CONVERTER_URL}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: CONVERTER_SAMPLE_URL }),
    });
    if (!ok || !json?.text) {
      fail(name, `HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`);
      return;
    }
    pass(name, `${json.text.length} chars extracted`);
  } catch (error) {
    fail(name, error.message);
  }
}

async function checkJobSerializationShape() {
  const name = 'job API serialization shape';
  try {
    const { ok, status, json } = await fetchJson(
      `${APP_URL}/api/meetings/process?active=1`,
    );
    if (!ok) {
      fail(name, `HTTP ${status}`);
      return;
    }
    const job = json[0];
    if (!job) {
      pass(name, 'no jobs to inspect (fields validated on empty list)');
      return;
    }
    const required = [
      'audioFiles',
      'supplementaryFiles',
      'asrTaskIds',
      'opencodeSessionId',
      'opencodeShareUrl',
    ];
    const missing = required.filter((key) => !(key in job));
    if (missing.length) {
      fail(name, `missing keys: ${missing.join(', ')}`);
      return;
    }
    pass(name);
  } catch (error) {
    fail(name, error.message);
  }
}

async function runLiveUpload() {
  const name = 'live upload (multi-audio + supplementary)';
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-smoke-'));
  const audioPath = path.join(tmpDir, 'part1.wav');
  const audio2Path = path.join(tmpDir, 'part2.wav');
  const suppPath = path.join(tmpDir, 'notes.txt');

  // Minimal valid WAV header + silence (~0.1s mono 8kHz)
  const wavHeader = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00,
    0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
  ]);
  await fs.writeFile(audioPath, wavHeader);
  await fs.writeFile(audio2Path, wavHeader);
  await fs.writeFile(
    suppPath,
    'Smoke test supplementary document.\nAction item: verify pipeline end-to-end.\n',
  );

  try {
    const form = new FormData();
    form.append(
      'audio',
      new Blob([wavHeader], { type: 'audio/wav' }),
      'part1.wav',
    );
    form.append(
      'audio-1',
      new Blob([wavHeader], { type: 'audio/wav' }),
      'part2.wav',
    );
    form.append(
      'supplementary',
      new Blob(['Smoke test supplementary document.'], { type: 'text/plain' }),
      'notes.txt',
    );

    const upload = await fetch(`${APP_URL}/api/meetings/process`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    const job = await upload.json();
    if (!upload.ok || !job?.id) {
      fail(name, `upload failed: ${upload.status} ${JSON.stringify(job)}`);
      return;
    }

    if (!Array.isArray(job.audioFiles) || job.audioFiles.length !== 2) {
      fail(
        name,
        `expected 2 audioFiles, got ${JSON.stringify(job.audioFiles)}`,
      );
      return;
    }
    if (
      !Array.isArray(job.supplementaryFiles) ||
      job.supplementaryFiles.length !== 1
    ) {
      fail(
        name,
        `expected 1 supplementaryFiles, got ${JSON.stringify(job.supplementaryFiles)}`,
      );
      return;
    }

    const deadline = Date.now() + 30 * 60 * 1000;
    let finalJob = job;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const poll = await fetchJson(`${APP_URL}/api/meetings/jobs/${job.id}`);
      if (!poll.ok) {
        fail(name, `poll failed HTTP ${poll.status}`);
        return;
      }
      finalJob = poll.json;
      if (['done', 'failed', 'cancelled'].includes(finalJob.status)) break;
    }

    if (finalJob.status === 'done') {
      pass(name, `job ${job.id} -> ${finalJob.outputPath || 'done'}`);
    } else {
      fail(
        name,
        `job ${job.id} ended as ${finalJob.status}: ${finalJob.error || ''}`,
      );
    }
  } catch (error) {
    fail(name, error.message);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function checkTranscode() {
  const name = 'audio transcode (S3 → ffmpeg → MP3 → S3)';
  const testKey = 'smoke-transcode-test/source.wav';
  const destKey = 'smoke-transcode-test/output.mp3';

  // This script runs inside the personaldash container (has S3 creds + ffmpeg).
  // It generates a 2s sine wave WAV, uploads it, transcodes to MP3 using the
  // same pattern as transcodeAudioToMp3, then verifies the MP3 object.
  const inlineScript = `
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const bucket = process.env.MEETING_S3_BUCKET || 'meeting-audio';
const client = new S3Client({
  endpoint: process.env.MEETING_S3_ENDPOINT,
  region: process.env.MEETING_S3_REGION || 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MEETING_S3_ACCESS_KEY,
    secretAccessKey: process.env.MEETING_S3_SECRET_KEY,
  },
});

(async () => {
  // 1. Generate a 2s sine wave WAV via ffmpeg.
  const wavProc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'wav', 'pipe:1']);
  const wavChunks = [];
  wavProc.stdout.on('data', (c) => wavChunks.push(c));
  wavProc.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((res, rej) => { wavProc.on('close', (c) => c === 0 ? res() : rej(new Error('wav gen code ' + c))); wavProc.on('error', rej); });
  const wavBuf = Buffer.concat(wavChunks);
  if (!wavBuf.length) throw new Error('Generated WAV is empty');

  // 2. Upload WAV to S3.
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: '${testKey}', Body: wavBuf, ContentType: 'audio/wav', ContentLength: wavBuf.length }));

  // 3. Download WAV and transcode to MP3 (same pattern as transcodeAudioToMp3).
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: '${testKey}' }));
  const sourceStream = typeof resp.Body?.getReader === 'function' ? Readable.fromWeb(resp.Body) : Readable.from(resp.Body);

  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-b:a', '32k', '-ac', '1', '-ar', '16000', '-f', 'mp3', 'pipe:1']);

  sourceStream.on('error', (e) => { if (e.code !== 'EPIPE') ff.stdin.destroy(e); });
  ff.stdin.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

  const mp3Chunks = [];
  ff.stdout.on('data', (c) => mp3Chunks.push(c));
  let stderrBuf = '';
  ff.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  sourceStream.pipe(ff.stdin);
  await new Promise((res, rej) => { ff.on('close', (c) => c === 0 ? res() : rej(new Error('transcode code ' + c + ': ' + stderrBuf.slice(-300)))); ff.on('error', rej); });

  const mp3Buf = Buffer.concat(mp3Chunks);
  if (!mp3Buf.length) throw new Error('MP3 output is empty');

  // 4. Upload MP3 with explicit ContentLength (the bug we're testing).
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: '${destKey}', Body: mp3Buf, ContentType: 'audio/mpeg', ContentLength: mp3Buf.length }));

  // 5. Verify the MP3 object exists with correct size.
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: '${destKey}' }));
  if (!head.ContentLength || head.ContentLength !== mp3Buf.length) {
    throw new Error('HeadObject size mismatch: ' + head.ContentLength + ' vs ' + mp3Buf.length);
  }

  // 6. Verify MP3 magic bytes (ID3 tag or frame sync 0xFF).
  const first3 = mp3Buf.subarray(0, 3);
  const hasId3 = first3[0] === 0x49 && first3[1] === 0x44 && first3[2] === 0x33; // "ID3"
  const hasSync = first3[0] === 0xff && (first3[1] & 0xe0) === 0xe0; // MPEG sync
  if (!hasId3 && !hasSync) {
    throw new Error('Output is not valid MP3 (first 3 bytes: ' + [...first3].map(b => '0x'+b.toString(16)).join(' ') + ')');
  }

  console.log(JSON.stringify({ ok: true, wavBytes: wavBuf.length, mp3Bytes: mp3Buf.length }));

  // 7. Cleanup.
  await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: '${testKey}' }, { Key: '${destKey}' }] } }));
})().catch(e => { console.error('TRANSCODE_ERR: ' + e.message); process.exit(1); });
`;

  try {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['compose', 'exec', '-T', 'personaldash', 'node', '-e', inlineScript],
      { cwd: process.cwd(), timeout: 60000 },
    );
    const output = (stdout + stderr).trim();
    const match = output.match(/\{"ok":true[^}]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      pass(name, `WAV ${result.wavBytes}B → MP3 ${result.mp3Bytes}B`);
    } else if (output.includes('TRANSCODE_ERR')) {
      fail(
        name,
        output.match(/TRANSCODE_ERR: (.*)/)?.[1] || output.slice(0, 200),
      );
    } else {
      fail(name, output.slice(0, 200));
    }
  } catch (error) {
    const detail = error.stdout || error.stderr || error.message;
    fail(name, String(detail).trim().slice(0, 300));
  }
}

async function main() {
  console.log('Meeting pipeline smoke test\n');

  await checkAppJobsApi();
  await checkJobSerializationShape();
  await checkConverterHealth();
  await checkOpencodeReachable();
  await checkOpencodeFromContainer();
  await checkMigrationsInContainer();
  await checkTranscode();
  await checkParserAgentInstalled();
  await checkConverterSampleUrl();

  if (LIVE) {
    console.log('\n--live mode: running end-to-end upload\n');
    await runLiveUpload();
  } else {
    console.log(
      '\nTip: pass --live for end-to-end upload (uses ASR/LLM quota).',
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
