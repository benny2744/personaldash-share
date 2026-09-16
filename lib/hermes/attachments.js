/**
 * Attachment preparation for Hermes chat.
 *
 * Images are attached through the Hermes gateway RPC (`image.attach_bytes`)
 * via an injected `attachImage` collaborator; documents are extracted to text
 * by PersonalDash (`/api/hermes/attachments/extract`) and inlined into the
 * prompt body as fenced code blocks.
 */

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export async function extractDocumentText(file) {
  const form = new FormData();
  form.append('file', file, file.name || 'attachment');
  const response = await fetch('/api/hermes/attachments/extract', {
    method: 'POST',
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload.error || `Text extraction failed (${response.status})`,
    );
  }
  return payload;
}

function isImageFile(file) {
  return String(file.type || '').startsWith('image/');
}

export function splitAttachments(attachments = []) {
  return {
    images: attachments.filter(isImageFile),
    documents: attachments.filter((file) => !isImageFile(file)),
  };
}

/**
 * Attach images via `attachImage` and extract document text for prompt
 * inlining. Per-file failures are collected instead of thrown so one bad
 * attachment does not abort the others; the caller decides whether the
 * accumulated errors should abort the whole send.
 *
 * @param {File[]} files
 * @param {{ attachImage?: (image: { content_base64: string, filename: string }) => Promise<void> }} options
 * @returns {Promise<{ extractedBlocks: string[], attachmentErrors: string[] }>}
 */
export async function prepareAttachments(files, { attachImage } = {}) {
  const { images, documents } = splitAttachments(files);
  const extractedBlocks = [];
  const attachmentErrors = [];

  for (const file of images) {
    try {
      const content_base64 = await fileToBase64(file);
      await attachImage?.({
        content_base64,
        filename: file.name || 'image.png',
      });
    } catch (error) {
      attachmentErrors.push(
        `${file.name || 'image'}: ${error?.message || String(error)}`,
      );
    }
  }

  for (const file of documents) {
    try {
      const result = await extractDocumentText(file);
      extractedBlocks.push(
        `\n\n[Attached file: ${result.filename || file.name}${result.truncated ? ' — truncated' : ''}]\n\`\`\`\n${result.text}\n\`\`\``,
      );
    } catch (error) {
      attachmentErrors.push(
        `${file.name || 'file'}: ${error?.message || String(error)}`,
      );
    }
  }

  return { extractedBlocks, attachmentErrors };
}
