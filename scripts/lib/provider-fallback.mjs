/**
 * Provider health probe and fallback model resolution.
 *
 * Fallback chain: codex-pool → openai-codex (same model) → anthropic-idealab (opus 4.6).
 * Used by the provider-fallback Extension at session_start to switch model before any LLM call.
 */

/**
 * Probe a provider's base URL for reachability.
 * @param {string} baseUrl - Provider base URL (e.g. "http://host:port/v1")
 * @param {{ timeoutMs?: number, fetch?: Function }} options
 * @returns {Promise<boolean>}
 */
export async function probeProvider(baseUrl, { timeoutMs = 3000, fetch: fetchFn = globalThis.fetch } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${baseUrl}/models`, { signal: controller.signal });
      return response?.ok === true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Resolve the best available model from primary + fallback chain.
 * @param {{
 *   primaryProvider: string,
 *   primaryModelId: string,
 *   fallbackChain: Array<{ provider: string, modelId: string }>,
 *   registry: { find(provider: string, id: string): object | undefined },
 *   probe: (provider: string) => Promise<boolean>,
 * }} options
 * @returns {Promise<{ provider: string, id: string }>}
 */
export async function resolveFallbackModel({ primaryProvider, primaryModelId, fallbackChain, registry, probe }) {
  const primary = registry.find(primaryProvider, primaryModelId);

  if (await probe(primaryProvider)) {
    return primary ?? { provider: primaryProvider, id: primaryModelId };
  }

  for (const { provider, modelId } of fallbackChain) {
    const model = registry.find(provider, modelId);
    if (!model) continue;
    if (await probe(provider)) return model;
  }

  return primary ?? { provider: primaryProvider, id: primaryModelId };
}
