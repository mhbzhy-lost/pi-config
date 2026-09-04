import assert from "node:assert/strict";
import test from "node:test";
import { createModelSystemPromptExtension } from "../src/model-system-prompt/index.ts";

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

test("does not replace system prompt for removed openai-idealab provider", async () => {
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

  assert.equal(result, undefined);
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

test("does not replace system prompt when model id does not match the dogfooding pattern", async () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);

  const handler = pi.handlers.get("before_agent_start");
  const ctx = {
    model: { provider: "openai-idealab-dogfooding", id: "some-other-model" },
  };

  const result = await handler(
    { systemPrompt: "generic prompt" },
    ctx,
  );

  assert.equal(result, undefined);
});

test("replaces system prompt for dogfooding Peach compatibility model", async () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);

  const handler = pi.handlers.get("before_agent_start");
  const ctx = {
    model: { provider: "openai-idealab-dogfooding", id: "Peach-07-17-DogFooding" },
  };

  const result = await handler(
    { systemPrompt: "generic prompt", systemPromptOptions: {} },
    ctx,
  );

  assert.ok(result);
  assert.match(result.systemPrompt, /Stop Rules/);
});

test("keeps OpenAI Codex GPT family on the generic Pi system prompt", async () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);

  const handler = pi.handlers.get("before_agent_start");
  const ctx = {
    model: { provider: "openai-codex", id: "gpt-5.6-terra" },
  };

  const result = await handler(
    { systemPrompt: "generic prompt", systemPromptOptions: {} },
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
