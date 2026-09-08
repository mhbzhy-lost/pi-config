import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createGoalRuntimeTrace, runtimeTraceEnabled } from "../src/goal-engine/runtime-trace.ts";
import { createGoalEngineExtension } from "../src/goal-engine/extension.ts";
import { resolveGoalStateScope } from "../src/goal-engine/state-scope.ts";

test("runtime trace is disabled by default and does not write", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-trace-"));
  const trace = createGoalRuntimeTrace({ root, config: {} });
  assert.equal(trace.enabled, false);
  trace.record("tool_call_seen", { toolName: "goal_status" });
  assert.equal(existsSync(join(root, "runtime-trace.jsonl")), false);
});

test("runtime trace can be enabled by settings or PI_GOAL_ENGINE_TRACE=1", () => {
  assert.equal(runtimeTraceEnabled({ config: { runtimeTrace: { enabled: true } }, env: {} }), true);
  assert.equal(runtimeTraceEnabled({ config: { runtimeTrace: { enabled: false } }, env: { PI_GOAL_ENGINE_TRACE: "1" } }), true);
  assert.equal(runtimeTraceEnabled({ config: { runtimeTrace: { enabled: true } }, env: { PI_GOAL_ENGINE_TRACE: "0" } }), false);
});

test("enabled runtime trace appends complete correlated observation records", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-trace-"));
  const trace = createGoalRuntimeTrace({ root, config: { runtimeTrace: { enabled: true } }, sessionId: "s1" });
  const result = trace.record("tool_call_seen", {
    turnId: "turn-1",
    toolCallId: "call-1",
    toolName: "goal_status",
    input: { action_token: "secret", goal_id: "g1" },
  });
  assert.equal(result, true);
  const entries = readFileSync(join(root, "runtime-trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const entry = entries.find((candidate) => candidate.kind === "tool_call_seen");
  assert.equal(entries[0].kind, "trace_config");
  assert.equal(entry.schema, "goal-runtime.trace.v1");
  assert.equal(entry.kind, "tool_call_seen");
  assert.equal(entry.sessionId, "s1");
  assert.equal(entry.toolCallId, "call-1");
  assert.deepEqual(entry.input, { action_token: "secret", goal_id: "g1" });
  assert.equal(Number.isInteger(entry.seq), true);
});

test("one root writer keeps sequence monotonic across session identities", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-trace-"));
  const trace = createGoalRuntimeTrace({ root, config: { runtimeTrace: { enabled: true } }, sessionId: "s1" });
  trace.record("session_start", { reason: "new" });
  trace.setSessionId("s2");
  trace.record("session_start", { reason: "reload" });
  const entries = readFileSync(join(root, "runtime-trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(entries.map((entry) => entry.seq), [1, 2, 3]);
  assert.equal(entries[1].sessionId, "s1");
  assert.equal(entries[2].sessionId, "s2");
});

test("enabled trace preserves hook payload fields for debugging", () => {
  const root = mkdtempSync(join(tmpdir(), "goal-trace-"));
  const trace = createGoalRuntimeTrace({ root, config: { runtimeTrace: { enabled: true } } });
  trace.record("debug_payload", { content: [{ type: "text", text: "result" }], prompt: "resume", result: { ok: true }, data: { eventId: "e1" } });
  const entries = readFileSync(join(root, "runtime-trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const entry = entries.find((candidate) => candidate.kind === "debug_payload");
  assert.deepEqual(entry.content, [{ type: "text", text: "result" }]);
  assert.equal(entry.prompt, "resume");
  assert.deepEqual(entry.result, { ok: true });
  assert.deepEqual(entry.data, { eventId: "e1" });
});

test("tool call gate is observable without adding a control tool", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "goal-trace-"));
  const hooks = {};
  const pi = {
    tools: [],
    sessionManager: { getSessionId: () => "s1", getSessionFile: () => join(cwd, "session.jsonl"), getEntries: () => [], getLeafId: () => "leaf-1" },
    registerTool(definition) { this.tools.push(definition); },
    on(name, handler) { (hooks[name] ||= []).push(handler); },
  };
  createGoalEngineExtension(pi, { runtimeTrace: { enabled: true }, enforceActionTokens: false, goalStateEnv: {} });
  await hooks.tool_call[0]({ toolName: "read", toolCallId: "call-1", input: { path: "README.md" } }, { cwd, sessionManager: pi.sessionManager });
  const lines = readFileSync(join(cwd, ".state/goal-engine/runtime-trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.some((entry) => entry.kind === "tool_call_seen" && entry.toolCallId === "call-1"), true);
  assert.equal(lines.some((entry) => entry.kind === "tool_call_gate" && entry.decision === "allow"), true);
  assert.equal(pi.tools.length, 8);
});

test("PI_GOAL_ENGINE_TRACE=1 enables extension tracing without runtimeTrace config", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "goal-trace-"));
  const hooks = {};
  const pi = {
    tools: [],
    sessionManager: { getSessionId: () => "s-env", getSessionFile: () => join(cwd, "session.jsonl"), getEntries: () => [], getLeafId: () => "leaf-env" },
    registerTool(definition) { this.tools.push(definition); },
    on(name, handler) { (hooks[name] ||= []).push(handler); },
  };
  createGoalEngineExtension(pi, { runtimeTraceEnv: { PI_GOAL_ENGINE_TRACE: "1" }, enforceActionTokens: false, goalStateEnv: {} });
  await hooks.tool_call[0]({ toolName: "read", toolCallId: "env-call-1", input: { path: "README.md" } }, { cwd, sessionManager: pi.sessionManager });
  const traceFile = join(cwd, ".state/goal-engine/runtime-trace.jsonl");
  assert.equal(existsSync(traceFile), true);
  const lines = readFileSync(traceFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.some((entry) => entry.kind === "tool_call_seen" && entry.toolCallId === "env-call-1"), true);
});

test("observer traces hooks when Pi omits cwd from ExtensionContext", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "goal-trace-"));
  const globalRoot = mkdtempSync(join(tmpdir(), "goal-trace-global-"));
  const hooks = {};
  const sessionManager = {
    getCwd: () => cwd,
    getSessionId: () => "s-no-cwd",
    getSessionFile: () => join(cwd, "session.jsonl"),
    getEntries: () => [],
    getLeafId: () => "leaf-no-cwd",
  };
  const pi = {
    tools: [],
    sessionManager,
    registerTool(definition) { this.tools.push(definition); },
    on(name, handler) { (hooks[name] ||= []).push(handler); },
  };
  const goalStateEnv = { PI_CODING_GOAL_DIR: globalRoot };
  createGoalEngineExtension(pi, { runtimeTrace: { enabled: true }, enforceActionTokens: false, goalStateEnv });
  const ctxWithoutCwd = { sessionManager };
  await hooks.input[0]({ source: "rpc", text: "debug this" }, ctxWithoutCwd);
  await hooks.before_agent_start[0]({ prompt: "resume" }, ctxWithoutCwd);
  await hooks.tool_call[0]({ toolName: "read", toolCallId: "no-cwd-call", input: { path: "README.md" } }, ctxWithoutCwd);
  const traceRoot = resolveGoalStateScope({ cwd, env: goalStateEnv }).preferredRoot;
  const traceFile = join(traceRoot, "runtime-trace.jsonl");
  assert.equal(existsSync(traceFile), true);
  const lines = readFileSync(traceFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.some((entry) => entry.kind === "user_message_received" && entry.text === "debug this"), true);
  assert.equal(lines.some((entry) => entry.kind === "before_agent_start" && entry.prompt === "resume"), true);
  assert.equal(lines.some((entry) => entry.kind === "tool_call_seen" && entry.toolCallId === "no-cwd-call"), true);
});
