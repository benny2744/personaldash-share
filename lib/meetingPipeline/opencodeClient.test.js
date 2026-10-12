import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
const originalAuthFile = process.env.OPENCODE_SERVER_AUTH_FILE;
import {
  runAgent,
  createSession,
  listSessionMessages,
  completedAssistantText,
  share,
  abortSession,
} from './opencodeClient.js';
const originalFetch = global.fetch;
const original = { ...config };
afterEach(() => {
  global.fetch = originalFetch;
  Object.assign(config, original);
  if (originalAuthFile === undefined)
    delete process.env.OPENCODE_SERVER_AUTH_FILE;
  else process.env.OPENCODE_SERVER_AUTH_FILE = originalAuthFile;
});
it('file auth fails closed, defaults username and gives env password precedence', async () => {
  const dir = await fs.mkdtemp(
    path.join(
      process.env.TMPDIR || '/home/user/.hermes/cache/scratch',
      'oc-auth-test-',
    ),
  );
  const file = path.join(dir, 'auth.json');
  try {
    Object.assign(config, {
      opencodeServerUrl: 'http://staged',
      opencodeServerPassword: '',
      opencodeTimeoutSec: 3,
    });
    process.env.OPENCODE_SERVER_AUTH_FILE = file;
    let calls = 0;
    global.fetch = async (_url, options) => {
      calls++;
      assert.equal(
        options.headers.Authorization,
        `Basic ${Buffer.from('opencode:synthetic-file').toString('base64')}`,
      );
      return json({ data: { id: 'ses_file' } });
    };
    await assert.rejects(createSession('synthetic'), /auth file/);
    await fs.writeFile(file, '{bad-json');
    await assert.rejects(createSession('synthetic'), /auth file/);
    await fs.writeFile(file, JSON.stringify({ username: 'test' }));
    await assert.rejects(createSession('synthetic'), /invalid credentials/);
    assert.equal(calls, 0);
    await fs.writeFile(file, JSON.stringify({ password: 'synthetic-file' }));
    await createSession('synthetic');
    await fs.writeFile(
      file,
      JSON.stringify({ username: 'file-user', password: 'synthetic-file' }),
    );
    global.fetch = async (_url, options) => {
      assert.equal(
        options.headers.Authorization,
        `Basic ${Buffer.from('file-user:synthetic-file').toString('base64')}`,
      );
      return json({ data: { id: 'ses_file' } });
    };
    await createSession('synthetic');
    process.env.OPENCODE_SERVER_AUTH_FILE = '/missing/declared/auth';
    setup(() => json({ data: { id: 'ses_env' } }));
    assert.equal((await createSession('synthetic')).sessionID, 'ses_env');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
function setup(handler) {
  Object.assign(config, {
    opencodeServerUrl: 'http://staged',
    opencodeServerUsername: 'test',
    opencodeServerPassword: 'synthetic',
    opencodeTimeoutSec: 3,
  });
  global.fetch = async (url, options) => {
    assert.equal(
      options.headers.Authorization,
      `Basic ${Buffer.from('test:synthetic').toString('base64')}`,
    );
    return handler(new URL(url), options);
  };
}
const json = (data) => new Response(JSON.stringify(data));
const user = (id) => ({
  id,
  type: 'user',
  text: 'synthetic',
  time: { created: 1 },
});
const assistant = (id, text, finish = 'stop') => ({
  id,
  type: 'assistant',
  content: [{ type: 'text', text }],
  finish,
  time: { created: 2, completed: 3 },
});
const idle = (outcome = 'succeeded') => ({
  id: 'msg_idle',
  type: 'idle',
  outcome,
});
it('requires current prompt, completed final stop, and successful idle', () => {
  const stale = [user('msg_old'), assistant('msg_a', 'STALE'), idle()];
  assert.equal(completedAssistantText(stale, 'msg_new'), '');
  const current = [
    ...stale,
    user('msg_new'),
    assistant('msg_tool', 'TOOL', 'tool-calls'),
  ];
  assert.equal(completedAssistantText(current, 'msg_new'), '');
  assert.equal(completedAssistantText([...current, idle()], 'msg_new'), '');
  assert.equal(
    completedAssistantText(
      [...current, assistant('msg_final', 'FINAL'), idle()],
      'msg_new',
    ),
    'FINAL',
  );
  assert.equal(
    completedAssistantText(
      [...current, assistant('msg_final', 'FINAL')],
      'msg_new',
    ),
    '',
  );
  assert.throws(
    () => completedAssistantText([...current, idle('interrupted')], 'msg_new'),
    /interrupted/,
  );
  assert.throws(
    () => completedAssistantText([...current, idle('failed')], 'msg_new'),
    /failed/,
  );
  assert.equal(
    completedAssistantText(
      [...current, user('msg_other'), assistant('msg_final', 'OTHER'), idle()],
      'msg_new',
    ),
    '',
  );
  assert.equal(
    completedAssistantText(
      [
        user('msg_new'),
        { ...assistant('a', 'partial'), time: { created: 2 } },
        idle(),
      ],
      'msg_new',
    ),
    '',
  );
});
it('creates v2 session envelope with body location and model', async () => {
  setup((url, options) => {
    assert.equal(url.pathname, '/api/session');
    const body = JSON.parse(options.body);
    assert.match(body.id, /^ses_/);
    assert.deepEqual(body.model, {
      providerID: 'litellm',
      id: 'model/with/slash',
    });
    assert.deepEqual(body.location, { directory: '/synthetic' });
    return json({ data: { id: body.id } });
  });
  assert.match(
    (await createSession('Synthetic', 'litellm/model/with/slash', '/synthetic'))
      .sessionID,
    /^ses_/,
  );
});
it('paginates in ascending order, deduplicates and normalizes messages', async () => {
  let calls = 0;
  setup((url) => {
    calls++;
    if (calls === 1) {
      assert.equal(url.searchParams.get('order'), 'asc');
      return json({ data: [user('msg_u')], cursor: { next: 'opaque' } });
    }
    assert.equal(url.searchParams.has('order'), false);
    assert.equal(url.searchParams.get('cursor'), 'opaque');
    return json({
      data: [user('msg_u'), assistant('msg_a', 'result')],
      cursor: { next: null },
    });
  });
  const messages = await listSessionMessages('ses_test');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].info.role, 'user');
  assert.equal(messages[0].parts[0].text, 'synthetic');
});
it('rejects repeated cursors', async () => {
  setup(() => json({ data: [], cursor: { next: 'same' } }));
  await assert.rejects(listSessionMessages('ses_test'), /Repeated/);
});
it('retries admission with one prompt ID, switches session agent/model, ignores stale text', async () => {
  let promptID,
    attempts = 0,
    polls = 0;
  const selections = [];
  setup((url, options) => {
    if (url.pathname.endsWith('/agent') || url.pathname.endsWith('/model')) {
      selections.push(JSON.parse(options.body));
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/prompt')) {
      const body = JSON.parse(options.body);
      if (promptID) assert.equal(body.id, promptID);
      promptID = body.id;
      assert.equal(body.text, 'synthetic');
      assert.equal(body.resume, true);
      if (++attempts === 1)
        return new Response('', {
          status: 503,
          headers: { 'retry-after': '0' },
        });
      return json({
        data: {
          id: promptID,
          type: 'user',
          payload: { text: 'admission is NOT output' },
        },
      });
    }
    polls++;
    const data = [
      user('msg_old'),
      assistant('msg_old_a', 'STALE'),
      idle(),
      user(promptID),
      assistant('msg_tool', 'TOOL', 'tool-calls'),
    ];
    if (polls > 1)
      data.push(assistant('msg_final', 'FINAL'), {
        ...idle(),
        id: 'msg_idle_new',
      });
    return json({ data, cursor: {} });
  });
  assert.deepEqual(
    await runAgent({
      agent: 'meeting-default',
      model: 'litellm/test',
      sessionID: 'ses_test',
      prompt: 'synthetic',
    }),
    { text: 'FINAL', sessionID: 'ses_test' },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(selections, [
    { agent: 'meeting-default' },
    { model: { providerID: 'litellm', id: 'test' } },
  ]);
});
it('cancellation after admission interrupts server without reusing aborted signal', async () => {
  const controller = new AbortController();
  let interrupted = false;
  setup((url, options) => {
    if (url.pathname.endsWith('/prompt')) {
      controller.abort(new Error('cancelled'));
      return json({ data: {} });
    }
    if (url.pathname.endsWith('/interrupt')) {
      assert.equal(url.searchParams.get('resume'), 'false');
      assert.equal(options.signal.aborted, false);
      interrupted = true;
      return json({ interrupted: true });
    }
    throw new Error('unexpected request');
  });
  await assert.rejects(
    runAgent({
      sessionID: 'ses_test',
      prompt: 'synthetic',
      signal: controller.signal,
    }),
    /cancelled/,
  );
  assert.equal(interrupted, true);
});
it('pre-cancelled run sends nothing; unsupported share sends nothing', async () => {
  setup(() => {
    throw new Error('unexpected request');
  });
  await assert.rejects(
    runAgent({
      sessionID: 'ses_test',
      signal: AbortSignal.abort(new Error('cancelled')),
    }),
    /cancelled/,
  );
  assert.equal(await share('ses_test'), null);
  await abortSession(null);
});
it('timeout while awaiting completion interrupts', async () => {
  let interrupted = false;
  setup((url) => {
    if (url.pathname.endsWith('/interrupt')) {
      interrupted = true;
      return json({});
    }
    if (url.pathname.endsWith('/prompt')) return json({ data: {} });
    return json({ data: [], cursor: {} });
  });
  config.opencodeTimeoutSec = 0.02;
  await assert.rejects(
    runAgent({ sessionID: 'ses_test', prompt: 'synthetic' }),
    /timeout/i,
  );
  assert.equal(interrupted, true);
});
