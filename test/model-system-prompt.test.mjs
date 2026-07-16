import assert from "node:assert/strict";
import test from "node:test";
import { createModelSystemPromptExtension } from "../scripts/lib/model-system-prompt.mjs";

function createMockPi() {
  const handlers = new Map();
  return {
    handlers,
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
}

test("registers before_agent_start handler", () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);
  assert.ok(pi.handlers.has("before_agent_start"));
});

test("replaces system prompt when provider is openai-idealab and model id contains Qwen", async () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);

  const handler = pi.handlers.get("before_agent_start");
  const ctx = {
    model: { provider: "openai-idealab", id: "Qwen3.7-Max-DogFooding" },
  };

  const result = await handler(
    { systemPrompt: "generic prompt" },
    ctx,
  );

  assert.ok(result);
  assert.ok(result.systemPrompt);
  assert.ok(result.systemPrompt.includes("Stop Rules"));
  assert.ok(result.systemPrompt.includes("Pi, a pragmatic coding agent"));
});

test("does not replace system prompt for non-Qwen models", async () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);

  const handler = pi.handlers.get("before_agent_start");
  const ctx = {
    model: { provider: "openai", id: "gpt-5.6-sol" },
  };

  const result = await handler(
    { systemPrompt: "generic prompt" },
    ctx,
  );

  assert.equal(result, undefined);
});

test("does not replace system prompt when provider is not openai-idealab", async () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);

  const handler = pi.handlers.get("before_agent_start");
  const ctx = {
    model: { provider: "openai", id: "Qwen3.7-Max" },
  };

  const result = await handler(
    { systemPrompt: "generic prompt" },
    ctx,
  );

  assert.equal(result, undefined);
});

test("does not replace system prompt when model id does not contain Qwen", async () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);

  const handler = pi.handlers.get("before_agent_start");
  const ctx = {
    model: { provider: "openai-idealab", id: "some-other-model" },
  };

  const result = await handler(
    { systemPrompt: "generic prompt" },
    ctx,
  );

  assert.equal(result, undefined);
});

test("handles missing model context gracefully", async () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);

  const handler = pi.handlers.get("before_agent_start");
  const ctx = { model: undefined };

  const result = await handler(
    { systemPrompt: "generic prompt" },
    ctx,
  );

  assert.equal(result, undefined);
});
