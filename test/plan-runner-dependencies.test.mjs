import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createPlanRunnerDependencies } from "../scripts/lib/plan/plan-runner-dependencies.mjs";
import { createPlanControl } from "../scripts/lib/plan/plan-control.mjs";
import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";

const TEST_MANIFEST = "a".repeat(64);
const TEST_IR = "b".repeat(64);

const execFile = promisify(execFileCallback);

const planSource = `# Approved plan

## Execution Contract

\`\`\`json
{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
\`\`\`

### Task 1: Ship it

**Files:**
- Create: \`src/a.mjs\`
`;

const parallelSource = `# Parallel plan

## Execution Contract

\`\`\`json
{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
\`\`\`

### Task 1: Alpha

**Files:**
- Create: \`src/alpha.txt\`

### Task 2: Beta

**Files:**
- Create: \`src/beta.txt\`
`;

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function fixture(source = planSource, { separateStateRoot = false } = {}) {
  const origin = await mkdtemp(path.join(os.tmpdir(), "pi-plan-runner-origin-"));
  await git(origin, "init");
  await git(origin, "config", "user.email", "test@example.com");
  await git(origin, "config", "user.name", "Test User");
  await writeFile(path.join(origin, "README.md"), "base\n");
  await git(origin, "add", "README.md");
  await git(origin, "commit", "-m", "base");
  const baseCommit = await git(origin, "rev-parse", "HEAD");
  const planId = "plan-runner";
  const stateRoot = separateStateRoot ? path.join(origin, "runtime-state") : origin;
  await mkdir(stateRoot, { recursive: true });
  const worktree = path.join(stateRoot, "var", "plan-worktrees", planId);
  await git(origin, "worktree", "add", "-b", `pi-plan/${planId}`, worktree, baseCommit);
  const docs = path.join(origin, "docs");
  await mkdir(docs);
  const planPath = path.join(docs, "release-candidate.md");
  await writeFile(planPath, source);
  const plan = parsePlanDocument(source, planPath);
  const revision = {
    planId, revision: 1, manifestSha256: TEST_MANIFEST,
    manifest: { planId, revision: 1, manifestSha256: TEST_MANIFEST, sourceBytesSha256: "c".repeat(64), planHash: plan.sha256, irVersion: "plan-ir.v3", irHash: TEST_IR, taskHashes: Object.fromEntries(plan.tasks.map((task) => [task.id, { full: "e".repeat(64), effective: "f".repeat(64), scheduling: "0".repeat(64) }])) },
    ir: { version: "plan-ir.v3", hash: TEST_IR }, plan, planPath,
  };
  return { origin, stateRoot, worktree, planPath, planId, baseCommit, revision };
}

async function submoduleFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-runner-submodule-"));
  const childSource = path.join(root, "child-source");
  const superproject = path.join(root, "superproject");
  await Promise.all([mkdir(childSource), mkdir(superproject)]);

  await git(childSource, "init");
  await git(childSource, "config", "user.email", "test@example.com");
  await git(childSource, "config", "user.name", "Test User");
  await mkdir(path.join(childSource, "docs"));
  await writeFile(path.join(childSource, "README.md"), "child\n");
  await writeFile(path.join(childSource, "docs", "release-candidate.md"), planSource);
  await git(childSource, "add", ".");
  await git(childSource, "commit", "-m", "child base");

  await git(superproject, "init");
  await git(superproject, "config", "user.email", "test@example.com");
  await git(superproject, "config", "user.name", "Test User");
  await git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", childSource, "plugins/crash_fix_v2");
  await git(superproject, "commit", "-am", "add child submodule");

  const origin = path.join(superproject, "plugins", "crash_fix_v2");
  const baseCommit = await git(origin, "rev-parse", "HEAD");
  const planId = "submodule-plan";
  const worktree = path.join(origin, "var", "plan-worktrees", planId);
  await git(origin, "worktree", "add", "-b", `pi-plan/${planId}`, worktree, baseCommit);
  return {
    root,
    superproject,
    origin,
    stateRoot: origin,
    worktree,
    planPath: path.join(worktree, "docs", "release-candidate.md"),
    planId,
    baseCommit,
  };
}

function context(cwd, branch = []) {
  return { cwd, sessionManager: { getBranch: () => branch } };
}

function created(binding) {
  return {
    schemaVersion: "pi-plan-event.v1",
    eventId: "created",
    planId: binding.planId,
    occurredAt: "2026-07-15T00:00:00.000Z",
    type: "plan.created",
    data: {
      workspace: {
        originRoot: binding.originRoot,
        worktree: binding.worktree,
        baseCommit: binding.baseCommit,
        headCommit: binding.headCommit,
        planPath: binding.planPath,
        planHash: binding.planHash,
      },
      tasks: binding.tasks.map((task) => task.id),
    },
  };
}

async function bindingInput(repo) {
  return {
    planId: repo.planId,
    revision: 1,
    manifestSha256: TEST_MANIFEST,
    planIrHash: TEST_IR,
    baseCommit: repo.baseCommit,
    worktree: repo.worktree,
    allowPlanCommits: true,
  };
}

function runnerDependencies(repo, options = {}) {
  return createPlanRunnerDependencies({
    originRoot: repo.origin,
    stateRoot: repo.stateRoot,
    revisionStore: { async readRevision(planId, revision) {
      if (planId !== repo.planId || revision !== 1) return null;
      if (repo.revision) return repo.revision;
      const plan = parsePlanDocument(await readFile(repo.planPath, "utf8"), repo.planPath);
      return { planId, revision, manifestSha256: TEST_MANIFEST, manifest: { planId, revision, sourceBytesSha256: "c".repeat(64), planHash: plan.sha256, irVersion: "plan-ir.v3", irHash: TEST_IR, taskHashes: Object.fromEntries(plan.tasks.map((task) => [task.id, { full: "e".repeat(64), effective: "f".repeat(64), scheduling: "0".repeat(64) }])) }, ir: { version: "plan-ir.v3", hash: TEST_IR }, plan, planPath: repo.planPath };
    }, async writeCurrent() {} },
    ...options,
  });
}

function fakeAllocator(input) {
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

function backend({ statuses = new Map(), stops = [], spawns = [] } = {}) {
  let sequence = 0;
  return {
    async spawn(input) {
      spawns.push(input);
      sequence++;
      return {
        dispatchId: input.dispatchId,
        attemptId: input.attemptId,
        runId: `run-${sequence}`,
        asyncDir: `/async/run-${sequence}`,
        cwd: input.cwd,
        sessionId: "plan-session",
      };
    },
    async status({ runId }) {
      return statuses.get(runId) ?? { status: { kind: "stable", value: { state: "running" } } };
    },
    async stop(target) {
      stops.push(target);
      return { stopped: true };
    },
  };
}

test("binds a submodule Plan to launcher-owned roots and keeps all runtime state in the submodule", async (t) => {
  const repo = await submoduleFixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const deps = runnerDependencies(repo, {
    originRoot: repo.origin,
    stateRoot: repo.stateRoot,
    executionBackend: backend(),
  });
  const binding = await deps.validateBinding(await bindingInput(repo), { ctx: context(repo.worktree) });

  assert.equal(binding.originRoot, await realpath(repo.origin));
  assert.equal(binding.stateRoot, await realpath(repo.stateRoot));
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);
  await deps.status({ ctx });
  const statusPath = path.join(repo.stateRoot, "var", "plan-runs", repo.planId, "status.json");
  assert.equal(JSON.parse(await readFile(statusPath, "utf8")).lifecycle, "created");

  const legacyRoot = path.dirname(await git(repo.origin, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  assert.notEqual(await realpath(repo.origin), legacyRoot);
  await assert.rejects(access(path.join(legacyRoot, "var", "plan-runs", repo.planId, "status.json")));

  const result = await deps.continuePlan({}, { ctx });
  assert.equal(result.state, "waiting-executors");
  assert.match(result.dispatched[0].cwd, new RegExp(`${repo.planId}/attempts/`));
});

test("validates an exact Plan bootstrap binding against its owned Git worktree", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const input = await bindingInput(repo);
  const deps = runnerDependencies(repo);

  const binding = await deps.validateBinding(input, { ctx: context(repo.worktree) });
  assert.equal(binding.originRoot, await realpath(repo.origin));
  assert.equal(binding.headCommit, repo.baseCommit);
  assert.deepEqual(binding.tasks.map((task) => task.id), ["task-1"]);

  for (const invalid of [
    { ...input, allowPlanCommits: false },
    { ...input, worktree: repo.origin },
    { ...input, planHash: "0".repeat(64) },
    { ...input, baseCommit: "0".repeat(40) },
    { ...input, planId: "other" },
  ]) await assert.rejects(deps.validateBinding(invalid, { ctx: context(repo.worktree) }));
});

test("derives status atomically and appends only Plan domain events", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const binding = await runnerDependencies(repo).validateBinding(await bindingInput(repo), { ctx: context(repo.worktree) });
  const appended = [];
  const deps = runnerDependencies(repo, { pi: { appendEntry(type, data) { appended.push({ type, data }); } } });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);

  const status = await deps.status({ ctx });
  assert.equal(status.lifecycle, "created");
  assert.deepEqual(JSON.parse(await readFile(path.join(repo.origin, "var", "plan-runs", repo.planId, "status.json"), "utf8")), status);
  await deps.blockPlan({ reason: "needs user input" }, { ctx });
  assert.deepEqual(appended.map((entry) => entry.data.type), ["plan.blocked"]);
});

test("reads and acknowledges cancel control from a stateRoot separate from the Git origin", async (t) => {
  const repo = await fixture(planSource, { separateStateRoot: true });
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const binding = await runnerDependencies(repo).validateBinding(await bindingInput(repo), { ctx: context(repo.worktree) });
  const deps = runnerDependencies(repo, {
    pi: { appendEntry() {} },
    id: () => "cancel-event",
    now: () => "2026-07-15T00:00:01.000Z",
  });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);
  const control = createPlanControl({ stateRoot: repo.stateRoot, id: () => "request-1", now: () => "2026-07-15T00:00:00.000Z" });
  const pending = control.requestCancel({ planId: repo.planId, runId: "run-1" });
  while (!(await control.readRequest(repo.planId))) await new Promise((resolve) => setTimeout(resolve, 1));

  const result = await deps.processCancelControl({ binding, ctx });
  if (!result) {
    const request = await control.readRequest(repo.planId);
    await control.writeAck({ ...request, lifecycle: "cancelled", result: "accepted", occurredAt: "2026-07-15T00:00:02.000Z" });
  }
  await pending;
  assert.equal(result?.lifecycle, "cancelled");
});

test("child control loop persists cancellation and acknowledges exactly once", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const binding = await runnerDependencies(repo).validateBinding(await bindingInput(repo), { ctx: context(repo.worktree) });
  const appended = [];
  const deps = runnerDependencies(repo, {
    pi: { appendEntry(_type, data) { appended.push(data); } },
    id: () => "cancel-event",
    now: () => "2026-07-15T00:00:01.000Z",
  });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);
  const control = createPlanControl({ stateRoot: repo.origin, id: () => "request-1", now: () => "2026-07-15T00:00:00.000Z" });
  const pending = control.requestCancel({ planId: repo.planId, runId: "run-1" });
  while (!(await control.readRequest(repo.planId))) await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal((await deps.processCancelControl({ binding, ctx })).lifecycle, "cancelled");
  assert.equal((await pending).lifecycle, "cancelled");
  assert.deepEqual(appended.map((entry) => entry.type), ["plan.cancelled"]);
  await deps.processCancelControl({ binding, ctx });
  assert.deepEqual(appended.map((entry) => entry.type), ["plan.cancelled"]);
});

test("continuePlan directly dispatches through the backend and never returns a tool", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const binding = await runnerDependencies(repo).validateBinding(await bindingInput(repo), { ctx: context(repo.worktree) });
  const appended = [];
  const spawns = [];
  const deps = runnerDependencies(repo, {
    pi: { appendEntry(_type, data) { appended.push(data); } },
    executionBackend: backend({ spawns }),
    allocateAttemptWorkspace: async (input) => fakeAllocator(input),
  });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);

  await assert.rejects(deps.continuePlan({ expectedProjectionVersion: 0 }, { ctx }), /version conflict/i);
  const result = await deps.continuePlan({ expectedProjectionVersion: 1 }, { ctx });
  assert.deepEqual(Object.keys(result).sort(), ["dispatched", "projectionVersion", "state"]);
  assert.equal(result.state, "waiting-executors");
  assert.equal(result.dispatched.length, 1);
  assert.equal("tool" in result, false);
  assert.equal(spawns[0].cwd, result.dispatched[0].cwd);
  assert.notEqual(spawns[0].cwd, repo.worktree);
  assert.deepEqual(appended.map(({ type }) => type), [
    "attempt.workspace-allocated", "attempt.dispatch-requested", "attempt.bound",
  ]);
});

test("one coordinator step dispatches parallel roots to distinct workspaces", async (t) => {
  const repo = await fixture(parallelSource);
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const binding = await runnerDependencies(repo).validateBinding(await bindingInput(repo), { ctx: context(repo.worktree) });
  const spawns = [];
  const deps = runnerDependencies(repo, {
    pi: { appendEntry() {} },
    executionBackend: backend({ spawns }),
    allocateAttemptWorkspace: async (input) => fakeAllocator(input),
  });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);

  const result = await deps.continuePlan({}, { ctx });
  assert.deepEqual(result.dispatched.map(({ taskId }) => taskId), ["task-1", "task-2"]);
  assert.equal(new Set(result.dispatched.map(({ cwd }) => cwd)).size, 2);
  assert.equal(spawns.every(({ agent }) => agent === "executor"), true);
});

test("session shutdown stops each bound backend run once", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const binding = await runnerDependencies(repo).validateBinding(await bindingInput(repo), { ctx: context(repo.worktree) });
  const stopped = [];
  const deps = runnerDependencies(repo, {
    pi: { appendEntry() {} },
    executionBackend: backend({ stops: stopped }),
    allocateAttemptWorkspace: async (input) => fakeAllocator(input),
  });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);
  await deps.continuePlan({}, { ctx });

  await deps.stopActiveRuns();
  await deps.stopActiveRuns();
  assert.deepEqual(stopped, [{ runId: "run-1", asyncDir: "/async/run-1" }]);
});

test("plan_status consumes official completion facts and settles from authoritative artifacts", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const binding = await runnerDependencies(repo).validateBinding(await bindingInput(repo), { ctx: context(repo.worktree) });
  const appended = [];
  const facts = [];
  const statuses = new Map([["run-1", { status: { kind: "stable", value: { state: "complete" } } }]]);
  const deps = runnerDependencies(repo, {
    pi: { appendEntry(_type, data) { appended.push(data); } },
    executionBackend: backend({ statuses }),
    takeExecutionFacts: () => facts.splice(0),
  });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);
  const dispatched = await deps.continuePlan({}, { ctx });
  const run = dispatched.dispatched[0];
  await mkdir(path.join(run.cwd, "src"), { recursive: true });
  await writeFile(path.join(run.cwd, "src", "a.mjs"), "export default 1;\n");
  await git(run.cwd, "add", "src/a.mjs");
  await git(run.cwd, "commit", "-m", "attempt result");
  facts.push({
    type: "execution.completed",
    dispatchId: run.dispatchId,
    attemptId: run.attemptId,
    runId: run.runId,
    asyncDir: run.asyncDir,
    cwd: run.cwd,
    state: "complete",
  });

  const status = await deps.status({ ctx });
  assert.equal(status.tasks[0].attempts[0].status, "validated");
  assert.deepEqual(appended.slice(-2).map(({ type }) => type), ["attempt.settled", "attempt.validated"]);

  const integrated = await deps.continuePlan({}, { ctx });
  assert.equal(integrated.state, "ready-to-verify");
  const integratedStatus = await deps.status({ ctx });
  assert.equal(integratedStatus.tasks[0].attempts[0].status, "integrated");
  assert.deepEqual(appended.slice(-3).map(({ type }) => type), ["integration.requested", "integration.finished", "attempt.workspace-released"]);
  await assert.rejects(access(run.cwd));
});

test("plan_status projects a structured Executor block without requiring a result commit", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const binding = await runnerDependencies(repo).validateBinding(await bindingInput(repo), { ctx: context(repo.worktree) });
  const appended = [];
  const facts = [];
  const statuses = new Map([["run-1", { status: { kind: "stable", value: { state: "complete" } } }]]);
  const deps = runnerDependencies(repo, {
    pi: { appendEntry(_type, data) { appended.push(data); } },
    executionBackend: backend({ statuses }),
    takeExecutionFacts: () => facts.splice(0),
  });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);
  const dispatched = await deps.continuePlan({}, { ctx });
  const run = dispatched.dispatched[0];
  const output = path.join(
    repo.stateRoot,
    "var",
    "plan-runs",
    repo.planId,
    "results",
    `${run.attemptId}.json`,
  );
  await writeFile(output, JSON.stringify({
    attempt_id: run.attemptId,
    task_id: "task-1",
    status: "blocked",
    reason: "real-module-candidates-not-ready",
    blockers: ["cocoapods", "tbctx7_code_auth"],
    artifact: {
      path: "materials/evidence/real-module-candidates.json",
      sha256: "a".repeat(64),
    },
    changed_files: [],
    commit: null,
  }));
  facts.push({
    type: "execution.completed",
    dispatchId: run.dispatchId,
    attemptId: run.attemptId,
    runId: run.runId,
    asyncDir: run.asyncDir,
    cwd: run.cwd,
    state: "complete",
  });

  const status = await deps.status({ ctx });

  assert.equal(status.lifecycle, "blocked");
  assert.equal(status.tasks[0].attempts[0].status, "blocked");
  assert.deepEqual(status.tasks[0].attempts[0].blocked, {
    reason: "real-module-candidates-not-ready",
    blockers: ["cocoapods", "tbctx7_code_auth"],
    evidenceSha256: "a".repeat(64),
  });
  assert.deepEqual(appended.slice(-2).map(({ type }) => type), ["attempt.settled", "plan.blocked"]);
  assert.equal(appended.at(-1).data.reason, "executor_blocked");
  assert.equal(await git(run.cwd, "rev-parse", "HEAD"), repo.baseCommit);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test("persists Supervisor Attention and resolves a fenced durable Root reply only after native delivery", async (t) => {
  const repo = await fixture(parallelSource);
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const binding = await runnerDependencies(repo).validateBinding(await bindingInput(repo), { ctx: context(repo.worktree) });
  const appended = [];
  const messages = [];
  let deliveryAttempts = 0;
  const deps = runnerDependencies(repo, {
    pi: {
      appendEntry(_type, data) { appended.push(data); },
      sendMessage(message, options) {
        deliveryAttempts++;
        if (deliveryAttempts === 1) throw new Error("turn queue busy");
        messages.push({ message, options });
      },
    },
    executionBackend: backend(),
    allocateAttemptWorkspace: async (input) => fakeAllocator(input),
    now: () => "2026-07-26T00:00:00.000Z",
  });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);
  await deps.continuePlan({}, { ctx });
  const attention = await deps.recordSupervisorRequest({
    customType: "subagent_supervisor_request",
    content: "Choose the approved target",
    display: true,
    details: { id: "request-1", reason: "need_decision", expectsReply: true, runId: "run-1", agent: "executor", childIndex: 0 },
  }, { ctx });

  assert.deepEqual(appended.slice(-2).map(({ type }) => type), ["attempt.attention-requested", "attempt.attention-escalated"]);
  assert.equal(await readFile(path.join(repo.origin, "var", "plan-runs", repo.planId, "attention", "request-1.md"), "utf8"), "Choose the approved target");

  await deps.recordSupervisorRequest({
    customType: "subagent_supervisor_request",
    content: "Task 2 is still running",
    display: true,
    details: { id: "progress-2", reason: "progress_update", expectsReply: false, runId: "run-2", agent: "executor", childIndex: 1 },
  }, { ctx });
  const afterParallelProgress = await deps.status({ ctx });
  assert.ok(afterParallelProgress.projectionVersion > attention.projectionVersion);

  const replyInput = {
    action: "reply", replyTo: "request-1", to: "executor", message: "Use target A",
  };
  await assert.rejects(
    deps.authorizeSupervisorReply(replyInput, { ctx }),
    /durable Root Attention reply/i,
  );

  const control = createPlanControl({ stateRoot: repo.origin });
  const command = {
    planId: repo.planId,
    requestId: "request-1",
    taskId: "task-1",
    attemptId: attention.attemptId,
    runId: "run-1",
    expectedProjectionVersion: attention.projectionVersion,
    message: "Use target A",
    occurredAt: "2026-07-26T00:00:01.000Z",
  };
  await control.writeAttentionReply(command);
  await assert.rejects(deps.processAttentionReplies({ binding, ctx }), /turn queue busy/);
  assert.deepEqual(await deps.processAttentionReplies({ binding, ctx }), [command]);
  assert.equal(deliveryAttempts, 2);
  assert.equal(messages.length, 1);
  assert.equal(messages.at(-1).message.customType, "pi-plan-attention-reply-v1");

  const authorization = await deps.authorizeSupervisorReply(replyInput, { ctx });
  assert.deepEqual(authorization.command, command);
  assert.equal(authorization.expectedProjectionVersion, afterParallelProgress.projectionVersion);
  await deps.resolveSupervisorReply(authorization, { ctx });
  assert.equal(appended.at(-1).type, "attempt.attention-resolved");
  assert.deepEqual(await control.readAttentionReplies(repo.planId), []);
  await assert.rejects(deps.resolveSupervisorReply(authorization, { ctx }), /stale|waiting-attention/i);
});

test("rejects an otherwise valid binding after its worktree HEAD advances", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const input = await bindingInput(repo);
  await writeFile(path.join(repo.worktree, "change.mjs"), "export default 1;\n");
  await git(repo.worktree, "add", "change.mjs");
  await git(repo.worktree, "commit", "-m", "advance");
  await assert.rejects(runnerDependencies(repo).validateBinding(input, { ctx: context(repo.worktree) }), /HEAD.*base/i);
});

async function verificationFixture(t) {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const binding = await runnerDependencies(repo).validateBinding(await bindingInput(repo), { ctx: context(repo.worktree) });
  await writeFile(path.join(repo.worktree, "src-a.mjs"), "export default 1;\n");
  await git(repo.worktree, "add", "src-a.mjs");
  await git(repo.worktree, "commit", "-m", "change");
  const entries = [created(binding), {
    ...created(binding), eventId: "accepted", type: "task.accepted", data: { taskId: "task-1" },
  }];
  return { repo, binding, entries, ctx: context(repo.worktree, entries.map((data) => ({ customType: "pi-plan-event-v1", data }))) };
}

test("verification fails closed with an unavailable external-review provider", async (t) => {
  const { repo, ctx } = await verificationFixture(t);
  const appended = [];
  const deps = runnerDependencies(repo, { pi: { appendEntry(_type, data) { appended.push(data); } } });
  const result = await deps.verifyPlan({ ctx });
  assert.equal(result.validated, false);
  assert.equal(result.attempts.find((attempt) => attempt.type === "external-review").status, "unavailable");
  assert.deepEqual(appended.map(({ type }) => type), [
    "workspace.head-observed", "gate.finished", "gate.finished", "gate.finished", "gate.finished",
  ]);
});

test("verification validates four passing gates on the observed accumulator HEAD", async (t) => {
  const { repo, ctx } = await verificationFixture(t);
  const appended = [];
  const deps = runnerDependencies(repo, {
    pi: { appendEntry(_type, data) { appended.push(data); } },
    audit: async () => ({ findings: [] }),
    externalReview: async () => ({ available: true, findings: [] }),
  });
  const result = await deps.verifyPlan({ ctx });
  const status = await deps.status({ ctx });
  assert.equal(result.validated, true);
  assert.equal(status.lifecycle, "validated");
  assert.equal(status.validatedHead, await git(repo.worktree, "rev-parse", "HEAD"));
  assert.equal(appended.at(-1).type, "plan.validated");
});
