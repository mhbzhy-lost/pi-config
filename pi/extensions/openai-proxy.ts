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
  throw new Error(`openai proxy cannot resolve ${packageName} from the Pi host package tree`);
}

export const hostPackageEntryForTest = hostPackageEntry;

// openai provider 的全部 chat 模型都是 openai-responses api。委派内置的同一个 api 工厂
// （内置 provider 定义就是 `api: openAIResponsesApi()`），保留 thinking level、
// maxTokens 夹取与 samplingParams 的完整换算。
// 不用 `@earendil-works/pi-ai/api/openai-responses` 子路径：宿主与测试都用 jiti 加载
// 本扩展，jiti 无法正确解析 exports 里的 `./api/*` 通配子路径（会拼成 dist/index.js/api/...）。
export async function loadOpenAIApi() {
  const module = await import("@earendil-works/pi-ai/compat");
  return module.openAIResponsesApi();
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

export function loadOpenAIProxyConfig(configPath: string, { onError }: { onError?: (message: string) => void } = {}): { proxy: string } | undefined {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (validProxy(config?.proxy)) return { proxy: config.proxy };
    onError?.("openai proxy configuration has an invalid proxy URL");
    return undefined;
  } catch {
    onError?.("openai proxy configuration could not be read");
    return undefined;
  }
}

async function defaultCreateProxyFetch(proxy: string) {
  const { fetch: undiciFetch, ProxyAgent } = await import(hostPackageEntry("undici"));
  const dispatcher = new ProxyAgent(proxy);
  return (input: any, init: any = {}) => undiciFetch(input, { ...init, dispatcher }) as any;
}

// openai provider 的模型流由 registerProvider 注入 fetch 覆盖；但它依赖的 OAuth
// 登录/刷新都在 pi-ai 内部裸调 globalThis.fetch（auth/oauth/openai-chatgpt.js 的
// requestToken），没有 fetch/dispatcher 注入点，也不吃 provider 覆盖。因此额外把一个
// 主机白名单的 fetch 包装层装上全局：只有 auth.openai.com 走代理，其余请求原样放行。
export const OAUTH_PROXY_HOSTS = ["auth.openai.com"];
const SCOPED_FETCH_KEY = Symbol.for("pi.openai-proxy.scopedFetch");

function requestUrl(input: any): URL | undefined {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof input.url === "string") return new URL(input.url);
  } catch {
    return undefined;
  }
  return undefined;
}

function isScopedFetch(value: any): boolean {
  return typeof value === "function" && Boolean((value as any)[SCOPED_FETCH_KEY]);
}

/**
 * 安装主机白名单 fetch 包装层。幂等，并能在宿主重新安装全局 fetch（例如设置的
 * httpProxy 变更后会重跑 configureHttpDispatcher）后重新包住新的 fetch。
 */
export async function ensureScopedProxyFetch(
  proxy: string,
  { hosts = OAUTH_PROXY_HOSTS, createProxyFetch = defaultCreateProxyFetch, target = globalThis as any }: any = {},
) {
  if (isScopedFetch(target.fetch)) return target.fetch;
  const allowed = new Set(hosts);
  const proxyFetch = await createProxyFetch(proxy);
  const original = target.fetch.bind(target);
  const scoped: any = (input: any, init: any) => {
    const url = requestUrl(input);
    if (!url || !allowed.has(url.hostname)) return original(input, init);
    return proxyFetch(input, init);
  };
  Object.defineProperty(scoped, SCOPED_FETCH_KEY, { value: true });
  target.fetch = scoped;
  return scoped;
}

// 只覆盖 provider 的 api + streamSimple：models、baseUrl、auth、filter、classify
// 全部沿用内置 openai provider 定义（provider-composer 的 overlay 合并）。
// 注入的 fetch 仅存在于该 provider 的 streamSimple 闭包内，不改 process.env，
// 因此 deepseek、zai-coding-cn 等其他 provider 完全不受影响。
export async function createOpenAIProxyExtension(
  pi: any,
  { openaiApi, proxy, createProxyFetch = defaultCreateProxyFetch }: any = {},
) {
  if (!validProxy(proxy)) return;
  const api = openaiApi ?? await loadOpenAIApi();
  const fetch = await createProxyFetch(proxy);
  await ensureScopedProxyFetch(proxy, { createProxyFetch: async () => fetch });
  pi.registerProvider("openai", {
    api: "openai-responses",
    streamSimple(model: any, context: any, options: any = {}) {
      // 宿主可能在设置变更后重装全局 fetch，这里顺手把 OAuth 白名单包装层补回来。
      void ensureScopedProxyFetch(proxy, { createProxyFetch: async () => fetch });
      return api.streamSimple(model, context, { ...options, fetch });
    },
  });
}

export default async function openAIProxyExtension(pi: any) {
  const configPath = join(import.meta.dirname, "..", "openai-proxy.json");
  const config = loadOpenAIProxyConfig(configPath, { onError: (message) => console.warn(`[pi extension] ${message}`) });
  await createOpenAIProxyExtension(pi, config);
}
