import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti } = await loadPiTestRuntime(import.meta.url);
const {
  createOpenAIProxyExtension,
  ensureScopedProxyFetch,
  loadOpenAIApi,
  loadOpenAICodexApi,
  loadOpenAIProxyConfig,
} = await jiti.import("../pi/extensions/openai-proxy.ts");

test("OpenAI proxy default API loader uses the public openai-responses api factory", async () => {
  const api = await loadOpenAIApi();
  assert.equal(typeof api.streamSimple, "function");
  assert.equal(typeof api.stream, "function");
});

test("Codex proxy default API loader uses the public openai-codex-responses api factory", async () => {
  const api = await loadOpenAICodexApi();
  assert.equal(typeof api.streamSimple, "function");
  assert.equal(typeof api.stream, "function");
});

test("OpenAI proxy config is loaded from the extension-owned JSON file", async () => {
  const root = await mkdtemp(join(tmpdir(), "openai-proxy-config-"));
  try {
    const configPath = join(root, "proxy.json");
    await writeFile(configPath, JSON.stringify({ proxy: "http://127.0.0.1:7897" }));
    assert.deepEqual(loadOpenAIProxyConfig(configPath), { proxy: "http://127.0.0.1:7897" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAI proxy config rejects credentials and reports invalid configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "openai-proxy-invalid-"));
  try {
    const configPath = join(root, "proxy.json");
    await writeFile(configPath, JSON.stringify({ proxy: "http://user:password@127.0.0.1:7897" }));
    const diagnostics = [];
    assert.equal(loadOpenAIProxyConfig(configPath, { onError: (message) => diagnostics.push(message) }), undefined);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /invalid proxy/i);
    assert.doesNotMatch(diagnostics[0], /password/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAI proxy extension scopes proxy settings to the openai streams", async () => {
  const originalProxy = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
  const registrations = [];
  const seen = [];
  const proxyFetch = () => {};
  const proxyFetches = [];
  const openaiApi = {
    streamSimple(model, context, options) {
      seen.push({ provider: "openai", model, context, options });
      return "openai-stream";
    },
  };
  const codexApi = {
    streamSimple(model, context, options) {
      seen.push({ provider: "openai-codex", model, context, options });
      return "codex-stream";
    },
  };

  await createOpenAIProxyExtension({
    registerProvider(name, config) {
      registrations.push({ name, config });
    },
  }, {
    openaiApi,
    codexApi,
    proxy: "http://127.0.0.1:7897",
    createProxyFetch(proxy) {
      proxyFetches.push(proxy);
      return proxyFetch;
    },
  });

  assert.deepEqual(registrations.map((r) => [r.name, r.config.api]), [
    ["openai", "openai-responses"],
    ["openai-codex", "openai-codex-responses"],
  ]);

  const [openaiRegistration, codexRegistration] = registrations;
  const openaiModel = { provider: "openai", id: "gpt-5.6-sol" };
  const codexModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const context = { messages: [] };

  assert.equal(openaiRegistration.config.streamSimple(openaiModel, context, {
    apiKey: "runtime-token",
    env: { EXISTING: "preserved" },
    reasoning: "high",
  }), "openai-stream");
  assert.equal(codexRegistration.config.streamSimple(codexModel, context, {
    apiKey: "runtime-token",
    transport: "auto",
  }), "codex-stream");

  // openai 只注入 fetch：apiKey、env、reasoning 等原样透传，不额外注入 transport。
  assert.deepEqual(seen[0], {
    provider: "openai",
    model: openaiModel,
    context,
    options: {
      apiKey: "runtime-token",
      env: { EXISTING: "preserved" },
      reasoning: "high",
      fetch: proxyFetch,
    },
  });
  // codex 的 auto 传输会选 WebSocket（不吃注入的 fetch），必须强制 sse。
  assert.deepEqual(seen[1], {
    provider: "openai-codex",
    model: codexModel,
    context,
    options: {
      apiKey: "runtime-token",
      transport: "sse",
      fetch: proxyFetch,
    },
  });

  assert.deepEqual(proxyFetches, ["http://127.0.0.1:7897"]);
  assert.equal(process.env.HTTP_PROXY, originalProxy.HTTP_PROXY);
  assert.equal(process.env.HTTPS_PROXY, originalProxy.HTTPS_PROXY);
});

test("OpenAI proxy routes only OpenAI auth hosts through the proxy fetch", async () => {
  // OAuth 登录/刷新在 pi-ai 内部裸调 globalThis.fetch，没有注入点，因此靠主机白名单包装层。
  const target = { fetch: async (input) => ({ via: "original", url: String(input) }) };
  const proxyCalls = [];
  const proxyFetch = (input) => {
    proxyCalls.push(String(input));
    return { via: "proxy" };
  };

  await ensureScopedProxyFetch("http://127.0.0.1:7897", {
    createProxyFetch: async () => proxyFetch,
    target,
  });

  const authResult = await target.fetch("https://auth.openai.com/api/accounts/oauth/token");
  const otherResult = await target.fetch("https://api.deepseek.com/v1/chat/completions");

  assert.equal(authResult.via, "proxy");
  assert.equal(otherResult.via, "original");
  assert.deepEqual(proxyCalls, ["https://auth.openai.com/api/accounts/oauth/token"]);

  // 幂等：重复安装不叠加包装层。
  const installed = target.fetch;
  await ensureScopedProxyFetch("http://127.0.0.1:7897", { createProxyFetch: async () => proxyFetch, target });
  assert.equal(target.fetch, installed);
});

test("OpenAI proxy undici resolver works outside the Pi bundle process (node --test argv)", async () => {
  // 复现 process-fleet-removal 场景：测试进程 argv[1] 不是 pi bundle、repo root
  // 无本地 undici。resolver 必须仍能从 pi 包依赖树解析 undici。
  const { hostPackageEntryForTest } = await jiti.import("../pi/extensions/openai-proxy.ts");
  assert.equal(typeof hostPackageEntryForTest, "function", "resolver 需可注入测试");
  const url = hostPackageEntryForTest("undici", { inferredRoot: process.cwd() });
  assert.match(url, /undici/);
  const module = await import(url);
  assert.equal(typeof module.fetch, "function");
  assert.equal(typeof module.ProxyAgent, "function");
});
