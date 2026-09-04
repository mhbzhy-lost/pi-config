import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";

import {
  WorkflowSpawnError,
  buildWorkflowSpawn,
  childStartTimeoutMs,
  createWorkflowChildStartCollector,
} from "../packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts";

function createEvents() {
  const listeners = new Map();
  return {
    on(type, listener) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
      return () => current.delete(listener);
    },
    emit(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function leafEvent(overrides = {}) {
  return {
    id: "leaf-run-1",
    runId: "leaf-run-1",
    asyncDir: "/tmp/leaf-run-1",
    pid: 43210,
    sessionId: "session-1",
    agent: "executor",
    workflowKey: "typed-request-1",
    parentWorkflowRunId: "workflow-run-1",
    ...overrides,
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof WorkflowSpawnError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("compiles one safe checked leaf workflow without public direct-execution fields", async () => {
  const task = "line 1\nquote: \"; globalThis.workflowInjected = true; //\nbacktick: `";
  const request = buildWorkflowSpawn({
    workflowKey: "typed-request-1",
    agent: "executor",
    task,
    cwd: "/repo",
    context: "fresh",
    timeoutMs: 900_000,
    acceptance: {
      criteria: ["The facade remains project-owned."],
      evidence: ["changed-files", "commands-run"],
    },
    child: {
      output: false,
      subagentOnlyExtensions: ["/package/child-extensions/root-session-owner.ts", "/package/child-extensions/acceptance-evidence.ts"],
    },
  });

  assert.deepEqual({ ...request, workflowScript: "<script>" }, {
    workflowScript: "<script>",
    cwd: "/repo",
    context: "fresh",
    async: true,
    timeoutMs: 900_000,
    artifacts: true,
    worktree: false,
    mission: false,
    chatProgress: "off",
  });
  for (const key of ["agent", "task", "title", "clarify", "acceptance", "chain", "tasks", "parallel"]) {
    assert.equal(Object.hasOwn(request, key), false, `${key} must remain inside the private workflow script`);
  }

  const started = [];
  const sandbox = {
    runs: {
      async run(key, params) {
        started.push({ key, params });
        return { key, runId: "leaf-run-1" };
      },
    },
  };
  const result = await runInNewContext(`(async () => {\n${request.workflowScript}\n})()`, sandbox);

  assert.deepEqual(result, { key: "typed-request-1", runId: "leaf-run-1" });
  assert.equal(sandbox.workflowInjected, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(started)), [{
    key: "typed-request-1",
    params: {
      agent: "executor",
      task,
      async: true,
      worktree: false,
      output: false,
      subagentOnlyExtensions: ["/package/child-extensions/root-session-owner.ts", "/package/child-extensions/acceptance-evidence.ts"],
      acceptance: {
        level: "checked",
        criteria: ["The facade remains project-owned."],
        evidence: ["changed-files", "commands-run"],
      },
    },
  }]);
  assert.equal(Object.hasOwn(started[0].params.acceptance, "verify"), false);
});

test("keeps supported generic execution controls inside the workflow leaf", async () => {
  const request = buildWorkflowSpawn({
    workflowKey: "typed-generic-1",
    agent: "reviewer",
    task: "Review the exact diff.",
    cwd: "/repo",
    context: "fork",
    timeoutMs: 60_000,
    artifacts: false,
    child: {
      model: "fake/deterministic",
      output: "review.md",
      outputMode: "file-only",
      skill: ["review"],
      reads: false,
      acceptance: { level: "attested", evidence: ["review-findings"] },
    },
  });
  const started = [];
  await runInNewContext(`(async () => {\n${request.workflowScript}\n})()`, {
    runs: { async run(key, params) { started.push({ key, params }); return { key }; } },
  });

  assert.equal(Object.hasOwn(request, "agent"), false);
  assert.equal(Object.hasOwn(request, "acceptance"), false);
  assert.equal(request.artifacts, false);
  assert.deepEqual(JSON.parse(JSON.stringify(started)), [{
    key: "typed-generic-1",
    params: {
      agent: "reviewer",
      task: "Review the exact diff.",
      async: true,
      worktree: false,
      model: "fake/deterministic",
      output: "review.md",
      outputMode: "file-only",
      skill: ["review"],
      reads: false,
      acceptance: { level: "attested", evidence: ["review-findings"] },
    },
  }]);
});

test("omits an unspecified generic timeout instead of inventing one", () => {
  const request = buildWorkflowSpawn({
    workflowKey: "typed-generic-no-timeout",
    agent: "reviewer",
    task: "Review the exact diff.",
    cwd: "/repo",
    context: "fresh",
    child: {},
  });

  assert.equal(Object.hasOwn(request, "timeoutMs"), false);
});

test("binds a matching leaf event that arrived before the workflow root reply", async () => {
  const events = createEvents();
  const collector = createWorkflowChildStartCollector(events, {
    workflowKey: "typed-request-1",
    agent: "executor",
    sessionId: "session-1",
    timeoutMs: 50,
  });

  events.emit("subagent:async-started", leafEvent());
  const binding = await collector.waitFor({ runId: "workflow-run-1" });

  assert.deepEqual(binding, { runId: "leaf-run-1", asyncDir: "/tmp/leaf-run-1" });
  assert.equal(events.listenerCount("subagent:async-started"), 0);
});

test("keeps validated leaf identity private while reporting it to the internal binding hook", async () => {
  const events = createEvents();
  const internal = [];
  const collector = createWorkflowChildStartCollector(events, {
    workflowKey: "typed-request-1",
    agent: "executor",
    sessionId: "session-1",
    timeoutMs: 50,
    onBinding(binding) { internal.push(binding); },
  });
  const pending = collector.waitFor({ runId: "workflow-run-1" });
  events.emit("subagent:async-started", leafEvent({ pid: 43210 }));

  assert.deepEqual(await pending, { runId: "leaf-run-1", asyncDir: "/tmp/leaf-run-1" });
  assert.deepEqual(internal, [{ runId: "leaf-run-1", asyncDir: "/tmp/leaf-run-1", sessionId: "session-1", pid: 43210, agent: "executor" }]);
});

test("buffered binding hook failure rejects within its watchdog and releases listener", async () => {
  const events = createEvents(); const error = new Error("broker rejected identity");
  const collector = createWorkflowChildStartCollector(events, { workflowKey: "typed-request-1", agent: "executor", sessionId: "session-1", timeoutMs: 50, onBinding() { throw error; } });
  events.emit("subagent:async-started", leafEvent());
  let watchdog;
  try {
    await assert.rejects(Promise.race([collector.waitFor({ runId: "workflow-run-1" }), new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("buffered binding hook failure watchdog")), 50); })]), (actual) => actual === error);
  } finally { clearTimeout(watchdog); }
  assert.equal(events.listenerCount("subagent:async-started"), 0);
});

test("ignores another workflow's leaf event until the matching leaf starts", async () => {
  const events = createEvents();
  const collector = createWorkflowChildStartCollector(events, {
    workflowKey: "typed-request-1",
    agent: "executor",
    sessionId: "session-1",
    timeoutMs: 50,
  });
  const pending = collector.waitFor({ runId: "workflow-run-1" });

  events.emit("subagent:async-started", leafEvent({ parentWorkflowRunId: "other-workflow" }));
  assert.equal(events.listenerCount("subagent:async-started"), 1);
  events.emit("subagent:async-started", leafEvent());

  assert.deepEqual(await pending, { runId: "leaf-run-1", asyncDir: "/tmp/leaf-run-1" });
});

test("fails closed when one workflow has conflicting leaf identities", async () => {
  const events = createEvents();
  const collector = createWorkflowChildStartCollector(events, {
    workflowKey: "typed-request-1",
    agent: "executor",
    sessionId: "session-1",
    timeoutMs: 50,
  });

  events.emit("subagent:async-started", leafEvent());
  events.emit("subagent:async-started", leafEvent({ id: "leaf-run-2", runId: "leaf-run-2", asyncDir: "/tmp/leaf-run-2" }));

  await rejectsWithCode(collector.waitFor({ runId: "workflow-run-1" }), "WORKFLOW_CHILD_BINDING_INVALID");
  assert.equal(events.listenerCount("subagent:async-started"), 0);
});

test("fails closed when a matching leaf event omits its async directory", async () => {
  const events = createEvents();
  const collector = createWorkflowChildStartCollector(events, {
    workflowKey: "typed-request-1",
    agent: "executor",
    sessionId: "session-1",
    timeoutMs: 50,
  });
  const pending = collector.waitFor({ runId: "workflow-run-1" });

  events.emit("subagent:async-started", leafEvent({ asyncDir: undefined }));

  await rejectsWithCode(pending, "WORKFLOW_CHILD_BINDING_INVALID");
  assert.equal(events.listenerCount("subagent:async-started"), 0);
});

test("times out without a matching leaf event and releases its listener", async () => {
  const events = createEvents();
  const collector = createWorkflowChildStartCollector(events, {
    workflowKey: "typed-request-1",
    agent: "executor",
    sessionId: "session-1",
    timeoutMs: 10,
  });

  await rejectsWithCode(collector.waitFor({ runId: "workflow-run-1" }), "WORKFLOW_CHILD_START_TIMEOUT");
  assert.equal(events.listenerCount("subagent:async-started"), 0);
});

test("fails fast with the workflow root error when the root fails before the leaf starts", async () => {
  const events = createEvents();
  const collector = createWorkflowChildStartCollector(events, {
    workflowKey: "typed-request-1",
    agent: "executor",
    sessionId: "session-1",
    timeoutMs: 5_000,
  });
  const pending = collector.waitFor({ runId: "workflow-run-1" });

  events.emit("subagent:async-complete", { runId: "workflow-run-1", state: "failed", error: "Error: Run 'typed-request-1' failed: Unknown agent: reviewer" });

  await assert.rejects(pending, (error) => {
    assert.equal(error instanceof WorkflowSpawnError, true);
    assert.equal(error.code, "WORKFLOW_CHILD_START_FAILED");
    assert.match(error.message, /Unknown agent: reviewer/);
    assert.match(error.message, /failed/);
    return true;
  });
  assert.equal(events.listenerCount("subagent:async-started"), 0);
  assert.equal(events.listenerCount("subagent:async-complete"), 0);
});

test("fails fast when a buffered root failure arrives before the workflow root reply", async () => {
  const events = createEvents();
  const collector = createWorkflowChildStartCollector(events, {
    workflowKey: "typed-request-1",
    agent: "executor",
    sessionId: "session-1",
    timeoutMs: 5_000,
  });

  events.emit("subagent:async-complete", { id: "workflow-run-1", state: "failed", error: "Unknown agent: reviewer" });

  await assert.rejects(collector.waitFor({ runId: "workflow-run-1" }), (error) => {
    assert.equal(error instanceof WorkflowSpawnError, true);
    assert.equal(error.code, "WORKFLOW_CHILD_START_FAILED");
    assert.match(error.message, /Unknown agent: reviewer/);
    return true;
  });
  assert.equal(events.listenerCount("subagent:async-started"), 0);
  assert.equal(events.listenerCount("subagent:async-complete"), 0);
});

test("fails fast when the workflow root completes successfully without a child start", async () => {
  const events = createEvents();
  const collector = createWorkflowChildStartCollector(events, {
    workflowKey: "typed-request-1",
    agent: "executor",
    sessionId: "session-1",
    timeoutMs: 5_000,
  });
  const pending = collector.waitFor({ runId: "workflow-run-1" });

  events.emit("subagent:async-complete", { runId: "workflow-run-1", state: "complete", success: true });

  await assert.rejects(pending, (error) => {
    assert.equal(error instanceof WorkflowSpawnError, true);
    assert.equal(error.code, "WORKFLOW_CHILD_START_FAILED");
    assert.match(error.message, /complete/);
    return true;
  });
  assert.equal(events.listenerCount("subagent:async-complete"), 0);
});

test("ignores completion events from other workflow roots", async () => {
  const events = createEvents();
  const collector = createWorkflowChildStartCollector(events, {
    workflowKey: "typed-request-1",
    agent: "executor",
    sessionId: "session-1",
    timeoutMs: 50,
  });
  const pending = collector.waitFor({ runId: "workflow-run-1" });

  events.emit("subagent:async-complete", { runId: "other-workflow", state: "failed", error: "Unknown agent: researcher" });
  events.emit("subagent:async-started", leafEvent());

  assert.deepEqual(await pending, { runId: "leaf-run-1", asyncDir: "/tmp/leaf-run-1" });
});

test("ignores the workflow root completion after the leaf is already bound", async () => {
  const events = createEvents();
  const collector = createWorkflowChildStartCollector(events, {
    workflowKey: "typed-request-1",
    agent: "executor",
    sessionId: "session-1",
    timeoutMs: 50,
  });
  const pending = collector.waitFor({ runId: "workflow-run-1" });

  events.emit("subagent:async-started", leafEvent());
  assert.deepEqual(await pending, { runId: "leaf-run-1", asyncDir: "/tmp/leaf-run-1" });

  events.emit("subagent:async-complete", { runId: "workflow-run-1", state: "complete", success: true });
  assert.equal(events.listenerCount("subagent:async-started"), 0);
  assert.equal(events.listenerCount("subagent:async-complete"), 0);
});

test("caps the child-start wait at the default ceiling when the execution timeout exceeds it", () => {
  assert.equal(childStartTimeoutMs(undefined, 900_000), 120_000);
});

test("keeps short execution timeouts as the child-start wait", () => {
  assert.equal(childStartTimeoutMs(undefined, 60_000), 60_000);
});

test("an explicit child-start timeout override wins over the ceiling", () => {
  assert.equal(childStartTimeoutMs(300_000, 900_000), 300_000);
});

test("rejects a non-positive child-start timeout override", () => {
  assert.throws(() => childStartTimeoutMs(0, 900_000), TypeError);
});
