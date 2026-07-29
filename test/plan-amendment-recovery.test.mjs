import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createPlanRunnerDependencies } from "../scripts/lib/plan/plan-runner-dependencies.mjs";
import { createPlanControl } from "../scripts/lib/plan/plan-control.mjs";
import { applyEvent, createProjection } from "../scripts/lib/plan/plan-events.mjs";
import { createPlanRevisionStore } from "../scripts/lib/plan/plan-revision-store.mjs";

const execFile = promisify(execFileCallback);
const sha = (seed) => seed.repeat(64).slice(0, 64);

async function git(cwd, ...args) {
  return (await execFile("git", args, { cwd })).stdout.trim();
}

function source(revision, parentPlanHash, changed = ["original", "original"]) {
  return Buffer.from(`# Recovery fixture

## Execution Contract

\`\`\`json
{"schemaVersion":"pi-plan.v3","revision":${revision},"parentPlanHash":${JSON.stringify(parentPlanHash)},"verification":[{"id":"test","command":"true","cwd":".","timeoutMs":900000}],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"],"resourceCapacities":{},"executionDefaults":{"agent":"executor","risk":"normal","workflow":{"mode":"inherit-repository"},"timeoutMs":900000},"taskExecution":{"task-1":{},"task-2":{},"task-3":{}},"taskAcceptance":{"task-1":{"strategy":"commands","commandIds":["test"]},"task-2":{"strategy":"commands","commandIds":["test"]},"task-3":{"strategy":"commands","commandIds":["test"]}}}
\`\`\`

Recover amendment workspaces after an interrupted approved revision.

### Task 1: Authorization source

**Files:**
- Modify: \`a.txt\`

Authorize amendment recovery.

### Task 2: ${changed[0]}

**Files:**
- Modify: \`b.txt\`

Perform the changed target task.

### Task 3: ${changed[1]}

**Files:**
- Modify: \`c.txt\`

Perform the second changed target task.
`);
}

function event(planId, type, data) {
  return {
    schemaVersion: "pi-plan-event.v1",
    eventId: crypto.randomUUID(),
    planId,
    occurredAt: "2026-07-29T00:00:00.000Z",
    type,
    data,
  };
}

function replay(entries) {
  return entries.reduce((projection, entry) => applyEvent(projection, entry), createProjection());
}

function attemptId(index = 0) {
  return `attempt-${String(index + 1).padStart(2, "0")}`;
}

function terminalProof(id) {
  return {
    kind: "terminal",
    dispatchId: `${id}-dispatch`,
    runId: `${id}-run`,
    asyncDir: `/attempts/${id}/async`,
    artifactSha256: sha("f"),
  };
}

async function fixture({
  attempt = "workspace-allocated",
  attempts = [{ attemptId: attemptId(), taskId: "task-2", status: attempt }],
  reverseInsertion = false,
  pointer = "match",
  inspect = async () => ({ clean: true }),
  release = async () => {},
  append = async () => {},
  backend: backendOverrides = {},
} = {}) {
  const origin = await mkdtemp(path.join(os.tmpdir(), "pi-amend-recovery-"));
  const stateRoot = path.join(origin, "state");
  const planId = "recovery";
  await git(origin, "init");
  await git(origin, "config", "user.email", "test@example.com");
  await git(origin, "config", "user.name", "Test");
  await writeFile(path.join(origin, "README.md"), "base\n");
  await git(origin, "add", ".");
  await git(origin, "commit", "-m", "base");
  const baseCommit = await git(origin, "rev-parse", "HEAD");
  const worktree = path.join(stateRoot, "var", "plan-worktrees", planId);
  await mkdir(path.dirname(worktree), { recursive: true });
  await git(origin, "worktree", "add", "-b", `pi-plan/${planId}`, worktree, baseCommit);

  const store = createPlanRevisionStore({ stateRoot });
  const one = await store.prepareRevision({ planId, sourceBytes: source(1, null), reason: "initial-approval", initiator: { kind: "launcher" } });
  const two = await store.prepareRevision({ planId, sourceBytes: source(2, one.manifest.planHash, ["changed contract", "changed second contract"]), reason: "scope-approved", initiator: { kind: "supervisor-request", requestId: "auth", taskId: "task-1", attemptId: "auth-attempt", runId: "auth-run" } });
  const [r1, r2] = await Promise.all([store.readRevision(planId, 1), store.readRevision(planId, 2)]);
  if (pointer === "match") await store.writeCurrent(r2);
  const workspace = { originRoot: origin, worktree, baseCommit, headCommit: baseCommit };
  const entries = [event(planId, "plan.created", { workspace, tasks: ["task-1", "task-2", "task-3"], revision: { number: 1, manifestSha256: r1.manifestSha256, sourceBytesSha256: r1.manifest.sourceBytesSha256, planHash: r1.manifest.planHash, irVersion: r1.manifest.irVersion, irHash: r1.manifest.irHash, taskHashes: r1.manifest.taskHashes } })];
  const authLease = { path: "/auth", branch: "pi-plan-attempt/recovery/task-1/auth", ownerToken: "auth-owner" };
  entries.push(
    event(planId, "attempt.workspace-allocated", { attemptId: "auth-attempt", taskId: "task-1", baseCommit, workspace: authLease }),
    event(planId, "attempt.dispatch-requested", { attemptId: "auth-attempt", taskId: "task-1", dispatchId: "auth-dispatch", baseCommit, workspace: authLease, tool: { agent: "executor", task: "auth", cwd: "/auth", output: "/auth.out", timeoutMs: 1, context: "fresh", async: true, clarify: false, worktree: false }, toolHash: sha("a"), planIrHash: r1.manifest.irHash, taskHash: r1.manifest.taskHashes["task-1"].effective, schedulingHash: r1.manifest.taskHashes["task-1"].scheduling, dispatchContextHash: sha("b") }),
    event(planId, "attempt.bound", { attemptId: "auth-attempt", taskId: "task-1", dispatchId: "auth-dispatch", runId: "auth-run", asyncDir: "/auth-async", sessionFile: "/auth.session" }),
    event(planId, "attempt.attention-requested", { requestId: "auth", taskId: "task-1", attemptId: "auth-attempt", runId: "auth-run", kind: "need_decision", message: "approved", projectionVersion: 5, createdAt: "2026-07-29T00:00:00.000Z" }),
    event(planId, "attempt.attention-resolved", { attemptId: "auth-attempt", requestId: "auth", runId: "auth-run", expectedProjectionVersion: 5, resolutionSha256: sha("c") }),
  );
  for (const target of (reverseInsertion ? [...attempts].reverse() : attempts)) {
    const { attemptId: id, taskId, status } = target;
    const lease = { path: `/attempts/${id}`, branch: `pi-plan-attempt/recovery/${taskId}/0`, ownerToken: `${id}-owner` };
    entries.push(event(planId, "attempt.workspace-allocated", { attemptId: id, taskId, baseCommit, workspace: lease }));
    if (status !== "workspace-allocated") {
      const tool = { agent: "executor", task: "target", cwd: lease.path, output: `${lease.path}/out`, timeoutMs: 1, context: "fresh", async: true, clarify: false, worktree: false };
      entries.push(event(planId, "attempt.dispatch-requested", { attemptId: id, taskId, dispatchId: `${id}-dispatch`, baseCommit, workspace: lease, tool, toolHash: sha("d"), planIrHash: r1.manifest.irHash, taskHash: r1.manifest.taskHashes[taskId].effective, schedulingHash: r1.manifest.taskHashes[taskId].scheduling, dispatchContextHash: sha("e") }));
      if (status === "active") entries.push(event(planId, "attempt.bound", { attemptId: id, taskId, dispatchId: `${id}-dispatch`, runId: `${id}-run`, asyncDir: `${lease.path}/async`, sessionFile: `${lease.path}/session` }));
    }
  }
  entries.push(event(planId, "plan.amended", { revision: 2, parentRevision: 1, manifestSha256: r2.manifestSha256, sourceBytesSha256: r2.manifest.sourceBytesSha256, planHash: r2.manifest.planHash, irHash: r2.manifest.irHash, taskHashes: r2.manifest.taskHashes, diff: { added: [], changed: ["task-2", "task-3"], rebound: [], retired: [], unchanged: ["task-1"] }, supersededAttemptIds: attempts.map(({ attemptId: id }) => id).sort(), requestId: "auth", reason: "approved recovery" }));

  const calls = { supersede: [], recoverBinding: [], recoverDispatch: [], release: [], inspect: [], spawn: [], stop: [] };
  const backend = {
    async spawn(input) { calls.spawn.push(input); },
    async supersede(input) { calls.supersede.push(input); return terminalProof(input.attemptId); },
    async recoverDispatch(input) { calls.recoverDispatch.push(input); },
    async recoverBinding(input) { calls.recoverBinding.push(input); },
    ...backendOverrides,
  };
  const revisionStore = { readRevision: (...args) => store.readRevision(...args), readCurrent: (...args) => store.readCurrent(...args), writeCurrent: (...args) => store.writeCurrent(...args) };
  const deps = createPlanRunnerDependencies({
    pi: { async appendEntry(_type, entry) { await append(entry); entries.push(entry); } },
    originRoot: origin,
    stateRoot,
    revisionStore,
    executionBackend: backend,
    inspectAttemptWorkspace: async (input) => { calls.inspect.push(input); return inspect(input); },
    releaseAttemptWorkspace: async (input, options) => { calls.release.push([input, options]); return release(input, options); },
  });
  return { origin, store, revisionStore, entries, calls, deps, ctx: { cwd: worktree, sessionManager: { getBranch: () => entries.map((data) => ({ customType: "pi-plan-event-v1", data })) } } };
}

function eventsOf(fixture, type) {
  return fixture.entries.filter((entry) => entry.type === type);
}

function targetCalls(fixture, name) {
  return fixture.calls[name].filter((call) => {
    if (name === "release") return call[0].path === `/attempts/${attemptId()}`;
    return (Array.isArray(call) ? call[0] : call).attemptId === attemptId();
  });
}

function assertRecovery(fixture, { proof = 1, release = 1, supersede = 0, recoverBinding = 0, stop = 0, physicalRelease = 1 } = {}) {
  const projection = replay(fixture.entries);
  const id = attemptId();
  assert.equal(eventsOf(fixture, "plan.amended").length, 1);
  assert.equal(eventsOf(fixture, "attempt.superseded").length, proof);
  assert.equal(eventsOf(fixture, "attempt.workspace-released").length, release);
  assert.equal(targetCalls(fixture, "supersede").length, supersede);
  assert.equal(targetCalls(fixture, "recoverBinding").length, recoverBinding);
  assert.equal(targetCalls(fixture, "stop").length, stop);
  assert.equal(targetCalls(fixture, "spawn").length, 0);
  assert.equal(targetCalls(fixture, "release").length, physicalRelease);
  assert.equal(projection.attempts.get(id).workspaceReleased === true, release === 1);
  return projection;
}

test("recovery records never-started proof and cleanup release", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.origin, { recursive: true, force: true }));
  await f.deps.recoverSupersededAttempts({ ctx: f.ctx });
  assert.deepEqual(eventsOf(f, "attempt.superseded")[0].data.evidence, { kind: "never-started", dispatchId: null });
  assert.deepEqual(eventsOf(f, "attempt.workspace-released")[0].data, { attemptId: attemptId(), disposition: "superseded-cleanup", evidence: { kind: "superseded-cleanup" } });
  assert.equal(f.calls.inspect.length, 1);
  assertRecovery(f);
});

test("recovery repairs a missing pointer but does not rewrite a matching pointer", async (t) => {
  const matching = await fixture();
  const missing = await fixture({ pointer: "missing" });
  t.after(() => Promise.all([rm(matching.origin, { recursive: true, force: true }), rm(missing.origin, { recursive: true, force: true })]));
  let matchingWrites = 0;
  const writeMatching = matching.revisionStore.writeCurrent.bind(matching.revisionStore);
  matching.revisionStore.writeCurrent = async (...input) => { matchingWrites++; return writeMatching(...input); };
  await matching.deps.recoverSupersededAttempts({ ctx: matching.ctx });
  await missing.deps.recoverSupersededAttempts({ ctx: missing.ctx });
  assert.equal(matchingWrites, 0);
  assert.equal(eventsOf(missing, "attempt.workspace-released").length, 1);
});

test("active recovery binds persisted session identity before retrying terminal supersede", async (t) => {
  let first = true;
  let stopped = false;
  const f = await fixture({ attempt: "active", backend: {
    async supersede(input) {
      f.calls.supersede.push(input);
      if (first) { first = false; throw Object.assign(new Error("missing"), { code: "EXECUTION_DISPATCH_NOT_FOUND" }); }
      if (!stopped) { stopped = true; f.calls.stop.push(input); }
      return terminalProof(input.attemptId);
    },
  } });
  t.after(() => rm(f.origin, { recursive: true, force: true }));
  await f.deps.recoverSupersededAttempts({ ctx: f.ctx });
  const id = attemptId();
  assert.deepEqual(f.calls.recoverBinding, [{ dispatchId: `${id}-dispatch`, attemptId: id, runId: `${id}-run`, asyncDir: `/attempts/${id}/async`, cwd: `/attempts/${id}`, output: `/attempts/${id}/out`, sessionId: `/attempts/${id}/session`, sessionFile: `/attempts/${id}/session` }]);
  assert.deepEqual(eventsOf(f, "attempt.superseded")[0].data.evidence, terminalProof(id));
  assertRecovery(f, { supersede: 2, recoverBinding: 1, stop: 1 });
});

test("active recovery fails closed when recoverBinding rejects", async (t) => {
  for (const { failure, code, message } of [
    {
      failure: () => { throw Object.assign(new Error("Negotiated execution session does not match recovered binding."), { code: "EXECUTION_CAPABILITY_MISMATCH" }); },
      code: "EXECUTION_CAPABILITY_MISMATCH",
      message: "Negotiated execution session does not match recovered binding.",
    },
    {
      failure: () => Promise.reject(Object.assign(new Error("Recovered execution binding conflicts with an existing binding."), { code: "EXECUTION_BINDING_CONFLICT" })),
      code: "EXECUTION_BINDING_CONFLICT",
      message: "Recovered execution binding conflicts with an existing binding.",
    },
  ]) {
    const f = await fixture({ attempt: "active", backend: {
      async supersede(input) { f.calls.supersede.push(input); throw Object.assign(new Error("missing"), { code: "EXECUTION_DISPATCH_NOT_FOUND" }); },
      async recoverBinding(input) { f.calls.recoverBinding.push(input); return failure(); },
    } });
    t.after(() => rm(f.origin, { recursive: true, force: true }));
    await assert.rejects(f.deps.recoverSupersededAttempts({ ctx: f.ctx }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.some((cause) => cause.code === code && cause.message === message));
      return true;
    });
    assert.equal(targetCalls(f, "recoverBinding").length, 1);
    assert.equal(targetCalls(f, "supersede").length, 1);
    assert.equal(eventsOf(f, "attempt.superseded").length, 0);
    assert.equal(eventsOf(f, "attempt.workspace-released").length, 0);
    assertRecovery(f, { proof: 0, release: 0, supersede: 1, recoverBinding: 1, physicalRelease: 0 });
  }
});

test("dirty and inspection uncertainty preserve, while terminal proof skips inspection", async (t) => {
  for (const inspect of [async () => ({ clean: false }), async () => { throw new Error("inspect"); }]) {
    const f = await fixture({ inspect });
    t.after(() => rm(f.origin, { recursive: true, force: true }));
    await f.deps.recoverSupersededAttempts({ ctx: f.ctx });
    assert.equal(replay(f.entries).attempts.get(attemptId()).workspaceDisposition, "superseded-preserve");
  }
  const terminal = await fixture({ attempt: "dispatch-requested" });
  t.after(() => rm(terminal.origin, { recursive: true, force: true }));
  await terminal.deps.recoverSupersededAttempts({ ctx: terminal.ctx });
  assert.equal(replay(terminal.entries).attempts.get(attemptId()).workspaceDisposition, "superseded-preserve");
  assert.equal(terminal.calls.inspect.length, 0);
});

test("NOT_FOUND dispatch recovery uses persisted request identity and retries without spawn", async (t) => {
  let first = true;
  const f = await fixture({ attempt: "dispatch-requested", backend: {
    async supersede(input) {
      f.calls.supersede.push(input);
      if (first) { first = false; throw Object.assign(new Error("missing"), { code: "EXECUTION_DISPATCH_NOT_FOUND" }); }
      return terminalProof(input.attemptId);
    },
  } });
  t.after(() => rm(f.origin, { recursive: true, force: true }));
  await f.deps.recoverSupersededAttempts({ ctx: f.ctx });
  assert.deepEqual(Object.keys(f.calls.recoverDispatch[0]).sort(), ["agent", "attemptId", "cwd", "dispatchId", "output", "task", "timeoutMs"]);
  assert.equal(f.calls.supersede.length, 2);
  assert.equal(f.calls.spawn.length, 0);
});

test("pointer repair failure aggregates after cleanup and blocks plan blocking", async (t) => {
  const f = await fixture({ pointer: "missing" });
  t.after(() => rm(f.origin, { recursive: true, force: true }));
  f.revisionStore.writeCurrent = async () => { throw new Error("pointer"); };
  await assert.rejects(f.deps.recoverSupersededAttempts({ ctx: f.ctx }), AggregateError);
  assert.deepEqual(f.calls.release.map(([input]) => input.path), [`/attempts/${attemptId()}`]);
  assert.equal(eventsOf(f, "plan.amended").length, 1);

  const g = await fixture({ pointer: "missing" });
  t.after(() => rm(g.origin, { recursive: true, force: true }));
  g.revisionStore.writeCurrent = async () => { throw new Error("pointer"); };
  await assert.rejects(g.deps.blockPlan({ reason: "no" }, { ctx: g.ctx }), AggregateError);
  assert.equal(eventsOf(g, "plan.blocked").length, 0);
});

test("proof append failure retries acquisition without a second physical stop", async (t) => {
  let failProof = true;
  let first = true;
  let terminal;
  const f = await fixture({ attempt: "active", append: async (entry) => {
    if (entry.type === "attempt.superseded" && failProof) { failProof = false; throw new Error("proof append failed"); }
  }, backend: {
    async supersede(input) {
      f.calls.supersede.push(input);
      if (first) { first = false; throw Object.assign(new Error("missing"), { code: "EXECUTION_DISPATCH_NOT_FOUND" }); }
      if (!terminal) { f.calls.stop.push(input); terminal = terminalProof(input.attemptId); }
      return terminal;
    },
  } });
  t.after(() => rm(f.origin, { recursive: true, force: true }));
  await assert.rejects(f.deps.recoverSupersededAttempts({ ctx: f.ctx }), AggregateError);
  assertRecovery(f, { proof: 0, release: 0, supersede: 2, recoverBinding: 1, stop: 1, physicalRelease: 0 });
  await f.deps.recoverSupersededAttempts({ ctx: f.ctx });
  assert.deepEqual(eventsOf(f, "attempt.superseded")[0].data.evidence, terminalProof(attemptId()));
  assertRecovery(f, { supersede: 3, recoverBinding: 1, stop: 1 });
});

test("workspace release append failure retries only the durable release and physical release", async (t) => {
  let failRelease = true;
  const f = await fixture({ append: async (entry) => {
    if (entry.type === "attempt.workspace-released" && failRelease) { failRelease = false; throw new Error("release append failed"); }
  } });
  t.after(() => rm(f.origin, { recursive: true, force: true }));
  await assert.rejects(f.deps.recoverSupersededAttempts({ ctx: f.ctx }), AggregateError);
  assertRecovery(f, { proof: 1, release: 0, physicalRelease: 0 });
  await f.deps.recoverSupersededAttempts({ ctx: f.ctx });
  assert.deepEqual(eventsOf(f, "attempt.workspace-released")[0].data.evidence, { kind: "superseded-cleanup" });
  assertRecovery(f);
});

test("physical release failure is not retried after its durable checkpoint", async (t) => {
  let failRelease = true;
  const f = await fixture({ release: async () => {
    if (failRelease) { failRelease = false; throw new Error("physical release failed"); }
  } });
  t.after(() => rm(f.origin, { recursive: true, force: true }));
  await assert.rejects(f.deps.recoverSupersededAttempts({ ctx: f.ctx }), AggregateError);
  assertRecovery(f, { physicalRelease: 1 });
  await f.deps.recoverSupersededAttempts({ ctx: f.ctx });
  assertRecovery(f, { physicalRelease: 1 });
});

test("multi-attempt backend failures continue in attemptId order after reverse insertion", async (t) => {
  const ids = ["attempt-01", "attempt-02"];
  const f = await fixture({
    attempts: [{ attemptId: "attempt-02", taskId: "task-2", status: "dispatch-requested" }, { attemptId: "attempt-01", taskId: "task-3", status: "dispatch-requested" }],
    reverseInsertion: true,
    backend: { async supersede(input) { f.calls.supersede.push(input); if (input.attemptId === "attempt-01") throw new Error("backend failed"); return terminalProof(input.attemptId); } },
  });
  t.after(() => rm(f.origin, { recursive: true, force: true }));
  await assert.rejects(f.deps.recoverSupersededAttempts({ ctx: f.ctx }), AggregateError);
  assert.deepEqual(f.calls.supersede.map(({ attemptId: id }) => id), ids);
  assert.deepEqual(eventsOf(f, "attempt.superseded").map(({ data }) => data.attemptId), ["attempt-02"]);
  assert.deepEqual(eventsOf(f, "attempt.workspace-released").map(({ data }) => data.attemptId), ["attempt-02"]);
  assert.deepEqual(f.calls.release.map(([{ path: leasePath }]) => leasePath), ["/attempts/attempt-02"]);
  assert.equal(eventsOf(f, "plan.amended").length, 1);
  assert.equal(f.calls.spawn.length, 0);
  const projection = replay(f.entries);
  assert.deepEqual(f.calls.recoverDispatch, []);
  assert.equal(projection.attempts.get("attempt-01").workspaceReleased, undefined);
  assert.equal(projection.attempts.get("attempt-02").workspaceReleased, true);
});

test("multi-attempt release failures continue and durable checkpoints prevent replay", async (t) => {
  let fail = true;
  const f = await fixture({
    attempts: [{ attemptId: "attempt-02", taskId: "task-2", status: "workspace-allocated" }, { attemptId: "attempt-01", taskId: "task-3", status: "workspace-allocated" }],
    reverseInsertion: true,
    release: async (lease) => { if (lease.path.endsWith("attempt-01") && fail) { fail = false; throw new Error("release failed"); } },
  });
  t.after(() => rm(f.origin, { recursive: true, force: true }));
  await assert.rejects(f.deps.recoverSupersededAttempts({ ctx: f.ctx }), AggregateError);
  assert.deepEqual(eventsOf(f, "attempt.superseded").map(({ data }) => data.attemptId), ["attempt-01", "attempt-02"]);
  assert.deepEqual(eventsOf(f, "attempt.workspace-released").map(({ data }) => data.attemptId), ["attempt-01", "attempt-02"]);
  assert.deepEqual(f.calls.release.map(([{ path: leasePath }]) => leasePath), ["/attempts/attempt-01", "/attempts/attempt-02"]);
  const before = { proofs: eventsOf(f, "attempt.superseded").length, releases: eventsOf(f, "attempt.workspace-released").length, physical: f.calls.release.length, backend: f.calls.supersede.length };
  await f.deps.recoverSupersededAttempts({ ctx: f.ctx });
  assert.deepEqual({ proofs: eventsOf(f, "attempt.superseded").length, releases: eventsOf(f, "attempt.workspace-released").length, physical: f.calls.release.length, backend: f.calls.supersede.length }, before);
  const projection = replay(f.entries);
  assert.equal(projection.attempts.get("attempt-01").workspaceReleased, true);
  assert.equal(projection.attempts.get("attempt-02").workspaceReleased, true);
});

test("lifecycle-moving public entries stop after recovery fence errors", async (t) => {
  const cases = [
    ["status", (f) => f.deps.status({ ctx: f.ctx })],
    ["continue", (f) => f.deps.continuePlan({}, { ctx: f.ctx })],
    ["verify", (f) => f.deps.verifyPlan({ ctx: f.ctx })],
    ["recover", (f) => f.deps.recoverExecutors({}, { ctx: f.ctx })],
    ["collect", (f) => f.deps.collectExecutorResults({}, { ctx: f.ctx })],
    ["block", (f) => f.deps.blockPlan({ reason: "blocked" }, { ctx: f.ctx })],
  ];
  for (const [name, invoke] of cases) {
    const f = await fixture({ pointer: "missing" });
    t.after(() => rm(f.origin, { recursive: true, force: true }));
    f.revisionStore.writeCurrent = async () => { throw new Error(`${name} pointer`); };
    const before = f.entries.length;
    await assert.rejects(invoke(f), AggregateError);
    const added = f.entries.slice(before).map(({ type }) => type);
    assert.deepEqual(added, ["attempt.superseded", "attempt.workspace-released"]);
    assert.equal(f.calls.spawn.length, 0);
    assert.equal(f.calls.release.length, 1);
    assert.equal(replay(f.entries).attempts.get(attemptId()).workspaceReleased, true);
    assert.equal(eventsOf(f, "plan.blocked").length, 0);
    assert.equal(eventsOf(f, "plan.cancelled").length, 0);
    assert.equal(eventsOf(f, "gate.finished").length, 0);
  }
});

test("durable cancel request is fenced by recovery failure without accepted acknowledgement", async (t) => {
  const f = await fixture({ pointer: "missing" });
  t.after(() => rm(f.origin, { recursive: true, force: true }));
  f.revisionStore.writeCurrent = async () => { throw new Error("cancel pointer"); };
  const control = createPlanControl({ stateRoot: path.join(f.origin, "state"), intervalMs: 1, timeoutMs: 20 });
  const pending = control.requestCancel({ planId: "recovery", runId: "cancel-run" });
  const pendingResult = pending.then(() => null, (error) => error);
  let request;
  for (let retry = 0; retry < 20 && !request; retry++) {
    request = await control.readRequest("recovery");
    if (!request) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(request);
  await assert.rejects(f.deps.processCancelControl({ binding: { planId: "recovery", stateRoot: path.join(f.origin, "state") }, ctx: f.ctx }), AggregateError);
  const timeout = await pendingResult;
  assert.match(timeout.message, /timed out/);
  await assert.rejects(readFile(control.paths("recovery").ack, "utf8"), { code: "ENOENT" });
  assert.equal(eventsOf(f, "plan.cancelled").length, 0);
  assert.deepEqual(f.entries.slice(-2).map(({ type }) => type), ["attempt.superseded", "attempt.workspace-released"]);
  assert.equal(f.calls.release.length, 1);
  assert.equal(replay(f.entries).attempts.get(attemptId()).workspaceReleased, true);
});
