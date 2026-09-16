import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api';
import {
  getVoiceLeaseConfig,
  voiceServiceFetch,
} from '@/lib/hermes/voiceLease';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

const MAX_BYTES = 7 * 1024 * 1024;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (error) => {
      reject(
        new Error(
          `ffmpeg unavailable: ${error.message}. Install ffmpeg in the PersonalDash image.`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code})`));
    });
  });
}

async function transcodeToPcm16(inputBuffer, inputExtension = 'webm') {
  const dir = await mkdtemp(join(tmpdir(), 'pd-stt-'));
  const ext = String(inputExtension || 'webm').replace(/^\./, '') || 'webm';
  const inputPath = join(dir, `input.${ext}`);
  const outputPath = join(dir, 'output.pcm');
  try {
    await writeFile(inputPath, inputBuffer);
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * HTTP fallback transcription for unsupported browsers.
 * Primary chat path streams PCM through the leased WebSocket sidecar.
 */
export async function POST(request) {
  const config = getVoiceLeaseConfig();
  if (!config.configured) {
    return errorResponse(
      'VOICE_LEASE_SECRET is not configured for chat voice',
      503,
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return errorResponse('Invalid multipart body', 400);
  }

  const audio = form.get('audio');
  if (!audio || typeof audio === 'string' || typeof audio.arrayBuffer !== 'function') {
    return errorResponse('Missing audio file field "audio"', 400);
  }

  const language = String(form.get('language') || 'auto').trim() || 'auto';
  const buffer = Buffer.from(await audio.arrayBuffer());
  if (!buffer.byteLength) {
    return errorResponse('Empty audio upload', 400);
  }
  if (buffer.byteLength > MAX_BYTES) {
    return errorResponse(
      `Audio exceeds ${Math.floor(MAX_BYTES / (1024 * 1024))} MB limit`,
      413,
    );
  }

  try {
    const filename = String(audio.name || 'recording.webm');
    const extension = filename.includes('.')
      ? filename.split('.').pop()
      : 'webm';
    const pcm = await transcodeToPcm16(buffer, extension);
    const response = await voiceServiceFetch('/v1/transcribe', {
      body: {
        audio: pcm.toString('base64'),
        language,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json(
        { error: payload.detail || payload.error || 'Transcription failed' },
        {
          status: response.status >= 500 ? 502 : response.status,
          headers: NO_STORE,
        },
      );
    }

    return NextResponse.json(
      {
        text: payload.text || '',
        provider: 'qwen',
        model: config.asrModel,
        bytes: buffer.byteLength,
        maxBytes: MAX_BYTES,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    const status = Number(error?.status) || 502;
    return NextResponse.json(
      { error: error?.message || 'Transcription failed' },
      { status, headers: NO_STORE },
    );
  }
}
