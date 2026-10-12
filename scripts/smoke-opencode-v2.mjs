/** Synthetic-only v2 rehearsal. Never targets the live :4096 service.
 *
 * WARNING (2026-10-12): the rehearsal server must NOT be started with
 * `opencode serve --service` while the production opencode.service is running —
 * a second service-mode instance crashes the main one (observed live; the
 * agent harness went down repeatedly). Either stop opencode.service first and
 * restart it afterwards, or run against a stopped-service window.
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const url = new URL(
  process.env.OPENCODE_REHEARSAL_URL || 'http://127.0.0.1:14096',
);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '14096');
assert.ok(
  process.env.OPENCODE_REHEARSAL_AUTH_FILE,
  'Set OPENCODE_REHEARSAL_AUTH_FILE',
);
const auth = JSON.parse(
  await fs.readFile(process.env.OPENCODE_REHEARSAL_AUTH_FILE, 'utf8'),
);
process.env.OPENCODE_SERVER_URL = url.origin;
process.env.OPENCODE_SERVER_AUTH_FILE =
  process.env.OPENCODE_REHEARSAL_AUTH_FILE;
process.env.OPENCODE_SERVER_PASSWORD = '';
process.env.OPENCODE_TIMEOUT_SEC = '120';
const { default: config } = await import('../lib/config.js');
config.opencodeTimeoutSec = 120;
const { createSession, runAgent, getSessionInfo, listSessionMessages, share } =
  await import('../lib/meetingPipeline/opencodeClient.js');
const directory =
  process.env.OPENCODE_SMOKE_DIR || '/tmp/opencode-v2-migration';
const model = process.env.OPENCODE_REHEARSAL_MODEL || 'litellm/qwen3.7-flash';
const { sessionID } = await createSession(
  'WorkDash v2 synthetic adapter rehearsal',
  model,
  directory,
);
const first = await runAgent({
  sessionID,
  agent: 'general',
  model,
  prompt:
    'Do not use any tools or read or write files. Reply with exactly PDASH_V2_FIRST.',
});
assert.equal(first.text, 'PDASH_V2_FIRST');
const second = await runAgent({
  sessionID,
  agent: 'general',
  model,
  prompt:
    'Do not use any tools or read or write files. Reply with exactly PDASH_V2_SECOND.',
});
assert.equal(second.text, 'PDASH_V2_SECOND');
const info = await getSessionInfo(sessionID);
assert.equal(info.agent, 'general');
assert.equal(info.raw.model.providerID, 'litellm');
assert.equal(info.raw.model.id, model.slice(model.indexOf('/') + 1));
assert.equal(info.raw.location.directory, directory);
const messages = await listSessionMessages(sessionID);
assert.equal(messages.filter((m) => m.info.role === 'user').length, 2);
assert.equal(await share(sessionID), null);
// Cancel a third synthetic generation, then verify server-side drain is absent.
const controller = new AbortController();
const timer = setTimeout(
  () => controller.abort(new Error('synthetic cancellation')),
  1000,
);
try {
  await assert.rejects(
    runAgent({
      sessionID,
      agent: 'general',
      model,
      signal: controller.signal,
      prompt:
        'Do not use tools or read or write files. Produce a long list of fictional colors, 2000 items.',
    }),
    /synthetic cancellation/,
  );
} finally {
  clearTimeout(timer);
}
const headers = {
  Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
};
let inactive = false;
for (let attempt = 0; attempt < 50; attempt++) {
  const activeResponse = await fetch(`${url.origin}/api/session/active`, {
    headers,
  });
  assert.equal(activeResponse.status, 200);
  const active = await activeResponse.json();
  if (!active.data[sessionID]) {
    inactive = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.equal(
  inactive,
  true,
  'interrupted drain did not settle within 10 seconds',
);
console.log(
  JSON.stringify({
    sessionID,
    first: first.text,
    second: second.text,
    agent: info.agent,
    model: info.raw.model,
    directory: info.raw.location.directory,
    cancellation: 'interrupted; inactive verified',
    share: null,
  }),
);
