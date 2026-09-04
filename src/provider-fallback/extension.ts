import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { probeProvider, resolveFallbackModel } from "./provider.ts";

const FALLBACK_CHAIN = [
  { provider: "openai-codex", modelId: "gpt-5.6-sol" },
];

const PROBE_TIMEOUT_MS = 3000;

function getBaseUrl(provider, modelsConfig) {
  return modelsConfig?.providers?.[provider]?.baseUrl;
}

export function createProviderFallbackExtension(pi, { configRoot = join(import.meta.dirname, "..", "..") } = {}) {
  let modelsConfig;

  pi.on("session_start", async (_event, ctx) => {
    try {
      const modelsPath = join(configRoot, "pi", "models.json");
      modelsConfig = JSON.parse(await readFile(modelsPath, "utf8"));
    } catch {
      modelsConfig = {};
    }

    const model = ctx.model;
    if (!model) return;

    const primaryProvider = model.provider;
    const primaryModelId = model.id;

    const baseUrl = getBaseUrl(primaryProvider, modelsConfig);
    if (!baseUrl) return;

    const resolved = await resolveFallbackModel({
      primaryProvider,
      primaryModelId,
      fallbackChain: FALLBACK_CHAIN,
      registry: ctx.modelRegistry,
      probe: async (provider) => {
        const url = getBaseUrl(provider, modelsConfig);
        if (!url) return probeProvider(`https://${provider}.example.invalid`, { timeoutMs: PROBE_TIMEOUT_MS });
        return probeProvider(url, { timeoutMs: PROBE_TIMEOUT_MS });
      },
    });

    if (resolved.provider !== primaryProvider || resolved.id !== primaryModelId) {
      const fallbackModel = ctx.modelRegistry.find(resolved.provider, resolved.id);
      if (fallbackModel) {
        const success = await pi.setModel(fallbackModel);
        if (success) {
          ctx.ui?.notify?.(`[fallback] ${primaryProvider}/${primaryModelId} 不可达，已切换至 ${resolved.provider}/${resolved.id}`, "warning");
        }
      }
    }
  });
}

export default createProviderFallbackExtension;
