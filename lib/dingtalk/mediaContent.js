const MEDIA_RE = /\[([^\]\n]{1,40}?)\]\(mediaId=(@[\w+/=.-]+)\)|\[文件\]\s*([^\n]*?)\s*fileId:\s*([\w+/=.-]+)(?:\s+url:\s*\S+)?/g;
const HINT_RE = /\s*注意：如需下载使用dws (?:chat message download-media|drive download)命令下载/g;

export function parseMediaSegments(content) {
  const text = String(content || '');
  const segments = [];
  let last = 0;
  let match;
  MEDIA_RE.lastIndex = 0;
  while ((match = MEDIA_RE.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ type: 'text', text: text.slice(last, match.index) });
    }
    if (match[2]) {
      segments.push({ type: 'media', label: match[1], resourceId: match[2] });
    } else {
      segments.push({ type: 'file', name: match[3]?.trim() || 'file', fileId: match[4] });
    }
    last = MEDIA_RE.lastIndex;
  }
  if (last < text.length) {
    segments.push({ type: 'text', text: text.slice(last) });
  }
  return segments
    .map((seg) =>
      seg.type === 'text' ? { ...seg, text: seg.text.replace(HINT_RE, '') } : seg,
    )
    .filter((seg) => seg.type !== 'text' || seg.text.length > 0);
}

export function dingTalkMediaUrl(messageId, resourceId, kind) {
  const params = new URLSearchParams({
    messageId: String(messageId || ''),
    resourceId: String(resourceId || ''),
    kind: kind === 'file' ? 'file' : 'media',
  });
  return `/api/dingtalk/media?${params.toString()}`;
}
