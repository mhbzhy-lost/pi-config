import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetch as httpFetch, ProxyAgent } from "undici";

export type SearchAction = "search" | "fetch";
export type SearchProvider = "deepseek" | "exa";
export type ProviderResult = { provider: SearchProvider; data: Record<string, unknown>; fallback: boolean };

const MAX_RESPONSE_BYTES = 1 << 20;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_EXA_PROXY_PORT = 7897;
const repositoryToolRoot = dirname(fileURLToPath(import.meta.url));

class ProviderFailure extends Error {
  readonly provider: SearchProvider;

  constructor(provider: SearchProvider, message: string) {
    super(message);
    this.provider = provider;
  }
}

function dotenvPath(): string {
  return join(repositoryToolRoot, ".env");
}

async function readDotenvKey(name: "DEEPSEEK_API_KEY" | "EXA_API_KEY"): Promise<string> {
  try {
    const text = await readFile(dotenvPath(), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const entry = line.trim();
      const match = new RegExp(`^(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(entry);
      if (!match) continue;
      const value = match[1]!.trim();
      if (!value) return "";
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1).trim();
      return value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProviderFailure(name === "DEEPSEEK_API_KEY" ? "deepseek" : "exa", "无法读取本地搜索配置");
  }
  return "";
}

async function apiKey(provider: SearchProvider): Promise<string> {
  const name = provider === "deepseek" ? "DEEPSEEK_API_KEY" : "EXA_API_KEY";
  const value = process.env[name]?.trim() || await readDotenvKey(name);
  if (!value) throw new ProviderFailure(provider, `缺少 ${name}`);
  if (value.length > 256 || [...value].some(char => char < " " || char === "\u007f")) throw new ProviderFailure(provider, `${name} 格式无效`);
  return value;
}

function safeRequestId(headers: { get(name: string): string | null }, provider: SearchProvider): string {
  const names = provider === "exa" ? ["x-exa-request-id", "x-request-id"] : ["x-request-id"];
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return ` (request_id=${value})`;
  }
  return "";
}

function statusCategory(status: number, action: SearchAction, provider: SearchProvider): string {
  if (status === 401 || (provider === "exa" && status === 403)) return "authentication_error";
  if (status === 402) return "payment_required";
  if (status === 403) return action === "fetch" ? "fetch_blocked_by_policy" : "access_forbidden";
  if (status === 404) return action === "fetch" ? "content_unavailable" : "not_found";
  if (status === 408) return "request_timeout";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "server_error" : status >= 400 ? "client_error" : "http_error";
}

function exaProxy(): ProxyAgent {
  const raw = process.env.EXA_PROXY_PORT;
  const port = raw === undefined ? DEFAULT_EXA_PROXY_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || (raw !== undefined && !/^[0-9]+$/.test(raw))) {
    throw new ProviderFailure("exa", "EXA_PROXY_PORT 必须是 1–65535 的十进制端口");
  }
  return new ProxyAgent(`http://127.0.0.1:${port}`);
}

function requestSpec(provider: SearchProvider, action: SearchAction, input: Record<string, unknown>): { url: string; payload: Record<string, unknown> } {
  if (provider === "deepseek") return { url: `https://api.deepseek.com/v1/tools/${action}`, payload: input };
  if (action === "search") return {
    url: "https://api.exa.ai/search",
    payload: { query: input.query, numResults: input.count, type: "auto", contents: { highlights: true } },
  };
  return { url: "https://api.exa.ai/contents", payload: { urls: [input.url], text: { maxCharacters: 3000 } } };
}

async function requestProvider(provider: SearchProvider, action: SearchAction, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { url, payload } = requestSpec(provider, action, input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await httpFetch(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(provider === "deepseek" ? { Authorization: `Bearer ${await apiKey(provider)}` } : { "x-api-key": await apiKey(provider), "User-Agent": "pi-config-search/1.0" }),
      },
      body: JSON.stringify(payload),
      ...(provider === "exa" ? { dispatcher: exaProxy() } : {}),
    });
    if (response.status >= 300 && response.status < 400) throw new ProviderFailure(provider, `${provider} 请求重定向被阻断`);
    if (!response.ok) throw new ProviderFailure(provider, `${provider} ${action} 失败：HTTP ${response.status} ${statusCategory(response.status, action, provider)}${safeRequestId(response.headers, provider)}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new ProviderFailure(provider, `${provider} 响应超过 ${MAX_RESPONSE_BYTES} 字节限制`);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ProviderFailure(provider, `${provider} 响应不是合法 JSON`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProviderFailure(provider, `${provider} 响应不是 JSON 对象`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new ProviderFailure(provider, `${provider} 请求超时`);
    throw new ProviderFailure(provider, `${provider} 请求失败`);
  } finally {
    clearTimeout(timer);
  }
}

export async function requestSearch(action: SearchAction, input: Record<string, unknown>): Promise<ProviderResult> {
  try {
    return { provider: "deepseek", data: await requestProvider("deepseek", action, input), fallback: false };
  } catch (deepseekError) {
    try {
      return { provider: "exa", data: await requestProvider("exa", action, input), fallback: true };
    } catch (exaError) {
      const deepseekMessage = deepseekError instanceof ProviderFailure ? deepseekError.message : "DeepSeek 请求失败";
      const exaMessage = exaError instanceof ProviderFailure ? exaError.message : "Exa 请求失败";
      throw new Error(`搜索服务均不可用：DeepSeek（${deepseekMessage}）；Exa（${exaMessage}）`);
    }
  }
}
