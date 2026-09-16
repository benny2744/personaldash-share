import { NextResponse } from 'next/server';
import config from '@/lib/config';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.sh',
  '.sql',
  '.css',
]);

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
]);

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdfText(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;
  try {
    const parts = [];
    for (let page = 1; page <= doc.numPages; page += 1) {
      const pageObj = await doc.getPage(page);
      const content = await pageObj.getTextContent();
      parts.push(content.items.map((item) => item.str).join(' '));
    }
    return parts.join('\n\n').trim();
  } finally {
    await loadingTask.destroy();
  }
}

async function convertViaLibreOffice(buffer, filename) {
  const response = await fetch(
    `${config.libreofficeConverterUrl}/convert-upload`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(filename),
      },
      body: buffer,
      signal: AbortSignal.timeout(150_000),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(
      payload.error || `Document converter failed (${response.status})`,
    );
  }
  const text = String(payload.text || '');
  return payload.format === 'html' ? stripHtml(text) : text.trim();
}

function truncateText(text) {
  if (text.length <= MAX_TEXT_CHARS) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

export async function POST(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return errorResponse('Invalid multipart body', 400);
  }

  const file = form.get('file');
  if (
    !file ||
    typeof file === 'string' ||
    typeof file.arrayBuffer !== 'function'
  ) {
    return errorResponse('Missing file field "file"', 400);
  }

  const filename = String(file.name || 'attachment');
  const extension = filename.includes('.')
    ? `.${filename.split('.').pop().toLowerCase()}`
    : '';
  const mime = String(file.type || '');

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.byteLength) {
    return errorResponse('Empty file upload', 400);
  }
  if (buffer.byteLength > MAX_BYTES) {
    return errorResponse(
      `File exceeds ${Math.floor(MAX_BYTES / (1024 * 1024))} MB limit`,
      413,
    );
  }

  try {
    let text;
    if (extension === '.pdf' || mime === 'application/pdf') {
      text = await extractPdfText(buffer);
    } else if (HTML_EXTENSIONS.has(extension)) {
      text = stripHtml(buffer.toString('utf-8'));
    } else if (TEXT_EXTENSIONS.has(extension) || mime.startsWith('text/')) {
      text = buffer.toString('utf-8').trim();
    } else if (OFFICE_EXTENSIONS.has(extension)) {
      text = await convertViaLibreOffice(buffer, filename);
    } else {
      return errorResponse(
        `Unsupported file type: ${extension || mime || 'unknown'}`,
        415,
      );
    }

    if (!text) {
      return errorResponse('No extractable text found in file', 422);
    }

    const { text: truncatedText, truncated } = truncateText(text);
    return NextResponse.json(
      {
        filename,
        text: truncatedText,
        charCount: truncatedText.length,
        truncated,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'Text extraction failed' },
      { status: 502, headers: NO_STORE },
    );
  }
}
