import assert from "node:assert/strict";
import test from "node:test";

import { createPiSubagentsExecutionBackend } from "../scripts/lib/plan/pi-subagents-execution-backend.mjs";

function events() {
  const listeners = new Map();
  return {
    on(channel, listener) { listeners.set(channel, listener); return () => listeners.delete(channel); },
    emit(channel, event) { listeners.get(channel)?.(event); },
  };
}

test("late binding publishes a complete SUPERSEDE_STOP_FAILED fact", async () => {
  const lifecycle = events();
  const facts = [];
  const backend = createPiSubagentsExecutionBackend({
    events: lifecycle,
    emitFact: (fact) => facts.push(fact),
    supersedeTimeoutMs: 10,
    supersedePollIntervalMs: 1,
    rpc: {
      async ping() { return { version: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"], session: { sessionId: "rpc-session", sessionFile: "/sessions/plan.jsonl" } }; },
      async spawn() { return new Promise(() => {}); },
      async stop() { throw new Error("late stop rejection"); },
      dispose() {},
    },
  });
  await backend.assertCapabilities({ rpcVersion: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] });
  void backend.spawn({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1", agent: "executor", task: "task", cwd: "/attempts/attempt-1", output: "/results/attempt-1.json", timeoutMs: 1 }).catch(() => {});
  await assert.rejects(backend.supersede({ dispatchId: "attempt-1.dispatch.1", attemptId: "attempt-1" }));
  lifecycle.emit("subagent:async-started", { id: "run-1", asyncDir: "/async/run-1", cwd: "/attempts/attempt-1", sessionId: "/sessions/plan.jsonl" });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const fact = facts.find((candidate) => candidate.code === "SUPERSEDE_STOP_FAILED");
  assert.deepEqual({ ...fact, observedAt: "observed" }, {
    type: "execution.protocol-violation",
    code: "SUPERSEDE_STOP_FAILED",
    message: "Background supersede stop failed",
    dispatchId: "attempt-1.dispatch.1",
    attemptId: "attempt-1",
    runId: "run-1",
    asyncDir: "/async/run-1",
    cwd: "/attempts/attempt-1",
    observedAt: "observed",
  });
  backend.dispose();
});
