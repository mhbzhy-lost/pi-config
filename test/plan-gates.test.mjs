import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { applyEvent, createProjection } from "../scripts/lib/plan/plan-events.mjs";
import { createTaskCommandRegistry, resolveTaskVerification, runPlanGates } from "../scripts/lib/plan/gates.mjs";

const execFile = promisify(execFileCallback);

function nodeCommand(source = "") {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-gates-"));
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  await writeFile(path.join(root, "file.txt"), "base\n");
  await git(root, "add", "file.txt");
  await git(root, "commit", "-m", "base");
  return root;
}

function projection(head) {
  return applyEvent(createProjection(), {
    schemaVersion: "pi-plan-event.v1",
    eventId: crypto.randomUUID(),
    planId: "plan-1",
    occurredAt: new Date().toISOString(),
    type: "plan.created",
    data: { workspace: { originRoot: "/origin", worktree: "/worktree", baseCommit: "base", headCommit: head, planPath: "/origin/docs/plan.md", planHash: "a".repeat(64) }, tasks: ["task-1"] },
  });
}

function acceptedProjection(head) {
  const result = projection(head);
  result.tasks.set("task-1", { status: "accepted" });
  return result;
}

test("builds a controlled task command registry from approved contract commands and package scripts", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test", "lint:plan": "node lint.mjs", "unsafe name": "echo no" } }));
  const plan = {
    verification: ["node --test test/plan.test.mjs"],
    taskVerification: { "task-1": ["package:test", "contract:verification:1"] },
  };
  const registry = await createTaskCommandRegistry({ cwd, plan });
  assert.deepEqual(resolveTaskVerification({ plan, taskId: "task-1", registry }), [
    { id: "package:test", command: "npm run test --" },
    { id: "contract:verification:1", command: "node --test test/plan.test.mjs" },
  ]);
  assert.equal(registry.has("package:unsafe name"), false);
  assert.throws(
    () => resolveTaskVerification({ plan: { ...plan, taskVerification: { "task-1": ["task prose"] } }, taskId: "task-1", registry }),
    /registered command/i,
  );
});

test("runs every declared verification command string before validating the current head", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "change.txt"), "change\n");
  await git(cwd, "add", "change.txt");
  await git(cwd, "commit", "-m", "change");
  const head = await git(cwd, "rev-parse", "HEAD");
  const first = `${cwd}.first.marker`;
  const second = `${cwd}.second.marker`;
  t.after(() => Promise.all([rm(first, { force: true }), rm(second, { force: true })]));

  const result = await runPlanGates({
    cwd,
    baseCommit: "HEAD~1",
    projection: acceptedProjection(head),
    commands: [
      nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(first)}, '')`),
      nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(second)}, '')`),
    ],
    audit: async () => ({ findings: [] }),
    externalReview: async () => ({ available: true, findings: [] }),
  });

  await access(first);
  await access(second);
  assert.equal(result.validated, true);
  assert.ok(result.attempts.every((item) => item.status === "passed"));
});

test("ignores only pi-subagents runtime artifacts when checking a clean committed change", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "change.txt"), "change\n");
  await git(cwd, "add", "change.txt");
  await git(cwd, "commit", "-m", "change");
  await mkdir(path.join(cwd, ".pi-subagents", "artifacts"), { recursive: true });
  await writeFile(path.join(cwd, ".pi-subagents", "artifacts", "runtime.json"), "{}\n");
  const head = await git(cwd, "rev-parse", "HEAD");

  const result = await runPlanGates({
    cwd,
    baseCommit: "HEAD~1",
    projection: acceptedProjection(head),
    commands: [nodeCommand()],
    audit: async () => ({ findings: [] }),
    externalReview: async () => ({ available: true, findings: [] }),
  });

  assert.equal(result.validated, true);
});

test("fails closed when the projection head is not the real gate input head", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const staleHead = await git(cwd, "rev-parse", "HEAD");
  await writeFile(path.join(cwd, "change.txt"), "change\n");
  await git(cwd, "add", "change.txt");
  await git(cwd, "commit", "-m", "change");

  const result = await runPlanGates({
    cwd,
    baseCommit: staleHead,
    projection: acceptedProjection(staleHead),
    commands: [nodeCommand()],
    audit: async () => ({ findings: [] }),
    externalReview: async () => ({ available: true, findings: [] }),
  });

  assert.equal(result.validated, false);
  assert.equal(result.lifecycle, "running");
});

test("refuses gates without committed diff, with dirty worktree, or active attempts", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const head = await git(cwd, "rev-parse", "HEAD");

  for (const state of [
    { name: "no diff", baseCommit: head, projection: projection(head) },
    { name: "dirty", baseCommit: head, dirty: true, projection: projection(head) },
    { name: "active attempt", baseCommit: head, active: true, projection: projection(head) },
  ]) {
    if (state.dirty) await writeFile(path.join(cwd, "dirty.txt"), "dirty\n");
    if (state.active) state.projection.attempts.set("attempt-1", { status: "dispatch-requested" });
    const result = await runPlanGates({ cwd, baseCommit: state.baseCommit, projection: state.projection, commands: [nodeCommand()] });
    assert.equal(result.validated, false, state.name);
    await git(cwd, "clean", "-fd");
  }
});

test("fails closed for failing commands, invalid audit, and critical external findings", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "change.txt"), "change\n");
  await git(cwd, "add", "change.txt");
  await git(cwd, "commit", "-m", "change");
  const head = await git(cwd, "rev-parse", "HEAD");

  for (const options of [
    { commands: [nodeCommand("process.exit(2)")] },
    { commands: [nodeCommand()], audit: async () => ({ nope: true }) },
    { commands: [nodeCommand()], audit: async () => ({ findings: [] }), externalReview: async () => ({ available: true, findings: [{ severity: "Critical" }] }) },
  ]) {
    const result = await runPlanGates({ cwd, baseCommit: "HEAD~1", projection: projection(head), ...options });
    assert.equal(result.validated, false);
  }
});

test("unavailable external-review blocks plan validation (fail-closed)", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "change.txt"), "change\n");
  await git(cwd, "add", "change.txt");
  await git(cwd, "commit", "-m", "change");
  const head = await git(cwd, "rev-parse", "HEAD");

  const result = await runPlanGates({
    cwd,
    baseCommit: "HEAD~1",
    projection: acceptedProjection(head),
    commands: [nodeCommand()],
    audit: async () => ({ findings: [] }),
    externalReview: async () => ({ available: false, findings: [] }),
  });
  assert.equal(result.validated, false);
  const erGate = result.attempts.find((a) => a.type === "external-review");
  assert.equal(erGate.status, "unavailable");
  const fcGate = result.attempts.find((a) => a.type === "final-completeness");
  assert.equal(fcGate.status, "failed");
});

test("returns four immutable gate attempts and invalidates all when HEAD changes during gates", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "change.txt"), "change\n");
  await git(cwd, "add", "change.txt");
  await git(cwd, "commit", "-m", "change");
  const head = await git(cwd, "rev-parse", "HEAD");
  const result = await runPlanGates({
    cwd,
    baseCommit: "HEAD~1",
    projection: projection(head),
    commands: [nodeCommand()],
    audit: async () => {
      await writeFile(path.join(cwd, "next.txt"), "next\n");
      await git(cwd, "add", "next.txt");
      await git(cwd, "commit", "-m", "next");
      return { findings: [] };
    },
    externalReview: async () => ({ available: true, findings: [] }),
  });

  assert.equal(result.validated, false);
  assert.equal(result.lifecycle, "running");
  assert.equal(result.attempts.length, 4);
  for (const attempt of result.attempts) {
    assert.deepEqual(Object.keys(attempt).sort(), ["changeSetHash", "evidence", "findings", "gateId", "inputHead", "status", "type"].sort());
    assert.notEqual(attempt.status, "passed");
  }
});
