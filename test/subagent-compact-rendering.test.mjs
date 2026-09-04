import assert from "node:assert/strict";
import test from "node:test";

import * as compactRendering from "../packages/pi-subagents-enhanced/src/tui/compact-rendering.ts";
const {
  formatCompactSubagentNotification,
  formatCompactSubagentSpawnSummary,
  formatCompactSubagentToolResult,
  formatCompactSubagentSteerResult,
  formatCompactSupervisorRequest,
} = compactRendering;
import { getTitleRegistry } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/title-registry.ts";

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
      `Status: ${state} · run: run-1`,
    );
    assert.deepEqual(result, before);
  }
});

test("compact status prefers the shared dispatch title and falls back to the run id", () => {
  const registry = getTitleRegistry();
  registry.remember("run-titled", "审查重新贡献与日志修复");
  const titled = { content: [{ type: "text", text: "Run: run-titled\nState: running\nDir: /tmp/run-titled" }] };
  assert.equal(
    formatCompactSubagentToolResult(titled, { action: "status", id: "run-titled" }),
    "Status: running · 审查重新贡献与日志修复",
  );
  const untitled = { content: [{ type: "text", text: "Run: run-untitled\nState: failed\nDir: /tmp/run-untitled" }] };
  assert.equal(
    formatCompactSubagentToolResult(untitled, { action: "status", id: "run-untitled" }),
    "Status: failed · run: run-untitled",
  );
});

test("compact resume distinguishes a resumed task without exposing the fixed runtime receipt", () => {
  const registry = getTitleRegistry();
  registry.remember("source-run", "集成手淘壳与双 Whale");
  const args = { action: "resume", id: "source-run", message: "继续处理集成问题" };
  const result = {
    content: [{
      type: "text",
      text: [
        "Revived async subagent from source-run.",
        "Revived run: revived-run",
        "Agent: executor",
        "Session: /tmp/session.jsonl",
        "Async dir: /tmp/revived-run",
        "Intercom target: subagent-executor-revived-run-1 (if registered)",
        "Status if needed: subagent({ action: \"status\", id: \"revived-run\" })",
        "",
        "The async run is detached and running in the background.",
      ].join("\n"),
    }],
    details: { mode: "single", results: [], asyncId: "revived-run", asyncDir: "/tmp/revived-run" },
  };
  const beforeArgs = clone(args);
  const beforeResult = clone(result);

  const rendered = formatCompactSubagentToolResult(result, args);

  assert.equal(rendered, "▶ 集成手淘壳与双 Whale · resumed");
  assert.doesNotMatch(rendered, /Revived run|Session|Async dir|Intercom|Status if needed|detached/);
  assert.deepEqual(args, beforeArgs);
  assert.deepEqual(result, beforeResult);
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
    "Status: error · run: missing",
  );
  assert.equal(
    formatCompactSubagentToolResult(
      { content: [{ type: "text", text: "Stop requested for run-1." }], details: { state: "stopping" } },
      { action: "stop", id: "run-1" },
    ),
    "Stop requested for run-1.",
  );
});

test("compact steer result separates the target title from the original message", () => {
  assert.equal(typeof formatCompactSubagentSteerResult, "function");
  const registry = getTitleRegistry();
  registry.remember("run-steer", "修复日志", "executor");
  const args = { action: "steer", id: "run-steer", message: "继续检查失败路径" };
  const result = { content: [{ type: "text", text: "Message sent to run-steer.\n```\n继续检查失败路径\n```" }], details: { runId: "run-steer", requestId: "req-1" } };
  const beforeArgs = clone(args);
  const beforeResult = clone(result);
  assert.equal(formatCompactSubagentSteerResult(result, args), "→ [steer] (executor) 修复日志：\n继续检查失败路径");
  assert.deepEqual(args, beforeArgs);
  assert.deepEqual(result, beforeResult);
});

test("compact supervisor request keeps only the agent and actual body", () => {
  assert.equal(typeof formatCompactSupervisorRequest, "function");
  const message = {
    customType: "subagent_supervisor_request",
    content: "Supervisor progress update.\nRun: run-1\nChild index: 0\nIntercom target: supervisor-1\n需要确认日志范围。",
    details: { agent: "executor", requestId: "req-1" },
  };
  const before = clone(message);
  assert.equal(formatCompactSupervisorRequest(message), "← (executor):\n需要确认日志范围。");
  assert.deepEqual(message, before);
});

test("compact supervisor renderer removes real runtime wrappers and metadata lines", () => {
  const cases = [
    ["Subagent progress update.\nAgent: executor\nChild intercom target: target-1\nUPDATE: 已完成扫描。", "← (executor):\nUPDATE: 已完成扫描。"],
    ["Subagent needs attention.\nAgent: executor\nSupervisor request: request-2\n需要批准继续。", "← (executor):\n需要批准继续。"],
    ["Subagent needs a supervisor decision.\nAgent: executor\nChild intercom target: target-3\n请决定是否重试。", "← (executor):\n请决定是否重试。"],
  ];
  for (const [content, expected] of cases) {
    const message = { customType: "subagent_supervisor_request", content, details: { agent: "executor" } };
    const before = clone(message);
    assert.equal(formatCompactSupervisorRequest(message), expected);
    assert.deepEqual(message, before);
  }
});

test("compact supervisor renderer moves the dispatch title to the header and hides the fixed reply hint", () => {
  const message = {
    customType: "subagent_supervisor_request",
    content: [
      "T6 is blocked after its single permitted install retry.",
      "Please provide an authorized resolver decision or close T6 as blocked.",
      "",
      "Reply with: subagent_supervisor({ action: \"reply\", replyTo: \"request-1\", message: \"...\" }) [物化 spec 并完成 T6]",
    ].join("\n"),
    details: {
      agent: "executor",
      requestId: "request-1",
      runId: "run-1",
      title: "物化 spec 并完成 T6",
    },
  };
  const before = clone(message);

  const rendered = formatCompactSupervisorRequest(message);

  assert.equal(
    rendered,
    "← (executor) 物化 spec 并完成 T6:\nT6 is blocked after its single permitted install retry.\nPlease provide an authorized resolver decision or close T6 as blocked.",
  );
  assert.doesNotMatch(rendered, /Reply with|subagent_supervisor|request-1|\[物化 spec/);
  assert.deepEqual(message, before);
});

test("compact notification uses leaf presentation metadata instead of raw failed lifecycle", () => {
  const rendered = formatCompactSubagentNotification({
    content: "Background tasks failed (2): **executor**, **reviewer**",
    details: { titles: ["TDD RED", "Need context"], presentations: ["reported", "needs-context"] },
  });
  assert.equal(rendered, "◇ TDD RED · reported\n? Need context · needs-context");
  assert.doesNotMatch(rendered, /✗|runtime-failed/);
});
