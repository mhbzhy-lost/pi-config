import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCompactSubagentNotification,
  formatCompactSubagentSpawnSummary,
  formatCompactSubagentToolResult,
} from "../scripts/lib/subagent-dispatch/compact-rendering.ts";

function clone(value) {
  return structuredClone(value);
}

test("compact spawn summary uses structured identity without mutating the result", () => {
  const result = {
    content: [{
      type: "text",
      text: "Started executor: 迁移 Shell 到官方 fullscreen (run-123). Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.",
    }],
    details: {
      runId: "run-123",
      asyncDir: "/tmp/run-123",
      agent: "executor",
      title: "迁移 Shell 到官方 fullscreen",
    },
  };
  const before = clone(result);

  assert.equal(
    formatCompactSubagentSpawnSummary(result),
    "* subagent started executor: 迁移 Shell 到官方 fullscreen",
  );
  assert.deepEqual(result, before);
});

test("compact spawn summary supports generic failures and rejects missing structured identity", () => {
  assert.equal(
    formatCompactSubagentSpawnSummary({ isError: true, details: { agent: "reviewer", title: "审查兼容性报告" } }),
    "* subagent failed reviewer: 审查兼容性报告",
  );
  for (const result of [
    { content: [{ type: "text", text: "Started guessed: from content" }], details: { title: "Missing agent" } },
    { details: { agent: "executor", title: "" } },
    { details: { agent: "executor" } },
  ]) assert.equal(formatCompactSubagentSpawnSummary(result), undefined);
});

test("compact notification shows only one title and completion state without mutating the message", () => {
  const message = {
    customType: "subagent-notify",
    content: [
      "Background task completed: **delegate** [Cobalt title verification]",
      "",
      "COBALT_RUN_OK",
      "",
      "Session file: /tmp/session.jsonl",
    ].join("\n"),
    details: { titles: ["Cobalt title verification"] },
  };
  const before = clone(message);

  const rendered = formatCompactSubagentNotification(message);

  assert.equal(rendered, "✓ Cobalt title verification · completed");
  assert.doesNotMatch(rendered, /COBALT_RUN_OK|Session file|delegate/);
  assert.deepEqual(message, before);
});

test("compact notification renders grouped titles and terminal states", () => {
  const grouped = {
    content: "Background tasks completed (2): **delegate** [First check], **delegate** [Second check]\n\nfull output",
    details: { titles: ["First check", "Second check"] },
  };
  assert.equal(
    formatCompactSubagentNotification(grouped),
    "✓ First check · completed\n✓ Second check · completed",
  );

  assert.equal(
    formatCompactSubagentNotification({
      content: "Background task failed: **executor** [Build release]\n\nstack trace",
      details: { titles: ["Build release"] },
    }),
    "◇ Build release · reported",
  );
  assert.equal(
    formatCompactSubagentNotification({
      content: "Detached foreground task paused: **executor** [Await approval]\n\npaused output",
      details: { titles: ["Await approval"] },
    }),
    "Ⅱ Await approval · paused",
  );
});

test("compact notification renders stopped legacy notifications", () => {
  assert.equal(
    formatCompactSubagentNotification({ content: "Background task stopped: **executor** [Stopped task]" }),
    "■ Stopped task · stopped",
  );
});

test("compact notification falls back to first-line title then agent without reading the result body", () => {
  assert.equal(
    formatCompactSubagentNotification({
      content: "Background task completed: **delegate** [Metadata fallback]\n\n[Wrong body title]",
    }),
    "✓ Metadata fallback · completed",
  );
  assert.equal(
    formatCompactSubagentNotification({
      content: "Background task completed: **delegate**\n\n[Wrong body title]",
    }),
    "✓ delegate · completed",
  );
});

test("compact status selects only exact state and preserves the original result", () => {
  for (const state of ["running", "complete", "failed", "remembered foreground"]) {
    const result = {
      content: [{ type: "text", text: `Run: run-1\nState: ${state}\nDir: /tmp/run-1\nLog: /tmp/log` }],
      details: { mode: "single", results: [], lifecycleStatus: { processTerminal: { state: "observed" } } },
    };
    const before = clone(result);

    assert.equal(
      formatCompactSubagentToolResult(result, { action: "status", id: "run-1" }),
      `Status: ${state}`,
    );
    assert.deepEqual(result, before);
  }
});

test("compact status summarizes active, idle, error, and non-status results", () => {
  assert.equal(
    formatCompactSubagentToolResult(
      { content: [{ type: "text", text: "Active async runs: 2\n\n- run-1 | running\n- run-2 | queued" }] },
      { action: "status" },
    ),
    "Status: 2 active",
  );
  assert.equal(
    formatCompactSubagentToolResult(
      { content: [{ type: "text", text: "No active async runs." }] },
      { action: "status" },
    ),
    "Status: idle",
  );
  assert.equal(
    formatCompactSubagentToolResult(
      { content: [{ type: "text", text: "Async run not found. Provide id or dir." }], isError: true },
      { action: "status", id: "missing" },
    ),
    "Status: error",
  );
  assert.equal(
    formatCompactSubagentToolResult(
      { content: [{ type: "text", text: "Stop requested for run-1." }], details: { state: "stopping" } },
      { action: "stop", id: "run-1" },
    ),
    "Stop requested for run-1.",
  );
});

test("compact notification uses leaf presentation metadata instead of raw failed lifecycle", () => {
  const rendered = formatCompactSubagentNotification({
    content: "Background tasks failed (2): **executor**, **reviewer**",
    details: { titles: ["TDD RED", "Need context"], presentations: ["reported", "needs-context"] },
  });
  assert.equal(rendered, "◇ TDD RED · reported\n? Need context · needs-context");
  assert.doesNotMatch(rendered, /✗|runtime-failed/);
});
