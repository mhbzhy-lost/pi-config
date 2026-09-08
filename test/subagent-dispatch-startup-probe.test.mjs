import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSubagentDispatchTraceFileSink, createTypedSubagentExtension } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { readBoundedDispatchTrace } from "../scripts/probes/subagent-dispatch-startup.ts";

function createPi() {
  const tools = [];
  const listeners = new Map();
  return {
    tools,
    events: {
      on(name, listener) {
        const entries = listeners.get(name) ?? [];
        entries.push(listener);
        listeners.set(name, entries);
        return () => entries.splice(entries.indexOf(listener), 1);
      },
      emit(name, payload) {
        for (const listener of listeners.get(name) ?? []) listener(payload);
      },
    },
    registerTool(tool) { tools.push(tool); },
    on() {},
  };
}

test("records correlated dispatch phases without retaining task content", async () => {
  const pi = createPi();
  const trace = [];
  const rpc = {
    async ping(options) {
      options.diagnostic.sink("rpc-ping-sent", { method: "ping", requestId: "ping-1" });
      options.diagnostic.sink("rpc-ping-replied", { method: "ping", requestId: "ping-1" });
      return { version: 1, methods: ["spawn"], session: { sessionId: "session-1", sessionFile: "session-1", cwd: "/repo" } };
    },
    async spawn(_params, options) {
      options.diagnostic.sink("rpc-spawn-sent", { method: "spawn", requestId: "spawn-1" });
      options.diagnostic.sink("rpc-spawn-replied", { method: "spawn", requestId: "spawn-1" });
      pi.events.emit("subagent:async-started", {
        runId: "leaf-1", asyncDir: "/tmp/leaf-1", sessionId: "session-1", pid: 7,
        agent: "executor", workflowKey: "typed-dispatch-1", parentWorkflowRunId: "root-1",
      });
      return { details: { runId: "root-1", asyncDir: "/tmp/root-1" } };
    },
    dispose() {},
  };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "dispatch-1",
    diagnosticSink(entry) { trace.push(entry); },
    discoverAgents: async () => ({ agents: [{ name: "executor" }] }),
  });

  const result = await pi.tools[0].execute("tool-1", {
    agent: "executor", title: "Trace", task: "secret task body",
  }, undefined, undefined, { cwd: "/repo" });

  assert.equal(result.isError, false);
  assert.deepEqual(trace.map((entry) => entry.phase), [
    "tool-entered", "agent-discovery-started", "agent-discovery-finished", "rpc-ping-sent", "rpc-ping-replied",
    "rpc-spawn-sent", "rpc-spawn-replied", "leaf-wait-started", "leaf-wait-finished", "tool-returned",
  ]);
  assert.ok(trace.every((entry) => entry.toolCallId === "tool-1"));
  assert.ok(trace.every((entry) => Number.isSafeInteger(entry.monotonicMs)));
  assert.ok(trace.every((entry) => !JSON.stringify(entry).includes("secret task body")));
});

test("explicit trace file holds a caller-owned fd and stops after replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-trace-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  const sink = createSubagentDispatchTraceFileSink(file);
  sink({ version: 1, toolCallId: "tool-1", phase: "tool-entered", monotonicMs: 1, task: "must not persist" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    version: 1, toolCallId: "tool-1", phase: "tool-entered", monotonicMs: 1,
  });
  const replacement = join(directory, "replacement.jsonl");
  writeFileSync(replacement, "", { mode: 0o600 });
  renameSync(replacement, file);
  sink({ version: 1, toolCallId: "tool-1", phase: "tool-returned", monotonicMs: 2 });
  assert.equal(readFileSync(file, "utf8"), "");
  sink.dispose();
  chmodSync(file, 0o644);
  assert.throws(() => createSubagentDispatchTraceFileSink(file), /caller-owned 0600 regular file/);
});

test("startup probe requires the actual parent session and ignores a partial final line", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-probe-"));
  const file = join(directory, "trace.jsonl");
  writeFileSync(file, `${JSON.stringify({ version: 1, parentSessionId: "parent-1", toolCallId: "tool-1", phase: "rpc-ping-replied", monotonicMs: 2 })}\n{`, { mode: 0o600 });
  const result = readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1", maxBytes: 1024, maxRecords: 4, windowMs: 10, outputBudget: 1024 });
  assert.equal(result.cause, "observed");
  assert.equal(result.partialTrailingLine, true);
  assert.equal(readBoundedDispatchTrace({ file, parentSessionId: "other", toolCallId: "tool-1" }).cause, "unproven");
});

test("startup probe discards a truncated first line and returns structured unproven results for invalid records", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-dispatch-probe-"));
  const file = join(directory, "trace.jsonl");
  const complete = JSON.stringify({ version: 1, parentSessionId: "parent-1", toolCallId: "tool-1", phase: "tool-entered", monotonicMs: 2 });
  writeFileSync(file, `partial\n${complete}\n`, { mode: 0o600 });
  const result = readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1", maxBytes: Buffer.byteLength(complete) + 3, maxRecords: 4, windowMs: 10, outputBudget: 1024 });
  assert.equal(result.partialLeadingLine, true);
  assert.equal(result.records.length, 1);

  writeFileSync(file, `${JSON.stringify({ version: 2, parentSessionId: "parent-1", toolCallId: "tool-1", phase: "tool-entered", monotonicMs: 2 })}\n`, { mode: 0o600 });
  assert.equal(readBoundedDispatchTrace({ file, parentSessionId: "parent-1", toolCallId: "tool-1" }).invalidTrace, "invalid-version");
});
