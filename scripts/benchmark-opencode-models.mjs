#!/usr/bin/env node
/**
 * scripts/benchmark-opencode-models.mjs — A/B benchmark the opencode meeting
 * formatter + linker agents against real transcripts, comparing two models.
 *
 * Does not touch the live vault, DB, or S3. Writes all artifacts to a temp
 * directory under /tmp/opencode-benchmark-<timestamp>/.
 *
 * Run:
 *   node --import ./scripts/register-alias-hooks.mjs scripts/benchmark-opencode-models.mjs
 *
 * Env overrides:
 *   OPENCODE_SERVER_URL, OPENCODE_SERVER_USERNAME, OPENCODE_SERVER_PASSWORD,
 *   OPENCODE_FORMATTER_MODEL_A, OPENCODE_FORMATTER_MODEL_B,
 *   OPENCODE_LINKER_MODEL_A, OPENCODE_LINKER_MODEL_B,
 *   VAULT_PATH, OPENCODE_VAULT_PATH, OPENCODE_TIMEOUT_SEC
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import {
  runFormatAgent,
  formatSessionTitle,
} from '@/lib/meetingPipeline/formatAgent.js';
import { parseLinkerContract } from '@/lib/meetingPipeline/linker.js';
import {
  runAgent,
  createSession,
  opencodeTimeoutSignal,
} from '@/lib/meetingPipeline/opencodeClient.js';
import { runPass4Assemble } from '@/lib/meetingPipeline/passes.js';
import { loadMeetingVaultContext } from '@/lib/meetingPipeline/vaultContext.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(__filename, '..', '..');

const MODELS = {
  A: {
    formatter:
      process.env.OPENCODE_FORMATTER_MODEL_A ||
      'xiaomi-token-plan-cn/mimo-v2.5',
    linker:
      process.env.OPENCODE_LINKER_MODEL_A || 'xiaomi-token-plan-cn/mimo-v2.5',
  },
  B: {
    formatter:
      process.env.OPENCODE_FORMATTER_MODEL_B ||
      'xiaomi-token-plan-cn/mimo-v2.5-pro',
    linker:
      process.env.OPENCODE_LINKER_MODEL_B ||
      'xiaomi-token-plan-cn/mimo-v2.5-pro',
  },
};

const VAULT_PATH = process.env.VAULT_PATH;
process.env.VAULT_PATH = VAULT_PATH;
process.env.OPENCODE_VAULT_PATH = process.env.OPENCODE_VAULT_PATH || VAULT_PATH;
process.env.OPENCODE_SERVER_URL =
  process.env.OPENCODE_SERVER_URL || 'http://host.docker.internal:4096';
process.env.OPENCODE_SERVER_USERNAME =
  process.env.OPENCODE_SERVER_USERNAME || 'opencode';
process.env.OPENCODE_TIMEOUT_SEC = process.env.OPENCODE_TIMEOUT_SEC || '900';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://unused';
process.env.MEETING_S3_ENDPOINT =
  process.env.MEETING_S3_ENDPOINT || 'http://unused';
process.env.MEETING_S3_PUBLIC_BASE =
  process.env.MEETING_S3_PUBLIC_BASE || 'http://unused';
process.env.QWEN_FILETRANS_BASE_URL =
  process.env.QWEN_FILETRANS_BASE_URL || 'http://unused';

const TYPE_OVERRIDES = {
  'Parent Comms':
    '2026-05-30 - Admissions - Parent Meeting Luhan Racing Interests.md',
};

const SAMPLE_FILES = {
  Leadership:
    '2026-06-25 - Leadership - AI Curriculum Device Policy Planning.md',
  Hiring: '2026-06-26 - Hiring - Computer Science Teacher Hiring Interview.md',
  Admissions: '2026-05-30 - Admissions - Chen Tianyi Admissions Interview.md',
  Curriculum:
    '2026-06-11 - Curriculum - Middle School Maker Engineering Curriculum Planning.md',
  'Program Ops':
    '2026-06-18 - Program Ops - AI Summer Camp Planning and Preparation.md',
  'Student Mentoring':
    '2026-06-18 - Student Mentoring - Aluminum-Carbon Battery Electrode Experiment Review.md',
  Partnership:
    '2026-06-08 - Partnership - WAIC Exhibition Project Preparation Discussion.md',
};

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_TRANSCRIPT_CHARS = Number(process.env.MAX_TRANSCRIPT_CHARS || '0');

function modelName(ref) {
  return ref.split('/').pop();
}

function isoTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readNoteSafe(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function extractTranscript(body) {
  const marker = '## Transcript';
  const index = body.indexOf(marker);
  if (index === -1) return body;
  const transcript = body
    .slice(index + marker.length)
    .replace(/<!--[\s\S]*?-->/, '')
    .trim();
  return transcript;
}

function extractOriginalSummaryEn(body) {
  const sections = [
    '## Meeting Context & Purpose',
    '## Applicant & Program Context',
    '## Cohort / Program Context',
    '## Context & Purpose',
    '## Role & Interview Stage',
    '## Family / Student',
  ];
  const start = sections
    .map((h) => body.indexOf(h))
    .filter((i) => i !== -1)
    .sort((a, b) => a - b)[0];
  if (start === undefined) return '';
  const end = body.indexOf('## Attendees', start);
  return body.slice(start, end === -1 ? undefined : end).trim();
}

function buildPass1FromNote(note, typeOverride) {
  const { data, content } = matter(note);
  const date = String(data.Date || '');
  const type = typeOverride || String(data.Type || 'Program Ops');
  const topic =
    data.topic ||
    data.Topic ||
    path
      .basename(data.filename || '', '.md')
      .replace(/^\d{4}-\d{2}-\d{2} - [^ -]+ - /, '');
  const cleanedTranscript = extractTranscript(content);
  const effectiveTranscript =
    MAX_TRANSCRIPT_CHARS > 0 && cleanedTranscript.length > MAX_TRANSCRIPT_CHARS
      ? cleanedTranscript.slice(0, MAX_TRANSCRIPT_CHARS)
      : cleanedTranscript;

  return {
    metadata: {
      date,
      type,
      topic,
      attendees: Array.isArray(data.Attendees)
        ? data.Attendees.map((a) =>
            String(a).replace(/^\[\[/, '').replace(/\]\]$/, ''),
          )
        : [],
      project: String(data.Project || '')
        .replace(/^\[\[/, '')
        .replace(/\]\]$/, ''),
      area: String(data.Area || '')
        .replace(/^\[\[/, '')
        .replace(/\]\]$/, ''),
      tags: Array.isArray(data.tags) ? data.tags : [],
      filename: path.basename(data.filename || ''),
    },
    cleanedTranscript: effectiveTranscript,
  };
}

function sectionCoverage(markdown, type) {
  const counts = {
    h2: (markdown.match(/^##\s+/gm) || []).length,
    h3: (markdown.match(/^###\s+/gm) || []).length,
    actionItems: (markdown.match(/^-\s+\[\s*\]\s+/gm) || []).length,
    decisions: (markdown.match(/^[-*]\s+[^\[]/gm) || []).length,
    hasContextOrPurpose:
      /^##\s+(Meeting Context & Purpose|Context & Purpose|Applicant & Program Context|Cohort \/ Program Context|Role & Interview Stage|Family \/ Student)/im.test(
        markdown,
      ),
    hasActionItems: /^##\s+Action Items/im.test(markdown),
    hasDecisions: /^##\s+Decisions/im.test(markdown),
    hasOpenQuestions:
      /^##\s+(Open Questions|Open Questions & Blockers|Risks & Open Questions)/im.test(
        markdown,
      ),
  };

  const typeHeadings = {
    Leadership: [
      'Context & Purpose',
      'Discussion by Theme',
      'Decisions',
      'Action Items',
    ],
    Hiring: [
      'Role & Interview Stage',
      'Candidate Profile',
      'Process Outcome',
      'Next Steps & Owners',
    ],
    Admissions: [
      'Applicant & Program Context',
      'Student Profile',
      'Outcome & Agreements',
    ],
    Curriculum: [
      'Meeting Context & Purpose',
      'Key Discussion Themes',
      'Decisions',
      'Action Items',
    ],
    'Program Ops': [
      'Meeting Context & Purpose',
      'Key Discussion Themes',
      'Decisions',
      'Action Items',
    ],
    'Student Mentoring': [
      'Meeting Context & Purpose',
      'Key Discussion Themes',
      'Decisions',
      'Action Items',
    ],
    Partnership: [
      'Meeting Context & Purpose',
      'Key Discussion Themes',
      'Decisions',
      'Action Items',
    ],
    'Parent Comms': [
      'Family / Student',
      'Topics Raised',
      'Parent Concerns',
      'Commitments Made',
    ],
  };

  const expected = typeHeadings[type] || typeHeadings.Curriculum;
  const matched = expected.filter((heading) =>
    new RegExp(
      `^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      'im',
    ).test(markdown),
  );
  return {
    ...counts,
    expected,
    matched,
    coverageRatio: matched.length / expected.length,
  };
}

function formatDurationMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function runFormatter(pass1, vaultContext, modelRef, outDir) {
  const label = modelName(modelRef);
  const started = Date.now();
  let result = {
    model: modelRef,
    durationMs: 0,
    ok: false,
    error: null,
    contract: null,
    markdown: null,
    rawText: null,
    coverage: null,
  };

  try {
    const { contract, sessionID, rawText } = await runFormatAgent({
      pass1,
      vaultContext,
      model: modelRef,
    });
    const durationMs = Date.now() - started;
    result.durationMs = durationMs;
    result.ok = true;
    result.contract = contract;
    result.sessionID = sessionID;
    result.rawText = rawText;

    const markdown = runPass4Assemble({
      metadata: pass1.metadata,
      cleanedTranscript: pass1.cleanedTranscript,
      summaryZh: contract.summary_zh,
      summaryEn: contract.summary_en,
      vaultContext,
      taskLinks: [],
      contract,
    });
    result.markdown = markdown;
    result.coverage = sectionCoverage(contract.summary_en, pass1.metadata.type);

    await fs.writeFile(
      path.join(outDir, `contract-${label}.json`),
      JSON.stringify(contract, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(outDir, `markdown-${label}.md`),
      markdown,
      'utf8',
    );
  } catch (error) {
    result.durationMs = Date.now() - started;
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
    result.rawText = error?.rawOutput || null;
    await fs.writeFile(
      path.join(outDir, `error-${label}.txt`),
      result.error,
      'utf8',
    );
    if (result.rawText) {
      await fs.writeFile(
        path.join(outDir, `raw-${label}.md`),
        result.rawText,
        'utf8',
      );
    }
  }

  return result;
}

function buildLinkerPrompt({ noteBody, vaultContext, absPath, title }) {
  const contextList = (values) =>
    values?.length ? values.join(', ') : '(none found)';
  return `Meeting note absolute path: ${absPath}
Meeting title: ${title}

Current frontmatter People: ${contextList([])}
Current frontmatter Project: ${contextList([])}
Current frontmatter Area: ${contextList([])}

Authoritative People notes in the vault: ${contextList(vaultContext.people)}
Authoritative Project notes: ${contextList(vaultContext.projects)}
Authoritative Area notes: ${contextList(vaultContext.areas)}

Full note body:

${noteBody}

Resolve and lint per your instructions. Every name you return must EXACTLY match an existing note title from the authoritative lists.`;
}

async function runLinker(markdown, modelRef, outDir, title, vaultContext) {
  const label = modelName(modelRef);
  const started = Date.now();
  let result = {
    model: modelRef,
    durationMs: 0,
    ok: false,
    error: null,
    contract: null,
    rawText: null,
  };

  try {
    const absPath = path.join(
      process.env.OPENCODE_VAULT_PATH,
      'meetings',
      `${title}.md`,
    );
    const sessionTitle = `Benchmark Linker: ${title}`;
    const session = await createSession(
      sessionTitle,
      modelRef,
      process.env.OPENCODE_VAULT_PATH,
    );
    const prompt = buildLinkerPrompt({
      noteBody: markdown,
      vaultContext,
      absPath,
      title,
    });
    const { text, sessionID } = await runAgent({
      agent: 'meeting-linker',
      model: modelRef,
      title: sessionTitle,
      prompt,
      sessionID: session.sessionID,
      signal: opencodeTimeoutSignal(),
    });
    const contract = parseLinkerContract(text);
    const durationMs = Date.now() - started;
    result.durationMs = durationMs;
    result.ok = true;
    result.contract = contract;
    result.sessionID = sessionID;
    result.rawText = text;

    await fs.writeFile(
      path.join(outDir, `linker-contract-${label}.json`),
      JSON.stringify(contract, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(outDir, `linker-raw-${label}.md`),
      text,
      'utf8',
    );
  } catch (error) {
    result.durationMs = Date.now() - started;
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
    await fs.writeFile(
      path.join(outDir, `linker-error-${label}.txt`),
      result.error,
      'utf8',
    );
  }

  return result;
}

function scoreLinker(contract) {
  return {
    attendees: contract?.attendees?.length || 0,
    extraLinks: contract?.extra_links?.length || 0,
    newEntities: contract?.new_entities?.length || 0,
    warnings: contract?.lint?.filter((i) => i.severity === 'warn').length || 0,
    errors: contract?.lint?.filter((i) => i.severity === 'error').length || 0,
  };
}

function scoreFormatter(result) {
  if (!result.ok || !result.contract) {
    return {
      ok: false,
      summaryEnChars: 0,
      summaryZhChars: 0,
      actionItems: 0,
      decisions: 0,
    };
  }
  return {
    ok: true,
    summaryEnChars: result.contract.summary_en.length,
    summaryZhChars: result.contract.summary_zh.length,
    actionItems: result.contract.action_items.length,
    decisions: result.contract.decisions.length,
    ...result.coverage,
  };
}

async function buildReport(results) {
  const lines = [
    '# opencode Formatter + Linker A/B Benchmark',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Models: A=${MODELS.A.formatter}, B=${MODELS.B.formatter}`,
    `Linker: A=${MODELS.A.linker}, B=${MODELS.B.linker}`,
    '',
    '## Summary',
    '',
    '| Type | Sample | Metric | A | B | Delta |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const r of results) {
    const fa = scoreFormatter(r.formatter.A);
    const fb = scoreFormatter(r.formatter.B);
    const la = r.linker.A.ok ? scoreLinker(r.linker.A.contract) : null;
    const lb = r.linker.B.ok ? scoreLinker(r.linker.B.contract) : null;

    lines.push(
      `| ${r.type} | ${r.basename} | Formatter OK | ${r.formatter.A.ok} | ${r.formatter.B.ok} | ${r.formatter.B.ok === r.formatter.A.ok ? '=' : r.formatter.B.ok ? 'B only' : 'A only'} |`,
    );
    if (fa.ok && fb.ok) {
      lines.push(
        `| | | summary_en chars | ${fa.summaryEnChars} | ${fb.summaryEnChars} | ${fb.summaryEnChars - fa.summaryEnChars} |`,
        `| | | summary_zh chars | ${fa.summaryZhChars} | ${fb.summaryZhChars} | ${fb.summaryZhChars - fa.summaryZhChars} |`,
        `| | | action_items | ${fa.actionItems} | ${fb.actionItems} | ${fb.actionItems - fa.actionItems} |`,
        `| | | decisions | ${fa.decisions} | ${fb.decisions} | ${fb.decisions - fa.decisions} |`,
        `| | | coverage | ${(fa.coverageRatio * 100).toFixed(0)}% | ${(fb.coverageRatio * 100).toFixed(0)}% | ${((fb.coverageRatio - fa.coverageRatio) * 100).toFixed(0)}pp |`,
      );
    }
    if (la && lb) {
      lines.push(
        `| | | Linker OK | ${r.linker.A.ok} | ${r.linker.B.ok} | ${r.linker.B.ok === r.linker.A.ok ? '=' : r.linker.B.ok ? 'B only' : 'A only'} |`,
        `| | | attendees resolved | ${la.attendees} | ${lb.attendees} | ${lb.attendees - la.attendees} |`,
        `| | | extra_links | ${la.extraLinks} | ${lb.extraLinks} | ${lb.extraLinks - la.extraLinks} |`,
        `| | | new_entities | ${la.newEntities} | ${lb.newEntities} | ${lb.newEntities - la.newEntities} |`,
        `| | | lint warnings | ${la.warnings} | ${lb.warnings} | ${lb.warnings - la.warnings} |`,
        `| | | lint errors | ${la.errors} | ${lb.errors} | ${lb.errors - la.errors} |`,
      );
    } else {
      lines.push(
        `| | | Linker OK | ${r.linker.A.ok} | ${r.linker.B.ok} | ${r.linker.B.ok === r.linker.A.ok ? '=' : r.linker.B.ok ? 'B only' : 'A only'} |`,
      );
    }
    lines.push(
      `| | | Formatter duration | ${formatDurationMs(r.formatter.A.durationMs)} | ${formatDurationMs(r.formatter.B.durationMs)} | ${formatDurationMs(r.formatter.B.durationMs - r.formatter.A.durationMs)} |`,
      `| | | Linker duration | ${formatDurationMs(r.linker.A.durationMs)} | ${formatDurationMs(r.linker.B.durationMs)} | ${formatDurationMs(r.linker.B.durationMs - r.linker.A.durationMs)} |`,
      '| | | | | | |',
    );
  }

  lines.push('', '## Per-sample detail', '');
  for (const r of results) {
    lines.push(
      `### ${r.type}: ${r.basename}`,
      '',
      `- A formatter: ${r.formatter.A.ok ? 'OK' : `ERROR: ${r.formatter.A.error}`}`,
      `- B formatter: ${r.formatter.B.ok ? 'OK' : `ERROR: ${r.formatter.B.error}`}`,
      `- A linker: ${r.linker.A.ok ? 'OK' : `ERROR: ${r.linker.A.error}`}`,
      `- B linker: ${r.linker.B.ok ? 'OK' : `ERROR: ${r.linker.B.error}`}`,
      `- Output dir: \`${r.outDir}\``,
      '',
    );
  }

  return lines.join('\n');
}

async function main() {
  const outRoot = await ensureDir(
    path.join('/tmp', `opencode-benchmark-${isoTimestamp()}`),
  );
  console.log(`Benchmark output: ${outRoot}`);

  const vaultContext = await loadMeetingVaultContext();

  const selectedTypes = process.argv
    .find((arg) => arg.startsWith('--samples='))
    ?.split('=')[1]
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const typesToRun = selectedTypes || [
    ...Object.keys(SAMPLE_FILES),
    'Parent Comms',
  ];

  const samples = typesToRun.map((type) => {
    const filename =
      TYPE_OVERRIDES[type] ||
      SAMPLE_FILES[type] ||
      Object.values(SAMPLE_FILES)[0];
    return {
      type,
      filename,
      filepath: path.join(VAULT_PATH, 'meetings', filename),
    };
  });

  const results = [];

  for (const sample of samples) {
    const note = await readNoteSafe(sample.filepath);
    if (!note) {
      console.warn(`Skipping missing sample: ${sample.filepath}`);
      continue;
    }

    const pass1 = buildPass1FromNote(
      note,
      sample.type === 'Parent Comms' ? 'Parent Comms' : undefined,
    );
    const outDir = await ensureDir(path.join(outRoot, sample.type));
    await fs.writeFile(
      path.join(outDir, 'transcript.md'),
      pass1.cleanedTranscript,
      'utf8',
    );

    const title = formatSessionTitle(pass1);
    console.log(`\n[${sample.type}] ${sample.filename}`);
    console.log(`  Transcript chars: ${pass1.cleanedTranscript.length}`);

    if (DRY_RUN) {
      console.log('  (dry-run: skipping opencode calls)');
      results.push({
        type: sample.type,
        basename: sample.filename,
        outDir,
        formatter: {
          A: { ok: false, error: 'dry-run' },
          B: { ok: false, error: 'dry-run' },
        },
        linker: {
          A: { ok: false, error: 'dry-run' },
          B: { ok: false, error: 'dry-run' },
        },
      });
      continue;
    }

    const formatA = await runFormatter(
      pass1,
      vaultContext,
      MODELS.A.formatter,
      outDir,
    );
    const formatB = await runFormatter(
      pass1,
      vaultContext,
      MODELS.B.formatter,
      outDir,
    );
    console.log(
      `  Formatter A: ${formatA.ok ? 'OK' : formatA.error} (${formatDurationMs(formatA.durationMs)})`,
    );
    console.log(
      `  Formatter B: ${formatB.ok ? 'OK' : formatB.error} (${formatDurationMs(formatB.durationMs)})`,
    );

    const markdownA = formatA.markdown || '';
    const markdownB = formatB.markdown || '';

    const linkerA = await runLinker(
      markdownA,
      MODELS.A.linker,
      outDir,
      title,
      vaultContext,
    );
    const linkerB = await runLinker(
      markdownB,
      MODELS.B.linker,
      outDir,
      title,
      vaultContext,
    );
    console.log(
      `  Linker A: ${linkerA.ok ? 'OK' : linkerA.error} (${formatDurationMs(linkerA.durationMs)})`,
    );
    console.log(
      `  Linker B: ${linkerB.ok ? 'OK' : linkerB.error} (${formatDurationMs(linkerB.durationMs)})`,
    );

    results.push({
      type: sample.type,
      basename: sample.filename,
      outDir,
      formatter: { A: formatA, B: formatB },
      linker: { A: linkerA, B: linkerB },
    });
  }

  const report = await buildReport(results);
  await fs.writeFile(path.join(outRoot, 'report.md'), report, 'utf8');
  await fs.writeFile(
    path.join(outRoot, 'report.json'),
    JSON.stringify(
      {
        models: MODELS,
        results: results.map((r) => ({
          type: r.type,
          basename: r.basename,
          outDir: r.outDir,
          formatter: {
            A: {
              model: r.formatter.A.model,
              ok: r.formatter.A.ok,
              error: r.formatter.A.error,
              durationMs: r.formatter.A.durationMs,
            },
            B: {
              model: r.formatter.B.model,
              ok: r.formatter.B.ok,
              error: r.formatter.B.error,
              durationMs: r.formatter.B.durationMs,
            },
          },
          linker: {
            A: {
              model: r.linker.A.model,
              ok: r.linker.A.ok,
              error: r.linker.A.error,
              durationMs: r.linker.A.durationMs,
            },
            B: {
              model: r.linker.B.model,
              ok: r.linker.B.ok,
              error: r.linker.B.error,
              durationMs: r.linker.B.durationMs,
            },
          },
        })),
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`\nReport written: ${path.join(outRoot, 'report.md')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
