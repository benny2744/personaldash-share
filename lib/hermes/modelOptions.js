/**
 * Normalize a Hermes `model.options` payload into picker rows.
 *
 * Truthful grouping only: the payload already arrives grouped by provider
 * (e.g. alibaba → qwen3.8-max…), so we render those groups verbatim rather
 * than inventing "Fast/Coding" categories. Model ids can repeat across
 * providers, so the current row is matched on (provider, id).
 *
 * @typedef {{
 *   groups: Array<{
 *     slug: string, name: string, isCurrent: boolean,
 *     authenticated: boolean,
 *     models: Array<{ id: string, label: string, isCurrent: boolean }>
 *   }>,
 *   currentModel: string,
 *   currentProvider: string,
 * }} NormalizedModels
 */

/**
 * @param {any} payload
 * @returns {NormalizedModels}
 */
export function normalizeModelOptions(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  const currentModel = typeof payload?.model === 'string' ? payload.model : '';
  const currentProvider =
    typeof payload?.provider === 'string' ? payload.provider : '';

  const groups = providers
    .map((provider) => {
      const rawModels = Array.isArray(provider?.models) ? provider.models : [];
      const slug = provider?.slug || '';
      const models = rawModels
        .map((entry) => {
          const id =
            typeof entry === 'string'
              ? entry
              : entry?.id || entry?.model || '';
          if (!id) return null;
          const isCurrent = currentProvider
            ? slug === currentProvider && id === currentModel
            : id === currentModel;
          return { id, label: id, isCurrent };
        })
        .filter(Boolean);
      return {
        slug,
        name: provider?.name || slug,
        isCurrent: Boolean(provider?.is_current),
        authenticated: provider?.authenticated !== false,
        models,
      };
    })
    .filter((group) => group.models.length > 0);

  return { groups, currentModel, currentProvider };
}

/**
 * Label for the picker trigger: the current model id (or a friendly fallback).
 * @param {NormalizedModels} normalized
 * @param {string} currentModel
 */
export function modelLabel(_normalized, currentModel) {
  return currentModel || '';
}
