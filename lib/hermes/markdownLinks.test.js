import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { vaultViewerHref } from './markdownLinks.js';

describe('vaultViewerHref', () => {
  it('rewrites percent-encoded root-relative vault paths to the vault viewer', () => {
    assert.equal(
      vaultViewerHref(
        '/resources/Yungu%20Student%20Project%20and%20Resource%20Platform%20-%20Leadership%20Pitch.md',
      ),
      `/vault?path=${encodeURIComponent(
        'resources/Yungu Student Project and Resource Platform - Leadership Pitch.md',
      )}`,
    );
  });

  it('rewrites already-decoded and bare-relative .md paths', () => {
    assert.equal(
      vaultViewerHref('/projects/Foo Bar.md'),
      `/vault?path=${encodeURIComponent('projects/Foo Bar.md')}`,
    );
    assert.equal(
      vaultViewerHref('Foo.md'),
      `/vault?path=${encodeURIComponent('Foo.md')}`,
    );
    assert.equal(
      vaultViewerHref('./notes/Foo.md'),
      `/vault?path=${encodeURIComponent('notes/Foo.md')}`,
    );
  });

  it('drops query and hash fragments from rewritten paths', () => {
    assert.equal(
      vaultViewerHref('/resources/Foo.md#section'),
      `/vault?path=${encodeURIComponent('resources/Foo.md')}`,
    );
  });

  it('leaves external URLs, protocol-relative URLs, and anchors alone', () => {
    assert.equal(
      vaultViewerHref('https://example.com/a.md'),
      'https://example.com/a.md',
    );
    assert.equal(
      vaultViewerHref('http://example.com/x'),
      'http://example.com/x',
    );
    assert.equal(
      vaultViewerHref('//cdn.example.com/a.md'),
      '//cdn.example.com/a.md',
    );
    assert.equal(vaultViewerHref('#section'), '#section');
    assert.equal(vaultViewerHref('mailto:a@b.md'), 'mailto:a@b.md');
  });

  it('leaves dashboard-owned routes alone', () => {
    assert.equal(
      vaultViewerHref('/api/vault/download?path=Foo.md'),
      '/api/vault/download?path=Foo.md',
    );
    assert.equal(
      vaultViewerHref('/hermes/api/files/download?path=%2Ftmp%2Fa.md'),
      '/hermes/api/files/download?path=%2Ftmp%2Fa.md',
    );
    assert.equal(vaultViewerHref('/_next/static/x'), '/_next/static/x');
  });

  it('leaves non-markdown relative paths alone', () => {
    assert.equal(vaultViewerHref('/projects'), '/projects');
    assert.equal(vaultViewerHref('/chat'), '/chat');
    assert.equal(
      vaultViewerHref('/vault?path=resources/Foo.md'),
      '/vault?path=resources/Foo.md',
    );
  });

  it('passes through empty, missing, and degenerate destinations', () => {
    assert.equal(vaultViewerHref(undefined), undefined);
    assert.equal(vaultViewerHref(''), '');
    assert.equal(vaultViewerHref('/.md'), '/.md');
  });
});
