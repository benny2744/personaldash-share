'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeModelOptions } from '@/lib/hermes/modelOptions';
import { buildTierCatalog, tierForModel } from '@/lib/hermes/tierModels';
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
 * `session.create` (see the facade), then confirmed by `session.bound`.
 *
 * @param {{
 *   runtime: object,
 *   currentModel: string,
 *   sessionId?: string | null,
 *   ready?: boolean,
 *   pendingModel?: { id: string, provider?: string, label?: string } | null,
 *   setPendingModel: (next: { id: string, provider?: string, label?: string } | null) => void,
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
  onError,
}) {
  const [raw, setRaw] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [tiers, setTiers] = useState(null);
  const loadedFor = useRef(null);

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

  const loading = catalogLoading || tiers === null;

  const switchModel = useCallback(
    async (model) => {
      const modelId = typeof model === 'string' ? model : model?.id;
      if (!modelId) return;
      const provider = typeof model === 'string' ? undefined : model?.provider;
      if (sessionId) {
        setSwitching(true);
        try {
          // slash.exec runs the live switch and re-emits `session.info`, so
          // state.model updates canonically. Plain /model is session-scoped
          // (persist defaults off); --provider disambiguates repeated ids.
          const command = provider
            ? `/model ${modelId} --provider ${provider}`
            : `/model ${modelId}`;
          await runtime.commands.exec({ sessionId, command });
        } catch (error) {
          onError?.(error);
        } finally {
          setSwitching(false);
        }
        return;
      }
      // No live session yet: remember the choice, applied at first create.
      setPendingModel({
        id: modelId,
        provider,
        label: typeof model === 'string' ? undefined : model?.label,
      });
    },
    [onError, runtime, sessionId, setPendingModel],
  );

  return {
    models,
    currentModel,
    currentTier,
    pendingModel,
    loading,
    switching,
    switchModel,
    reload,
  };
}
