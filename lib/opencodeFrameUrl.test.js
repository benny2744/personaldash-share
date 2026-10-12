import test from 'node:test';
import assert from 'node:assert/strict';
import { getOpencodeFrameUrl } from './opencodeFrameUrl.js';

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

test('rejects empty, malformed, and non-HTTP(S) URLs', () => {
  assert.equal(getOpencodeFrameUrl(''), '');
  assert.equal(getOpencodeFrameUrl(undefined), '');
  assert.equal(getOpencodeFrameUrl('javascript:alert(1)'), '');
  assert.equal(getOpencodeFrameUrl('not a URL'), '');
});
