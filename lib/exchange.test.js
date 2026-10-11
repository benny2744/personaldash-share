import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub';
process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/vault';
process.env.EXCHANGE_PATH = await fs.mkdtemp(
  path.join(os.tmpdir(), 'exchange-test-'),
);

const {
  normalizeExchangePath,
  isHidden,
  resolveExchangePath,
  contentTypeForPath,
  isPreviewablePath,
  listExchangeDirectory,
  ensureUniqueExchangeFilename,
  writeExchangeStream,
} = await import('./exchange.js');

const ROOT = process.env.EXCHANGE_PATH;

describe('exchange path guards', () => {
  it('normalizes user-supplied paths', () => {
    assert.equal(normalizeExchangePath('inbox/notes'), 'inbox/notes');
    assert.equal(normalizeExchangePath('/inbox/'), 'inbox/');
    assert.equal(normalizeExchangePath('inbox\\sub'), 'inbox/sub');
    assert.equal(normalizeExchangePath(null), '');
  });

  it('flags hidden path segments', () => {
    assert.equal(isHidden('inbox/.hidden'), true);
    assert.equal(isHidden('.git/config'), true);
    assert.equal(isHidden('inbox/notes.md'), false);
  });

  it('resolves nested paths and rejects escapes', () => {
    assert.equal(
      resolveExchangePath('inbox/file.txt'),
      path.join(ROOT, 'inbox/file.txt'),
    );
    assert.throws(() => resolveExchangePath('../outside'), /escapes/);
    assert.throws(() => resolveExchangePath('inbox/../../etc'), /escapes/);
    assert.equal(resolveExchangePath(''), ROOT);
  });
});

describe('exchange metadata helpers', () => {
  it('maps extensions to content types', () => {
    assert.equal(contentTypeForPath('a.md'), 'text/markdown; charset=utf-8');
    assert.equal(contentTypeForPath('b.PDF'), 'application/pdf');
    assert.equal(
      contentTypeForPath('c.unknownext'),
      'application/octet-stream',
    );
  });

  it('marks previewable types', () => {
    assert.equal(isPreviewablePath('note.md'), true);
    assert.equal(isPreviewablePath('photo.PNG'), true);
    assert.equal(isPreviewablePath('archive.zip'), false);
  });
});

describe('exchange listing and writing', () => {
  it('lists directories first, skipping hidden entries, with metadata', async () => {
    await fs.mkdir(path.join(ROOT, 'alpha'), { recursive: true });
    await fs.mkdir(path.join(ROOT, '.hiddendir'), { recursive: true });
    await fs.writeFile(path.join(ROOT, 'zeta.txt'), 'hello');
    await fs.writeFile(path.join(ROOT, '.secret'), 'x');

    const entries = await listExchangeDirectory('');
    const names = entries.map((entry) => entry.name);

    assert.equal(names.includes('.hiddendir'), false);
    assert.equal(names.includes('.secret'), false);
    const alphaIdx = names.indexOf('alpha');
    const zetaIdx = names.indexOf('zeta.txt');
    assert.ok(alphaIdx !== -1 && zetaIdx !== -1);
    assert.ok(alphaIdx < zetaIdx, 'directories sort first');

    const zeta = entries.find((entry) => entry.name === 'zeta.txt');
    assert.equal(zeta.size, 5);
    assert.ok(zeta.modifiedAt);
    assert.equal(zeta.type, 'file');
  });

  it('writes streams atomically under the exchange root', async () => {
    const written = await writeExchangeStream(
      'inbox/streamed.md',
      Readable.from(Buffer.from('# hello')),
    );
    assert.equal(written, 'inbox/streamed.md');
    assert.equal(
      await fs.readFile(path.join(ROOT, 'inbox/streamed.md'), 'utf8'),
      '# hello',
    );
  });

  it('never overwrites an existing destination (suffixes instead)', async () => {
    await fs.mkdir(path.join(ROOT, 'race'), { recursive: true });
    await fs.writeFile(path.join(ROOT, 'race', 'doc.txt'), 'original');
    const written = await writeExchangeStream(
      'race/doc.txt',
      Readable.from(Buffer.from('new content')),
    );
    assert.equal(written, 'race/doc-2.txt');
    assert.equal(
      await fs.readFile(path.join(ROOT, 'race', 'doc.txt'), 'utf8'),
      'original',
    );
    assert.equal(
      await fs.readFile(path.join(ROOT, 'race', 'doc-2.txt'), 'utf8'),
      'new content',
    );
  });

  it('keeps every concurrent same-name upload intact', async () => {
    await fs.mkdir(path.join(ROOT, 'concurrent'), { recursive: true });
    const payload = (n) => Buffer.from(`payload-${n}-`.padEnd(4096, 'x'));
    const uploads = Array.from({ length: 8 }, (_, n) =>
      writeExchangeStream(
        'concurrent/same.bin',
        Readable.from(payload(n)),
      ).then((saved) => ({ saved, n })),
    );
    const results = await Promise.all(uploads);
    const savedPaths = new Set(results.map((r) => r.saved));
    assert.equal(savedPaths.size, 8, 'each upload gets a distinct path');
    assert.ok(
      savedPaths.has('concurrent/same.bin'),
      'first racer keeps base name',
    );
    for (const { saved, n } of results) {
      const content = await fs.readFile(path.join(ROOT, saved));
      assert.deepEqual(content, payload(n), `${saved} keeps its own content`);
    }
    assert.equal(
      (await fs.readdir(path.join(ROOT, 'concurrent'))).filter((name) =>
        name.includes('.upload-'),
      ).length,
      0,
      'no temp files leak',
    );
  });

  it('rejects stream writes that escape the root', async () => {
    await assert.rejects(
      writeExchangeStream('../escape.bin', Readable.from(Buffer.from('x'))),
      /escapes/,
    );
  });

  it('returns collision-free filenames', async () => {
    await fs.mkdir(path.join(ROOT, 'uniq'), { recursive: true });
    await fs.writeFile(path.join(ROOT, 'uniq', 'report.pdf'), 'a');
    const first = await ensureUniqueExchangeFilename('uniq', 'report.pdf');
    assert.equal(first, path.posix.join('uniq', 'report-2.pdf'));
    await fs.writeFile(path.join(ROOT, first), 'b');
    const second = await ensureUniqueExchangeFilename('uniq', 'report.pdf');
    assert.equal(second, path.posix.join('uniq', 'report-3.pdf'));
  });
});
