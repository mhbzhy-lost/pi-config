import assert from "node:assert/strict";
import test from "node:test";

import { createPlanEventWriter } from "../scripts/lib/plan/plan-event-writer.mjs";
import { applyEvent, createProjection } from "../scripts/lib/plan/plan-events.mjs";
import { createPlanCoordinator } from "../scripts/lib/plan/coordinator.mjs";
import { compilePlanToIR } from "../scripts/lib/plan/ir/index.mjs";

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
  const result = createPlanCoordinator({
    ir: compilePlanToIR(approvedPlan),
    entries: entries ?? [createdEntry(approvedPlan.tasks.map(({ id }) => id))],
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
