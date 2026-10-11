import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAgentApiToken, requireAgentAuth } from './agentAuth.js';

function requestWithToken(token) {
  const headers = new Headers();
  if (token != null) headers.set('x-hermes-session-token', token);
  return { headers };
}

const ENV_KEYS = ['AGENT_API_TOKEN', 'HERMES_DASHBOARD_SESSION_TOKEN'];

function withEnv(overrides, run) {
  const saved = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, overrides);
    run();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('getAgentApiToken', () => {
  it('prefers AGENT_API_TOKEN over the Hermes dashboard token', () => {
    withEnv(
      {
        AGENT_API_TOKEN: 'agent-secret',
        HERMES_DASHBOARD_SESSION_TOKEN: 'hermes-secret',
      },
      () => {
        assert.equal(getAgentApiToken(), 'agent-secret');
      },
    );
  });

  it('falls back to the Hermes dashboard token for existing deployments', () => {
    withEnv(
      {
        HERMES_DASHBOARD_SESSION_TOKEN: 'hermes-secret',
      },
      () => {
        assert.equal(getAgentApiToken(), 'hermes-secret');
      },
    );
  });
});

describe('requireAgentAuth', () => {
  it('accepts the dedicated agent token', () => {
    withEnv(
      {
        AGENT_API_TOKEN: 'agent-secret',
        HERMES_DASHBOARD_SESSION_TOKEN: 'hermes-secret',
      },
      () => {
        assert.equal(
          requireAgentAuth(requestWithToken('agent-secret')),
          null,
        );
      },
    );
  });

  it('rejects the Hermes browser token once AGENT_API_TOKEN diverges', () => {
    withEnv(
      {
        AGENT_API_TOKEN: 'agent-secret',
        HERMES_DASHBOARD_SESSION_TOKEN: 'hermes-secret',
      },
      () => {
        const denied = requireAgentAuth(requestWithToken('hermes-secret'));
        assert.equal(denied.status, 401);
        assert.equal(
          denied.headers.get('cache-control'),
          'no-store',
        );
      },
    );
  });

  it('rejects missing or wrong tokens', () => {
    withEnv({ AGENT_API_TOKEN: 'agent-secret' }, () => {
      assert.equal(requireAgentAuth(requestWithToken(null)).status, 401);
      assert.equal(requireAgentAuth(requestWithToken('nope')).status, 401);
      assert.equal(requireAgentAuth(requestWithToken('')).status, 401);
    });
  });

  it('keeps accepting the Hermes token when no agent token is configured', () => {
    withEnv({ HERMES_DASHBOARD_SESSION_TOKEN: 'hermes-secret' }, () => {
      assert.equal(
        requireAgentAuth(requestWithToken('hermes-secret')),
        null,
      );
    });
  });
});
