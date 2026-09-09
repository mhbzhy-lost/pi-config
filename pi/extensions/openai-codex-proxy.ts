import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function hostPackageEntry(packageName: string, packageEntry: string): string {
  const configuredRoot = process.env.PI_PACKAGE_DIR?.trim();
  const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
  const entryDirectory = dirname(entryPath);
  const distDirectory = basename(entryDirectory) === "bundle" ? dirname(entryDirectory) : entryDirectory;
  const inferredRoot = dirname(distDirectory);
  const configuredEntry = configuredRoot ? join(configuredRoot, "node_modules", packageName, packageEntry) : "";
  const candidate = configuredEntry && existsSync(configuredEntry)
    ? configuredEntry
    : join(inferredRoot, "node_modules", packageName, packageEntry);
  return pathToFileURL(candidate).href;
}

async function loadCodexApi() {
  const module = await import(hostPackageEntry("@earendil-works/pi-ai", "dist/compat.js"));
  return { stream: module.streamOpenAICodexResponses };
}


function validProxy(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username && !url.password && Boolean(url.hostname)
      && (!url.port || (Number(url.port) >= 1 && Number(url.port) <= 65535));
  } catch {
    return false;
  }
}

export function loadOpenAICodexProxyConfig(configPath: string, { onError }: { onError?: (message: string) => void } = {}): { proxy: string } | undefined {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (validProxy(config?.proxy)) return { proxy: config.proxy };
    onError?.("openai-codex proxy configuration has an invalid proxy URL");
    return undefined;
  } catch {
    onError?.("openai-codex proxy configuration could not be read");
    return undefined;
  }
}

async function defaultCreateProxyFetch(proxy: string) {
  const { fetch: undiciFetch, ProxyAgent } = await import(hostPackageEntry("undici", "index.js"));
  const dispatcher = new ProxyAgent(proxy);
  return (input: any, init: any = {}) => undiciFetch(input, { ...init, dispatcher }) as any;
}

export async function createOpenAICodexProxyExtension(
  pi: any,
  { codexApi, proxy, createProxyFetch = defaultCreateProxyFetch }: any = {},
) {
  if (!validProxy(proxy)) return;
  const api = codexApi ?? await loadCodexApi();
  const fetch = await createProxyFetch(proxy);
  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    streamSimple(model: any, context: any, options: any = {}) {
      return api.stream(model, context, {
        ...options,
        fetch,
        transport: "sse",
        env: {
          ...(options.env ?? {}),
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
        },
      });
    },
  });
}

export default async function openAICodexProxyExtension(pi: any) {
  const configPath = join(import.meta.dirname, "..", "openai-codex-proxy.json");
  const config = loadOpenAICodexProxyConfig(configPath, { onError: (message) => console.warn(`[pi extension] ${message}`) });
  await createOpenAICodexProxyExtension(pi, config);
}
