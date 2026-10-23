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
  createOverrideCandidates,
  isCreateOverrideRejection,
  mirrorRefusedSwitch,
  modelSwitchValue,
} from '@/lib/hermes/modelSwitch';
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

  // Whether a turn has completed on the current session since it was bound.
  // The gateway's config.set model path (fast switch) is only reliable after
  // the session's agent has survived a turn — before that it resolves but is
  // silently dropped by the later agent build (useHermesModels routes around
  // this with the slower slash path; see lib/hermes/modelSwitch.js).
  const [turnRanSinceBind, setTurnRanSinceBind] = useState(false);
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !state.running) setTurnRanSinceBind(true);
    wasRunningRef.current = state.running;
  }, [state.running]);
  const resetTurnRanSinceBind = useCallback(() => {
    wasRunningRef.current = false;
    setTurnRanSinceBind(false);
  }, []);
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
  // True while a session switch (resume/create) is in flight: sendMessage and
  // sendLiveTurn refuse to run, and the composer is disabled, so a typed
  // message can never land in the session being left.
  const switchingRef = useRef(false);
  // Default model for sessions created without an explicit picker choice: the
  // fast tier (resolved in useHermesModels below). Ref because createSession
  // is defined before that hook runs; synced via effect.
  const defaultModelRef = useRef(null);
  // Stable settle handle for sends: resolves when an in-flight model switch
  // finishes, so a submitted turn always runs on the picked model. Declared
  // with the other refs; synced from modelsApi via effect below.
  const settleModelSwitchRef = useRef(null);
  // True while the model catalog / tier registry is still loading. createSession
  // waits (bounded) on this so a fresh page's first message deterministically
  // gets the fast default instead of silently staying on the profile default.
  const modelsLoadingRef = useRef(true);
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

  const getActiveSessionIds = useCallback(() => {
    const current = stateRef.current;
    return [current.liveSessionId, current.storedSessionId];
  }, []);

  const sessionsApi = useHermesSessions({
    runtime,
    cacheStore,
    profile,
    getActiveSessionIds,
  });

  const handleConnectionState = useCallback((connectionState) => {
    dispatch({ type: 'connection', payload: connectionState });
  }, []);

  const handleGatewayEvent = useCallback(
    (event) => {
      dispatch({ type: 'event', payload: event });
      // Write-through: snapshot the transcript when a turn completes
      // (debounced — streaming deltas never hit the cache). Gateway events
      // arrive as {type, payload, session_id} (frame.params) — there is no
      // `.params` on the dispatched shape; gate on the open session so another
      // session's completion can't snapshot this view mid-turn.
      if (
        event?.type === 'message.complete' &&
        (!event.session_id ||
          !stateRef.current.liveSessionId ||
          event.session_id === stateRef.current.liveSessionId)
      ) {
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
    // Creation is a generation boundary: invalidate any in-flight resume/create
    // continuation so a stale session.bound can never land after this bind.
    const gen = ++sessionGenRef.current;
    const previousLiveSessionId = stateRef.current.liveSessionId;
    switchingRef.current = true;
    dispatch({
      type: 'session.switching',
      payload: { previousLiveSessionId },
    });
    try {
      await ensureConnected();
      if (gen !== sessionGenRef.current) return null;
      // Explicit picker choice wins; otherwise the chat default (fast tier).
      // Fresh page → first message can race the catalog/tier load; without a
      // resolved default no post-bind switch runs and the chat silently stays
      // on the profile default. Wait briefly for the catalog to settle; if it
      // never does (e.g. the tier fetch failed), proceed rather than block.
      if (!pendingModelRef.current) {
        const deadline = Date.now() + 2500;
        while (
          !defaultModelRef.current &&
          modelsLoadingRef.current &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (gen !== sessionGenRef.current) return null;
        }
      }
      // Falls back to the Hermes profile default when neither is resolved yet.
      const pending = pendingModelRef.current || defaultModelRef.current;
      // Preferred path: pass the model+provider straight into session.create —
      // instant, and the agent builds ON the picked model (no post-bind switch
      // window at all). The create path validates the pair against its curated
      // per-provider catalogs, which differ from the picker's credential-pool
      // groups, so try the model's providers in preference order (openai-codex
      // ahead of the profile's LiteLLM slot for the OpenAI family) until one
      // is accepted; only a catalog rejection falls through to the next.
      const candidates = createOverrideCandidates(pending);
      let result = null;
      for (const candidate of candidates) {
        try {
          result = await runtime.sessions.create({
            source: 'personaldash',
            model: candidate.id,
            provider: candidate.provider,
          });
          break;
        } catch (error) {
          if (!isCreateOverrideRejection(error)) throw error;
        }
      }
      if (!result) {
        result = await runtime.sessions.create({ source: 'personaldash' });
      }
      if (gen !== sessionGenRef.current) return null;
      resetTurnRanSinceBind();
      dispatch({
        type: 'session.bound',
        payload: {
          liveSessionId: result.session_id,
          storedSessionId: result.stored_session_id || result.session_id,
          title: result.info?.title || 'New chat',
          model: result.info?.model,
        },
      });
      // Fallback path (create-override rejected or no attributed provider):
      // apply the pick as a session-scoped /model switch after the bind. The
      // slash mirror accepts pairs the create catalog rejects and the gateway
      // resolves the true serving provider at inference. Both serving paths
      // for the fast default are honest — `openai-codex` (ChatGPT Codex
      // backend) and `alibaba` (credential slot repurposed to the local
      // LiteLLM gateway, which routes luna to OpenAI) both serve gpt-6-luna
      // as gpt-6-luna (verified via session_model_usage 10-21) — so
      // attribution drift between them is harmless. A non-empty warning means
      // the live mirror did NOT apply (busy session) — surfaced, not swallowed.
      if (pending?.id && result.info?.model !== pending.id) {
        try {
          // Preferred provider first — NOT whichever attribution happened to
          // be current: the slash mirror accepts any listed pair (including
          // the LiteLLM slot), so the preference, not validation, picks the
          // serving path here.
          const switched = await runtime.commands.exec({
            sessionId: result.session_id,
            command: `/model ${modelSwitchValue(
              pending.id,
              candidates[0]?.provider,
            )}`,
          });
          if (mirrorRefusedSwitch(switched?.warning)) {
            throw new Error(String(switched.warning).trim());
          }
        } catch (error) {
          // The bound model is already reflected and the session stays usable,
          // but it is now on the profile default instead of the requested
          // model — that mismatch must be visible, not silently swallowed
          // (a swallowed failure looked like "the default model loaded wrong").
          dispatch({
            type: 'error',
            payload: {
              message: `Model switch failed (${
                error?.message || error
              }) — chat stays on the profile default.`,
            },
          });
        }
      }
      dispatch({ type: 'history.loaded', payload: { messages: [] } });
      setDraft(loadDraft('new'));
      // The pending choice is now applied and confirmed by session.bound; drop it.
      if (pendingModelRef.current?.id) setPendingModel(null);
      await refreshSessions();
      return result;
    } finally {
      // A newer switch owns the flag; only the current generation releases it.
      if (gen === sessionGenRef.current) switchingRef.current = false;
    }
  }, [
    ensureConnected,
    refreshSessions,
    resetTurnRanSinceBind,
    runtime,
    setPendingModel,
  ]);

  // Rehydrate prompts the client missed while detached. `session.resume`
  // returns the open server→client requests (`open_requests`, answerable in
  // place) plus the legacy `pending_approval` / `pending_clarify` snapshots
  // (answerable via the `approval.respond` RPC only). Prefer the live srq
  // frames; fall back to the snapshots only for kinds no srq request covers.
  // Must run AFTER `history.loaded`, which clears prompt state.
  const dispatchPendingPrompts = useCallback((result, liveSessionId) => {
    const openRequests = Array.isArray(result?.open_requests)
      ? result.open_requests
      : [];
    const kindOf = (method) =>
      method === 'approval'
        ? 'approval'
        : method === 'clarify'
          ? 'clarify'
          : method === 'sudo'
            ? 'sudo'
            : method === 'secret'
              ? 'secret'
              : null;
    const covered = new Set();
    for (const request of openRequests) {
      if (!kindOf(request?.method)) continue;
      if (request?.params?.session_id !== liveSessionId) continue;
      covered.add(request.method);
      dispatch({
        type: 'serverRequest.prompt',
        payload: {
          request: {
            id: request.id,
            method: request.method,
            params: request.params || {},
          },
        },
      });
    }
    const approval = result?.pending_approval;
    const clarify = result?.pending_clarify;
    if (!approval && !clarify) return;
    dispatch({
      type: 'prompt.pending',
      payload: {
        approval: approval && !covered.has('approval') ? approval : null,
        clarify: clarify && !covered.has('clarify') ? clarify : null,
      },
    });
  }, []);

  // Protocol-v7 blocking prompts arrive as server→client JSON-RPC requests
  // (`approval`, `clarify`, `sudo`, `secret`). Claim only the ones belonging
  // to the open session (another attached client, e.g. the Hermes dashboard,
  // owns the rest); the user answers later through the card via
  // answerServerRequest. Unhandled methods MUST stay unclaimed (`undefined`):
  // an error reply (-32601) settles the request for EVERY attached client,
  // which once turned a `vault.save_login` prompt into an instant
  // `save_declined` before the dashboard could show it (2026-10-08). When
  // WorkDash is the only client, an unhandled prompt then waits out its
  // backend deadline — the acceptable cost of never stealing another surface's
  // prompt.
  useEffect(() => {
    const PROMPT_METHODS = new Set(['approval', 'clarify', 'sudo', 'secret']);
    return runtime.onServerRequest(({ id, method, params }) => {
      if (!PROMPT_METHODS.has(method)) return undefined;
      if (!stateRef.current.liveSessionId) return undefined;
      if (params?.session_id !== stateRef.current.liveSessionId) {
        return undefined;
      }
      dispatch({
        type: 'serverRequest.prompt',
        payload: { request: { id, method, params: params || {} } },
      });
      return undefined;
    });
  }, [runtime]);

  const resumeSession = useCallback(
    async (sessionId, { afterDisconnect = false } = {}) => {
      const gen = ++sessionGenRef.current;
      const pgen = profileGenRef.current;
      const isCurrent = () =>
        gen === sessionGenRef.current && pgen === profileGenRef.current;
      const openedAt = Date.now();
      let warm = false;
      let cached = null;
      const previous = {
        liveSessionId: stateRef.current.liveSessionId,
        storedSessionId: stateRef.current.storedSessionId,
        title: stateRef.current.title,
        model: stateRef.current.model,
      };

      // Session switch boundary: clear the previous session's transcript and
      // transient state up front (the warm-cache read below repaints within a
      // tick) so nothing from it can render or be sent while this switch
      // resolves. switchingRef blocks sends until the bind completes. The
      // pending pre-session model pick dies here too: it belonged to the
      // abandoned new chat, and surviving a resume would make the picker lie
      // about this session and silently hijack the next createSession.
      switchingRef.current = true;
      setPendingModel(null);
      resetTurnRanSinceBind();
      dispatch({
        type: 'session.switching',
        payload: { previousLiveSessionId: previous.liveSessionId },
      });
      try {
        // Local-first: render the cached snapshot before any network roundtrip.
        cached = await readTranscript(cacheStore(), sessionId, profile);
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
          result.stored_session_id ||
          result.info?.stored_session_id ||
          targetId;
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
          dispatchPendingPrompts(result, liveSessionId);
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
        dispatchPendingPrompts(result, liveSessionId);

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
      } catch (error) {
        if (isCurrent()) {
          // Restore the prior view (previous binding + cached transcript) so a
          // failed open doesn't strand an empty, send-locked chat.
          dispatch({
            type: 'session.bound',
            payload: previous.liveSessionId
              ? previous
              : { liveSessionId: null, storedSessionId: null },
          });
          dispatch({
            type: 'history.loaded',
            payload: {
              messages: cached?.messages || [],
              title: previous.title,
            },
          });
          dispatch({
            type: 'error',
            payload: {
              message: `Could not open session — ${error?.message || error}`,
            },
          });
        }
        throw error;
      } finally {
        // A newer switch owns the flag; only the current generation releases it.
        if (isCurrent()) switchingRef.current = false;
      }
    },
    [
      cacheStore,
      dispatchPendingPrompts,
      ensureConnected,
      profile,
      refreshSessions,
      resetTurnRanSinceBind,
      runtime,
      setPendingModel,
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
      // A session switch is in flight (composer is disabled): never let a
      // message land in the session being left.
      if (switchingRef.current) return;

      await ensureConnected();
      let liveSessionId = stateRef.current.liveSessionId;
      let storedSessionId = stateRef.current.storedSessionId;

      if (!liveSessionId) {
        const created = await createSession();
        if (!created) return; // superseded by a newer switch mid-create
        liveSessionId = created.session_id;
        storedSessionId = created.stored_session_id || created.session_id;
      }
      // A model pick still switching (the first slash path forks an ~8s
      // worker): wait it out, or the gateway refuses the live mirror
      // ("session busy") and the turn runs on the OLD model while the label
      // shows the new one — exactly the "reverts when I send" symptom.
      await settleModelSwitchRef.current?.();

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
      // Same switch guard as sendMessage: never delegate into the session
      // being left.
      if (switchingRef.current) return;

      await ensureConnected();
      let liveSessionId = stateRef.current.liveSessionId;

      if (!liveSessionId) {
        const created = await createSession();
        if (!created) return; // superseded by a newer switch mid-create
        liveSessionId = created.session_id;
      }
      // Same contract as sendMessage: never submit while a model switch is
      // still being applied.
      await settleModelSwitchRef.current?.();

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
      const approval = stateRef.current.approval;
      if (approval?.srq_id) {
        // Protocol-v7 path: answer the open server→client request frame.
        if (!runtime.answerServerRequest(approval.srq_id, { choice })) {
          dispatch({
            type: 'error',
            payload: { message: 'Gateway disconnected — approval not sent' },
          });
          return;
        }
      } else {
        // Replay fallback: only the queue snapshot exists, no live request.
        await runtime.prompt.respondApproval(liveSessionId, choice);
      }
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

      if (clarify?.srq_id) {
        // Protocol-v7 path: answers ride the request frame; per-question
        // state updates in place until the last answer closes the request
        // with the full map (ClarifyResult.answers).
        if (clarify.batch && Array.isArray(clarify.questions)) {
          const questions = clarify.questions.map((question) =>
            question.qid === String(questionId)
              ? { ...question, answered: true, answer }
              : question,
          );
          dispatch({
            type: 'clarify.answer',
            payload: { questionId, answer },
          });
          if (questions.every((question) => question.answered)) {
            const answers = Object.fromEntries(
              questions.map((question) => [question.qid, question.answer]),
            );
            if (!runtime.answerServerRequest(clarify.srq_id, { answers })) {
              dispatch({
                type: 'error',
                payload: {
                  message: 'Gateway disconnected — clarify answers not sent',
                },
              });
              return undefined;
            }
            dispatch({ type: 'clear.prompt' });
          }
          return { remaining: [] };
        }
        // Single-question shape (not produced by current gateway builds, kept
        // for replay robustness): one answer closes the request.
        if (
          !runtime.answerServerRequest(clarify.srq_id, {
            answers: { [String(questionId || requestId)]: answer },
          })
        ) {
          dispatch({
            type: 'error',
            payload: {
              message: 'Gateway disconnected — clarify answer not sent',
            },
          });
          return undefined;
        }
        dispatch({ type: 'clear.prompt' });
        return { remaining: [] };
      }

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
      if (promptState?.srq_id) {
        // Protocol-v7 path: the masked value rides the request frame.
        if (!runtime.answerServerRequest(promptState.srq_id, { value })) {
          dispatch({
            type: 'error',
            payload: { message: 'Gateway disconnected — value not sent' },
          });
          return;
        }
      } else {
        await runtime.prompt.respondSecret(
          liveSessionId,
          kind,
          promptState.request_id,
          value,
        );
      }
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
    sessionRunning: state.running,
    turnRanSinceBind,
    onError: handleModelError,
  });

  useEffect(() => {
    defaultModelRef.current = modelsApi.defaultModel;
  }, [modelsApi.defaultModel]);

  useEffect(() => {
    settleModelSwitchRef.current = modelsApi.settlePendingSwitch;
  }, [modelsApi.settlePendingSwitch]);

  useEffect(() => {
    modelsLoadingRef.current = modelsApi.loading;
  }, [modelsApi.loading]);

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
    defaultModel: modelsApi.defaultModel,
    modelsLoading: modelsApi.loading,
    modelSwitching: modelsApi.switching,
    switchModel: modelsApi.switchModel,
  };
}
