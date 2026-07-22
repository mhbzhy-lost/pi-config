import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProgressEvents } from "../pi/extensions/async-progress-watcher.ts";

test("parseProgressEvents summarizes turn and tool activity", () => {
  const lines = [
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "tool_execution_start", tool: "bash" }),
    JSON.stringify({ type: "tool_execution_end", tool: "bash", durationMs: 3200 }),
    JSON.stringify({ type: "turn_end" }),
  ];
  const result = parseProgressEvents(lines, { turnCount: 0 });
  assert.equal(result.summary, "turn 1 | bash (3.2s)");
  assert.equal(result.state.turnCount, 1);
});

test("parseProgressEvents handles message tokens", () => {
  const lines = [
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_end", usage: { totalTokens: 42000 } }),
  ];
  const result = parseProgressEvents(lines, { turnCount: 0 });
  assert.match(result.summary, /turn 1/);
  assert.match(result.summary, /42k tok/);
});

test("parseProgressEvents returns null for no meaningful events", () => {
  const lines = [
    JSON.stringify({ type: "session_info_changed" }),
  ];
  const result = parseProgressEvents(lines, { turnCount: 0 });
  assert.equal(result, null);
});
