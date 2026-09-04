import assert from "node:assert/strict";
import test from "node:test";

import { createTitleRegistry, normalizeSubagentTitle } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/title-registry.ts";

test("normalizes concise single-line titles and rejects control injection", () => {
  assert.equal(normalizeSubagentTitle("  Review title  "), "Review title");
  assert.throws(() => normalizeSubagentTitle("line\nbreak"), /INVALID_TITLE/);
  assert.throws(() => normalizeSubagentTitle("\u0000"), /INVALID_TITLE/);
  assert.throws(() => normalizeSubagentTitle("x".repeat(257)), /INVALID_TITLE/);
});

test("resets stale completion titles without dropping run bindings", () => {
  const registry = createTitleRegistry();
  registry.remember("run-1", "First");
  registry.completed({ runId: "run-1", agent: "delegate" });

  registry.resetCompleted();

  assert.equal(registry.takeCompleted("delegate"), undefined);
  assert.equal(registry.titleFor("run-1"), "First");
});

test("associates a pending dispatch with its started run and stays bounded", () => {
  const registry = createTitleRegistry({ maxEntries: 2 });
  registry.prepare({ agent: "delegate", task: "Inspect this change", title: "Inspect diff" });
  assert.equal(registry.started({ id: "run-1", agent: "delegate", goal: "Inspect this change" }), "Inspect diff");
  assert.equal(registry.titleFor("run-1"), "Inspect diff");
  registry.remember("run-2", "Second");
  registry.remember("run-3", "Third");
  assert.equal(registry.titleFor("run-1"), undefined);
  assert.equal(registry.titleFor("run-3"), "Third");
});
