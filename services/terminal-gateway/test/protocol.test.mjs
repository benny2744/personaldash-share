/** Frame protocol validation tests. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeServerFrame,
  parseClientFrame,
} from '../lib/protocol.js';

test('input frames decode base64 to bytes', () => {
  const result = parseClientFrame(
    JSON.stringify({ type: 'input', data: Buffer.from('ls\n').toString('base64') }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.frame.data.toString('utf8'), 'ls\n');
});

test('oversized frames are fatal', () => {
  const big = 'x'.repeat(97 * 1024);
  const result = parseClientFrame(JSON.stringify({ type: 'input', data: big }));
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
});

test('input over the decoded cap is fatal (decompression bomb guard)', () => {
  const base64 = Buffer.alloc(65 * 1024, 65).toString('base64');
  const result = parseClientFrame(JSON.stringify({ type: 'input', data: base64 }));
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
});

test('non-JSON and empty input are handled', () => {
  assert.equal(parseClientFrame('not json').fatal, true);
  const empty = parseClientFrame(
    JSON.stringify({ type: 'input', data: '' }),
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.fatal, false);
});

test('resize bounds are enforced', () => {
  assert.equal(
    parseClientFrame(JSON.stringify({ type: 'resize', cols: 1, rows: 24 })).ok,
    false,
  );
  assert.equal(
    parseClientFrame(JSON.stringify({ type: 'resize', cols: 80, rows: 501 })).ok,
    false,
  );
  assert.equal(
    parseClientFrame(JSON.stringify({ type: 'resize', cols: 80.5, rows: 24 })).ok,
    false,
  );
  const ok = parseClientFrame(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  assert.deepEqual(ok.frame, { type: 'resize', cols: 120, rows: 40 });
});

test('unknown frame types are ignored, not fatal', () => {
  const result = parseClientFrame(JSON.stringify({ type: 'nonsense', x: 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.fatal, false);
});

test('server output frames encode base64', () => {
  const raw = encodeServerFrame({ type: 'output', data: Buffer.from('hi') });
  assert.deepEqual(JSON.parse(raw), {
    type: 'output',
    data: Buffer.from('hi').toString('base64'),
  });
});
