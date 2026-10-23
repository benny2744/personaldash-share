'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeModelOptions } from '@/lib/hermes/modelOptions';
import { buildTierCatalog, tierForModel } from '@/lib/hermes/tierModels';
import {
  mirrorRefusedSwitch,
  modelSwitchValue,
  shouldFastSwitch,
} from '@/lib/hermes/modelSwitch';
import { fetchLlmTiers } from '@/lib/hermes/api';

/**
 * Model catalog + switching for the composer picker, driven by the LLM tier
 * registry (cheap / fast / balanced / …).
 *
 * The effective model is NEVER owned here — it is the canonical `state.model`
 * fed by `session.bound`/`session.info` and passed in as `currentModel`, so the
 * picker reflects every real change (dropdown switch, `/model` typed in the
 * composer, resume, reconnect, future agent routing) without a second source of
 * truth. Each tier resolves to a model that is also switchable via Hermes; a
 * pick dispatches `/model <id> --provider <slug>` (slash.exec → session.info).
 * Before a session exists, the choice parks as `pendingModel` and is applied at
 * `session.create` (see the facade), then confirmed by `session.bound`. A
 * mid-session pick is shown optimistically (display-only) until session.info
 * confirms it, so the trigger label never waits out the slash roundtrip.
 *
 * @param {{
 *   runtime: object,
 *   currentModel: string,
 *   sessionId?: string | null,
 *   ready?: boolean,
 *   pendingModel?: { id: string, provider?: string, label?: string } | null,
 *   setPendingModel: (next: { id: string, provider?: string, label?: string } | null) => void,
 *   sessionRunning?: boolean,
 *   turnRanSinceBind?: boolean,
 *   onError?: (error: Error) => void,
 * }} args
 */
export function useHermesModels({
  runtime,
  currentModel,
  sessionId = null,
  ready = false,
  pendingModel = null,
  setPendingModel,
  sessionRunning = false,
  turnRanSinceBind = false,
  onError,
}) {
  const [raw, setRaw] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  // Optimistic mid-session switch display: shown immediately on pick, then
  // reconciled — cleared once the canonical model (session.info) confirms it,
  // on failure, or after a safety timeout. The slash roundtrip plus
  // session.info re-emission normally lands within a second or two; the
  // timeout only guards a silent gateway so the label can never stick.
  const [optimistic, setOptimistic] = useState(null);
  const [tiers, setTiers] = useState(null);
  const loadedFor = useRef(null);
  // The in-flight mid-session switch, so a send typed while a slow (first-use
  // slash-worker ~8s) switch is still running waits for it instead of racing
  // it — a prompt submitted mid-switch makes the gateway refuse the live
  // mirror ("session busy") and the turn runs on the OLD model.
  const pendingSwitchRef = useRef(null);

  useEffect(() => {
    if (!optimistic) return undefined;
    if (currentModel === optimistic.id) {
      setOptimistic(null);
      return undefined;
    }
    // A deferred switch (picked mid-turn; the gateway applies it at the next
    // turn start) has no completion signal before session.info catches up —
    // holding the label IS the truth there, so no safety timer.
    if (optimistic.deferred) return undefined;
    const timer = setTimeout(() => setOptimistic(null), 10000);
    return () => clearTimeout(timer);
  }, [currentModel, optimistic]);

  // A session switch invalidates the pick instantly — the optimistic label
  // belonged to the session being left, never to the one being opened.
  const optimisticForRef = useRef(sessionId);
  useEffect(() => {
    if (optimisticForRef.current !== sessionId) {
      optimisticForRef.current = sessionId;
      setOptimistic(null);
    }
  }, [sessionId]);

  // Tier registry (same-origin app route). Independent of the Hermes WS.
  useEffect(() => {
    let alive = true;
    fetchLlmTiers()
      .then((rows) => {
        if (alive) setTiers(rows);
      })
      .catch(() => {
        if (alive) setTiers([]); // buildTierCatalog falls back to raw catalog
      });
    return () => {
      alive = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const result = await runtime.models.options();
      setRaw(result);
      loadedFor.current = runtime;
    } catch (error) {
      onError?.(error);
    } finally {
      setCatalogLoading(false);
    }
  }, [onError, runtime]);

  useEffect(() => {
    if (ready && loadedFor.current !== runtime) {
      reload();
    }
  }, [ready, reload, runtime]);

  const models = useMemo(
    () => buildTierCatalog(tiers || [], normalizeModelOptions(raw)),
    [raw, tiers],
  );

  // Friendly label for the trigger: the tier backing the canonical model, if any.
  const currentTier = useMemo(
    () => tierForModel(tiers || [], currentModel),
    [tiers, currentModel],
  );

  // Display values: the optimistic pick wins until the canonical model
  // confirms (or the pick fails / times out). The tier label resolves through
  // the same registry, so picking "fast" shows "fast" instantly.
  const displayModel = optimistic?.id || currentModel;
  const displayTier = optimistic
    ? tierForModel(tiers || [], optimistic.id) || optimistic.label || null
    : currentTier;

  // The model sessions default to when the user hasn't picked one: the chat
  // default tier (fast), resolved through the same catalog the picker uses so
  // provider attribution matches a manual pick. Null until the tier registry
  // and catalog load — createSession then falls back to the profile default.
  const defaultModel = useMemo(() => {
    const tiersGroup = models.groups?.find((group) => group.slug === 'tier');
    return tiersGroup?.models.find((model) => model.tier === 'fast') || null;
  }, [models]);

  const loading = catalogLoading || tiers === null;

  // Resolves when any in-flight mid-session switch settles (success or
  // failure). sendMessage/sendLiveTurn await this so a turn can never be
  // submitted while the gateway still refuses live model mirrors.
  const settlePendingSwitch = useCallback(async () => {
    const pending = pendingSwitchRef.current;
    if (pending) await pending;
  }, []);

  const switchModel = useCallback(
    (model) => {
      const modelId = typeof model === 'string' ? model : model?.id;
      if (!modelId) return;
      const provider = typeof model === 'string' ? undefined : model?.provider;
      if (!sessionId) {
        // No live session yet: remember the choice, applied at create time.
        setPendingModel({
          id: modelId,
          provider,
          label: typeof model === 'string' ? undefined : model?.label,
        });
        return;
      }
      // Reflect the pick immediately — the switch transport can take a beat
      // (first-use slash path ~8s), and waiting for it read as "switching is
      // slow". Reverted on failure; reconciled by the effect above.
      setOptimistic({
        id: modelId,
        label: typeof model === 'string' ? undefined : model?.label,
      });
      const attempt = (async () => {
        if (shouldFastSwitch({ sessionRunning, turnRanSinceBind })) {
          // config.set: ~200ms; while a turn runs the gateway defers the pick
          // to the next turn start (result.deferred) — the intended mid-turn
          // behavior, no busy refusal.
          const result = await runtime.config.set(
            sessionId,
            'model',
            modelSwitchValue(modelId, provider),
          );
          if (result?.error) {
            throw new Error(result.error.message || 'model switch failed');
          }
          setOptimistic({ id: modelId, deferred: Boolean(result?.deferred) });
          return;
        }
        // slash.exec: the only transport that applies before the session's
        // first turn (config.set would be silently dropped by the later agent
        // build). The mirror result MUST be checked: a busy session still
        // answers "✓ Model switched" (the slash worker's own output) while
        // the warning field carries "session busy — …" meaning NOT applied.
        const result = await runtime.commands.exec({
          sessionId,
          command: `/model ${modelSwitchValue(modelId, provider)}`,
        });
        if (mirrorRefusedSwitch(result?.warning)) {
          throw new Error(String(result.warning).trim());
        }
      })();
      pendingSwitchRef.current = attempt;
      setSwitching(true);
      attempt
        .catch((error) => {
          setOptimistic(null);
          onError?.(
            error?.message
              ? error
              : new Error(
                  `Model switch to ${modelId} did not apply — try again once the current reply finishes.`,
                ),
          );
        })
        .finally(() => {
          setSwitching(false);
          if (pendingSwitchRef.current === attempt) {
            pendingSwitchRef.current = null;
          }
        });
    },
    [
      onError,
      runtime,
      sessionId,
      sessionRunning,
      setPendingModel,
      turnRanSinceBind,
    ],
  );

  return {
    models,
    currentModel: displayModel,
    currentTier: displayTier,
    defaultModel,
    pendingModel,
    loading,
    switching,
    switchModel,
    settlePendingSwitch,
    reload,
  };
}
