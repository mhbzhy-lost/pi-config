import test from "node:test";
import assert from "node:assert/strict";
import contextUsageExtension from "../pi/extensions/context-usage.ts";

test("context usage extension 使用无参数 schema 且不依赖宿主脚本", () => {
  const registered = [];
  const listeners = [];
  const pi = {
    registerTool(definition) {
      registered.push(definition);
    },
    on(name, listener) {
      listeners.push({ name, listener });
      return () => {};
    },
    sendMessage() {},
  };

  contextUsageExtension(pi);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "context_usage");
  assert.deepEqual(registered[0].parameters, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.ok(listeners.some(({ name }) => name === "agent_end"));
});
