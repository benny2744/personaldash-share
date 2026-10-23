import test from 'node:test';
import assert from 'node:assert/strict';
import { getOpencodeFrameUrl, getOpencodeHosts } from './opencodeFrameUrl.js';

test('accepts and normalizes HTTP(S) OpenCode URLs', () => {
  assert.equal(
    getOpencodeFrameUrl(' https://opencode.example.test/ '),
    'https://opencode.example.test',
  );
  assert.equal(
    getOpencodeFrameUrl('http://localhost:4096/'),
    'http://localhost:4096',
  );
});

test('host list validates origins, deduplicates and preserves the legacy URL', () => {
  assert.deepEqual(
    getOpencodeHosts(
      'BZ|https://code.test/,Duplicate|https://code.test,Bad|javascript:bad,User|https://u:p@code.test,Path|https://code.test/path,Home|https://home.test',
    ),
    [
      { id: 'code.test', label: 'BZ', url: 'https://code.test' },
      { id: 'home.test', label: 'Home', url: 'https://home.test' },
    ],
  );
  assert.deepEqual(getOpencodeHosts('', 'https://legacy.test'), [
    { id: 'legacy.test', label: 'OpenCode', url: 'https://legacy.test' },
  ]);
  assert.deepEqual(getOpencodeHosts('bad'), []);
});

test('rejects empty, malformed, and non-HTTP(S) URLs', () => {
  assert.equal(getOpencodeFrameUrl(''), '');
  assert.equal(getOpencodeFrameUrl(undefined), '');
  assert.equal(getOpencodeFrameUrl('javascript:alert(1)'), '');
  assert.equal(getOpencodeFrameUrl('not a URL'), '');
});
