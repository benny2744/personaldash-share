import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fileToBase64,
  prepareAttachments,
  splitAttachments,
} from './attachments.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_FILE_READER = globalThis.FileReader;

function makeFile(name, type, content = 'x') {
  // Real File instances: FormData.append requires a Blob-backed object.
  return new File([content], name, { type });
}

describe('splitAttachments', () => {
  it('splits images from documents by MIME type', () => {
    const files = [
      makeFile('a.png', 'image/png'),
      makeFile('b.pdf', 'application/pdf'),
      makeFile('c.jpg', 'image/jpeg'),
      makeFile('d.txt', 'text/plain'),
    ];
    const { images, documents } = splitAttachments(files);
    assert.deepEqual(images.map((f) => f.name), ['a.png', 'c.jpg']);
    assert.deepEqual(documents.map((f) => f.name), ['b.pdf', 'd.txt']);
  });

  it('treats unknown MIME types as documents', () => {
    const { images, documents } = splitAttachments([makeFile('x', '')]);
    assert.equal(images.length, 0);
    assert.equal(documents.length, 1);
  });
});

describe('fileToBase64', () => {
  afterEach(() => {
    globalThis.FileReader = ORIGINAL_FILE_READER;
  });

  it('strips the data URL prefix', async () => {
    globalThis.FileReader = class {
      readAsDataURL() {
        this.result = 'data:image/png;base64,QUJD';
        this.onload();
      }
    };
    const base64 = await fileToBase64(makeFile('a.png', 'image/png'));
    assert.equal(base64, 'QUJD');
  });

  it('rejects when the reader errors', async () => {
    globalThis.FileReader = class {
      readAsDataURL() {
        this.onerror();
      }
    };
    await assert.rejects(() => fileToBase64(makeFile('a.png', 'image/png')));
  });
});

describe('prepareAttachments', () => {
  beforeEach(() => {
    globalThis.FileReader = class {
      readAsDataURL() {
        this.result = 'data:image/png;base64,QUJD';
        this.onload();
      }
    };
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    globalThis.FileReader = ORIGINAL_FILE_READER;
  });

  it('attaches images through the injected collaborator with RPC-shaped payloads', async () => {
    const attached = [];
    globalThis.fetch = async () => {
      throw new Error('extract endpoint must not be called for images');
    };
    const { extractedBlocks, attachmentErrors } = await prepareAttachments(
      [makeFile('shot.png', 'image/png', 'abc')],
      {
        attachImage: async (image) => {
          attached.push(image);
        },
      },
    );
    assert.deepEqual(attached, [
      { content_base64: 'QUJD', filename: 'shot.png' },
    ]);
    assert.deepEqual(extractedBlocks, []);
    assert.deepEqual(attachmentErrors, []);
  });

  it('extracts documents and formats fenced prompt blocks', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        filename: 'notes.pdf',
        text: 'hello world',
        truncated: true,
      }),
    });
    const { extractedBlocks, attachmentErrors } = await prepareAttachments(
      [makeFile('notes.pdf', 'application/pdf')],
      { attachImage: async () => {} },
    );
    assert.equal(extractedBlocks.length, 1);
    assert.match(extractedBlocks[0], /\[Attached file: notes\.pdf — truncated\]/);
    assert.match(extractedBlocks[0], /```\nhello world\n```/);
    assert.deepEqual(attachmentErrors, []);
  });

  it('collects per-file failures without aborting the other files', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'extraction exploded' }),
    });
    const { extractedBlocks, attachmentErrors } = await prepareAttachments(
      [
        makeFile('bad.png', 'image/png'),
        makeFile('bad.pdf', 'application/pdf'),
      ],
      {
        attachImage: async () => {
          throw new Error('rpc down');
        },
      },
    );
    assert.deepEqual(extractedBlocks, []);
    assert.equal(attachmentErrors.length, 2);
    assert.match(attachmentErrors[0], /^bad\.png: rpc down$/);
    assert.match(attachmentErrors[1], /^bad\.pdf: extraction exploded$/);
  });

  it('keeps the plain-file error label when extraction returns no error field', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 413,
      json: async () => ({}),
    });
    const { attachmentErrors } = await prepareAttachments(
      [makeFile('big.pdf', 'application/pdf')],
      {},
    );
    assert.match(attachmentErrors[0], /^big\.pdf: Text extraction failed \(413\)$/);
  });
});
