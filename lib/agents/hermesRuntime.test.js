import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHermesRuntime } from './hermesRuntime.js';

const ORIGINAL_FETCH = globalThis.fetch;

class FakeGateway {
  constructor() {
    this.state = 'idle';
    this.requests = [];
    this.connectAuths = [];
    this.closeCount = 0;
    this.lastClose = null;
  }

  get connectionState() {
    return this.state;
  }

  onState(handler) {
    handler(this.state);
    return () => {};
  }

  onAny() {
    return () => {};
  }

  async connectWithToken(auth) {
    this.connectAuths.push(auth);
    this.state = 'open';
  }

  close() {
    this.closeCount += 1;
    this.state = 'closed';
  }

  request(method, params) {
    if (this.state !== 'open') {
      return Promise.reject(new Error('gateway not connected'));
    }
    this.requests.push({ method, params });
    return Promise.resolve({ echo: { method, params } });
  }
}

function makeHarness(runtimeOptions = {}) {
  const gateways = [];
  const bootstrapFetches = [];
  let clearedCount = 0;
  const runtime = createHermesRuntime({
    profile: 'builder',
    ...runtimeOptions,
    gatewayFactory: () => {
      const gateway = new FakeGateway();
      gateways.push(gateway);
      return gateway;
    },
    bootstrapProvider:
      runtimeOptions.bootstrapProvider ||
      {
        fetch: async (opts) => {
          bootstrapFetches.push(opts);
          return { token: 'tok-1', basePath: '/hermes' };
        },
        clear: () => {
          clearedCount += 1;
        },
      },
  });
  return {
    runtime,
    gateways,
    bootstrapFetches,
    cleared: () => clearedCount,
  };
}

async function connected(harness) {
  await harness.runtime.connect();
  return harness.gateways[0];
}

describe('createHermesRuntime descriptor', () => {
  it('describes the profile as a runtime property', () => {
    const { runtime } = makeHarness();
    assert.deepEqual(runtime.descriptor, {
      id: 'hermes:builder',
      provider: 'hermes',
      profile: 'builder',
    });
  });

  it('falls back to the default descriptor without a profile', () => {
    const runtime = createHermesRuntime({
      gatewayFactory: () => new FakeGateway(),
      bootstrapProvider: { fetch: async () => ({ token: 't', basePath: '/hermes' }) },
    });
    assert.equal(runtime.descriptor.id, 'hermes');
    assert.equal(runtime.descriptor.profile, undefined);
    assert.equal(runtime.descriptor.provider, 'hermes');
  });

  it('exposes a basePath override as the endpoint', async () => {
    const harness = makeHarness({ basePath: '/alt-hermes' });
    const gateway = await connected(harness);
    assert.equal(harness.runtime.descriptor.endpoint, '/alt-hermes');
    assert.equal(gateway.connectAuths[0].basePath, '/alt-hermes');
  });
});

describe('connection lifecycle', () => {
  it('clears and force-refetches bootstrap, then connects with the token', async () => {
    const harness = makeHarness();
    assert.equal(harness.runtime.connectionState, 'idle');
    await harness.runtime.connect();
    assert.deepEqual(harness.bootstrapFetches, [{ force: true }]);
    assert.equal(harness.cleared(), 1);
    assert.deepEqual(harness.gateways[0].connectAuths, [
      { token: 'tok-1', basePath: '/hermes' },
    ]);
    assert.equal(harness.runtime.connectionState, 'open');
  });

  it('is a no-op when already open (no extra bootstrap fetches)', async () => {
    const harness = makeHarness();
    await harness.runtime.connect();
    await harness.runtime.connect();
    assert.equal(harness.bootstrapFetches.length, 1);
    assert.equal(harness.gateways.length, 1);
  });

  it('disconnect closes the gateway', async () => {
    const harness = makeHarness();
    await harness.runtime.connect();
    harness.runtime.disconnect();
    assert.equal(harness.gateways[0].closeCount, 1);
  });

  it('formats close diagnostics from the gateway', async () => {
    const harness = makeHarness();
    await harness.runtime.connect();
    harness.gateways[0].lastCloseInfo = { code: 1006, reason: 'abnormal closure' };
    assert.equal(
      harness.runtime.lastCloseDiagnostic(),
      '1006: abnormal closure',
    );
  });

  it('exposes subscription methods consumers rely on', () => {
    const harness = makeHarness();
    assert.equal(typeof harness.runtime.onConnectionState, 'function');
    assert.equal(typeof harness.runtime.onEvent, 'function');
    assert.equal(harness.runtime.onState, undefined);
  });

  it('onConnectionState subscribes through to the gateway state stream', () => {
    const harness = makeHarness();
    const seen = [];
    const off = harness.runtime.onConnectionState((state) => seen.push(state));
    assert.deepEqual(seen, ['idle']);
    assert.equal(typeof off, 'function');
    assert.equal(harness.gateways.length, 1);
  });

  it('rejects RPCs made before connecting', async () => {
    const harness = makeHarness();
    await assert.rejects(
      () => harness.runtime.prompt.submit('live-1', 'hi'),
      /gateway not connected/,
    );
  });
});

describe('session/prompt RPC mappings', () => {
  const cases = [
    {
      name: 'sessions.create defaults the personaldash source and injects profile',
      call: (rt) => rt.sessions.create(),
      method: 'session.create',
      params: { source: 'personaldash', profile: 'builder' },
    },
    {
      name: 'sessions.create forwards a custom source',
      call: (rt) => rt.sessions.create({ source: 'projects' }),
      method: 'session.create',
      params: { source: 'projects', profile: 'builder' },
    },
    {
      name: 'sessions.create pins a per-session model/provider override',
      call: (rt) =>
        rt.sessions.create({ model: 'claude-sonnet-4', provider: 'anthropic' }),
      method: 'session.create',
      params: {
        source: 'personaldash',
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        profile: 'builder',
      },
    },
    {
      name: 'sessions.create omits provider when only a model is given',
      call: (rt) => rt.sessions.create({ model: 'qwen3.8-flash' }),
      method: 'session.create',
      params: { source: 'personaldash', model: 'qwen3.8-flash', profile: 'builder' },
    },
    {
      name: 'sessions.resume',
      call: (rt) => rt.sessions.resume('live-1'),
      method: 'session.resume',
      params: { session_id: 'live-1', profile: 'builder' },
    },
    {
      name: 'sessions.interrupt',
      call: (rt) => rt.sessions.interrupt('live-1'),
      method: 'session.interrupt',
      params: { session_id: 'live-1', profile: 'builder' },
    },
    {
      name: 'sessions.steer',
      call: (rt) => rt.sessions.steer('live-1', 'focus on the tests'),
      method: 'session.steer',
      params: {
        session_id: 'live-1',
        text: 'focus on the tests',
        profile: 'builder',
      },
    },
    {
      name: 'prompt.submit (session-bound, no profile param)',
      call: (rt) => rt.prompt.submit('live-1', 'hello'),
      method: 'prompt.submit',
      params: { session_id: 'live-1', text: 'hello' },
    },
    {
      name: 'prompt.attachImage',
      call: (rt) =>
        rt.prompt.attachImage('live-1', {
          content_base64: 'QUJD',
          filename: 'shot.png',
        }),
      method: 'image.attach_bytes',
      params: {
        session_id: 'live-1',
        content_base64: 'QUJD',
        filename: 'shot.png',
      },
    },
    {
      name: 'prompt.respondApproval',
      call: (rt) => rt.prompt.respondApproval('live-1', 'once'),
      method: 'approval.respond',
      params: { session_id: 'live-1', choice: 'once' },
    },
    {
      name: 'prompt.respondClarify',
      call: (rt) => rt.prompt.respondClarify('live-1', 'req-7', 'yes'),
      method: 'clarify.respond',
      params: { session_id: 'live-1', request_id: 'req-7', answer: 'yes' },
    },
    {
      name: 'prompt.respondSecret sudo uses password param',
      call: (rt) => rt.prompt.respondSecret('live-1', 'sudo', 'req-8', 'pw'),
      method: 'sudo.respond',
      params: { session_id: 'live-1', request_id: 'req-8', password: 'pw' },
    },
    {
      name: 'prompt.respondSecret secret uses value param',
      call: (rt) =>
        rt.prompt.respondSecret('live-1', 'secret', 'req-9', 'api-key'),
      method: 'secret.respond',
      params: { session_id: 'live-1', request_id: 'req-9', value: 'api-key' },
    },
    {
      name: 'commands.catalog',
      call: (rt) => rt.commands.catalog(),
      method: 'commands.catalog',
      params: {},
    },
    {
      name: 'commands.resolve',
      call: (rt) => rt.commands.resolve('/model claude-sonnet-4'),
      method: 'command.resolve',
      params: { command: '/model claude-sonnet-4' },
    },
    {
      name: 'commands.dispatch (session-bound, no profile param)',
      call: (rt) =>
        rt.commands.dispatch({
          sessionId: 'live-1',
          command: '/model claude-sonnet-4 --session',
        }),
      method: 'command.dispatch',
      params: {
        session_id: 'live-1',
        command: '/model claude-sonnet-4 --session',
      },
    },
    {
      name: 'commands.exec routes slash commands through slash.exec',
      call: (rt) =>
        rt.commands.exec({
          sessionId: 'live-1',
          command: '/model qwen3.6-flash --provider alibaba',
        }),
      method: 'slash.exec',
      params: {
        session_id: 'live-1',
        command: '/model qwen3.6-flash --provider alibaba',
      },
    },
    {
      name: 'models.options defaults refresh to false and injects profile',
      call: (rt) => rt.models.options(),
      method: 'model.options',
      params: { refresh: false, profile: 'builder' },
    },
    {
      name: 'models.options forwards refresh',
      call: (rt) => rt.models.options({ refresh: true }),
      method: 'model.options',
      params: { refresh: true, profile: 'builder' },
    },
    {
      name: 'profiles.list enumerates cross-profile (no profile param)',
      call: (rt) => rt.profiles.list(),
      method: 'profiles.list',
      params: {},
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const harness = makeHarness();
      await connected(harness);
      await testCase.call(harness.runtime);
      assert.deepEqual(harness.gateways[0].requests, [
        { method: testCase.method, params: testCase.params },
      ]);
    });
  }
});

describe('default-profile runtime omits the profile param', () => {
  async function connectDefault() {
    const gateways = [];
    const runtime = createHermesRuntime({
      gatewayFactory: () => {
        const gateway = new FakeGateway();
        gateways.push(gateway);
        return gateway;
      },
      bootstrapProvider: {
        fetch: async () => ({ token: 't', basePath: '/hermes' }),
        clear: () => {},
      },
    });
    await runtime.connect();
    return { runtime, gateway: gateways[0] };
  }

  it('sessions.create carries no profile for the default runtime', async () => {
    const { runtime, gateway } = await connectDefault();
    await runtime.sessions.create();
    assert.deepEqual(gateway.requests[0], {
      method: 'session.create',
      params: { source: 'personaldash' },
    });
  });

  it('models.options carries no profile for the default runtime', async () => {
    const { runtime, gateway } = await connectDefault();
    await runtime.models.options();
    assert.deepEqual(gateway.requests[0], {
      method: 'model.options',
      params: { refresh: false },
    });
  });
});

describe('normalizeProfileRows', () => {
  it('maps a profiles.list payload to the picker shape', async () => {
    const { normalizeProfileRows } = await import('./hermesRuntime.js');
    const rows = normalizeProfileRows({
      profiles: [
        {
          name: 'default',
          is_default: true,
          model: 'qwen3.8-flash',
          provider: 'alibaba',
          display_name: '',
          description: '',
        },
        {
          name: 'coding',
          is_default: false,
          model: 'gpt-5.2-codex',
          provider: 'copilot',
          display_name: 'Coding',
          description: 'code work',
        },
      ],
    });
    assert.deepEqual(rows, [
      {
        name: 'default',
        displayName: 'default',
        isDefault: true,
        model: 'qwen3.8-flash',
        provider: 'alibaba',
        description: '',
      },
      {
        name: 'coding',
        displayName: 'Coding',
        isDefault: false,
        model: 'gpt-5.2-codex',
        provider: 'copilot',
        description: 'code work',
      },
    ]);
  });

  it('accepts a bare array and tolerates a missing payload', async () => {
    const { normalizeProfileRows } = await import('./hermesRuntime.js');
    assert.deepEqual(normalizeProfileRows([{ name: 'x' }]), [
      {
        name: 'x',
        displayName: 'x',
        isDefault: false,
        model: '',
        provider: '',
        description: '',
      },
    ]);
    assert.deepEqual(normalizeProfileRows(undefined), []);
    assert.deepEqual(normalizeProfileRows({}), []);
  });
});

describe('files wiring', () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('builds authenticated download URLs through the bootstrap token', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'tok-file',
        basePath: '/hermes',
        wsPath: '/hermes/api/ws',
        authRequired: false,
      }),
    });
    const { runtime } = makeHarness();
    const url = await runtime.files.downloadUrl('notes/todo.md');
    assert.equal(
      url,
      '/hermes/api/files/download?path=' +
        encodeURIComponent('notes/todo.md') +
        '&token=tok-file',
    );
  });
});
