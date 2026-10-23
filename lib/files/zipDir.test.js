import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { unzipSync } from 'fflate';

const { createDirZipStream, zipDownloadName } = await import('./zipDir.js');

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function makeTree(root) {
  await fs.mkdir(path.join(root, 'sub', 'deeper'), { recursive: true });
  await fs.mkdir(path.join(root, 'empty-dir'), { recursive: true });
  await fs.mkdir(path.join(root, 'hidden-only'), { recursive: true });
  await fs.mkdir(path.join(root, '.hiddendir'), { recursive: true });
  await fs.mkdir(path.join(root, 'Secrets'), { recursive: true });
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha');
  await fs.writeFile(path.join(root, 'sub', 'b.md'), 'beta');
  await fs.writeFile(path.join(root, 'sub', 'deeper', 'c.json'), '{"gamma":1}');
  await fs.writeFile(path.join(root, '.hidden.txt'), 'nope');
  await fs.writeFile(path.join(root, '.hiddendir', 'x.txt'), 'nope');
  await fs.writeFile(path.join(root, 'hidden-only', '.dotfile'), 'nope');
  await fs.writeFile(path.join(root, 'Secrets', 'secret.md'), 'classified');
  await fs.symlink(path.join(root, 'a.txt'), path.join(root, 'link-to-a'));
}

describe('createDirZipStream', () => {
  it('zips a tree: files, nesting, empty dirs; skips hidden + symlinks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zipdir-test-'));
    await makeTree(root);

    const stream = await createDirZipStream(root, '');
    const bytes = await collect(Readable.from(stream));
    const unzipped = unzipSync(new Uint8Array(bytes));

    const names = Object.keys(unzipped).sort();
    assert.deepEqual(names, [
      'Secrets/secret.md',
      'a.txt',
      'empty-dir/',
      'hidden-only/',
      'sub/b.md',
      'sub/deeper/c.json',
    ]);
    assert.equal(Buffer.from(unzipped['a.txt']).toString('utf8'), 'alpha');
    assert.equal(Buffer.from(unzipped['sub/b.md']).toString('utf8'), 'beta');
    assert.equal(
      Buffer.from(unzipped['sub/deeper/c.json']).toString('utf8'),
      '{"gamma":1}',
    );
  });

  it('honors excludeRelative for subtrees (vault Secrets policy)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zipdir-test-'));
    await makeTree(root);

    const stream = await createDirZipStream(root, '', {
      excludeRelative: (rel) => rel === 'Secrets' || rel.startsWith('Secrets/'),
    });
    const bytes = await collect(Readable.from(stream));
    const names = Object.keys(unzipSync(new Uint8Array(bytes)));

    assert.ok(!names.some((name) => name.startsWith('Secrets')));
    assert.ok(names.includes('a.txt'));
  });

  it('zips a nested subdirectory with paths relative to it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zipdir-test-'));
    await makeTree(root);

    const stream = await createDirZipStream(root, 'sub');
    const bytes = await collect(Readable.from(stream));
    const names = Object.keys(unzipSync(new Uint8Array(bytes))).sort();

    assert.deepEqual(names, ['b.md', 'deeper/c.json']);
  });

  it('refuses roots that escape the base', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zipdir-test-'));
    await assert.rejects(createDirZipStream(root, '../outside'), /escapes/);
  });

  it('produces a valid (empty) archive for an empty directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zipdir-test-'));
    await fs.mkdir(path.join(root, 'void'), { recursive: true });

    const stream = await createDirZipStream(root, 'void');
    const bytes = await collect(Readable.from(stream));
    const unzipped = unzipSync(new Uint8Array(bytes));
    assert.deepEqual(Object.keys(unzipped), []);
  });
});

describe('zipDownloadName', () => {
  it('derives the attachment filename', () => {
    assert.equal(zipDownloadName('outputs/reports'), 'reports.zip');
    assert.equal(zipDownloadName('single'), 'single.zip');
    assert.equal(zipDownloadName(''), 'archive.zip');
  });
});
