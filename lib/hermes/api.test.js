import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearHermesBootstrapCache,
  deleteSession,
  getLatestDescendant,
  getSession,
  getSessionMessages,
  listProfiles,
  listSessions,
  renameSession,
  searchSessions,
} from './api.js';

const ORIGINAL_FETCH = globalThis.fetch;

function captureFetch() {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/api/hermes/bootstrap')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          token: 'tok',
          basePath: '/hermes',
          wsPath: '/hermes/api/ws',
          authRequired: false,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true }),
    };
  };
  return urls;
}

describe('hermes api profile query threading', () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    clearHermesBootstrapCache();
  });

  it('listSessions omits profile for the default', async () => {
    const urls = captureFetch();
    await listSessions({ limit: 10 });
    assert.ok(!urls[1].includes('profile='), urls[1]);
  });

  it('listSessions appends ?profile=', async () => {
    const urls = captureFetch();
    await listSessions({ limit: 10, profile: 'coding' });
    assert.ok(urls[1].includes('profile=coding'), urls[1]);
  });

  it('searchSessions appends profile alongside q', async () => {
    const urls = captureFetch();
    await searchSessions('hello world', { profile: 'coding' });
    assert.ok(urls[1].includes('q=hello+world'), urls[1]);
    assert.ok(urls[1].includes('profile=coding'), urls[1]);
  });

  it('getSession / getLatestDescendant append a profile query', async () => {
    const urls = captureFetch();
    await getSession('s-1', { profile: 'coding' });
    await getLatestDescendant('s-1', { profile: 'coding' });
    assert.ok(urls[1].endsWith('/api/sessions/s-1?profile=coding'), urls[1]);
    assert.ok(
      urls[2].endsWith('/api/sessions/s-1/latest-descendant?profile=coding'),
      urls[2],
    );
  });

  it('getSessionMessages keeps offset/limit and adds profile', async () => {
    const urls = captureFetch();
    await getSessionMessages('s-1', { offset: 5, limit: 500, profile: 'coding' });
    const qs = new URL(urls[1], 'http://localhost').searchParams;
    assert.equal(qs.get('offset'), '5');
    assert.equal(qs.get('limit'), '500');
    assert.equal(qs.get('profile'), 'coding');
  });

  it('renameSession / deleteSession append profile to the mutation URL', async () => {
    const urls = captureFetch();
    await renameSession('s-1', { title: 'x' }, { profile: 'coding' });
    await deleteSession('s-1', { profile: 'coding' });
    assert.ok(urls[1].endsWith('/api/sessions/s-1?profile=coding'), urls[1]);
    assert.ok(urls[2].endsWith('/api/sessions/s-1?profile=coding'), urls[2]);
  });

  it('listProfiles hits /api/profiles', async () => {
    const urls = captureFetch();
    await listProfiles();
    assert.ok(urls[1].endsWith('/api/profiles'), urls[1]);
  });
});
