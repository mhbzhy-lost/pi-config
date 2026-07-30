import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createPlanEventWriter } from "../scripts/lib/plan/plan-event-writer.mjs";
import { applyEvent, createProjection } from "../scripts/lib/plan/plan-events.mjs";
import { createPlanCoordinator } from "../scripts/lib/plan/coordinator.mjs";
import { compilePlanToIR } from "../scripts/lib/plan/ir/index.mjs";
import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";
import { compileCodingDispatchIR } from "../scripts/lib/subagent-dispatch/ir.ts";

test("requires a compiled Plan IR instead of compiling a parsed plan", () => {
  assert.throws(
    () => createPlanCoordinator({ plan: {}, entries: [], append() {} }),
    /compiled Plan IR is required/,
  );
});

const workspace = {
  originRoot: "/repo",
  worktree: "/accumulator",
  baseCommit: "base",
  headCommit: "base",
  planPath: "/repo/docs/plan.md",
  planHash: "a".repeat(64),
};

function task(id, { deps = [], resources = [], allowedPaths = [`src/${id}/**`] } = {}) {
  return {
    id,
    deps,
    agent: "executor",
    title: `Implement ${id}`,
    files: allowedPaths,
    allowedPaths,
    resources,
    body: "",
  };
}

function plan(tasks = [task("task-1"), task("task-2")], capacities = {}) {
  return {
    schemaVersion: "pi-plan.v2",
    tasks,
    resourceCapacities: capacities,
    verification: ["true"],
  };
}

function createdEntry(tasks = ["task-1", "task-2"]) {
  return {
    schemaVersion: "pi-plan-event.v1",
    eventId: "created",
    planId: "plan-1",
    occurredAt: "2026-07-15T00:00:00.000Z",
    type: "plan.created",
    data: { workspace, tasks },
  };
}

function v3Plan({
  instructions = "Keep the execution contract intact.",
  body = "Implement the approved change.",
  taskExecution = {},
  verification = [{ id: "test", command: "true", cwd: ".", timeoutMs: 900000 }],
  taskAcceptance = { "task-1": { strategy: "commands", commandIds: ["test"] } },
} = {}) {
  return parsePlanDocument(`# V3 coordinator fixture

**Goal:** dispatch the exact approved task

## Execution Contract

\`\`\`json
${JSON.stringify({
  schemaVersion: "pi-plan.v3", revision: 1, parentPlanHash: null,
  verification,
  requiredGates: ["deterministic", "plan-audit", "external-review", "final-completeness"], resourceCapacities: {},
  executionDefaults: { agent: "executor", risk: "normal", workflow: { mode: "inherit-repository" }, timeoutMs: 321000 },
  taskExecution: { "task-1": taskExecution }, taskAcceptance,
})}
\`\`\`

${instructions}

### Task 1: Exact task

**Files:**
- Modify: \`src/exact.mjs\`

${body}
`, "/plans/v3-coordinator.md");
}

function v3DependencyPlan() {
  return parsePlanDocument(`# V3 dependency coordinator fixture

**Goal:** dispatch a task from its integrated dependency receipt

## Execution Contract

\`\`\`json
${JSON.stringify({
  schemaVersion: "pi-plan.v3", revision: 1, parentPlanHash: null,
  verification: [{ id: "test", command: "true", cwd: ".", timeoutMs: 900000 }],
  requiredGates: ["deterministic", "plan-audit", "external-review", "final-completeness"], resourceCapacities: {},
  executionDefaults: { agent: "executor", risk: "normal", workflow: { mode: "inherit-repository" }, timeoutMs: 321000 },
  taskExecution: { "task-1": {}, "task-2": {} },
  taskAcceptance: {
    "task-1": { strategy: "commands", commandIds: ["test"] },
    "task-2": { strategy: "commands", commandIds: ["test"] },
  },
})}
\`\`\`

Keep the execution contract intact.

### Task 1: Produce receipt

**Files:**
- Modify: \`src/receipt.mjs\`

Produce the bounded receipt.

### Task 2: Consume integrated receipt

**Deps:** Task 1

**Files:**
- Modify: \`src/consumer.mjs\`

Consume the bounded receipt.
`, "/plans/v3-dependency-coordinator.md");
}

function v3ParallelPlan() {
  return parsePlanDocument(`# Parallel v3

## Execution Contract

\`\`\`json
${JSON.stringify({
    schemaVersion: "pi-plan.v3", revision: 1, parentPlanHash: null,
    verification: [{ id: "test", command: "true", cwd: ".", timeoutMs: 900000 }],
    requiredGates: ["deterministic", "plan-audit", "external-review", "final-completeness"], resourceCapacities: {},
    executionDefaults: { agent: "executor", risk: "normal", workflow: { mode: "inherit-repository" }, timeoutMs: 321000 },
    taskExecution: { "task-1": {}, "task-2": {} },
    taskAcceptance: { "task-1": { strategy: "commands", commandIds: ["test"] }, "task-2": { strategy: "commands", commandIds: ["test"] } },
  })}
\`\`\`

Keep parallel execution contracts exact.

### Task 1: One

**Files:**
- Modify: \`src/one.mjs\`

One.

### Task 2: Two

**Files:**
- Modify: \`src/two.mjs\`

Two.
`, "/plans/parallel-v3.md");
}

function createdV3Entry(ir) {
  return {
    ...createdEntry(ir.nodes.map(({ id }) => id)),
    data: {
      workspace: Object.fromEntries(["originRoot", "worktree", "baseCommit", "headCommit"].map((key) => [key, workspace[key]])),
      tasks: ir.nodes.map(({ id }) => id),
      revision: {
        number: 1, manifestSha256: "a".repeat(64), sourceBytesSha256: "b".repeat(64),
        planHash: ir.source.planHash, irVersion: ir.version, irHash: ir.hash,
        taskHashes: Object.fromEntries(ir.nodes.map((node) => [node.id, Object.fromEntries(["full", "effective", "scheduling"].map((key) => [key, node.hashes[key]]))])),
      },
    },
  };
}

function canonicalDispatchContext(event) {
  const { planIrHash, taskHash, schedulingHash } = event.data;
  return {
    planIrHash, taskHash, schedulingHash,
    attemptId: event.data.attemptId, baseCommit: event.data.baseCommit,
    output: event.data.tool.output, dependencyReceipts: [],
  };
}

async function dispatchV3(approvedPlan) {
  const ir = compilePlanToIR(approvedPlan);
  const entries = [createdV3Entry(ir)];
  const spawned = [];
  const writer = createPlanEventWriter({
    readEntries: async () => entries,
    append: async (entry) => entries.push(entry),
    id: (() => { let sequence = 0; return () => `v3-matrix-${++sequence}`; })(),
    now: () => "2026-07-15T00:00:01.000Z",
  });
  const { coordinator } = createPlanCoordinator({
    ir, entries, writer, readEntries: async () => entries, readProjection: () => replay(entries),
    allocateWorkspace: async (input) => lease(input),
    backend: { async spawn(input) { spawned.push(input); return { dispatchId: input.dispatchId, attemptId: input.attemptId, runId: "run-v3-matrix", asyncDir: "/async/v3-matrix", cwd: input.cwd }; } },
    stateRoot: "/repo", outputForAttempt: (attemptId) => `/results/${attemptId}.json`, timeoutMs: 654000,
    id: (() => { let sequence = 0; return () => `v3-coordinator-${++sequence}`; })(), now: () => "2026-07-15T00:00:01.000Z",
  });
  await coordinator.dispatchAuthorized();
  const event = entries.find(({ type }) => type === "attempt.dispatch-requested");
  assert.equal(event.data.dispatchContextHash, createHash("sha256").update(JSON.stringify(canonicalDispatchContext(event))).digest("hex"));
  return { ir, event, spawned: spawned[0] };
}

function lease(input) {
  return {
    planId: input.planId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    baseCommit: input.baseCommit,
    path: `/attempts/${input.attemptId}`,
    branch: `pi-plan-attempt/${input.planId}/${input.taskId}/${input.attemptId.split("-").at(-1)}`,
    ownerToken: `${input.attemptId}-owner`,
  };
}

function replay(entries) {
  let projection = createProjection();
  for (const entry of entries) projection = applyEvent(projection, entry);
  return projection;
}

function event(type, data, sequence) {
  return {
    schemaVersion: "pi-plan-event.v1",
    eventId: `receipt-${sequence}`,
    planId: "plan-1",
    occurredAt: "2026-07-15T00:00:00.000Z",
    type,
    data,
  };
}

function integratedDependencyEntries(ir) {
  const attemptId = "attempt-plan-1-task-1-1";
  const dispatchId = `${attemptId}.dispatch.1`;
  const workspaceLease = lease({ planId: "plan-1", taskId: "task-1", attemptId, baseCommit: "base" });
  const tool = { agent: "executor", task: "Produce the bounded receipt.", cwd: workspaceLease.path, context: "fresh", async: true, clarify: false, worktree: false };
  const dispatchContext = {
    planIrHash: ir.hash, taskHash: ir.nodes[0].hashes.effective, schedulingHash: ir.nodes[0].hashes.scheduling,
    attemptId, baseCommit: "base", output: "/results/dependency.json", dependencyReceipts: [],
  };
  const entries = [
    createdV3Entry(ir),
    event("attempt.workspace-allocated", { attemptId, taskId: "task-1", baseCommit: "base", workspace: workspaceLease }, 1),
    event("attempt.dispatch-requested", {
      attemptId, taskId: "task-1", dispatchId, baseCommit: "base", workspace: workspaceLease, tool,
      toolHash: createHash("sha256").update(JSON.stringify(tool)).digest("hex"),
      planIrHash: ir.hash, taskHash: ir.nodes[0].hashes.effective, schedulingHash: ir.nodes[0].hashes.scheduling,
      dispatchContextHash: createHash("sha256").update(JSON.stringify(dispatchContext)).digest("hex"),
    }, 2),
    event("attempt.bound", { attemptId, taskId: "task-1", dispatchId, runId: "run-receipt", asyncDir: "/async/receipt", sessionFile: "/sessions/receipt.jsonl" }, 3),
    event("attempt.settled", { attemptId, outcome: "succeeded", resultCommit: "dependency-result" }, 4),
    event("attempt.validated", {
      attemptId, resultCommit: "dependency-result", validationHash: "dependency-validation", diffSha256: "dependency-diff",
      changedPaths: ["src/receipt.mjs"], evidence: [
        { kind: "command", commandId: "test", exitCode: 0, stdout: "private stdout", stderr: "private stderr", transcript: "/private/transcript" },
        { kind: "local", path: "/private/evidence.json", transcript: "/private/local-transcript" },
      ],
    }, 5),
    event("integration.requested", { attemptId, expectedHead: "base", resultCommit: "dependency-result", diffSha256: "dependency-diff" }, 6),
    event("integration.finished", { attemptId, previousHead: "base", newHead: "dependency-head" }, 7),
  ];
  assert.equal(replay(entries).attempts.get(attemptId).status, "integrated");
  return entries;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ approvedPlan = plan(), entries, backend: backendOverrides = {}, allocation = lease, options = {} } = {}) {
  const appended = [];
  const spawned = [];
  const allocations = [];
  let run = 0;
  const backend = {
    async spawn(input) {
      spawned.push(input);
      run++;
      return {
        dispatchId: input.dispatchId,
        attemptId: input.attemptId,
        runId: `run-${run}`,
        asyncDir: `/async/run-${run}`,
        cwd: input.cwd,
        sessionId: "plan-session",
      };
    },
    async status() {
      return { status: { kind: "stable", value: { state: "running" } } };
    },
    ...backendOverrides,
  };
  const ir = compilePlanToIR(approvedPlan);
  const result = createPlanCoordinator({
    ir,
    entries: entries ?? [ir.source?.schemaVersion === "pi-plan.v3" ? createdV3Entry(ir) : createdEntry(approvedPlan.tasks.map(({ id }) => id))],
    append: (entry) => appended.push(entry),
    allocateWorkspace: async (input) => {
      allocations.push(input);
      return allocation(input);
    },
    backend,
    readAttemptHead: async (workspaceLease) => `${workspaceLease.attemptId}-commit`,
    stateRoot: "/repo",
    outputForAttempt: (attemptId) => `/results/${attemptId}.json`,
    id: (() => { let index = 0; return () => `event-${++index}`; })(),
    now: () => "2026-07-15T00:00:01.000Z",
    ...options,
  });
  return { ...result, appended, spawned, allocations, backend };
}

test("synchronously reflects an external cancellation and refuses dispatch before allocation", async () => {
  const entries = [createdEntry(["task-1"])];
  const appended = [];
  const sharedWriter = createPlanEventWriter({
    readEntries: async () => entries,
    append: async (entry) => { entries.push(entry); appended.push(entry); },
    id: (() => { let index = 0; return () => `shared-${++index}`; })(),
    now: () => "2026-07-15T00:00:01.000Z",
  });
  const subject = harness({
    approvedPlan: plan([task("task-1")]),
    entries,
    options: { writer: sharedWriter, readEntries: async () => entries, readProjection: () => replay(entries) },
  });

  await sharedWriter.append({ expectedProjectionVersion: 1, planId: "plan-1", type: "plan.cancelled", data: { reason: "external" } });

  assert.equal(subject.coordinator.projection().lifecycle, "cancelled");
  await assert.rejects(subject.coordinator.dispatchAuthorized(), /Plan cannot dispatch executors/);
  assert.equal(subject.allocations.length, 0);
  assert.equal(subject.spawned.length, 0);
  assert.equal(appended.at(-1).type, "plan.cancelled");
});

test("does not recover or settle attempts after an external cancellation", async () => {
  const entries = [...requestedEntries(), {
    schemaVersion: "pi-plan-event.v1", eventId: "bound", planId: "plan-1", occurredAt: "2026-07-15T00:00:03.000Z", type: "attempt.bound",
    data: { attemptId: "attempt-plan-1-task-1-1", taskId: "task-1", dispatchId: "attempt-plan-1-task-1-1.dispatch.1", runId: "run-1", asyncDir: "/async/run-1", sessionFile: null },
  }];
  const appended = [];
  const sharedWriter = createPlanEventWriter({
    readEntries: async () => entries,
    append: async (entry) => { entries.push(entry); appended.push(entry); },
    id: () => "cancelled",
    now: () => "2026-07-15T00:00:04.000Z",
  });
  let statusReads = 0;
  const subject = harness({
    approvedPlan: plan([task("task-1")]),
    entries,
    backend: { async status() { statusReads++; return { status: { kind: "stable", value: { state: "complete" } } }; } },
    options: { writer: sharedWriter, readEntries: async () => entries, readProjection: () => replay(entries) },
  });
  await sharedWriter.append({ expectedProjectionVersion: 4, planId: "plan-1", type: "plan.cancelled", data: { reason: "external" } });
  const eventCount = entries.length;

  assert.equal((await subject.coordinator.recover()).state, "cancelled");
  await assert.rejects(subject.coordinator.settleBoundAttempt("failed", "attempt-plan-1-task-1-1"), /Plan cannot settle attempts/);
  assert.equal(statusReads, 0);
  assert.equal(entries.length, eventCount);
  assert.equal(appended.length, 1);
});

test("stops a deferred spawned run when external cancellation wins before binding", async () => {
  const entries = [createdEntry(["task-1"])];
  const spawnStarted = deferred();
  const releaseBinding = deferred();
  const stops = [];
  const sharedWriter = createPlanEventWriter({
    readEntries: async () => entries,
    append: async (entry) => { entries.push(entry); },
    id: (() => { let index = 0; return () => `shared-${++index}`; })(),
    now: () => "2026-07-15T00:00:01.000Z",
  });
  const subject = harness({
    approvedPlan: plan([task("task-1")]),
    entries,
    backend: {
      async spawn(input) {
        spawnStarted.resolve();
        await releaseBinding.promise;
        return { dispatchId: input.dispatchId, attemptId: input.attemptId, runId: "run-deferred", asyncDir: "/async/deferred", cwd: input.cwd };
      },
      async stop(target) { stops.push(target); },
    },
    options: { writer: sharedWriter, readEntries: async () => entries, readProjection: () => replay(entries) },
  });

  const dispatch = subject.coordinator.dispatchAuthorized();
  await spawnStarted.promise;
  assert.equal(replay(entries).attempts.get("attempt-plan-1-task-1-1").status, "dispatch-requested");
  await sharedWriter.append({ expectedProjectionVersion: 3, planId: "plan-1", type: "plan.cancelled", data: { reason: "external" } });
  releaseBinding.resolve();

  const result = await dispatch;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(stops, [{ runId: "run-deferred", asyncDir: "/async/deferred" }]);
  assert.equal(replay(entries).attempts.get("attempt-plan-1-task-1-1").status, "dispatch-requested");
  assert.doesNotThrow(() => replay(entries));
});

test("stops a spawned run when cancellation wins the attempt.bound CAS", async () => {
  const entries = [createdEntry(["task-1"])];
  const boundQueued = deferred();
  const releaseBound = deferred();
  const stops = [];
  const sharedWriter = createPlanEventWriter({
    readEntries: async () => entries,
    append: async (entry) => { entries.push(entry); },
    id: (() => { let index = 0; return () => `shared-${++index}`; })(),
    now: () => "2026-07-15T00:00:01.000Z",
  });
  const writer = {
    async append(input) {
      if (input.type === "attempt.bound") {
        boundQueued.resolve();
        await releaseBound.promise;
      }
      return await sharedWriter.append(input);
    },
  };
  const subject = harness({
    approvedPlan: plan([task("task-1")]),
    entries,
    backend: { async stop(target) { stops.push(target); } },
    options: { writer, readEntries: async () => entries, readProjection: () => replay(entries) },
  });

  const dispatch = subject.coordinator.dispatchAuthorized();
  await boundQueued.promise;
  await sharedWriter.append({ expectedProjectionVersion: 3, planId: "plan-1", type: "plan.cancelled", data: { reason: "external" } });
  releaseBound.resolve();

  const result = await dispatch;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(stops, [{ runId: "run-1", asyncDir: "/async/run-1" }]);
  assert.equal(entries.filter(({ type }) => type === "attempt.bound").length, 0);
  assert.doesNotThrow(() => replay(entries));
});

test("retries attempt.bound after a non-terminal projection conflict", async () => {
  const entries = [createdEntry(["task-1"])];
  const stops = [];
  const sharedWriter = createPlanEventWriter({
    readEntries: async () => entries,
    append: async (entry) => { entries.push(entry); },
    id: (() => { let index = 0; return () => `shared-${++index}`; })(),
    now: () => "2026-07-15T00:00:01.000Z",
  });
  let conflict = true;
  const writer = {
    async append(input) {
      if (input.type === "attempt.bound" && conflict) {
        conflict = false;
        throw Object.assign(new Error("injected conflict"), { code: "PROJECTION_CONFLICT" });
      }
      return await sharedWriter.append(input);
    },
  };
  const subject = harness({
    approvedPlan: plan([task("task-1")]),
    entries,
    backend: { async stop(target) { stops.push(target); } },
    options: { writer, readEntries: async () => entries, readProjection: () => replay(entries) },
  });

  const result = await subject.coordinator.dispatchAuthorized();

  assert.equal(result.state, "waiting-executors");
  assert.equal(entries.filter(({ type }) => type === "attempt.bound").length, 1);
  assert.deepEqual(stops, []);
});

test("dispatches every authorized root with isolated cwd and returns no model-callable tool", async () => {
  const approvedPlan = plan([
    task("task-1", { resources: [{ id: "xcode", mode: "exclusive" }] }),
    task("task-2", { resources: [{ id: "xcode", mode: "exclusive" }] }),
    task("task-3", { allowedPaths: ["docs/**"] }),
  ], { xcode: 1 });
  const { coordinator, appended, spawned } = harness({ approvedPlan });

  const result = await coordinator.dispatchAuthorized();

  assert.equal(result.state, "waiting-executors");
  assert.deepEqual(result.dispatched.map(({ taskId }) => taskId), ["task-1", "task-3"]);
  assert.notEqual(result.dispatched[0].cwd, result.dispatched[1].cwd);
  assert.equal(result.dispatched.every((dispatch) => !("tool" in dispatch)), true);
  assert.deepEqual(appended.map(({ type }) => type), [
    "attempt.workspace-allocated", "attempt.dispatch-requested", "attempt.bound",
    "attempt.workspace-allocated", "attempt.dispatch-requested", "attempt.bound",
  ]);
  assert.deepEqual(spawned.map(({ cwd }) => cwd), [
    "/attempts/attempt-plan-1-task-1-1",
    "/attempts/attempt-plan-1-task-3-1",
  ]);
  assert.deepEqual(spawned.map(({ dispatchId }) => dispatchId), [
    "attempt-plan-1-task-1-1.dispatch.1",
    "attempt-plan-1-task-3-1.dispatch.1",
  ]);
});

test("derives immutable backend input from the approved task and allocated lease", async () => {
  const approvedPlan = plan([task("task-1", { allowedPaths: ["src/a/**"] })]);
  const { coordinator, spawned, appended } = harness({ approvedPlan });
  await coordinator.dispatchAuthorized();

  assert.deepEqual(spawned[0], {
    dispatchId: "attempt-plan-1-task-1-1.dispatch.1",
    attemptId: "attempt-plan-1-task-1-1",
    agent: "executor",
    task: [
      "Execute plan task task-1: Implement task-1.",
      "Allowed paths: src/a/**",
      "Commit all changes in the attempt worktree when done.",
      "If an approved fail-closed prerequisite requires stopping without task file changes or a commit, write this JSON shape to the authoritative output:",
      '{"attempt_id":"attempt-plan-1-task-1-1","task_id":"task-1","status":"blocked","reason":"<code>","blockers":["<sorted-code>"],"changed_files":[],"commit":null}',
      "An optional artifact object may contain a sha256 evidence digest. Never include secrets, credentials, URLs, or local paths.",
    ].join("\n"),
    cwd: "/attempts/attempt-plan-1-task-1-1",
    output: "/results/attempt-plan-1-task-1-1.json",
    timeoutMs: 900_000,
  });
  const intent = appended.find(({ type }) => type === "attempt.dispatch-requested");
  assert.equal(intent.data.tool.cwd, spawned[0].cwd);
  assert.equal(intent.data.tool.worktree, false);
  assert.equal(intent.data.tool.acceptance, false);
  assert.match(intent.data.toolHash, /^[a-f0-9]{64}$/);
});

test("blocks and preserves the allocated workspace when backend spawn is uncertain", async () => {
  const { coordinator, appended, allocations } = harness({
    approvedPlan: plan([task("task-1")]),
    backend: { async spawn() { throw new Error("RPC reply lost"); } },
  });

  const result = await coordinator.dispatchAuthorized();

  assert.equal(result.state, "blocked");
  assert.equal(allocations.length, 1);
  assert.deepEqual(appended.map(({ type }) => type), [
    "attempt.workspace-allocated",
    "attempt.dispatch-requested",
    "plan.blocked",
  ]);
  assert.equal(appended.at(-1).data.reason, "dispatch_uncertain");
});

test("settles out-of-order completions against their exact attempt", async () => {
  const { coordinator, appended } = harness();
  const dispatched = await coordinator.dispatchAuthorized();
  const [first, second] = dispatched.dispatched;

  await coordinator.settleBoundAttempt("succeeded", second.attemptId);
  await coordinator.settleBoundAttempt("failed", first.attemptId);

  const settled = appended.filter(({ type }) => type === "attempt.settled");
  assert.deepEqual(settled.map(({ data }) => [data.attemptId, data.outcome]), [
    [second.attemptId, "succeeded"],
    [first.attemptId, "failed"],
  ]);
});

function requestedEntries() {
  const attemptId = "attempt-plan-1-task-1-1";
  const workspaceLease = lease({ planId: "plan-1", taskId: "task-1", attemptId, baseCommit: "base" });
  const tool = {
    agent: "executor",
    task: "approved prompt",
    cwd: workspaceLease.path,
    context: "fresh",
    async: true,
    clarify: false,
    worktree: false,
    output: "/results/attempt.json",
    outputMode: "file-only",
    acceptance: false,
    artifacts: true,
    timeoutMs: 900_000,
  };
  return [
    createdEntry(["task-1"]),
    { schemaVersion: "pi-plan-event.v1", eventId: "allocated", planId: "plan-1", occurredAt: "2026-07-15T00:00:01.000Z", type: "attempt.workspace-allocated", data: { attemptId, taskId: "task-1", baseCommit: "base", workspace: workspaceLease } },
    { schemaVersion: "pi-plan-event.v1", eventId: "requested", planId: "plan-1", occurredAt: "2026-07-15T00:00:02.000Z", type: "attempt.dispatch-requested", data: { attemptId, taskId: "task-1", dispatchId: `${attemptId}.dispatch.1`, baseCommit: "base", workspace: workspaceLease, tool, toolHash: "hash" } },
  ];
}

test("recovery blocks an unbound dispatch instead of spawning it again", async () => {
  const { coordinator, appended, spawned } = harness({
    approvedPlan: plan([task("task-1")]),
    entries: requestedEntries(),
  });
  const result = await coordinator.recover({ facts: [] });
  assert.equal(result.state, "blocked");
  assert.equal(spawned.length, 0);
  assert.equal(appended.at(-1).type, "plan.blocked");
  assert.equal(appended.at(-1).data.reason, "dispatch_uncertain");
});

test("recovery binds exactly one matching started fact and rejects ambiguous facts", async () => {
  const fact = {
    type: "execution.started",
    dispatchId: "attempt-plan-1-task-1-1.dispatch.1",
    attemptId: "attempt-plan-1-task-1-1",
    runId: "run-1",
    asyncDir: "/async/run-1",
    cwd: "/attempts/attempt-plan-1-task-1-1",
    state: "running",
  };
  const exact = harness({ approvedPlan: plan([task("task-1")]), entries: requestedEntries() });
  assert.equal((await exact.coordinator.recover({ facts: [fact] })).state, "waiting-executors");
  assert.equal(exact.appended.at(-1).type, "attempt.bound");

  const ambiguous = harness({ approvedPlan: plan([task("task-1")]), entries: requestedEntries() });
  const result = await ambiguous.coordinator.recover({ facts: [fact, { ...fact }] });
  assert.equal(result.state, "blocked");
  assert.equal(ambiguous.appended.at(-1).data.reason, "protocol_violation");
});

test("recovery keeps running artifacts active and settles terminal artifacts", async () => {
  const requested = requestedEntries();
  const bound = {
    schemaVersion: "pi-plan-event.v1",
    eventId: "bound",
    planId: "plan-1",
    occurredAt: "2026-07-15T00:00:03.000Z",
    type: "attempt.bound",
    data: {
      attemptId: "attempt-plan-1-task-1-1",
      taskId: "task-1",
      dispatchId: "attempt-plan-1-task-1-1.dispatch.1",
      runId: "run-1",
      asyncDir: "/async/run-1",
      sessionFile: null,
    },
  };
  const running = harness({ approvedPlan: plan([task("task-1")]), entries: [...requested, bound] });
  assert.equal((await running.coordinator.recover()).state, "waiting-executors");
  assert.equal(running.appended.length, 0);

  const complete = harness({
    approvedPlan: plan([task("task-1")]),
    entries: [...requested, bound],
    backend: { async status() { return { status: { kind: "stable", value: { state: "complete" } } }; } },
  });
  assert.equal((await complete.coordinator.recover()).state, "ready-to-integrate");
  assert.equal(complete.appended.at(-1).type, "attempt.settled");
  assert.equal(complete.appended.at(-1).data.outcome, "succeeded");
});

test("recovery preserves an explicit Executor block without reading or validating a commit", async () => {
  let headReads = 0;
  let validations = 0;
  const subject = harness({
    approvedPlan: plan([task("task-1")]),
    backend: { async status() { return { status: { kind: "stable", value: { state: "complete" } } }; } },
    options: {
      async readAttemptDisposition({ attemptId, taskId, output }) {
        assert.equal(attemptId, "attempt-plan-1-task-1-1");
        assert.equal(taskId, "task-1");
        assert.equal(output, "/results/attempt-plan-1-task-1-1.json");
        return {
          status: "blocked",
          reason: "real-module-candidates-not-ready",
          blockers: ["cocoapods", "tbctx7_code_auth"],
          evidenceSha256: "a".repeat(64),
        };
      },
      async readAttemptHead() {
        headReads++;
        return "base";
      },
      async validateAttemptResult() {
        validations++;
        return { accepted: false, code: "NO_RESULT_COMMIT" };
      },
    },
  });
  await subject.coordinator.dispatchAuthorized();

  const recovered = await subject.coordinator.recover();

  assert.equal(recovered.state, "blocked");
  assert.equal(headReads, 0);
  assert.equal(validations, 0);
  assert.deepEqual(subject.appended.slice(-2).map(({ type }) => type), [
    "attempt.settled",
    "plan.blocked",
  ]);
  assert.deepEqual(subject.appended.at(-2).data, {
    attemptId: "attempt-plan-1-task-1-1",
    outcome: "blocked",
    blockerReason: "real-module-candidates-not-ready",
    blockers: ["cocoapods", "tbctx7_code_auth"],
    evidenceSha256: "a".repeat(64),
  });
  assert.deepEqual(subject.appended.at(-1).data, {
    reason: "executor_blocked",
    detail: {
      attemptId: "attempt-plan-1-task-1-1",
      taskId: "task-1",
      blockerReason: "real-module-candidates-not-ready",
      blockers: ["cocoapods", "tbctx7_code_auth"],
      evidenceSha256: "a".repeat(64),
    },
  });
  assert.equal(subject.coordinator.projection().attempts.get("attempt-plan-1-task-1-1").status, "blocked");
});

test("validates a completed Attempt, enqueues it, and drains integration before another dispatch frontier", async () => {
  const calls = [];
  const queued = [];
  const integrationQueue = {
    enqueue(attempt) { calls.push("enqueue"); queued.push(attempt); },
    async drain() { calls.push("drain"); return { state: "waiting", integrated: [] }; },
  };
  const subject = harness({
    approvedPlan: plan([task("task-1")]),
    backend: { async status() { return { status: { kind: "stable", value: { state: "complete" } } }; } },
    options: {
      integrationQueue,
      integrationOwnerToken: "owner",
      validateAttemptResult: async ({ lease: attemptLease }) => ({
        accepted: true,
        attemptId: attemptLease.attemptId,
        baseCommit: attemptLease.baseCommit,
        resultCommit: `${attemptLease.attemptId}-commit`,
        changedPaths: ["src/task-1/a.mjs"],
        diffSha256: "diff-hash",
        evidence: [],
      }),
    },
  });
  await subject.coordinator.dispatchAuthorized();
  calls.length = 0;
  const recovered = await subject.coordinator.recover();

  assert.equal(recovered.state, "ready-to-integrate");
  assert.deepEqual(calls, ["enqueue"]);
  assert.equal(queued[0].taskId, "task-1");
  assert.equal(queued[0].validationHash.length, 64);
  assert.deepEqual(subject.appended.slice(-2).map(({ type }) => type), ["attempt.settled", "attempt.validated"]);

  await subject.coordinator.dispatchAuthorized();
  assert.deepEqual(calls, ["enqueue", "drain"]);
});

test("failed attempts receive a new workspace and sequence on retry", async () => {
  const { coordinator } = harness({ approvedPlan: plan([task("task-1")]) });
  const first = await coordinator.dispatchAuthorized();
  await coordinator.settleBoundAttempt("failed", first.dispatched[0].attemptId);
  const retry = await coordinator.dispatchAuthorized();
  assert.equal(retry.dispatched[0].attemptId, "attempt-plan-1-task-1-2");
  assert.notEqual(retry.dispatched[0].cwd, first.dispatched[0].cwd);
});

test("v3 dispatch emits the complete exact prompt and canonical identity context", async () => {
  const approvedPlan = v3Plan();
  const ir = compilePlanToIR(approvedPlan);
  const spawned = [];
  const appended = [];
  const coordinator = createPlanCoordinator({
    ir, entries: [createdV3Entry(ir)], append: (entry) => appended.push(entry),
    allocateWorkspace: async (input) => lease(input),
    backend: { async spawn(input) { spawned.push(input); return { dispatchId: input.dispatchId, attemptId: input.attemptId, runId: "run-v3", asyncDir: "/async/v3", cwd: input.cwd }; } },
    stateRoot: "/repo", outputForAttempt: (attemptId) => `/results/${attemptId}.json`, id: (() => { let sequence = 0; return () => `v3-event-${++sequence}`; })(), now: () => "2026-07-15T00:00:01.000Z",
  }).coordinator;
  await coordinator.dispatchAuthorized();
  const event = appended.find(({ type }) => type === "attempt.dispatch-requested");
  assert.match(event.data.tool.task, /^Plan: V3 coordinator fixture\nPlan instructions:\n\*\*Goal:\*\* dispatch the exact approved task\n\n\nKeep the execution contract intact\.\nTask: task-1 Exact task\nTask body:\n\*\*Files:\*\*\n- Modify: `src\/exact\.mjs`\n\nImplement the approved change\.\nDependency receipts:\n\[\]/);
  assert.match(event.data.tool.task, /\nAllowed paths: src\/exact\.mjs\nResources: \[\]\nExecution: /);
  assert.equal(event.data.tool.task.includes(`\nAcceptance: commands\n${JSON.stringify(ir.nodes[0].acceptance)}\nAttempt: attempt-plan-1-task-1-1\nBase commit: base\nAuthoritative output: /results/attempt-plan-1-task-1-1.json\nResult contract: `), true);
  assert.match(event.data.tool.task, /\nBlocked result shape: /);
  assert.equal(event.data.planIrHash, ir.hash);
  assert.equal(event.data.taskHash, ir.nodes[0].hashes.effective);
  assert.equal(event.data.schedulingHash, ir.nodes[0].hashes.scheduling);
  const canonical = {
    planIrHash: ir.hash, taskHash: ir.nodes[0].hashes.effective, schedulingHash: ir.nodes[0].hashes.scheduling,
    attemptId: "attempt-plan-1-task-1-1", baseCommit: "base", output: "/results/attempt-plan-1-task-1-1.json", dependencyReceipts: [],
  };
  assert.equal(event.data.dispatchContextHash, createHash("sha256").update(JSON.stringify(canonical)).digest("hex"));
  assert.equal(event.data.toolHash, createHash("sha256").update(JSON.stringify(event.data.tool)).digest("hex"));
});

test("prepareAuthorizedDispatches persists a new durable Executor intent", async () => {
  const approvedPlan = v3Plan();
  const ir = compilePlanToIR(approvedPlan);
  const execution = {
    plan: {
      title: ir.title,
      instructions: ir.instructions,
      executionPolicy: ir.executionPolicy,
    },
    task: ir.nodes[0],
  };
  const subject = harness({
    approvedPlan,
    entries: [createdV3Entry(ir)],
    backend: { async spawn() { throw new Error("backend.spawn must not be called"); } },
  });

  const result = await subject.coordinator.prepareAuthorizedDispatches();

  assert.equal(result.state, "dispatch-required");
  assert.equal(result.dispatches.length, 1);
  const [dispatch] = result.dispatches;
  assert.equal(dispatch.attemptId, "attempt-plan-1-task-1-1");
  assert.equal(dispatch.dispatchId, "attempt-plan-1-task-1-1.dispatch.1");
  assert.equal(typeof dispatch.contractHash, "string");
  assert.match(dispatch.contractHash, /^[a-f0-9]{64}$/);
  assert.equal("hash" in dispatch.contract, false);
  assert.deepEqual(subject.spawned, []);
  assert.deepEqual(subject.appended.map(({ type }) => type), [
    "attempt.workspace-allocated",
    "attempt.dispatch-requested",
  ]);

  const intent = subject.appended[1];
  assert.equal(intent.data.attemptId, dispatch.attemptId);
  assert.equal(intent.data.dispatchId, dispatch.dispatchId);
  assert.equal(intent.data.toolHash, dispatch.contractHash);
  assert.deepEqual(intent.data.tool.contract, dispatch.contract);
  const expectedContract = {
    version: "dispatch-ir.v1",
    taskId: "task-1",
    title: "Exact task",
    agent: "executor",
    risk: "normal",
    objective: "Complete approved plan task task-1: Exact task.",
    workflow: { mode: "tdd" },
    requirements: [execution.task.body],
    context: {
      knownFacts: [
        `Plan title: ${execution.plan.title}`,
        `Plan instructions: ${execution.plan.instructions}`,
        `Task resources: ${JSON.stringify(execution.task.resources)}`,
      ],
      decisions: [JSON.stringify(execution.plan.executionPolicy)],
      relevantFiles: ["src/exact.mjs"],
    },
    boundaries: {
      writePaths: ["src/exact.mjs"],
      excludedWork: [],
      forbiddenActions: [],
    },
    acceptance: {
      criteria: [JSON.stringify(execution.task.acceptance)],
      commands: ["true"],
    },
    execution: { cwd: "/attempts/attempt-plan-1-task-1-1", timeoutMs: 321000 },
  };
  assert.deepEqual(dispatch.contract, expectedContract);
  const expectedTask = [
    `Plan: ${execution.plan.title}`,
    `Plan instructions:\n${execution.plan.instructions}`,
    `Task: ${execution.task.id} ${execution.task.title}`,
    `Task body:\n${execution.task.body}`,
    "Dependency receipts:\n[]",
    `Allowed paths: ${execution.task.allowedPaths.join(", ")}`,
    `Resources: ${JSON.stringify(execution.task.resources)}`,
    `Execution: ${JSON.stringify(execution.task.execution)}`,
    `Acceptance: ${execution.task.acceptance.strategy}`,
    JSON.stringify(execution.task.acceptance),
    "Attempt: attempt-plan-1-task-1-1",
    "Base commit: base",
    "Authoritative output: /results/attempt-plan-1-task-1-1.json",
    `Result contract: ${execution.plan.executionPolicy.resultContract}`,
    `Blocked result shape: ${JSON.stringify({ attempt_id: "attempt-plan-1-task-1-1", task_id: "task-1", status: "blocked", reason: "<code>", blockers: ["<sorted-code>"], changed_files: [], commit: null })}`,
  ].join("\n");
  assert.deepEqual(intent.data.tool, {
    agent: "executor",
    task: expectedTask,
    cwd: "/attempts/attempt-plan-1-task-1-1",
    context: "fresh",
    async: true,
    clarify: false,
    worktree: false,
    output: "/results/attempt-plan-1-task-1-1.json",
    outputMode: "file-only",
    acceptance: false,
    artifacts: true,
    timeoutMs: 321000,
    contract: expectedContract,
    dependencyReceipts: [],
  });
  assert.equal(typeof intent.data.tool.task, "string");
  assert.equal(intent.data.planIrHash, ir.hash);
  assert.equal(intent.data.taskHash, execution.task.hashes.effective);
  assert.equal(intent.data.schedulingHash, execution.task.hashes.scheduling);
  assert.equal(intent.data.dispatchContextHash, createHash("sha256").update(JSON.stringify({
    planIrHash: ir.hash,
    taskHash: execution.task.hashes.effective,
    schedulingHash: execution.task.hashes.scheduling,
    attemptId: dispatch.attemptId,
    baseCommit: "base",
    output: "/results/attempt-plan-1-task-1-1.json",
    dependencyReceipts: [],
  })).digest("hex"));
  const compiled = compileCodingDispatchIR(dispatch.contract, { cwd: "/repo" });
  assert.equal(compiled.hash, dispatch.contractHash);
  assert.equal(intent.data.toolHash, compiled.hash);
  assert.equal(compiled.execution.cwd, "/attempts/attempt-plan-1-task-1-1");
  assert.equal(compiled.execution.timeoutMs, 321000);
});


test("Task5A2 replays a pending intent before integration drain, allocation, or append", async () => {
  const approvedPlan = v3Plan();
  const ir = compilePlanToIR(approvedPlan);
  const first = harness({ approvedPlan, entries: [createdV3Entry(ir)] });
  const initial = await first.coordinator.prepareAuthorizedDispatches();
  const calls = [];
  const replayed = harness({
    approvedPlan,
    entries: [createdV3Entry(ir), ...first.appended],
    options: { integrationQueue: { async drain() { calls.push("drain"); throw new Error("must not drain pending intent"); } } },
  });

  const repeated = await replayed.coordinator.prepareAuthorizedDispatches();

  assert.equal(repeated.dispatches.length, 1);
  assert.deepEqual(repeated.dispatches[0], initial.dispatches[0]);
  assert.deepEqual(calls, []);
  assert.equal(replayed.allocations.length, 0);
  assert.equal(replayed.appended.length, 0);
});

test("Task5A2 rejects a replayed pending nested contract mismatch while reducer preserves the event", async () => {
  const approvedPlan = v3Plan();
  const ir = compilePlanToIR(approvedPlan);
  const initial = harness({ approvedPlan, entries: [createdV3Entry(ir)] });
  await initial.coordinator.prepareAuthorizedDispatches();
  const nestedTamper = structuredClone(initial.appended);
  nestedTamper[1].data.tool.contract.requirements[0] = "tampered";
  const nested = harness({ approvedPlan, entries: [createdV3Entry(ir), ...nestedTamper] });

  assert.equal(replay([createdV3Entry(ir), ...nestedTamper]).attempts.size, 1);
  await assert.rejects(nested.coordinator.prepareAuthorizedDispatches(), /contract hash mismatch/);
});

test("Task5A2 rejects a replayed pending stale dispatch context while reducer preserves the event", async () => {
  const approvedPlan = v3Plan();
  const ir = compilePlanToIR(approvedPlan);
  const initial = harness({ approvedPlan, entries: [createdV3Entry(ir)] });
  await initial.coordinator.prepareAuthorizedDispatches();
  const contextTamper = structuredClone(initial.appended);
  contextTamper[1].data.dispatchContextHash = "c".repeat(64);
  const context = harness({ approvedPlan, entries: [createdV3Entry(ir), ...contextTamper] });

  assert.equal(replay([createdV3Entry(ir), ...contextTamper]).attempts.size, 1);
  await assert.rejects(context.coordinator.prepareAuthorizedDispatches(), /stale revision\/context/);
});

test("Task5A2 rejects v3 preparation without current revision identity", async () => {
  const approvedPlan = v3Plan();
  const subject = harness({ approvedPlan, entries: [createdEntry(["task-1"])] });

  await assert.rejects(subject.coordinator.prepareAuthorizedDispatches(), /stale revision\/context/);
  assert.equal(subject.allocations.length, 0);
  assert.equal(subject.appended.length, 0);
});

test("Task5A2 resumes a workspace-allocated crash without allocating a second lease", async () => {
  const approvedPlan = v3Plan();
  const ir = compilePlanToIR(approvedPlan);
  const allocated = harness({ approvedPlan, entries: [createdV3Entry(ir)] });
  await allocated.coordinator.prepareAuthorizedDispatches().catch(() => {});
  const allocatedBeforeCrash = structuredClone(allocated.appended[0]);
  allocatedBeforeCrash.eventId = "allocated-before-crash";
  const replayed = harness({ approvedPlan, entries: [createdV3Entry(ir), allocatedBeforeCrash] });

  const result = await replayed.coordinator.prepareAuthorizedDispatches();

  assert.equal(result.dispatches[0].attemptId, "attempt-plan-1-task-1-1");
  assert.equal(replayed.allocations.length, 0);
  assert.deepEqual(replayed.appended.map(({ type }) => type), ["attempt.dispatch-requested"]);
});

test("Task5A2 rejects a stale workspace-allocated recovery candidate", async () => {
  const approvedPlan = v3Plan();
  const ir = compilePlanToIR(approvedPlan);
  const allocated = harness({ approvedPlan, entries: [createdV3Entry(ir)] });
  await allocated.coordinator.prepareAuthorizedDispatches().catch(() => {});
  const stale = structuredClone(allocated.appended[0]);
  stale.data.baseCommit = "stale";
  const staleSubject = harness({ approvedPlan, entries: [createdV3Entry(ir), stale] });

  assert.equal(replay([createdV3Entry(ir), stale]).attempts.size, 1);
  await assert.rejects(staleSubject.coordinator.prepareAuthorizedDispatches(), /stale base/);
});

test("Task5A2 prepares every independent v3 frontier without spawning", async () => {
  const approvedPlan = v3ParallelPlan();
  const ir = compilePlanToIR(approvedPlan);
  const subject = harness({ approvedPlan, entries: [createdV3Entry(ir)], backend: { async spawn() { throw new Error("must not spawn"); } } });

  const result = await subject.coordinator.prepareAuthorizedDispatches();

  assert.deepEqual(result.dispatches.map(({ contract }) => contract.taskId), ["task-1", "task-2"]);
  assert.deepEqual(subject.appended.map(({ type }) => type), ["attempt.workspace-allocated", "attempt.dispatch-requested", "attempt.workspace-allocated", "attempt.dispatch-requested"]);
  assert.equal(subject.spawned.length, 0);
});

test("Task5A2 replays all durable pending intents before integration drain", async () => {
  const approvedPlan = v3ParallelPlan();
  const ir = compilePlanToIR(approvedPlan);
  const first = harness({ approvedPlan, entries: [createdV3Entry(ir)] });
  const initial = await first.coordinator.prepareAuthorizedDispatches();
  const calls = [];
  const replayed = harness({
    approvedPlan,
    entries: [createdV3Entry(ir), ...first.appended],
    options: { integrationQueue: { async drain() { calls.push("drain"); throw new Error("must not drain pending intents"); } } },
  });

  const repeated = await replayed.coordinator.prepareAuthorizedDispatches();

  assert.deepEqual(repeated.dispatches.map(({ contract }) => contract.taskId), ["task-1", "task-2"]);
  assert.deepEqual(repeated.dispatches, initial.dispatches);
  assert.deepEqual(calls, []);
  assert.equal(replayed.allocations.length, 0);
  assert.equal(replayed.appended.length, 0);
});

test("Task5A2 binds redacted integrated dependency receipts into the dispatch context", async () => {
  const approvedPlan = v3DependencyPlan();
  const ir = compilePlanToIR(approvedPlan);
  const subject = harness({ approvedPlan, entries: integratedDependencyEntries(ir) });

  const result = await subject.coordinator.prepareAuthorizedDispatches();

  const receipt = result.dispatches[0].contract.context.knownFacts.find((fact) => fact.startsWith("Dependency receipts: "));
  assert.ok(receipt, "Coordinator must bind the integrated dependency receipt into contract context");
  assert.equal(receipt, `Dependency receipts: ${JSON.stringify([{ taskId: "task-1", resultCommit: "dependency-result", integratedHead: "dependency-head", changedPaths: ["src/receipt.mjs"], verificationSummary: [{ commandId: "test", exitCode: 0 }] }])}`);
  assert.equal(subject.appended[1].data.tool.dependencyReceipts.length, 1);
  assert.equal(subject.appended[1].data.dispatchContextHash, createHash("sha256").update(JSON.stringify({
    planIrHash: ir.hash, taskHash: ir.nodes[1].hashes.effective, schedulingHash: ir.nodes[1].hashes.scheduling,
    attemptId: result.dispatches[0].attemptId, baseCommit: "dependency-head", output: `/results/${result.dispatches[0].attemptId}.json`,
    dependencyReceipts: subject.appended[1].data.tool.dependencyReceipts,
  })).digest("hex"));
  const currentWorkspace = `/attempts/${result.dispatches[0].attemptId}`;
  assert.equal(subject.appended[1].data.tool.cwd, currentWorkspace);
  assert.equal(subject.appended[1].data.tool.contract.execution.cwd, currentWorkspace);
  const publicDependencyProjections = [
    subject.appended[1].data.tool.dependencyReceipts,
    receipt,
    subject.appended[1].data.tool.task,
  ].map((projection) => JSON.stringify(projection));
  for (const privateValue of ["private stdout", "private stderr", "/private/transcript", "/private/evidence.json", "/private/local-transcript", "/attempts/"]) {
    for (const projection of publicDependencyProjections) assert.equal(projection.includes(privateValue), false);
  }
});

test("Task5A2 returns a blocked empty preparation when integration drain blocks", async () => {
  const subject = harness({
    approvedPlan: v3Plan(),
    options: { integrationQueue: { async drain() { return { state: "blocked", integrated: [] }; } } },
  });

  const result = await subject.coordinator.prepareAuthorizedDispatches();

  assert.equal(result.state, "blocked");
  assert.deepEqual(result.dispatches, []);
  assert.equal(subject.allocations.length, 0);
  assert.equal(subject.appended.length, 0);
});

test("Task5A2 drains integration before preparing a newly authorized frontier", async () => {
  const drained = [];
  const subject = harness({
    approvedPlan: v3Plan(),
    options: { integrationQueue: { async drain(input) { drained.push(input); return { state: "waiting", integrated: [] }; } } },
  });

  const result = await subject.coordinator.prepareAuthorizedDispatches();

  assert.equal(drained.length, 1);
  assert.equal(result.state, "dispatch-required");
});

test("Task5A2 preserves every supported workflow mode in independent preparations", async () => {
  const subjects = [
    [v3Plan({ taskExecution: { workflow: { mode: "tdd" } } }), { mode: "tdd" }],
    [v3Plan({ taskExecution: { workflow: { mode: "existing-tests", reason: "covered" } } }), { mode: "existing-tests", reason: "covered" }],
    [v3Plan({ taskExecution: { workflow: { mode: "docs-only", reason: "documentation" } } }), { mode: "docs-only", reason: "documentation" }],
  ].map(([approvedPlan, expected]) => ({ subject: harness({ approvedPlan }), expected }));
  const results = await Promise.allSettled(subjects.map(({ subject }) => subject.coordinator.prepareAuthorizedDispatches()));

  assert.deepEqual(results.map(({ status }) => status), ["fulfilled", "fulfilled", "fulfilled"]);
  assert.deepEqual(results.map((result) => result.value.dispatches[0].contract.workflow), subjects.map(({ expected }) => expected));
});

test("Task5A2 preserves verification commands rooted in a safe subdirectory", async () => {
  const subject = harness({ approvedPlan: v3Plan({ verification: [{ id: "test", command: "node --test", cwd: "test/unit", timeoutMs: 900000 }] }) });
  const result = await subject.coordinator.prepareAuthorizedDispatches();

  assert.deepEqual(result.dispatches[0].contract.acceptance.commands, ["cd -- 'test/unit' && node --test"]);
});

test("Task5A2 shell-quotes apostrophes in verification cwd", async () => {
  const subject = harness({ approvedPlan: v3Plan({ verification: [{ id: "test", command: "node --test", cwd: "test/it's", timeoutMs: 900000 }] }) });
  const result = await subject.coordinator.prepareAuthorizedDispatches();

  assert.deepEqual(result.dispatches[0].contract.acceptance.commands, ["cd -- 'test/it'\"'\"'s' && node --test"]);
});

test("Task5A2 preserves non-command acceptance JSON with the base diff command", async () => {
  const subject = harness({ approvedPlan: v3Plan({ taskAcceptance: { "task-1": { strategy: "inherit-final", reason: "final integration" } } }) });
  const result = await subject.coordinator.prepareAuthorizedDispatches();

  assert.deepEqual(result.dispatches[0].contract.acceptance, {
    criteria: [JSON.stringify({ strategy: "inherit-final", reason: "final integration" })],
    commands: ["git diff --check base..HEAD"],
  });
});

test("Task5A2 chunks 5000-byte requirements and plan instruction facts without truncation", async () => {
  const longText = "x".repeat(5000);
  const approvedPlan = v3Plan({ instructions: longText, body: longText });
  const ir = compilePlanToIR(approvedPlan);
  const subject = harness({ approvedPlan });

  const result = await subject.coordinator.prepareAuthorizedDispatches();
  const contract = result.dispatches[0].contract;
  assert.equal(contract.requirements.join(""), ir.nodes[0].body);
  const instructionFacts = contract.context.knownFacts.filter((fact) => fact.startsWith("Plan instructions ("));
  assert.equal(instructionFacts.length > 1, true);
  assert.equal(instructionFacts.map((fact, index) => {
    const prefix = `Plan instructions (${index + 1}/${instructionFacts.length}): `;
    assert.equal(fact.startsWith(prefix), true);
    return fact.slice(prefix.length);
  }).join(""), ir.instructions);
  assert.equal(contract.requirements.every((value) => Buffer.byteLength(value) <= 4096), true);
  assert.equal(instructionFacts.every((value) => Buffer.byteLength(value) <= 4096), true);
  assert.equal(subject.allocations.length, 1);
});

test("Task5A2 preserves whitespace at dispatch chunk boundaries", async () => {
  const probeBody = "probe-body";
  const probeInstructions = "probe-instructions";
  const probe = compilePlanToIR(v3Plan({ instructions: probeInstructions, body: probeBody }));
  const bodyPrefix = Buffer.byteLength(probe.nodes[0].body) - Buffer.byteLength(probeBody);
  const instructionsPrefix = Buffer.byteLength(probe.instructions) - Buffer.byteLength(probeInstructions);
  const body = "x".repeat(4095 - bodyPrefix) + " " + "body-tail";
  const instructions = "x".repeat(3999 - instructionsPrefix) + " " + "instructions-tail";
  const approvedPlan = v3Plan({ instructions, body });
  const ir = compilePlanToIR(approvedPlan);
  const subject = harness({ approvedPlan });

  const result = await subject.coordinator.prepareAuthorizedDispatches();
  const contract = result.dispatches[0].contract;
  const instructionFacts = contract.context.knownFacts.filter((fact) => fact.startsWith("Plan instructions ("));
  const reconstructed = {
    body: contract.requirements.join(""),
    instructions: instructionFacts.map((fact) => fact.slice(fact.indexOf(": ") + 2)).join(""),
  };

  assert.deepEqual(reconstructed, { body: ir.nodes[0].body, instructions: ir.instructions });
});

test("Task5A2 rejects total dispatch expression capacity before workspace allocation", async () => {
  const subject = harness({ approvedPlan: v3Plan({ instructions: "x".repeat(33 * 4096) }) });

  await assert.rejects(subject.coordinator.prepareAuthorizedDispatches(), /capacity/);
  assert.equal(subject.allocations.length, 0);
});

test("Task5A2 rejects overlong verification capacity before workspace allocation", async () => {
  const verification = Array.from({ length: 33 }, (_, index) => ({ id: `test-${index}`, command: "true", cwd: ".", timeoutMs: 900000 }));
  const subject = harness({ approvedPlan: v3Plan({ verification, taskAcceptance: { "task-1": { strategy: "commands", commandIds: verification.map(({ id }) => id) } } }) });

  await assert.rejects(subject.coordinator.prepareAuthorizedDispatches(), /capacity/);
  assert.equal(subject.allocations.length, 0);
});

test("v3 dispatch carries body-only IR hash changes while scheduling remains stable", async () => {
  const baseline = await dispatchV3(v3Plan());
  const changed = await dispatchV3(v3Plan({ body: "Implement the changed approved behavior." }));

  assert.notEqual(changed.event.data.tool.task, baseline.event.data.tool.task);
  assert.notEqual(changed.event.data.planIrHash, baseline.event.data.planIrHash);
  assert.notEqual(changed.event.data.taskHash, baseline.event.data.taskHash);
  assert.notEqual(changed.event.data.dispatchContextHash, baseline.event.data.dispatchContextHash);
  assert.equal(changed.event.data.schedulingHash, baseline.event.data.schedulingHash);
  assert.notEqual(changed.ir.nodes[0].hashes.full, baseline.ir.nodes[0].hashes.full);
  assert.notEqual(changed.ir.nodes[0].hashes.effective, baseline.ir.nodes[0].hashes.effective);
});

test("v3 dispatch carries instructions-only effective hash changes while local full remains stable", async () => {
  const baseline = await dispatchV3(v3Plan());
  const changed = await dispatchV3(v3Plan({ instructions: "Keep the changed global execution contract intact." }));

  assert.notEqual(changed.event.data.tool.task, baseline.event.data.tool.task);
  assert.notEqual(changed.event.data.planIrHash, baseline.event.data.planIrHash);
  assert.notEqual(changed.event.data.taskHash, baseline.event.data.taskHash);
  assert.notEqual(changed.event.data.dispatchContextHash, baseline.event.data.dispatchContextHash);
  assert.equal(changed.event.data.schedulingHash, baseline.event.data.schedulingHash);
  assert.equal(changed.ir.nodes[0].hashes.full, baseline.ir.nodes[0].hashes.full);
  assert.notEqual(changed.ir.nodes[0].hashes.effective, baseline.ir.nodes[0].hashes.effective);
});

test("v3 dispatch inherits the executor agent with task risk and timeout identity changes", async () => {
  const baseline = await dispatchV3(v3Plan());
  const changed = await dispatchV3(v3Plan({ taskExecution: { risk: "high", timeoutMs: 123000 } }));

  assert.equal(changed.ir.nodes[0].execution.agent, "executor");
  assert.equal(changed.ir.nodes[0].execution.risk, "high");
  assert.equal(changed.ir.nodes[0].execution.timeoutMs, 123000);
  assert.equal(changed.event.data.tool.agent, changed.ir.nodes[0].execution.agent);
  assert.equal(changed.event.data.tool.timeoutMs, 123000);
  assert.equal(changed.spawned.agent, changed.ir.nodes[0].execution.agent);
  assert.equal(changed.spawned.timeoutMs, 123000);
  assert.notEqual(changed.event.data.planIrHash, baseline.event.data.planIrHash);
  assert.notEqual(changed.event.data.taskHash, baseline.event.data.taskHash);
  assert.equal(changed.event.data.schedulingHash, baseline.event.data.schedulingHash);
  assert.notEqual(changed.event.data.dispatchContextHash, baseline.event.data.dispatchContextHash);
  assert.notEqual(changed.ir.nodes[0].hashes.full, baseline.ir.nodes[0].hashes.full);
  assert.notEqual(changed.ir.nodes[0].hashes.effective, baseline.ir.nodes[0].hashes.effective);
});

test("v3 dependency dispatch fails closed before allocation when its integrated receipt is incomplete", async () => {
  const approvedPlan = v3DependencyPlan();
  const ir = compilePlanToIR(approvedPlan);
  const projection = replay([createdV3Entry(ir)]);
  projection.tasks.set("task-1", { status: "accepted" });
  projection.attempts.set("attempt-plan-1-task-1-1", {
    taskId: "task-1", status: "integrated", resultCommit: "dependency-result",
    integration: { newHead: "dependency-head" }, validationChangedPaths: ["src/exact.mjs"],
  });
  const subject = harness({ approvedPlan, entries: [createdV3Entry(ir)], options: { readProjection: () => projection } });
  await assert.rejects(subject.coordinator.dispatchAuthorized(), /integrated dependency receipt is incomplete/);
  assert.equal(subject.allocations.length, 0);
  assert.equal(subject.spawned.length, 0);
  assert.equal(subject.appended.length, 0);
});

test("v3 dependency dispatch replays an integrated receipt into the exact redacted prompt", async () => {
  const approvedPlan = v3DependencyPlan();
  const ir = compilePlanToIR(approvedPlan);
  const subject = harness({ approvedPlan, entries: integratedDependencyEntries(ir) });

  const dispatched = await subject.coordinator.dispatchAuthorized();

  assert.deepEqual(dispatched.dispatched.map(({ taskId }) => taskId), ["task-2"]);
  assert.equal(subject.spawned.length, 1);
  const prompt = subject.appended.find(({ type }) => type === "attempt.dispatch-requested").data.tool.task;
  const receipts = [{
    taskId: "task-1", resultCommit: "dependency-result", integratedHead: "dependency-head",
    changedPaths: ["src/receipt.mjs"], verificationSummary: [{ commandId: "test", exitCode: 0 }],
  }];
  assert.equal(prompt.includes(`Dependency receipts:\n${JSON.stringify(receipts)}`), true);
  for (const privateValue of ["private stdout", "private stderr", "/private/transcript", "/private/evidence.json", "/private/local-transcript", "/attempts/"]) {
    assert.equal(prompt.includes(privateValue), false);
  }
});

test("v3 successful settle enqueues dependencies from the compiled dependency view", async () => {
  const approvedPlan = v3DependencyPlan();
  const ir = compilePlanToIR(approvedPlan);
  const queued = [];
  const subject = harness({
    approvedPlan,
    entries: integratedDependencyEntries(ir),
    options: {
      integrationQueue: { enqueue(attempt) { queued.push(attempt); }, async drain() { return { state: "waiting", integrated: [] }; } },
      readAttemptHead: async () => "task-2-result",
      validateAttemptResult: async () => ({
        accepted: true, resultCommit: "task-2-result", diffSha256: "task-2-diff", changedPaths: ["src/consumer.mjs"],
        evidence: [{ kind: "command", commandId: "test", exitCode: 0 }],
      }),
    },
  });
  const dispatched = await subject.coordinator.dispatchAuthorized();
  const attemptId = dispatched.dispatched[0].attemptId;

  await assert.doesNotReject(subject.coordinator.settleBoundAttempt("succeeded", attemptId));

  const validation = subject.appended.find(({ type }) => type === "attempt.validated");
  assert.equal(validation.data.attemptId, attemptId);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].deps, ["task-1"]);
  assert.equal(queued[0].validationHash, validation.data.validationHash);
});
