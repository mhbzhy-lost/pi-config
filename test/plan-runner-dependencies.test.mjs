import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createPlanRunnerDependencies } from "../scripts/lib/plan/plan-runner-dependencies.mjs";
import { createPlanControl } from "../scripts/lib/plan/plan-control.mjs";

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

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function fixture() {
  const origin = await mkdtemp(path.join(os.tmpdir(), "pi-plan-runner-origin-"));
  await git(origin, "init");
  await git(origin, "config", "user.email", "test@example.com");
  await git(origin, "config", "user.name", "Test User");
  await writeFile(path.join(origin, "README.md"), "base\n");
  await git(origin, "add", "README.md");
  await git(origin, "commit", "-m", "base");
  const baseCommit = await git(origin, "rev-parse", "HEAD");
  const planId = "plan-runner";
  const worktree = path.join(origin, "worktree");
  await git(origin, "worktree", "add", "-b", `pi-plan/${planId}`, worktree, baseCommit);
  const docs = path.join(origin, "docs");
  await (await import("node:fs/promises")).mkdir(docs);
  const planPath = path.join(docs, "release-candidate.md");
  await writeFile(planPath, planSource);
  return { origin, worktree, planPath, planId, baseCommit };
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

test("validates an exact child bootstrap binding against its owned Git worktree", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const source = await readFile(repo.planPath, "utf8");
  const { sha256 } = (await import("../scripts/lib/plan/plan-document.mjs")).parsePlanDocument(source, repo.planPath);
  const deps = createPlanRunnerDependencies();
  const input = { planId: repo.planId, planPath: repo.planPath, planHash: sha256, baseCommit: repo.baseCommit, worktree: repo.worktree, allowPlanCommits: true };

  const binding = await deps.validateBinding(input, { ctx: context(repo.worktree) });
  assert.equal(binding.originRoot, await realpath(repo.origin));
  assert.equal(binding.headCommit, repo.baseCommit);
  assert.deepEqual(binding.tasks.map((task) => task.id), ["task-1"]);
  assert.equal(binding.plan.sha256, sha256);

  for (const invalid of [
    { ...input, allowPlanCommits: false },
    { ...input, worktree: repo.origin },
    { ...input, planHash: "0".repeat(64) },
    { ...input, baseCommit: "0".repeat(40) },
    { ...input, planId: "other" },
  ]) {
    await assert.rejects(deps.validateBinding(invalid, { ctx: context(repo.worktree) }));
  }
});

test("derives child-only status, writes it atomically, and appends only child events", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const source = await readFile(repo.planPath, "utf8");
  const { sha256 } = (await import("../scripts/lib/plan/plan-document.mjs")).parsePlanDocument(source, repo.planPath);
  const binding = await createPlanRunnerDependencies().validateBinding(
    { planId: repo.planId, planPath: repo.planPath, planHash: sha256, baseCommit: repo.baseCommit, worktree: repo.worktree, allowPlanCommits: true },
    { ctx: context(repo.worktree) },
  );
  const entries = [created(binding)];
  const appended = [];
  const pi = { appendEntry(type, data) { appended.push({ type, data }); } };
  const deps = createPlanRunnerDependencies({ pi, externalReview: async () => ({ available: true, findings: [] }), audit: async () => ({ findings: [] }) });
  const ctx = context(repo.worktree, entries.map((data) => ({ customType: "pi-plan-event-v1", data })));

  const status = await deps.status({ ctx });
  assert.equal(status.planId, repo.planId);
  assert.equal(status.lifecycle, "created");
  assert.deepEqual(JSON.parse(await readFile(path.join(repo.origin, "var", "plan-runs", repo.planId, "status.json"), "utf8")), status);

  await deps.blockPlan({ reason: "needs user input" }, { ctx });
  assert.deepEqual(appended.map((entry) => entry.data.type), ["plan.blocked"]);
});

test("child control loop appends plan.cancelled, writes derived status, then acknowledges exactly once", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const source = await readFile(repo.planPath, "utf8");
  const { sha256 } = (await import("../scripts/lib/plan/plan-document.mjs")).parsePlanDocument(source, repo.planPath);
  const binding = await createPlanRunnerDependencies().validateBinding(
    { planId: repo.planId, planPath: repo.planPath, planHash: sha256, baseCommit: repo.baseCommit, worktree: repo.worktree, allowPlanCommits: true },
    { ctx: context(repo.worktree) },
  );
  const entries = [created(binding)];
  const appended = [];
  const pi = { appendEntry(_type, data) { appended.push(data); } };
  const deps = createPlanRunnerDependencies({ pi, id: () => "cancel-event", now: () => "2026-07-15T00:00:01.000Z" });
  const ctx = context(repo.worktree, entries.map((data) => ({ customType: "pi-plan-event-v1", data })));
  const control = createPlanControl({ stateRoot: repo.origin, id: () => "request-1", now: () => "2026-07-15T00:00:00.000Z" });
  const pending = control.requestCancel({ planId: repo.planId, runId: "run-1" });
  while (!(await control.readRequest(repo.planId))) await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal((await deps.processCancelControl({ binding, ctx })).lifecycle, "cancelled");
  assert.equal((await pending).lifecycle, "cancelled");
  assert.deepEqual(appended.map((entry) => entry.type), ["plan.cancelled"]);
  assert.equal(JSON.parse(await readFile(path.join(repo.origin, "var", "plan-runs", repo.planId, "status.json"), "utf8")).lifecycle, "cancelled");
  await deps.processCancelControl({ binding, ctx });
  assert.deepEqual(appended.map((entry) => entry.type), ["plan.cancelled"]);
});

test("authorizes exactly one nested subagent intent without executing it", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const source = await readFile(repo.planPath, "utf8");
  const { sha256 } = (await import("../scripts/lib/plan/plan-document.mjs")).parsePlanDocument(source, repo.planPath);
  const binding = await createPlanRunnerDependencies().validateBinding(
    { planId: repo.planId, planPath: repo.planPath, planHash: sha256, baseCommit: repo.baseCommit, worktree: repo.worktree, allowPlanCommits: true },
    { ctx: context(repo.worktree) },
  );
  const entries = [created(binding)];
  const appended = [];
  const deps = createPlanRunnerDependencies({ pi: { appendEntry(_type, data) { appended.push(data); } } });
  const ctx = context(repo.worktree, entries.map((data) => ({ customType: "pi-plan-event-v1", data })));

  const next = await deps.continuePlan({ reason: "resume" }, { ctx });
  assert.deepEqual(Object.keys(next.tool).sort(), ["acceptance", "agent", "async", "clarify", "context", "cwd", "task"]);
  assert.equal(appended[0].type, "attempt.dispatch-requested");
  assert.equal(deps.authorizeNestedSubagent(next.tool, { ctx }), true);
  assert.throws(() => deps.authorizeNestedSubagent(next.tool, { ctx }), /consumed/i);
});

test("binds a structured nested result, polls stable runtime state, reviews, accepts, and writes status", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const source = await readFile(repo.planPath, "utf8");
  const { sha256 } = (await import("../scripts/lib/plan/plan-document.mjs")).parsePlanDocument(source, repo.planPath);
  const binding = await createPlanRunnerDependencies().validateBinding(
    { planId: repo.planId, planPath: repo.planPath, planHash: sha256, baseCommit: repo.baseCommit, worktree: repo.worktree, allowPlanCommits: true },
    { ctx: context(repo.worktree) },
  );
  const appended = [];
  const readers = [];
  const reviews = [];
  const deps = createPlanRunnerDependencies({
    pi: { appendEntry(_type, data) { appended.push(data); } },
    readRuntimeArtifacts: async ({ artifactDir }) => {
      readers.push(artifactDir);
      return { status: { kind: "stable", value: { state: "complete" } } };
    },
    taskReview: async (value) => {
      reviews.push(value);
      return { accepted: true, findings: [] };
    },
    runtimePollIntervalMs: 0,
    runtimePollTimeoutMs: 10,
  });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);
  const next = await deps.continuePlan({ reason: "resume" }, { ctx });
  deps.authorizeNestedSubagent(next.tool, { ctx });

  const status = await deps.handleNestedResult({
    toolName: "subagent",
    input: next.tool,
    details: { runId: "run-1", asyncDir: "/async/run-1", results: [{ sessionFile: "/sessions/run-1.jsonl" }] },
    isError: false,
  }, { ctx });

  assert.equal(status.state, "succeeded");
  assert.deepEqual(appended.map((entry) => entry.type), ["attempt.dispatch-requested", "attempt.bound", "attempt.settled", "task.accepted"]);
  assert.deepEqual(readers, ["/async/run-1"]);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].taskId, "task-1");
  assert.equal(reviews[0].attempt.runId, "run-1");
  assert.equal(JSON.parse(await readFile(path.join(repo.origin, "var", "plan-runs", repo.planId, "status.json"), "utf8")).lifecycle, "running");
});

test("stops each active bound nested run once and keeps stopping after an individual failure", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const source = await readFile(repo.planPath, "utf8");
  const { sha256 } = (await import("../scripts/lib/plan/plan-document.mjs")).parsePlanDocument(source, repo.planPath);
  const binding = await createPlanRunnerDependencies().validateBinding(
    { planId: repo.planId, planPath: repo.planPath, planHash: sha256, baseCommit: repo.baseCommit, worktree: repo.worktree, allowPlanCommits: true },
    { ctx: context(repo.worktree) },
  );
  const stopped = [];
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);
  const makeDeps = () => createPlanRunnerDependencies({
    pi: { appendEntry() {} },
    readRuntimeArtifacts: async () => ({ status: { kind: "stable", value: { state: "running" } } }),
    runtimePollIntervalMs: 0,
    runtimePollTimeoutMs: 0,
    stopNestedRun: async ({ runId, asyncDir }) => {
      stopped.push({ runId, asyncDir });
      if (runId === "run-1") throw new Error("stop failed");
    },
  });
  const deps = makeDeps();
  for (const runId of ["run-1"]) {
    const next = await deps.continuePlan({ reason: "resume" }, { ctx });
    deps.authorizeNestedSubagent(next.tool, { ctx });
    assert.equal((await deps.handleNestedResult({ toolName: "subagent", input: next.tool, details: { runId, asyncDir: `/async/${runId}` }, isError: false }, { ctx })).state, "active");
  }

  await assert.rejects(deps.stopActiveRuns(), AggregateError);
  assert.deepEqual(stopped, [
    { runId: "run-1", asyncDir: "/async/run-1" },
  ]);
  await assert.rejects(deps.stopActiveRuns(), AggregateError);
  assert.deepEqual(stopped, [
    { runId: "run-1", asyncDir: "/async/run-1" },
  ]);
});

test("fails closed for review failures, unstable runtime states, and duplicate nested results", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const source = await readFile(repo.planPath, "utf8");
  const { sha256 } = (await import("../scripts/lib/plan/plan-document.mjs")).parsePlanDocument(source, repo.planPath);
  const binding = await createPlanRunnerDependencies().validateBinding(
    { planId: repo.planId, planPath: repo.planPath, planHash: sha256, baseCommit: repo.baseCommit, worktree: repo.worktree, allowPlanCommits: true },
    { ctx: context(repo.worktree) },
  );
  const appended = [];
  const deps = createPlanRunnerDependencies({
    pi: { appendEntry(_type, data) { appended.push(data); } },
    readRuntimeArtifacts: async () => ({ status: { kind: "stable", value: { state: "complete" } } }),
    taskReview: async () => ({ accepted: true, findings: [{ severity: "high" }] }),
    runtimePollIntervalMs: 0,
    runtimePollTimeoutMs: 10,
  });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);
  const next = await deps.continuePlan({ reason: "resume" }, { ctx });
  deps.authorizeNestedSubagent(next.tool, { ctx });
  const event = { toolName: "subagent", input: next.tool, details: { runId: "run-1", results: [{ exitCode: 0 }] }, isError: false };

  const first = await deps.handleNestedResult(event, { ctx });
  const second = await deps.handleNestedResult(event, { ctx });

  assert.equal(first.state, "awaiting-review");
  assert.equal(second.state, "ignored");
  assert.deepEqual(appended.map((entry) => entry.type), ["attempt.dispatch-requested", "attempt.bound", "attempt.settled"]);
});

test("rejects an otherwise valid binding after its worktree HEAD advances", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const source = await readFile(repo.planPath, "utf8");
  const { sha256 } = (await import("../scripts/lib/plan/plan-document.mjs")).parsePlanDocument(source, repo.planPath);
  await writeFile(path.join(repo.worktree, "change.mjs"), "export default 1;\n");
  await git(repo.worktree, "add", "change.mjs");
  await git(repo.worktree, "commit", "-m", "advance");
  const deps = createPlanRunnerDependencies();

  await assert.rejects(
    deps.validateBinding({ planId: repo.planId, planPath: repo.planPath, planHash: sha256, baseCommit: repo.baseCommit, worktree: repo.worktree, allowPlanCommits: true }, { ctx: context(repo.worktree) }),
    /HEAD.*base/i,
  );
});

test("verification fails-closed with unavailable external-review provider", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const source = await readFile(repo.planPath, "utf8");
  const { sha256 } = (await import("../scripts/lib/plan/plan-document.mjs")).parsePlanDocument(source, repo.planPath);
  const binding = await createPlanRunnerDependencies().validateBinding(
    { planId: repo.planId, planPath: repo.planPath, planHash: sha256, baseCommit: repo.baseCommit, worktree: repo.worktree, allowPlanCommits: true },
    { ctx: context(repo.worktree) },
  );
  await writeFile(path.join(repo.worktree, "src-a.mjs"), "export default 1;\n");
  await git(repo.worktree, "add", "src-a.mjs");
  await git(repo.worktree, "commit", "-m", "change");
  const entries = [created(binding)];
  entries[0].data.tasks = ["task-1"];
  entries[0].data.tasks.forEach((taskId) => { entries.push({ ...created(binding), eventId: `accepted-${taskId}`, type: "task.accepted", data: { taskId } }); });
  const appended = [];
  const deps = createPlanRunnerDependencies({ pi: { appendEntry(_type, data) { appended.push(data); } } });
  const ctx = context(repo.worktree, entries.map((data) => ({ customType: "pi-plan-event-v1", data })));

  const result = await deps.verifyPlan({ ctx });
  assert.equal(result.validated, false);
  const erGate = result.attempts.find((a) => a.type === "external-review");
  assert.equal(erGate.status, "unavailable");
  assert.deepEqual(appended.map((entry) => entry.type), ["workspace.head-observed", "gate.finished", "gate.finished", "gate.finished", "gate.finished"]);
});

test("verification observes the worker commit and validates four passing gates on that HEAD", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const source = await readFile(repo.planPath, "utf8");
  const { sha256 } = (await import("../scripts/lib/plan/plan-document.mjs")).parsePlanDocument(source, repo.planPath);
  const binding = await createPlanRunnerDependencies().validateBinding(
    { planId: repo.planId, planPath: repo.planPath, planHash: sha256, baseCommit: repo.baseCommit, worktree: repo.worktree, allowPlanCommits: true },
    { ctx: context(repo.worktree) },
  );
  await writeFile(path.join(repo.worktree, "src-a.mjs"), "export default 1;\n");
  await git(repo.worktree, "add", "src-a.mjs");
  await git(repo.worktree, "commit", "-m", "change");
  const head = await git(repo.worktree, "rev-parse", "HEAD");
  const entries = [created(binding), {
    ...created(binding), eventId: "accepted", type: "task.accepted", data: { taskId: "task-1" },
  }];
  const appended = [];
  const deps = createPlanRunnerDependencies({
    pi: { appendEntry(_type, data) { appended.push(data); } },
    audit: async () => ({ findings: [] }),
    externalReview: async () => ({ available: true, findings: [] }),
  });
  const ctx = context(repo.worktree, entries.map((data) => ({ customType: "pi-plan-event-v1", data })));

  const result = await deps.verifyPlan({ ctx });
  const status = await deps.status({ ctx });

  assert.equal(result.validated, true);
  assert.deepEqual(appended.map((entry) => entry.type), [
    "workspace.head-observed", "gate.finished", "gate.finished", "gate.finished", "gate.finished", "plan.validated",
  ]);
  assert.equal(status.lifecycle, "validated");
  assert.equal(status.validatedHead, head);
  assert.equal(status.headCommit, head);
});

test("auto-accepts task when no taskReview is provided and marks reviewSkipped", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.origin, { recursive: true, force: true }));
  const source = await readFile(repo.planPath, "utf8");
  const { sha256 } = (await import("../scripts/lib/plan/plan-document.mjs")).parsePlanDocument(source, repo.planPath);
  const binding = await createPlanRunnerDependencies().validateBinding(
    { planId: repo.planId, planPath: repo.planPath, planHash: sha256, baseCommit: repo.baseCommit, worktree: repo.worktree, allowPlanCommits: true },
    { ctx: context(repo.worktree) },
  );
  const appended = [];
  const deps = createPlanRunnerDependencies({
    pi: { appendEntry(_type, data) { appended.push(data); } },
    readRuntimeArtifacts: async () => ({ status: { kind: "stable", value: { state: "complete" } } }),
    runtimePollIntervalMs: 0,
    runtimePollTimeoutMs: 10,
  });
  const ctx = context(repo.worktree, [{ customType: "pi-plan-event-v1", data: created(binding) }]);
  const next = await deps.continuePlan({ reason: "resume" }, { ctx });
  deps.authorizeNestedSubagent(next.tool, { ctx });

  const status = await deps.handleNestedResult({
    toolName: "subagent",
    input: next.tool,
    details: { runId: "run-auto", asyncDir: "/async/run-auto", results: [{ sessionFile: "/sessions/run-auto.jsonl" }] },
    isError: false,
  }, { ctx });

  assert.equal(status.state, "succeeded");
  assert.equal(status.reviewSkipped, true);
  const accepted = appended.filter((e) => e.type === "task.accepted");
  assert.equal(accepted.length, 1);
});
