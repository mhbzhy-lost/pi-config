import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The extension reads PI_CODING_AGENT_DIR/models.json at import-time.
// We set up a temporary config dir with a test models.json before importing.
const configRoot = await mkdtemp(join(tmpdir(), "anthropic-rewriter-"));
await writeFile(
  join(configRoot, "models.json"),
  JSON.stringify({
    providers: {
      "anthropic-idealab": {
        api: "anthropic-messages",
        baseUrl: "https://test.example",
        metadataUserId: "test-user-id",
        models: [
          { id: "claude-4-alias", actualModelId: "claude-opus-4-20250514" },
          { id: "claude-4-direct" },
        ],
      },
      "openai": {
        api: "openai",
        models: [{ id: "gpt-4o" }],
      },
    },
  }),
);
process.env.PI_CODING_AGENT_DIR = configRoot;

const { default: createExtension } = await import("../pi/extensions/anthropic-request-rewriter.ts");

function createMockPi() {
  const handlers = new Map();
  return {
    handlers,
    on(name, handler) { handlers.set(name, handler); },
  };
}

test("rewrites alias model ID to actual model ID", () => {
  const pi = createMockPi();
  createExtension(pi);
  const handler = pi.handlers.get("before_provider_request");
  const payload = { model: "claude-4-alias", messages: [] };
  const result = handler(
    { payload },
    { model: { provider: "anthropic-idealab", id: "claude-4-alias" } },
  );
  assert.equal(result.model, "claude-opus-4-20250514");
});

test("does not rewrite model ID when no alias exists", () => {
  const pi = createMockPi();
  createExtension(pi);
  const handler = pi.handlers.get("before_provider_request");
  const payload = { model: "claude-4-direct", messages: [] };
  const result = handler(
    { payload },
    { model: { provider: "anthropic-idealab", id: "claude-4-direct" } },
  );
  assert.equal(result.model, "claude-4-direct");
});

test("fills metadata user_id from provider config", () => {
  const pi = createMockPi();
  createExtension(pi);
  const handler = pi.handlers.get("before_provider_request");
  const payload = { model: "claude-4-direct", messages: [] };
  const result = handler(
    { payload },
    { model: { provider: "anthropic-idealab", id: "claude-4-direct" } },
  );
  assert.equal(result.metadata?.user_id, "test-user-id");
});

test("does not overwrite existing metadata user_id", () => {
  const pi = createMockPi();
  createExtension(pi);
  const handler = pi.handlers.get("before_provider_request");
  const payload = { model: "claude-4-direct", messages: [], metadata: { user_id: "existing" } };
  const result = handler(
    { payload },
    { model: { provider: "anthropic-idealab", id: "claude-4-direct" } },
  );
  assert.equal(result.metadata.user_id, "existing");
});

test("rewrites thinking type from enabled to adaptive", () => {
  const pi = createMockPi();
  createExtension(pi);
  const handler = pi.handlers.get("before_provider_request");
  const payload = {
    model: "claude-4-direct",
    messages: [],
    thinking: { type: "enabled", budget_tokens: 10000 },
  };
  const result = handler(
    { payload },
    { model: { provider: "anthropic-idealab", id: "claude-4-direct" } },
  );
  assert.equal(result.thinking.type, "adaptive");
  assert.equal(result.thinking.budget_tokens, undefined);
});

test("strips budget_tokens from adaptive thinking (Pi kernel sends both)", () => {
  const pi = createMockPi();
  createExtension(pi);
  const handler = pi.handlers.get("before_provider_request");
  const payload = {
    model: "claude-opus-4-6",
    messages: [],
    thinking: { type: "adaptive", budget_tokens: 16000 },
  };
  const result = handler(
    { payload },
    { model: { provider: "anthropic-idealab", id: "claude-opus-4-6" } },
  );
  assert.equal(result.thinking.type, "adaptive");
  assert.equal(result.thinking.budget_tokens, undefined);
});

test("places cache markers on system and message blocks", () => {
  const pi = createMockPi();
  createExtension(pi);
  const handler = pi.handlers.get("before_provider_request");
  const longText = "x".repeat(5000);
  const payload = {
    model: "claude-4-direct",
    system: [{ type: "text", text: longText }],
    messages: [
      { role: "user", content: [{ type: "text", text: longText }] },
      { role: "assistant", content: [{ type: "text", text: longText }] },
      { role: "user", content: [{ type: "text", text: longText }] },
    ],
  };
  const result = handler(
    { payload },
    { model: { provider: "anthropic-idealab", id: "claude-4-direct" } },
  );
  // At least one cache_control marker should be placed
  const hasMarker = (obj) => obj?.cache_control?.type === "ephemeral";
  const systemMarked = Array.isArray(result.system) && result.system.some(hasMarker);
  const msgMarked = result.messages.some((msg) =>
    Array.isArray(msg.content) && msg.content.some(hasMarker),
  );
  assert.ok(systemMarked || msgMarked, "should place at least one cache marker");
});

test("ignores non-anthropic providers", () => {
  const pi = createMockPi();
  createExtension(pi);
  const handler = pi.handlers.get("before_provider_request");
  const result = handler(
    { payload: { model: "gpt-4o", messages: [] } },
    { model: { provider: "openai", id: "gpt-4o" } },
  );
  assert.equal(result, undefined);
});

test.after(() => rm(configRoot, { recursive: true, force: true }));
