'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getLocalStore } from '@/lib/cache/localStore';
import {
  getMessageCursor,
  readConversationList,
  readMessages,
  setMessageCursor,
  writeConversationList,
  writeMessages,
} from '@/lib/cache/dingTalkCache';

const LIST_POLL_MS = 30000;
const THREAD_POLL_MS = 10000;

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

export function useDingTalkChat() {
  const [self, setSelf] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationsError, setConversationsError] = useState(null);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');

  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;
  const latestTsRef = useRef(null);
  const earliestTsRef = useRef(null);
  const threadGenRef = useRef(0);

  const [olderLoading, setOlderLoading] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);

  useEffect(() => {
    fetchJson('/api/dingtalk/self')
      .then(setSelf)
      .catch(() => setSelf(null));
  }, []);

  const refreshConversations = useCallback(async (search = '') => {
    const store = getLocalStore();
    if (!search) {
      const cached = await readConversationList(store);
      if (cached?.length) setConversations(cached);
    }
    try {
      const qs = search ? `?q=${encodeURIComponent(search)}` : '';
      const data = await fetchJson(`/api/dingtalk/conversations${qs}`);
      const list = data.conversations || [];
      setConversations(list);
      setConversationsError(null);
      if (!search) await writeConversationList(store, list);
    } catch (error) {
      setConversationsError(error.message);
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshConversations(query);
    const timer = setInterval(() => refreshConversations(query), LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [query, refreshConversations]);

  const loadThread = useCallback(
    async (cid, { incremental = false, older = false } = {}) => {
      const gen = threadGenRef.current;
      const isCurrent = () =>
        gen === threadGenRef.current && activeIdRef.current === cid;
      const store = getLocalStore();

      async function fetchOlder() {
        if (!earliestTsRef.current) return;
        setOlderLoading(true);
        const url = `/api/dingtalk/conversations/${encodeURIComponent(
          cid,
        )}/messages?before=${encodeURIComponent(earliestTsRef.current)}&limit=100`;
        const data = await fetchJson(url);
        if (!isCurrent()) return;
        const incoming = data.messages || [];
        setHasMoreOlder(incoming.length === 100);
        if (incoming.length === 0) {
          setOlderLoading(false);
          return;
        }
        earliestTsRef.current = incoming[0].createdAt;
        setMessages((current) => {
          const seen = new Map(current.map((m) => [m.openMessageId, true]));
          const merged = [
            ...incoming.filter((m) => !seen.has(m.openMessageId)),
            ...current,
          ];
          return merged.sort((a, b) =>
            String(a.createdAt).localeCompare(String(b.createdAt)),
          );
        });
        await writeMessages(store, cid, incoming);
        setOlderLoading(false);
      }

      async function fetchAfter() {
        const url = `/api/dingtalk/conversations/${encodeURIComponent(
          cid,
        )}/messages?after=${encodeURIComponent(latestTsRef.current)}&limit=100`;
        const data = await fetchJson(url);
        if (!isCurrent()) return;
        const incoming = data.messages || [];
        if (incoming.length > 0) {
          setMessages((current) => {
            const seen = new Map(current.map((m) => [m.openMessageId, true]));
            return [
              ...current,
              ...incoming.filter((m) => !seen.has(m.openMessageId)),
            ];
          });
          const last = incoming[incoming.length - 1];
          latestTsRef.current = last.createdAt;
          await setMessageCursor(store, cid, last.createdAt);
          await writeMessages(store, cid, incoming);
        }
      }

      async function fetchLatest() {
        const data = await fetchJson(
          `/api/dingtalk/conversations/${encodeURIComponent(cid)}/messages?latest=1&limit=100`,
        );
        if (!isCurrent()) return;
        const incoming = data.messages || [];
        if (incoming.length > 0) {
          setMessages((current) => {
            const seen = new Map(current.map((m) => [m.openMessageId, true]));
            const merged = [
              ...current,
              ...incoming.filter((m) => !seen.has(m.openMessageId)),
            ];
            return merged.sort((a, b) =>
              String(a.createdAt).localeCompare(String(b.createdAt)),
            );
          });
          earliestTsRef.current = incoming[0].createdAt;
          const last = incoming[incoming.length - 1];
          if (last) {
            latestTsRef.current = last.createdAt;
            await setMessageCursor(store, cid, last.createdAt);
          }
          setHasMoreOlder(incoming.length === 100);
          await writeMessages(store, cid, incoming);
        } else {
          setHasMoreOlder(false);
        }
      }

      try {
        if (older) {
          await fetchOlder();
        } else if (!incremental) {
          const cached = await readMessages(store, cid);
          if (cached?.length && isCurrent()) {
            setMessages(cached);
            earliestTsRef.current = cached[0].createdAt;
            latestTsRef.current = cached[cached.length - 1].createdAt;
            setHasMoreOlder(true);
          }
          await fetchLatest();
        } else if (!latestTsRef.current) {
          await fetchLatest();
        } else {
          await fetchAfter();
        }
      } catch (error) {
        console.error('[dingtalk] thread load failed', error);
      } finally {
        if (isCurrent()) setMessagesLoading(false);
      }
    },
    [],
  );

  const selectConversation = useCallback(
    (cid) => {
      if (activeIdRef.current === cid) return;
      threadGenRef.current += 1;
      setActiveId(cid);
      setMessages([]);
      latestTsRef.current = null;
      earliestTsRef.current = null;
      setHasMoreOlder(false);
      if (!cid) {
        setMessagesLoading(false);
        return;
      }
      setMessagesLoading(true);
      loadThread(cid);
    },
    [loadThread],
  );

  useEffect(() => {
    if (!activeId) return undefined;
    const timer = setInterval(
      () => loadThread(activeIdRef.current, { incremental: true }),
      THREAD_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [activeId, loadThread]);

  const loadOlderMessages = useCallback(() => {
    const cid = activeIdRef.current;
    if (!cid || olderLoading || !hasMoreOlder) return;
    loadThread(cid, { older: true });
  }, [olderLoading, hasMoreOlder, loadThread]);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    const cid = activeIdRef.current;
    if (!text || !cid || sending) return false;
    setSending(true);
    setSendError(null);
    try {
      await fetchJson('/api/dingtalk/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openConversationId: cid, text }),
      });
      setDraft('');
      await loadThread(cid, { incremental: true });
      refreshConversations(query);
      return true;
    } catch (error) {
      setSendError(error.message);
      return false;
    } finally {
      setSending(false);
    }
  }, [draft, sending, loadThread, refreshConversations, query]);

  return {
    self,
    conversations,
    conversationsLoading,
    conversationsError,
    query,
    setQuery,
    searchConversations: () => refreshConversations(query),
    activeId,
    selectConversation,
    messages,
    messagesLoading,
    olderLoading,
    hasMoreOlder,
    loadOlderMessages,
    draft,
    setDraft,
    sendMessage,
    sending,
    sendError,
  };
}
