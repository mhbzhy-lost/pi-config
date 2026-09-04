import assert from "node:assert/strict";
import test from "node:test";
import { probeProvider, resolveFallbackModel } from "../src/provider-fallback/provider.ts";

test("probeProvider returns true for a reachable endpoint", async () => {
  const probe = probeProvider("http://127.0.0.1:1", { timeoutMs: 100, fetch: async () => ({ ok: true, status: 200 }) });
  assert.equal(await probe, true);
});

test("probeProvider returns false on connection error", async () => {
  const probe = probeProvider("http://127.0.0.1:1", {
    timeoutMs: 100,
    fetch: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(await probe, false);
});

test("probeProvider returns false on timeout", async () => {
  const probe = probeProvider("http://127.0.0.1:1", {
    timeoutMs: 50,
    fetch: () => new Promise((resolve) => setTimeout(resolve, 200)),
  });
  assert.equal(await probe, false);
});

test("probeProvider returns true on 4xx/5xx (server reachable)", async () => {
  const probe401 = probeProvider("http://127.0.0.1:1", {
    timeoutMs: 100,
    fetch: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(await probe401, true);

  const probe502 = probeProvider("http://127.0.0.1:1", {
    timeoutMs: 100,
    fetch: async () => ({ ok: false, status: 502 }),
  });
  assert.equal(await probe502, true);
});

test("resolveFallbackModel returns primary when reachable", async () => {
  const registry = {
    find: (provider, id) => ({ provider, id }),
  };
  const probes = { "codex-pool": true, "openai-codex": true, "anthropic-idealab": true };
  const result = await resolveFallbackModel({
    primaryProvider: "codex-pool",
    primaryModelId: "gpt-5.6-sol",
    fallbackChain: [
      { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      { provider: "anthropic-idealab", modelId: "claude-opus-4-6" },
    ],
    registry,
    probe: async (provider) => probes[provider] ?? false,
  });
  assert.deepEqual(result, { provider: "codex-pool", id: "gpt-5.6-sol" });
});

test("resolveFallbackModel falls back to first available when primary unreachable", async () => {
  const registry = {
    find: (provider, id) => ({ provider, id }),
  };
  const probes = { "codex-pool": false, "openai-codex": true, "anthropic-idealab": true };
  const result = await resolveFallbackModel({
    primaryProvider: "codex-pool",
    primaryModelId: "gpt-5.6-sol",
    fallbackChain: [
      { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      { provider: "anthropic-idealab", modelId: "claude-opus-4-6" },
    ],
    registry,
    probe: async (provider) => probes[provider] ?? false,
  });
  assert.deepEqual(result, { provider: "openai-codex", id: "gpt-5.6-sol" });
});

test("resolveFallbackModel falls back to last resort when all prior unreachable", async () => {
  const registry = {
    find: (provider, id) => ({ provider, id }),
  };
  const probes = { "codex-pool": false, "openai-codex": false, "anthropic-idealab": true };
  const result = await resolveFallbackModel({
    primaryProvider: "codex-pool",
    primaryModelId: "gpt-5.6-sol",
    fallbackChain: [
      { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      { provider: "anthropic-idealab", modelId: "claude-opus-4-6" },
    ],
    registry,
    probe: async (provider) => probes[provider] ?? false,
  });
  assert.deepEqual(result, { provider: "anthropic-idealab", id: "claude-opus-4-6" });
});

test("resolveFallbackModel returns primary when all fallbacks unreachable", async () => {
  const registry = {
    find: (provider, id) => ({ provider, id }),
  };
  const probes = { "codex-pool": false, "openai-codex": false, "anthropic-idealab": false };
  const result = await resolveFallbackModel({
    primaryProvider: "codex-pool",
    primaryModelId: "gpt-5.6-sol",
    fallbackChain: [
      { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      { provider: "anthropic-idealab", modelId: "claude-opus-4-6" },
    ],
    registry,
    probe: async (provider) => probes[provider] ?? false,
  });
  assert.deepEqual(result, { provider: "codex-pool", id: "gpt-5.6-sol" });
});

test("resolveFallbackModel skips fallback when model not found in registry", async () => {
  const registry = {
    find: (provider, id) => (provider === "openai-codex" ? undefined : { provider, id }),
  };
  const probes = { "codex-pool": false, "openai-codex": true, "anthropic-idealab": true };
  const result = await resolveFallbackModel({
    primaryProvider: "codex-pool",
    primaryModelId: "gpt-5.6-sol",
    fallbackChain: [
      { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      { provider: "anthropic-idealab", modelId: "claude-opus-4-6" },
    ],
    registry,
    probe: async (provider) => probes[provider] ?? false,
  });
  assert.deepEqual(result, { provider: "anthropic-idealab", id: "claude-opus-4-6" });
});
