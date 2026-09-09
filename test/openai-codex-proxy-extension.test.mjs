import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti } = await loadPiTestRuntime(import.meta.url);
const { createOpenAICodexProxyExtension, loadOpenAICodexProxyConfig } = await jiti.import("../pi/extensions/openai-codex-proxy.ts");

test("Codex proxy config is loaded from the extension-owned JSON file", async () => {
  const root = await mkdtemp(join(tmpdir(), "openai-codex-proxy-config-"));
  try {
    const configPath = join(root, "proxy.json");
    await writeFile(configPath, JSON.stringify({ proxy: "http://127.0.0.1:7897" }));
    assert.deepEqual(loadOpenAICodexProxyConfig(configPath), { proxy: "http://127.0.0.1:7897" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex proxy config rejects credentials and reports invalid configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "openai-codex-proxy-invalid-"));
  try {
    const configPath = join(root, "proxy.json");
    await writeFile(configPath, JSON.stringify({ proxy: "http://user:password@127.0.0.1:7897" }));
    const diagnostics = [];
    assert.equal(loadOpenAICodexProxyConfig(configPath, { onError: (message) => diagnostics.push(message) }), undefined);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /invalid proxy/i);
    assert.doesNotMatch(diagnostics[0], /password/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex proxy extension scopes proxy settings to the openai-codex stream", async () => {
  let registration;
  const seen = [];
  const proxyFetch = () => {};
  const proxyFetches = [];
  const codexApi = {
    stream(model, context, options) {
      seen.push({ model, context, options });
      return "stream";
    },
  };

  await createOpenAICodexProxyExtension({
    registerProvider(name, config) {
      registration = { name, config };
    },
  }, {
    codexApi,
    proxy: "http://127.0.0.1:7897",
    createProxyFetch(proxy) {
      proxyFetches.push(proxy);
      return proxyFetch;
    },
  });

  assert.equal(registration.name, "openai-codex");
  assert.equal(registration.config.api, "openai-codex-responses");
  const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const context = { messages: [] };
  const result = registration.config.streamSimple(model, context, {
    apiKey: "runtime-token",
    env: { EXISTING: "preserved" },
    transport: "auto",
  });

  assert.equal(result, "stream");
  assert.deepEqual(seen, [{
    model,
    context,
    options: {
      apiKey: "runtime-token",
      fetch: proxyFetch,
      env: {
        EXISTING: "preserved",
        HTTP_PROXY: "http://127.0.0.1:7897",
        HTTPS_PROXY: "http://127.0.0.1:7897",
      },
      transport: "sse",
    },
  }]);
  assert.deepEqual(proxyFetches, ["http://127.0.0.1:7897"]);
  assert.equal(process.env.HTTP_PROXY, undefined);
  assert.equal(process.env.HTTPS_PROXY, undefined);
});
