// Resolves DingTalk media to a playable/displayable src, transparently backed
// by the LocalStore blob cache. Falls back to the raw API URL when IndexedDB
// is unavailable. Generation-safe: stale async resolutions never set state
// after unmount or param change.

import { useEffect, useState } from 'react';
import { getLocalStore } from './localStore';
import { readMediaBlob, writeMediaBlob } from './dingTalkCache';
import { dingTalkMediaUrl } from '../dingtalk/mediaContent';

const URL_CACHE_LIMIT = 200;
const urlCache = new Map(); // key `${kind}:${resourceId}` -> objectURL (LRU via re-insertion)

function rememberUrl(key, url) {
  if (urlCache.has(key)) urlCache.delete(key);
  urlCache.set(key, url);
  while (urlCache.size > URL_CACHE_LIMIT) {
    const oldestKey = urlCache.keys().next().value;
    URL.revokeObjectURL(urlCache.get(oldestKey));
    urlCache.delete(oldestKey);
  }
}

export function useCachedMediaSrc(media) {
  const apiUrl = media?.messageId
    ? dingTalkMediaUrl(media.messageId, media.resourceId, media.kind)
    : media?.url || null;
  const [src, setSrc] = useState(apiUrl);

  useEffect(() => {
    if (!apiUrl) {
      setSrc(null);
      return undefined;
    }
    if (!media?.resourceId) {
      setSrc(apiUrl);
      return undefined;
    }
    let cancelled = false;
    const key = `${media.kind}:${media.resourceId}`;

    (async () => {
      const hit = urlCache.get(key);
      if (hit) {
        if (!cancelled) setSrc(hit);
        return;
      }
      const store = getLocalStore();
      if (!store.available) {
        if (!cancelled) setSrc(apiUrl);
        return;
      }
      try {
        const cached = await readMediaBlob(store, media.kind, media.resourceId);
        if (cached) {
          const url = URL.createObjectURL(cached);
          rememberUrl(key, url);
          if (!cancelled) setSrc(url);
          return;
        }
        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error(`media fetch failed: ${response.status}`);
        const data = await response.blob();
        await writeMediaBlob(store, media.kind, media.resourceId, data);
        const url = URL.createObjectURL(data);
        rememberUrl(key, url);
        if (!cancelled) setSrc(url);
      } catch {
        if (!cancelled) setSrc(apiUrl); // graceful: straight to network URL
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiUrl, media?.kind, media?.resourceId]);

  return src;
}
