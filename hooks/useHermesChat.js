'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { createHermesRuntime } from '@/lib/agents/hermesRuntime';
import { chatReducer, createInitialChatState } from '@/lib/hermes/chatReducer';
import { prepareAttachments } from '@/lib/hermes/attachments';
import { reconcileTranscript } from '@/lib/hermes/transcriptSync';
import { resolveResumeTarget } from '@/lib/hermes/resumeTarget';
import {
  loadDraft,
  loadPanelState,
  saveDraft,
  savePanelState,
} from '@/lib/hermes/panelState';
import { getLocalStore } from '@/lib/cache/localStore';
import { readTranscript, writeTranscript } from '@/lib/cache/hermesCache';
import { markSync } from '@/lib/cache/diagnostics';
import { useHermesConnection } from './useHermesConnection';
import { useHermesSessions } from './useHermesSessions';
import { useHermesProfiles } from './useHermesProfiles';
import { useHermesModels } from './useHermesModels';

/**
 * Facade for the Hermes chat workspace: owns the centralized chat reducer and
 * active-session orchestration (create/resume/send/prompt responses/drafts),
 * composing connection lifecycle (useHermesConnection) and session list
 * lifecycle (useHermesSessions). The returned shape is the public contract
 * consumed by ChatWorkspace.
 */
export function useHermesChat() {
  const [state, dispatch] = useReducer(
    chatReducer,
    undefined,
    createInitialChatState,
  );
  const [draft, setDraft] = useState('');

  // Profile selects a runtime instance (one runtime = one Hermes profile). The
  // map caches an instance per profile; only the active one is ever connected,
  // because the connection effect disconnects the previous runtime on swap.
  const [profileName, setProfileName] = useState(
    () => loadPanelState().hermesProfile || '',
  );
  const [pendingModel, setPendingModel] = useState(null);
  const pendingModelRef = useRef(null);
  useEffect(() => {
    pendingModelRef.current = pendingModel;
  }, [pendingModel]);
  const runtimesRef = useRef(new Map());
  const getRuntime = useCallback((profile) => {
    const key = profile || '';
    const cache = runtimesRef.current;
    if (!cache.has(key)) cache.set(key, createHermesRuntime({ profile: key }));
    return cache.get(key);
  }, []);
  const runtime = useMemo(
    () => getRuntime(profileName),
    [getRuntime, profileName],
  );
  const profile = runtime.descriptor.profile || '';

  const stateRef = useRef(state);
  const resumeSessionRef = useRef(null);
  const sessionGenRef = useRef(0);
  // Generation boundary for profile switches: every async continuation
  // captures the current profile generation and abandons work if it changed.
  const profileGenRef = useRef(0);
  const pendingResumeGenRef = useRef(null);
  const transcriptWriteTimer = useRef(null);
  const cacheStoreRef = useRef(null);

  const cacheStore = useCallback(() => {
    if (!cacheStoreRef.current) cacheStoreRef.current = getLocalStore();
    return cacheStoreRef.current;
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const sessionsApi = useHermesSessions({ runtime, cacheStore, profile });

  const handleConnectionState = useCallback((connectionState) => {
    dispatch({ type: 'connection', payload: connectionState });
  }, []);

  const handleGatewayEvent = useCallback(
    (event) => {
      dispatch({ type: 'event', payload: event });
      // Write-through: snapshot the transcript when a turn completes
      // (debounced — streaming deltas never hit the cache).
      if (event?.params?.type === 'message.complete') {
        if (transcriptWriteTimer.current)
          clearTimeout(transcriptWriteTimer.current);
        transcriptWriteTimer.current = setTimeout(() => {
          transcriptWriteTimer.current = null;
          const current = stateRef.current;
          if (current.storedSessionId && current.messages.length > 0) {
            // Only canonical REST-origin rows may be persisted; live WS rows
            // are ephemeral and lack stable DB ids.
            const canonical = current.messages.filter(
              (message) => !message.provisional,
            );
            if (canonical.length > 0) {
              writeTranscript(
                cacheStore(),
                current.storedSessionId,
                {
                  messages: canonical,
                  title: current.title,
                },
                { profile },
              );
            }
          }
        }, 2000);
      }
    },
    [cacheStore, profile],
  );

  const getSessionSnapshot = useCallback(
    () => ({
      storedSessionId: stateRef.current.storedSessionId,
      running: stateRef.current.running,
    }),
    [],
  );

  // After (re)connect: refresh the profile-scoped list, and if a profile switch
  // is pending, reopen that profile's most recent session (or stay in new-chat).
  const refreshSessions = sessionsApi.refreshSessions;
  const handleConnected = useCallback(async () => {
    await refreshSessions();
    const gen = pendingResumeGenRef.current;
    if (gen == null || gen !== profileGenRef.current) return;
    pendingResumeGenRef.current = null;
    try {
      const list = await runtime.sessions.list({ limit: 50, order: 'recent' });
      if (profileGenRef.current !== gen) return;
      const recent = (list.sessions || [])[0];
      const id = recent?.session_id || recent?.id;
      if (id) await resumeSessionRef.current?.(id);
    } catch {
      // most-recent reopen is best-effort; new-chat state remains
    }
  }, [refreshSessions, runtime]);

  const connection = useHermesConnection({
    runtime,
    cacheStore,
    onConnectionState: handleConnectionState,
    onEvent: handleGatewayEvent,
    getSnapshot: getSessionSnapshot,
    resumeSessionRef,
    onConnected: handleConnected,
  });
  const { bootstrapError: connectionBootstrapError, ensureConnected } =
    connection;
  const {
    sessions,
    sessionsLoading,
    sessionsError,
    query,
    setQuery,
    renameSession: renameSessionInList,
    removeSession: removeSessionFromList,
  } = sessionsApi;

  const createSession = useCallback(async () => {
    await ensureConnected();
    const pending = pendingModelRef.current;
    const result = await runtime.sessions.create({
      source: 'personaldash',
      ...(pending?.id
        ? {
            model: pending.id,
            ...(pending.provider ? { provider: pending.provider } : {}),
          }
        : {}),
    });
    dispatch({
      type: 'session.bound',
      payload: {
        liveSessionId: result.session_id,
        storedSessionId: result.stored_session_id || result.session_id,
        title: result.info?.title || 'New chat',
        model: result.info?.model,
      },
    });
    dispatch({ type: 'history.loaded', payload: { messages: [] } });
    setDraft(loadDraft('new'));
    // The pending choice is now applied and confirmed by session.bound; drop it.
    if (pending?.id) setPendingModel(null);
    await refreshSessions();
    return result;
  }, [ensureConnected, refreshSessions, runtime, setPendingModel]);

  // Rehydrate prompts the client missed while detached: `session.resume`
  // replays `pending_approval` / `pending_clarify` so an agent parked on a
  // confirmation is never left with no visible card. Must run AFTER
  // `history.loaded`, which clears prompt state.
  const dispatchPendingPrompts = useCallback((result) => {
    const approval = result?.pending_approval;
    const clarify = result?.pending_clarify;
    if (!approval && !clarify) return;
    dispatch({
      type: 'prompt.pending',
      payload: { approval: approval || null, clarify: clarify || null },
    });
  }, []);

  const resumeSession = useCallback(
    async (sessionId, { afterDisconnect = false } = {}) => {
      const gen = ++sessionGenRef.current;
      const pgen = profileGenRef.current;
      const isCurrent = () =>
        gen === sessionGenRef.current && pgen === profileGenRef.current;
      const openedAt = Date.now();
      let warm = false;

      // Local-first: render the cached snapshot before any network roundtrip.
      const cached = await readTranscript(cacheStore(), sessionId, profile);
      if (cached && isCurrent()) {
        warm = true;
        dispatch({
          type: 'history.loaded',
          payload: {
            messages: cached.messages,
            title: cached.title,
            fromCache: true,
          },
        });
        markSync(cacheStore(), 'agent-open', {
          warm: true,
          openMs: Date.now() - openedAt,
        });
      }

      await ensureConnected();
      if (!isCurrent()) return null;

      // Resolve to the live session tip (compression continuations branch the
      // id). resolveResumeTarget refuses delegate/branch/reset children, which
      // the REST latest-descendant endpoint does not filter — resuming one of
      // those renders the sub-agent's internal transcript and poisons the
      // parent's transcript cache via aliasing.
      const targetId = await resolveResumeTarget(sessionId, {
        getLatestDescendant: runtime.sessions.getLatestDescendant,
        getSession: runtime.sessions.get,
      });
      if (!isCurrent()) return null;

      // Bind the live session via WS. The RPC history projection lacks DB ids,
      // so we ignore result.messages here and fetch authoritative REST rows.
      const result = await runtime.sessions.resume(targetId);
      if (!isCurrent()) return null;

      const liveSessionId = result.session_id || targetId;
      const storedSessionId =
        result.stored_session_id || result.info?.stored_session_id || targetId;
      const title = result.info?.title || result.title || cached?.title || '';

      dispatch({
        type: 'session.bound',
        payload: {
          liveSessionId,
          storedSessionId,
          title,
          model: result.info?.model,
        },
      });

      // One-shot usage snapshot: the ~1/s ticker only runs mid-turn, so a
      // resumed session would otherwise show nothing until the next prompt.
      // The result also seeds the baseline so live deltas stack on top of the
      // cold REST row instead of double-counting (or masking) history.
      runtime.sessions
        .usage(liveSessionId)
        .then((usage) => {
          if (!isCurrent()) return;
          dispatch({ type: 'usage.baseline', payload: usage });
          dispatch({ type: 'usage.set', payload: usage });
        })
        .catch(() => {});

      // Fetch cheap metadata, then use the integer message id cursor to decide
      // whether we can skip transfer, append a tail, or need a full replace.
      let sessionRow;
      try {
        sessionRow = await runtime.sessions.get(storedSessionId);
      } catch {
        sessionRow = null;
      }
      if (!isCurrent()) return null;
      // Cold stats: the REST row carries lifetime token/cost/count columns
      // the live usage ticker never reports (resumed + ended sessions).
      dispatch({ type: 'stats.cold', payload: sessionRow });

      const reconciliation = await reconcileTranscript({
        cached,
        sessionRow,
        storedSessionId,
        rpcMessages: result.messages,
        isCurrent,
        fetchMessages: runtime.sessions.getMessages,
      });
      if (!isCurrent()) return null;
      if (reconciliation.status === 'rpc-fallback') {
        dispatch({
          type: 'history.loaded',
          payload: {
            messages: reconciliation.messages,
            title,
            provisional: true,
          },
        });
        dispatchPendingPrompts(result);
        return result;
      }

      const { messages, cursor, mode: syncMode } = reconciliation;

      dispatch({
        type: 'history.loaded',
        payload: {
          messages,
          title,
          storedSessionId,
        },
      });
      dispatchPendingPrompts(result);

      // Authoritative snapshot replaces cache; alias under every id so the next
      // open finds it regardless of which id the sidebar supplied.
      await writeTranscript(
        cacheStore(),
        storedSessionId,
        {
          messages,
          title,
          canonicalCount: cursor.canonicalCount,
          messageCount: cursor.messageCount,
          lastMessageId: cursor.lastMessageId,
          lastActivityAt: cursor.lastActivityAt,
        },
        { aliases: [sessionId, targetId, liveSessionId], profile },
      );
      markSync(cacheStore(), 'agent-open', {
        warm,
        openMs: warm ? undefined : Date.now() - openedAt,
        reconcileMs: Date.now() - openedAt,
        mode: syncMode,
      });

      if (afterDisconnect) {
        dispatch({ type: 'mark.interrupted' });
      }

      setDraft(loadDraft(storedSessionId));
      await refreshSessions();
      return result;
    },
    [
      cacheStore,
      dispatchPendingPrompts,
      ensureConnected,
      profile,
      refreshSessions,
      runtime,
    ],
  );

  useEffect(() => {
    resumeSessionRef.current = resumeSession;
  }, [resumeSession]);

  useEffect(
    () => () => {
      if (transcriptWriteTimer.current)
        clearTimeout(transcriptWriteTimer.current);
    },
    [],
  );

  const sendMessage = useCallback(
    async (text, attachments = []) => {
      const trimmed = String(text || '').trim();
      if (!trimmed && attachments.length === 0) return;

      await ensureConnected();
      let liveSessionId = stateRef.current.liveSessionId;
      let storedSessionId = stateRef.current.storedSessionId;

      if (!liveSessionId) {
        const created = await createSession();
        liveSessionId = created.session_id;
        storedSessionId = created.stored_session_id || created.session_id;
      }

      const images = attachments.filter((file) =>
        String(file.type || '').startsWith('image/'),
      );

      const { extractedBlocks, attachmentErrors } = await prepareAttachments(
        attachments,
        {
          attachImage: (image) =>
            runtime.prompt.attachImage(liveSessionId, image),
        },
      );

      if (attachmentErrors.length > 0) {
        dispatch({
          type: 'error',
          payload: {
            message: `Message not sent — could not read attachment${attachmentErrors.length > 1 ? 's' : ''}: ${attachmentErrors.join('; ')}`,
          },
        });
        throw Object.assign(new Error('attachment send aborted'), {
          code: 'ATTACHMENT_ABORT',
        });
      }

      dispatch({
        type: 'user.message',
        payload: {
          text: trimmed,
          attachments: attachments.map((file) => ({
            name: file.name,
            type: file.type,
            size: file.size,
          })),
        },
      });

      saveDraft(storedSessionId || 'new', '');
      setDraft('');

      await runtime.prompt.submit(
        liveSessionId,
        trimmed + extractedBlocks.join('') ||
          (images.length > 0 ? '(attached image)' : '(attached file)'),
      );
      await refreshSessions();
    },
    [createSession, ensureConnected, refreshSessions, runtime],
  );

  const stop = useCallback(async () => {
    const liveSessionId = stateRef.current.liveSessionId;
    if (!liveSessionId || runtime.connectionState !== 'open') return;
    await runtime.sessions.interrupt(liveSessionId);
  }, [runtime]);

  // A live-voice delegation: the bubble and the persisted row are what the
  // user said; the recent spoken exchange rides the model input only (the
  // gateway prepends the voice-live turn note, never the system prompt).
  const sendLiveTurn = useCallback(
    async (text, voiceContext = '') => {
      const trimmed = String(text || '').trim();
      if (!trimmed) return;

      await ensureConnected();
      let liveSessionId = stateRef.current.liveSessionId;

      if (!liveSessionId) {
        const created = await createSession();
        liveSessionId = created.session_id;
      }

      dispatch({
        type: 'user.message',
        payload: { text: trimmed, attachments: [] },
      });

      await runtime.prompt.submit(liveSessionId, trimmed, {
        surface: 'voice-live',
        voice_context: String(voiceContext || '').slice(0, 6000),
      });
      await refreshSessions();
    },
    [createSession, ensureConnected, refreshSessions, runtime],
  );

  const respondApproval = useCallback(
    async (choice) => {
      const liveSessionId = stateRef.current.liveSessionId;
      if (!liveSessionId) return;
      await runtime.prompt.respondApproval(liveSessionId, choice);
      dispatch({ type: 'clear.prompt' });
    },
    [runtime],
  );

  const respondClarify = useCallback(
    async (answer, questionId) => {
      const liveSessionId = stateRef.current.liveSessionId;
      const clarify = stateRef.current.clarify;
      const requestId = clarify?.request_id;
      if (!liveSessionId || !requestId) return;

      const result = await runtime.prompt.respondClarify(
        liveSessionId,
        requestId,
        answer,
        questionId,
      );

      if (questionId && clarify?.batch) {
        // Per-question lock: mark answered, keep the card until the batch
        // resolves (server reports an empty `remaining`).
        dispatch({
          type: 'clarify.answer',
          payload: { questionId, answer },
        });
        const remaining = result?.remaining;
        const allAnswered = Array.isArray(remaining)
          ? remaining.length === 0
          : (clarify.questions || []).every(
              (question) =>
                question.answered || question.qid === String(questionId),
            );
        if (allAnswered) dispatch({ type: 'clear.prompt' });
      } else {
        dispatch({ type: 'clear.prompt' });
      }
      return result;
    },
    [runtime],
  );

  const respondSecret = useCallback(
    async (kind, value) => {
      const liveSessionId = stateRef.current.liveSessionId;
      const promptState = stateRef.current[kind];
      if (!liveSessionId || !promptState?.request_id) return;
      await runtime.prompt.respondSecret(
        liveSessionId,
        kind,
        promptState.request_id,
        value,
      );
      dispatch({ type: 'clear.prompt' });
    },
    [runtime],
  );

  const renameSession = useCallback(
    async (sessionId, title) => {
      await renameSessionInList(sessionId, title);
      if (
        stateRef.current.storedSessionId === sessionId ||
        stateRef.current.liveSessionId === sessionId
      ) {
        dispatch({
          type: 'session.bound',
          payload: {
            liveSessionId: stateRef.current.liveSessionId,
            storedSessionId: stateRef.current.storedSessionId,
            title,
            model: stateRef.current.model,
          },
        });
      }
    },
    [renameSessionInList],
  );

  const removeSession = useCallback(
    async (sessionId) => {
      await removeSessionFromList(sessionId);
      if (
        stateRef.current.storedSessionId === sessionId ||
        stateRef.current.liveSessionId === sessionId
      ) {
        dispatch({ type: 'reset.session' });
        setDraft(loadDraft('new'));
      }
    },
    [removeSessionFromList],
  );

  const updateDraft = useCallback((value) => {
    setDraft(value);
    saveDraft(stateRef.current.storedSessionId || 'new', value);
  }, []);

  // Profile switch is a generation boundary: bump the generation, clear the
  // active session + pending model synchronously (before the swapped runtime's
  // events can land), then let the connection effect reconnect and reopen the
  // new profile's most recent session.
  const selectProfile = useCallback(
    (name) => {
      const next = name || '';
      if (next === profileName) return;
      const gen = ++profileGenRef.current;
      pendingResumeGenRef.current = gen;
      dispatch({ type: 'reset.session' });
      setPendingModel(null);
      setDraft(loadDraft('new'));
      setProfileName(next);
      savePanelState({ ...loadPanelState(), hermesProfile: next });
    },
    [profileName],
  );

  const profilesApi = useHermesProfiles({
    runtime,
    ready: state.connectionState === 'open',
  });

  const handleModelError = useCallback((error) => {
    dispatch({
      type: 'error',
      payload: { message: error?.message || 'Model operation failed' },
    });
  }, []);

  const modelsApi = useHermesModels({
    runtime,
    currentModel: state.model,
    sessionId: state.liveSessionId,
    ready: state.connectionState === 'open',
    pendingModel,
    setPendingModel,
    onError: handleModelError,
  });

  return {
    state,
    sessions: sessionsApi.sessions,
    sessionsLoading: sessionsApi.sessionsLoading,
    sessionsError: sessionsApi.sessionsError,
    pinnedIds: sessionsApi.pinnedIds,
    togglePin: sessionsApi.togglePin,
    searching: sessionsApi.searching,
    bootstrapError: connectionBootstrapError,
    draft,
    query: sessionsApi.query,
    setQuery: sessionsApi.setQuery,
    updateDraft,
    refreshSessions: sessionsApi.refreshSessions,
    createSession,
    resumeSession,
    sendMessage,
    sendLiveTurn,
    stop,
    respondApproval,
    respondClarify,
    respondSecret,
    renameSession,
    removeSession,
    runtime,
    profile,
    profiles: profilesApi.profiles,
    profilesLoading: profilesApi.loading,
    selectProfile,
    pendingModel,
    models: modelsApi.models,
    currentModel: modelsApi.currentModel,
    currentTier: modelsApi.currentTier,
    modelsLoading: modelsApi.loading,
    modelSwitching: modelsApi.switching,
    switchModel: modelsApi.switchModel,
  };
}
