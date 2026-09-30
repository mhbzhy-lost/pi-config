import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function hostPackageEntry(packageName: string, options: { inferredRoot?: string; selfUrl?: string } = {}): string {
  const configuredRoot = process.env.PI_PACKAGE_DIR?.trim();
  const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
  const entryDirectory = dirname(entryPath);
  const inferredRoot = options.inferredRoot
    ?? (basename(entryDirectory) === "bundle" ? dirname(dirname(entryDirectory)) : dirname(entryDirectory));
  const root = configuredRoot || inferredRoot;
  const selfUrl = options.selfUrl ?? import.meta.url;
  // 依次尝试三个解析起点：①进程/配置推断的 root（生产 bundle 布局）；
  // ②本模块自身位置（测试经 jiti alias 加载时指向全局 pi 包内）；
  // ③从本模块位置逐级向上找含该包的 node_modules。undici 是 Pi 包树的
  // 传递依赖，repo root 无本地副本，不再依赖 argv 布局。
  const candidates: Array<() => string> = [
    () => createRequire(pathToFileURL(join(root, "package.json"))).resolve(packageName),
    // Pi bundles keep transitive runtime dependencies under the Host package;
    // resolve from that package manifest instead of assuming root/node_modules.
    () => createRequire(pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"))).resolve(packageName),
    () => createRequire(selfUrl).resolve(packageName),
    () => {
      let directory = dirname(realpathSync(fileURLToPath(selfUrl)));
      for (let depth = 0; depth < 16 && directory !== "/"; depth += 1) {
        try {
          return createRequire(pathToFileURL(join(directory, "package.json"))).resolve(packageName);
        } catch {
          directory = dirname(directory);
        }
      }
      throw new Error(`${packageName} is not resolvable upward from ${directory}`);
    },
  ];
  for (const resolve of candidates) {
    try {
      return pathToFileURL(resolve()).href;
    } catch {
      continue;
    }
  }
  throw new Error(`openai-codex proxy cannot resolve ${packageName} from the Pi host package tree`);
}

export const hostPackageEntryForTest = hostPackageEntry;

export async function loadCodexApi() {
  const module = await import("@earendil-works/pi-ai/compat");
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
  const { fetch: undiciFetch, ProxyAgent } = await import(hostPackageEntry("undici"));
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
