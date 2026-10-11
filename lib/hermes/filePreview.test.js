import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dataUrlToText,
  fileExtension,
  isImageMime,
  isMarkdownPath,
  isTextMime,
  isTextPath,
} from './filePreview.js';

describe('fileExtension', () => {
  it('extracts the lowercase extension from paths', () => {
    assert.equal(fileExtension('/notes/Demo.MD'), 'md');
    assert.equal(fileExtension('C:\\tmp\\report.Pdf'), 'pdf');
    assert.equal(fileExtension('archive.tar.gz'), 'gz');
  });

  it('returns empty for extensionless and dotfile paths', () => {
    assert.equal(fileExtension('/usr/bin/Dockerfile'), '');
    assert.equal(fileExtension('.gitignore'), '');
    assert.equal(fileExtension(''), '');
    assert.equal(fileExtension(null), '');
  });
});

describe('isMarkdownPath', () => {
  it('detects markdown extensions', () => {
    assert.equal(isMarkdownPath('notes/meeting.md'), true);
    assert.equal(isMarkdownPath('notes/meeting.markdown'), true);
    assert.equal(isMarkdownPath('notes/slide.mdx'), true);
    assert.equal(isMarkdownPath('notes/meeting.txt'), false);
    assert.equal(isMarkdownPath('notes/meeting'), false);
  });
});

describe('isTextPath', () => {
  it('treats code and data files as text', () => {
    for (const path of ['a.js', 'b.json', 'c.yml', 'd.csv', 'e.sh']) {
      assert.equal(isTextPath(path), true, path);
    }
  });

  it('treats binary extensions as non-text', () => {
    for (const path of ['a.png', 'b.pdf', 'c.zip', 'd.mp4', 'e.xlsx']) {
      assert.equal(isTextPath(path), false, path);
    }
  });

  it('treats extensionless files as text', () => {
    assert.equal(isTextPath('Dockerfile'), true);
    assert.equal(isTextPath('Makefile'), true);
  });
});

describe('isImageMime / isTextMime', () => {
  it('classifies server MIME types', () => {
    assert.equal(isImageMime('image/png'), true);
    assert.equal(isImageMime('text/markdown'), false);
    assert.equal(isTextMime('text/plain'), true);
    assert.equal(isTextMime('application/json'), true);
    assert.equal(isTextMime('application/x-sh'), true);
    assert.equal(isTextMime('application/octet-stream'), false);
  });
});

describe('dataUrlToText', () => {
  it('decodes a data URL to UTF-8 text', () => {
    const source = '# Hello\n\n- one\n- two\n';
    const encoded = `data:text/markdown;base64,${Buffer.from(
      source,
      'utf8',
    ).toString('base64')}`;
    assert.equal(dataUrlToText(encoded), source);
  });

  it('preserves multi-byte UTF-8 (CJK) that atob alone would mangle', () => {
    const source = '中文笔记 — em dash ✓';
    const encoded = `data:text/plain;base64,${Buffer.from(
      source,
      'utf8',
    ).toString('base64')}`;
    assert.equal(dataUrlToText(encoded), source);
    assert.notEqual(atob(encoded.split(',')[1]), source);
  });

  it('accepts bare base64 without the data URL prefix', () => {
    const encoded = Buffer.from('plain body', 'utf8').toString('base64');
    assert.equal(dataUrlToText(encoded), 'plain body');
  });
});
