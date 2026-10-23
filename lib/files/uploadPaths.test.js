import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  uploadPathSegments,
  sanitizeRelativeUploadPath,
  zipRootDirName,
} from './uploadPaths.js';

describe('uploadPathSegments', () => {
  it('splits and keeps plain nested paths', () => {
    assert.deepEqual(uploadPathSegments('MyFolder/sub/a.txt'), [
      'MyFolder',
      'sub',
      'a.txt',
    ]);
    assert.deepEqual(uploadPathSegments('a.txt'), ['a.txt']);
  });

  it('normalizes backslashes, duplicate and edge slashes', () => {
    assert.deepEqual(uploadPathSegments('a\\b\\c.md'), ['a', 'b', 'c.md']);
    assert.deepEqual(uploadPathSegments('/a//b/'), ['a', 'b']);
    assert.deepEqual(uploadPathSegments('./a/./b'), ['a', 'b']);
  });

  it('sanitizes illegal filename characters per segment', () => {
    assert.deepEqual(uploadPathSegments('what?is/this: "x".txt'), [
      'what is',
      'this x .txt',
    ]);
  });

  it('rejects traversal attempts outright', () => {
    assert.equal(uploadPathSegments('../outside'), null);
    assert.equal(uploadPathSegments('ok/../../etc/passwd'), null);
    assert.equal(uploadPathSegments('..\\windows'), null);
  });

  it('rejects hidden segments', () => {
    assert.equal(uploadPathSegments('.git/config'), null);
    assert.equal(uploadPathSegments('folder/.hidden.txt'), null);
  });

  it('rejects empty results', () => {
    assert.equal(uploadPathSegments(''), null);
    assert.equal(uploadPathSegments(null), null);
    assert.equal(uploadPathSegments('///'), null);
  });
});

describe('sanitizeRelativeUploadPath', () => {
  it('joins safe segments with posix separators', () => {
    assert.equal(
      sanitizeRelativeUploadPath('Photos\\from trip/a (1).jpg'),
      'Photos/from trip/a (1).jpg',
    );
  });

  it('returns null for unsafe paths', () => {
    assert.equal(sanitizeRelativeUploadPath('../evil'), null);
    assert.equal(sanitizeRelativeUploadPath('x/.DS_Store'), null);
  });
});

describe('zipRootDirName', () => {
  it('uses the sanitized zip stem', () => {
    assert.equal(zipRootDirName('photos 2026.zip'), 'photos 2026');
    assert.equal(zipRootDirName('REPORT?.ZIP'), 'REPORT');
    assert.equal(zipRootDirName('archive.zip.zip'), 'archive.zip');
  });

  it('falls back to archive for unusable stems', () => {
    assert.equal(zipRootDirName('.zip'), 'archive');
    assert.equal(zipRootDirName('???'), 'archive');
    assert.equal(zipRootDirName(''), 'archive');
  });
});
