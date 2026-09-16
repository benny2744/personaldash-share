#!/usr/bin/env node
/**
 * scripts/recover-meeting-job.mjs — Recover a meeting-notes job whose format
 * stage completed on the opencode host but whose container died before the
 * note was written (e.g. "Container restarted mid-job" after a deploy).
 *
 * Derives the format contract + pass1 from the job's persisted opencode
 * session (lib/meetingPipeline/recover.js), replays the post-format steps,
 * and marks the job done. No ASR, no re-upload.
 *
 * Run (host, from the repo root):
 *   VAULT_PATH=/path/to/your/vault \
 *   OPENCODE_SERVER_URL=http://127.0.0.1:4096 \
 *   GBRAIN_SYNC_HOOK_URL=http://127.0.0.1:9103/sync \
 *   MIMO_BASE_URL=http://127.0.0.1:4000/v1 \
 *   node --import ./scripts/register-alias-hooks.mjs --env-file .env \
 *     scripts/recover-meeting-job.mjs --job <jobId> [--dry-run]
 *
 * DB access goes through `docker exec <pg container> psql` (Postgres is not
 * exposed on the host), so the script never imports prisma. MIMO_BASE_URL is
 * overridden because .env points meeting-LLM traffic at the docker-internal LLM gateway hostname.
 */

import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import config from '@/lib/config';
import {
  buildRecoveryFromSession,
  replayPostFormat,
} from '@/lib/meetingPipeline/recover';

const DRY_RUN = process.argv.includes('--dry-run');
const JOB_ID = (() => {
  const i = process.argv.indexOf('--job');
  return i > 0 ? process.argv[i + 1] : '';
})();

const PG_CONTAINER = process.env.PG_CONTAINER || '';
const PG_USER = process.env.PG_USER || 'workdash';
const PG_DB = process.env.PG_DB || 'workdash';

function sqlQuote(value) {
  return String(value).replace(/'/g, "''");
}

function psql(sql) {
  const result = spawnSync(
    'docker',
    [
      'exec',
      PG_CONTAINER,
      'psql',
      '-U',
      PG_USER,
      '-d',
      PG_DB,
      '-At',
      '-F',
      '\t',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed: ${(result.stderr || '').trim()}`);
  }
  const out = (result.stdout || '').trim();
  if (out === '') return [];
  // Drop psql command tags (e.g. "UPDATE 1") that share stdout with -t output.
  return out
    .split('\n')
    .filter((line) => !/^(SELECT|UPDATE|INSERT|DELETE) \d+$/.test(line.trim()))
    .map((line) => line.split('\t'));
}

async function loadJob(jobId) {
  const rows = psql(
    `SELECT id, audio_name, status, step, coalesce(output_path,''), coalesce(opencode_session_id,''), coalesce(opencode_share_url,''), coalesce(error,''), coalesce(pass1_json,''), created_at FROM meeting_jobs WHERE id='${sqlQuote(jobId)}';`,
  );
  if (!rows.length) throw new Error(`Meeting job not found: ${jobId}`);
  const [
    id,
    audioName,
    status,
    step,
    outputPath,
    sessionRaw,
    shareUrl,
    error,
    pass1Json,
    createdAt,
  ] = rows[0];
  return {
    id,
    audioName,
    status,
    step,
    outputPath,
    opencodeSessionId: sessionRaw,
    shareUrl,
    error,
    pass1Json: pass1Json || null,
    createdAt: new Date(createdAt.replace(' ', 'T') + 'Z'),
  };
}

function markJobDone(jobId, outputPath, shareUrl, analysisJson) {
  const sets = [
    `status='done'`,
    `step='done'`,
    `output_path='${sqlQuote(outputPath)}'`,
    `error=NULL`,
    `finished_at=now()`,
    `updated_at=now()`,
  ];
  if (shareUrl) sets.push(`opencode_share_url='${sqlQuote(shareUrl)}'`);
  if (analysisJson) sets.push(`analysis_json='${sqlQuote(analysisJson)}'`);
  const rows = psql(
    `UPDATE meeting_jobs SET ${sets.join(', ')} WHERE id='${sqlQuote(jobId)}' AND status IN ('failed','cancelled') RETURNING id;`,
  );
  if (!rows.some((r) => r[0] === jobId)) {
    throw new Error(
      `DB update did not apply (job ${jobId} is no longer failed/cancelled — concurrent change?)`,
    );
  }
}

async function main() {
  if (!JOB_ID) {
    console.error('usage: recover-meeting-job.mjs --job <jobId> [--dry-run]');
    process.exit(2);
  }
  const job = await loadJob(JOB_ID);
  console.log(
    `[recover] job ${job.id} audio="${job.audioName}" status=${job.status} step=${job.step} error="${job.error}"`,
  );
  if (job.status === 'done') {
    throw new Error(
      `job is already done (output: ${job.outputPath}) — nothing to recover`,
    );
  }
  if (!['failed', 'cancelled'].includes(job.status)) {
    throw new Error(
      `job status is ${job.status}; only failed/cancelled jobs are recoverable`,
    );
  }
  if (!job.opencodeSessionId) {
    throw new Error(
      'job has no opencode_session_id — the format stage never started',
    );
  }

  const { contract, analysis, pass1, vaultContext, sessionTitle } =
    await buildRecoveryFromSession(job, { rePrompt: true });
  console.log(`[recover] session "${sessionTitle}"`);
  console.log(
    `[recover] metadata: date=${pass1.metadata.date} type=${pass1.metadata.type} topic="${pass1.metadata.topic}" attendees=${pass1.metadata.attendees.length}`,
  );
  console.log(
    `[recover] contract: ${(contract.action_items || []).length} action item(s), ${(contract.decisions || []).length} decision(s)`,
  );

  if (DRY_RUN) {
    const { outputPath, previewPath, taskTitles } = await replayPostFormat({
      jobId: job.id,
      contract,
      analysis,
      pass1,
      vaultContext,
      sessionID: job.opencodeSessionId,
      dryRun: true,
      previewDir: '/tmp/opencode',
    });
    console.log('──────── dry run ────────');
    console.log(
      `note would be written to: ${path.join(config.vaultPath, outputPath)}`,
    );
    console.log(
      `task notes would be created: ${taskTitles.join(' | ') || '(none)'}`,
    );
    console.log(`markdown preview: ${previewPath}`);
    console.log('[recover] dry run complete — no vault/DB changes made');
    return;
  }

  const { outputPath, shareUrl } = await replayPostFormat({
    jobId: job.id,
    contract,
    analysis,
    pass1,
    vaultContext,
    sessionID: job.opencodeSessionId,
  });
  console.log(
    `[recover] note written: ${path.join(config.vaultPath, outputPath)}`,
  );

  markJobDone(
    job.id,
    outputPath,
    shareUrl || job.shareUrl || null,
    analysis ? JSON.stringify(analysis) : null,
  );
  console.log(
    `[recover] job ${job.id} marked done in DB (share: ${shareUrl || job.shareUrl || 'n/a'})`,
  );
  console.log('[recover] done');
}

main().catch((error) => {
  console.error(`[recover] FAILED: ${error.message}`);
  process.exit(1);
});
