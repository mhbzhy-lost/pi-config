import assert from "node:assert/strict";
import test from "node:test";

import * as compactRendering from "../packages/pi-subagents-enhanced/src/tui/compact-rendering.ts";
const {
  formatCompactSubagentNotification,
  formatCompactSubagentWorkspaceReminder,
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
    "executor: 迁移 Shell 到官方 fullscreen · started",
  );
  assert.deepEqual(result, before);
});

test("compact spawn summary supports generic failures and rejects missing structured identity", () => {
  assert.equal(
    formatCompactSubagentSpawnSummary({ isError: true, details: { agent: "reviewer", title: "审查兼容性报告" } }),
    "reviewer: 审查兼容性报告 · failed",
  );
  for (const result of [
    { content: [{ type: "text", text: "Started guessed: from content" }], details: { title: "Missing agent" } },
    { details: { agent: "executor", title: "" } },
    { details: { agent: "executor" } },
  ]) assert.equal(formatCompactSubagentSpawnSummary(result), undefined);
});

test("compact notification shows only one title and completion state without mutating the message", () => {
  const registry = getTitleRegistry();
  registry.remember("1ae07ab7-0000-4000-8000-000000000001", "Cobalt title verification");
  const message = {
    customType: "subagent-notify",
    content: [
      "Background task completed: **delegate** [Cobalt title verification]",
      "",
      "COBALT_RUN_OK",
      "",
      "Retention-managed async directory: /tmp/retained/1ae07ab7-0000-4000-8000-000000000001/",
      "",
      "Session file: /tmp/session.jsonl",
    ].join("\n"),
    details: { titles: ["Wrong historical title"] },
  };
  const before = clone(message);

  const rendered = formatCompactSubagentNotification(message);

  assert.equal(rendered, "✓ Cobalt title verification · completed");
  assert.doesNotMatch(rendered, /COBALT_RUN_OK|Session file|delegate/);
  assert.deepEqual(message, before);
});

test("compact notification keeps workflow dispatch receipts distinct from child completion", () => {
  const receipt = {
    content: "Background task completed: **workflow** (dispatch complete; 1 child running or uncollected)",
  };
  const before = clone(receipt);
  assert.equal(formatCompactSubagentNotification(receipt), "派发完成，1个子任务仍运行或待收集");
  assert.deepEqual(receipt, before);
  assert.equal(formatCompactSubagentNotification({
    content: "Background task completed: **reviewer**",
  }), "✓ reviewer · completed");
  assert.equal(formatCompactSubagentNotification({
    content: "Background task completed: **workflow** (dispatch complete; child state unavailable)",
  }), "派发完成，子任务仍运行或待收集（数量未知）");
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
    "Async run not found. Provide id or dir.",
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

test("compact interrupt shows a short success state and keeps errors visible", () => {
  const args = { action: "interrupt", id: "run-int-1" };
  const success = {
    content: [{ type: "text", text: "Interrupt requested for async run run-int-1." }],
    details: { mode: "management", results: [] },
  };
  const beforeArgs = clone(args);
  const beforeResult = clone(success);

  assert.equal(formatCompactSubagentToolResult(success, args), "已中断 · run-int-1");
  assert.deepEqual(args, beforeArgs);
  assert.deepEqual(success, beforeResult);

  const failure = {
    content: [{ type: "text", text: "No running async run with an interrupt-capable pid was found for 'run-int-1'." }],
    isError: true,
    details: { mode: "management", results: [] },
  };
  assert.equal(
    formatCompactSubagentToolResult(failure, { action: "interrupt", id: "run-int-1" }),
    "No running async run with an interrupt-capable pid was found for 'run-int-1'.",
  );
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

test("compact supervisor renderer removes only the duplicated trailing dispatch title", () => {
  const message = {
    customType: "subagent_supervisor_request",
    content: "UPDATE: Starting isolated [probe]. I will preserve this body. [验证 external podspec 注册]",
    details: {
      agent: "executor",
      runId: "run-1",
      title: "验证 external podspec 注册",
    },
  };
  const before = clone(message);

  const rendered = formatCompactSupervisorRequest(message);

  assert.equal(
    rendered,
    "← (executor) 验证 external podspec 注册:\nUPDATE: Starting isolated [probe]. I will preserve this body.",
  );
  assert.doesNotMatch(rendered, /\[验证 external podspec 注册\]$/);
  assert.deepEqual(message, before);
});

test("compact workspace reminder renders a separate disposition summary without mutation", () => {
  const message = {
    customType: "subagent-workspace-reminder",
    content: "Subagent workspace awaiting disposition: workspace-a. Call subagent_worktree({action:\"status\",workspace_id:\"workspace-a\"}), then integrate, discard, or preserve according to the returned allowed_dispositions.",
    details: { schemaVersion: "subagent-workspace-reminder.v1", rootSessionId: "root", runId: "run", workspaceId: "workspace-a", workspaceState: "preserved", mode: "coding" },
  };
  const before = clone(message);
  assert.equal(formatCompactSubagentWorkspaceReminder(message), "↳ workspace workspace-a · preserved; release when no longer needed");
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

test("compact list projects only the roster rows without the Available agents heading", () => {
  // 夹具镜像 extension.ts executeControl(list) 的真实回执：details.agents 为扁平
  // description 字段，content JSON 为 name+frontmatter 条目。
  const result = {
    content: [{
      type: "text",
      text: JSON.stringify([
        { name: "delegate", frontmatter: { description: "派发并跟踪子任务" } },
        { name: "executor", frontmatter: { description: "执行具体实现" } },
        { name: "reviewer", frontmatter: { description: "审查产出" } },
      ], null, 2),
    }],
    details: {
      agents: [
        { name: "delegate", description: "派发并跟踪子任务", model: null, models: [], tools: null },
        { name: "executor", description: "执行具体实现", model: null, models: [], tools: null },
        { name: "reviewer", description: "审查产出", model: null, models: [], tools: null },
      ],
    },
  };
  const before = clone(result);
  const args = { action: "list" };
  const beforeArgs = clone(args);

  const rendered = formatCompactSubagentToolResult(result, args);

  assert.equal(
    rendered,
    "• delegate：派发并跟踪子任务\n• executor：执行具体实现\n• reviewer：审查产出",
  );
  assert.doesNotMatch(rendered, /Available agents/);
  assert.deepEqual(result, before);
  assert.deepEqual(args, beforeArgs);
});

test("compact list falls back to the raw roster JSON when structured details are missing", () => {
  // details 缺失时只读 parse 原 content JSON，投影不变且不改原始 payload。
  const result = {
    content: [{
      type: "text",
      text: JSON.stringify([
        { name: "delegate", frontmatter: { description: "派发并跟踪子任务" } },
        { name: "executor", frontmatter: { description: "执行具体实现" } },
      ], null, 2),
    }],
  };
  const before = clone(result);

  const rendered = formatCompactSubagentToolResult(result, { action: "list" });

  assert.equal(rendered, "• delegate：派发并跟踪子任务\n• executor：执行具体实现");
  assert.doesNotMatch(rendered, /Available agents/);
  assert.deepEqual(result, before);
});

test("compact list keeps a neutral empty-roster placeholder without inventing rows", () => {
  const emptyDetails = {
    content: [{ type: "text", text: JSON.stringify([], null, 2) }],
    details: { agents: [] },
  };
  const beforeDetails = clone(emptyDetails);
  assert.equal(formatCompactSubagentToolResult(emptyDetails, { action: "list" }), "(no roster)");
  assert.deepEqual(emptyDetails, beforeDetails);

  const emptyContent = { content: [{ type: "text", text: "[]" }] };
  const beforeContent = clone(emptyContent);
  assert.equal(formatCompactSubagentToolResult(emptyContent, { action: "list" }), "(no roster)");
  assert.deepEqual(emptyContent, beforeContent);

  const unparseable = { content: [{ type: "text", text: "agent discovery unavailable" }] };
  const beforeUnparseable = clone(unparseable);
  assert.equal(formatCompactSubagentToolResult(unparseable, { action: "list" }), "(no roster)");
  assert.deepEqual(unparseable, beforeUnparseable);
});

test("compact list errors pass through unchanged and nearby actions keep their projections", () => {
  // list 失败回执原样透传，不误标成功也不加名册投影。
  const failure = {
    content: [{ type: "text", text: "Agent discovery failed: no pi/agents directory." }],
    isError: true,
  };
  const beforeFailure = clone(failure);
  assert.equal(
    formatCompactSubagentToolResult(failure, { action: "list" }),
    "Agent discovery failed: no pi/agents directory.",
  );
  assert.deepEqual(failure, beforeFailure);

  // 非 list 动作不受名册渲染变化影响（interrupt 投影既有行为回归）。
  const interrupt = {
    content: [{ type: "text", text: "Interrupt requested for async run run-list-1." }],
    details: { mode: "management", results: [] },
  };
  const beforeInterrupt = clone(interrupt);
  assert.equal(
    formatCompactSubagentToolResult(interrupt, { action: "interrupt", id: "run-list-1" }),
    "已中断 · run-list-1",
  );
  assert.deepEqual(interrupt, beforeInterrupt);
});

// S4：新每操作独立工具的 args 不再携带 action，显示层必须按工具名映射固定 operation；
// 旧历史工具名（无 context.tool 提示或提示为旧名）继续按 args.action 投影。
test("compact rendering routes new operation tools by tool name without args.action", () => {
  const statusResult = { content: [{ type: "text", text: "State: running\nRun: run-1" }], details: { runId: "run-1" } };
  assert.equal(
    formatCompactSubagentToolResult(statusResult, { id: "run-1" }, { tool: "subagent_run_status" }),
    "Status: running · run: run-1",
  );
  // 同一 result/args 在无工具名提示时不冒充 status 投影（旧路径按 args.action 判定）。
  assert.equal(
    formatCompactSubagentToolResult(statusResult, { id: "run-1" }),
    "State: running\nRun: run-1",
  );
  assert.equal(
    formatCompactSubagentToolResult(
      { content: [{ type: "text", text: "Interrupt requested for async run run-9." }] },
      { id: "run-9" },
      { tool: "subagent_run_interrupt" },
    ),
    "已中断 · run-9",
  );
  const steerArgs = { runId: "run-steer", message: "继续检查失败路径" };
  const beforeSteer = clone(steerArgs);
  const steered = formatCompactSubagentToolResult(
    { content: [{ type: "text", text: "Steered." }], details: { runId: "run-steer" } },
    steerArgs,
    { tool: "subagent_run_steer" },
  );
  // title registry 是模块级单例，具体标题/agent 由其他用例登记；本用例只验证按工具名进入 steer 投影。
  assert.match(steered, /^→ \[steer\] /);
  assert.match(steered, /\n继续检查失败路径$/);
  assert.deepEqual(steerArgs, beforeSteer, "显示层不得改写原 args");
  // roster 与 legacy action:"list" 共用名册投影。
  const roster = { content: [{ type: "text", text: JSON.stringify([{ name: "executor", frontmatter: { description: "执行" } }]) }], details: { agents: [{ name: "executor", description: "执行" }] } };
  assert.equal(formatCompactSubagentToolResult(roster, {}, { tool: "subagent_roster" }), "• executor：执行");
  assert.equal(formatCompactSubagentToolResult(roster, { action: "list" }), "• executor：执行");
  // 新工具名的 Host 校验失败文案：isError 权威时原文完整保留（不折叠错误事实）；
  // Host 只透传 {content, details} 时同样只保首行摘要，不展开 Received arguments。
  const validation = {
    isError: true,
    content: [{ type: "text", text: ['Validation failed for tool "subagent_start":', "  - $.agent: expected string", "", "Received arguments:", JSON.stringify({ agent: 1 })].join("\n") }],
  };
  const renderedValidation = formatCompactSubagentToolResult(validation, { agent: 1 }, { isError: true, tool: "subagent_start" });
  assert.match(renderedValidation, /Validation failed for tool "subagent_start":/);
  assert.match(renderedValidation, /Received arguments/);
  const trimmed = formatCompactSubagentToolResult({ content: validation.content }, { agent: 1 }, { tool: "subagent_start" });
  assert.match(trimmed, /Validation failed for tool "subagent_start":/);
  assert.doesNotMatch(trimmed, /Received arguments/);
});

test("compact supervisor rendering routes reply by tool name and keeps legacy args.action history", () => {
  const { formatCompactSupervisorToolResult } = compactRendering;
  const result = { content: [{ type: "text", text: "Reply recorded." }], details: { replyTo: "request-1", runId: "run-1", agent: "executor" } };
  const args = { replyTo: "request-1", message: "按方案 A 执行" };
  const expected = "→ [reply] (executor)\nRun: run-1\nReply to: request-1\n\n按方案 A 执行";
  assert.equal(formatCompactSupervisorToolResult(result, args, { tool: "supervisor_request_reply" }), expected);
  assert.equal(formatCompactSupervisorToolResult(result, { ...args, action: "reply" }), expected);
  // pending/status 只读工具不得复用 reply 正文投影。
  assert.equal(
    formatCompactSupervisorToolResult({ content: [{ type: "text", text: "no pending requests" }] }, {}, { tool: "supervisor_request_pending" }),
    "no pending requests",
  );
  assert.deepEqual(args, { replyTo: "request-1", message: "按方案 A 执行" }, "显示层不得改写原 args");
});

test("operation-by-tool maps cover exactly the registered operation tool names", () => {
  const { SUBAGENT_OPERATION_BY_TOOL, SUPERVISOR_OPERATION_BY_TOOL, WORKSPACE_OPERATION_BY_TOOL, LEGACY_OPERATION_TOOL_NAMES } = compactRendering;
  assert.deepEqual(Object.keys(SUBAGENT_OPERATION_BY_TOOL), [
    "subagent_roster", "subagent_start", "subagent_run_status", "subagent_run_steer",
    "subagent_run_interrupt", "subagent_run_resume", "subagent_run_stop",
  ]);
  assert.deepEqual(Object.keys(WORKSPACE_OPERATION_BY_TOOL), [
    "managed_workspace_list", "managed_workspace_status", "managed_workspace_dispose", "managed_workspace_release",
  ]);
  assert.deepEqual(Object.keys(SUPERVISOR_OPERATION_BY_TOOL), [
    "supervisor_request_pending", "supervisor_request_status", "supervisor_request_reply",
  ]);
  assert.deepEqual([...LEGACY_OPERATION_TOOL_NAMES], ["subagent", "subagent_worktree", "subagent_supervisor"]);
});
