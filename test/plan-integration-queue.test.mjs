import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createIntegrationQueue, hashValidatedAttempt } from "../scripts/lib/plan/integration-queue.mjs";

const execFile = promisify(execFileCallback);

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function fixture({ conflict = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-integration-queue-"));
  const origin = path.join(root, "origin");
  await mkdir(origin);
  await git(origin, "init");
  await git(origin, "config", "user.email", "test@example.com");
  await git(origin, "config", "user.name", "Test User");
  await writeFile(path.join(origin, "shared.txt"), "base\n");
  await git(origin, "add", "shared.txt");
  await git(origin, "commit", "-m", "base");
  const baseCommit = await git(origin, "rev-parse", "HEAD");
  const attempts = {};
  for (const taskId of ["task-1", "task-2"]) {
    const attemptId = `attempt-${taskId}`;
    const workspace = path.join(root, attemptId);
    await git(origin, "worktree", "add", "-b", `attempt/${taskId}`, workspace, baseCommit);
    const file = conflict ? "shared.txt" : `${taskId}.txt`;
    await writeFile(path.join(workspace, file), `${taskId}\n`);
    await git(workspace, "add", file);
    await git(workspace, "commit", "-m", `${taskId} result`);
    const { stdout: attemptDiff } = await execFile("git", ["diff", "--binary", `${baseCommit}..HEAD`], { cwd: workspace, encoding: "utf8" });
    const value = {
      planId: "plan-1",
      taskId,
      attemptId,
      resultCommit: await git(workspace, "rev-parse", "HEAD"),
      diffSha256: createHash("sha256").update(attemptDiff).digest("hex"),
      changedPaths: [file],
      evidence: [],
      workspace: { path: workspace, ownerToken: `${attemptId}-owner` },
      deps: [],
    };
    attempts[taskId] = { ...value, validationHash: hashValidatedAttempt(value) };
  }
  return { root, origin, baseCommit, attempts };
}

async function withFixture(options, fn) {
  const value = await fixture(options);
  try {
    await fn(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

function queueFor(repo, overrides = {}) {
  const events = [];
  const released = [];
  const resources = [];
  const integrationOwnerToken = "integration-owner";
  const queue = createIntegrationQueue({
    accumulator: repo.origin,
    integrationOwnerToken,
    nodeOrder: ["task-1", "task-2"],
    append: (type, data) => events.push({ type, data }),
    releaseResources: async (attemptId) => resources.push(attemptId),
    releaseWorkspace: async (attempt) => released.push(attempt.attemptId),
    ...overrides,
  });
  return { queue, events, released, resources, integrationOwnerToken };
}

test("integrates same-base attempts serially in Plan order even when task-2 completes first", async () => {
  await withFixture({}, async (repo) => {
    const subject = queueFor(repo);
    subject.queue.enqueue(repo.attempts["task-2"]);
    subject.queue.enqueue(repo.attempts["task-1"]);

    const result = await subject.queue.drain({ expectedHead: repo.baseCommit, ownerToken: subject.integrationOwnerToken });

    assert.equal(result.state, "integrated");
    assert.deepEqual(result.integrated.map(({ taskId }) => taskId), ["task-1", "task-2"]);
    assert.equal(await git(repo.origin, "rev-list", "--count", `${repo.baseCommit}..HEAD`), "2");
    assert.deepEqual(subject.events.filter(({ type }) => type === "integration.requested").map(({ data }) => data.taskId), ["task-1", "task-2"]);
    assert.deepEqual(subject.released, ["attempt-task-1", "attempt-task-2"]);
    assert.deepEqual(subject.resources, ["attempt-task-1", "attempt-task-2"]);
  });
});

test("fails closed on owner, validation hash, duplicate enqueue, stale HEAD, and cancelled Plan", async () => {
  await withFixture({}, async (repo) => {
    const subject = queueFor(repo);
    assert.throws(() => subject.queue.enqueue({ ...repo.attempts["task-1"], validationHash: "forged" }), /validation hash/i);
    subject.queue.enqueue(repo.attempts["task-1"]);
    assert.throws(() => subject.queue.enqueue(repo.attempts["task-1"]), /duplicate/i);
    await assert.rejects(subject.queue.drain({ expectedHead: repo.baseCommit, ownerToken: "forged" }), /owner/i);
    const stale = await subject.queue.drain({ expectedHead: "stale", ownerToken: subject.integrationOwnerToken });
    assert.equal(stale.state, "blocked");
    assert.equal(subject.events.at(-1).data.reason, "stale_accumulator_head");
  });

  await withFixture({}, async (repo) => {
    const subject = queueFor(repo, { isPlanActive: () => false });
    subject.queue.enqueue(repo.attempts["task-1"]);
    const result = await subject.queue.drain({ expectedHead: repo.baseCommit, ownerToken: subject.integrationOwnerToken });
    assert.equal(result.state, "cancelled");
    assert.equal(await git(repo.origin, "rev-parse", "HEAD"), repo.baseCommit);
  });
});

test("aborts a cherry-pick conflict at the item expected HEAD and preserves its workspace", async () => {
  await withFixture({ conflict: true }, async (repo) => {
    const subject = queueFor(repo);
    subject.queue.enqueue(repo.attempts["task-2"]);
    subject.queue.enqueue(repo.attempts["task-1"]);
    const result = await subject.queue.drain({ expectedHead: repo.baseCommit, ownerToken: subject.integrationOwnerToken });

    assert.equal(result.state, "blocked");
    assert.equal(result.reason, "integration_conflict");
    assert.equal(await git(repo.origin, "status", "--porcelain"), "");
    assert.equal(await git(repo.origin, "rev-list", "--count", `${repo.baseCommit}..HEAD`), "1");
    assert.deepEqual(subject.released, ["attempt-task-1"]);
    assert.equal(subject.events.at(-1).type, "plan.blocked");
    assert.equal(subject.events.at(-1).data.attemptId, "attempt-task-2");
  });
});

test("blocks after an integrated commit when workspace cleanup fails and never reintegrates it", async () => {
  await withFixture({}, async (repo) => {
    let cleanupCalls = 0;
    const subject = queueFor(repo, {
      nodeOrder: ["task-1"],
      releaseWorkspace: async () => {
        cleanupCalls++;
        throw new Error("cleanup failed");
      },
    });
    subject.queue.enqueue(repo.attempts["task-1"]);
    const result = await subject.queue.drain({ expectedHead: repo.baseCommit, ownerToken: subject.integrationOwnerToken });
    assert.equal(result.state, "blocked");
    assert.equal(result.reason, "workspace_cleanup_failed");
    assert.equal(await git(repo.origin, "rev-list", "--count", `${repo.baseCommit}..HEAD`), "1");
    await assert.rejects(
      subject.queue.drain({ expectedHead: await git(repo.origin, "rev-parse", "HEAD"), ownerToken: subject.integrationOwnerToken }),
      /blocked/i,
    );
    assert.equal(cleanupCalls, 1);
  });
});

test("recovers a cherry-pick committed before integration.finished without applying it twice", async () => {
  await withFixture({}, async (repo) => {
    const events = [];
    let crashBeforeFinished = true;
    const first = queueFor(repo, {
      nodeOrder: ["task-1"],
      append: (type, data) => {
        events.push({ type, data });
        if (type === "integration.finished" && crashBeforeFinished) throw new Error("simulated crash before event append");
      },
    });
    first.queue.enqueue(repo.attempts["task-1"]);
    await assert.rejects(
      first.queue.drain({ expectedHead: repo.baseCommit, ownerToken: first.integrationOwnerToken }),
      /simulated crash/,
    );
    const integratedHead = await git(repo.origin, "rev-parse", "HEAD");
    assert.notEqual(integratedHead, repo.baseCommit);

    crashBeforeFinished = false;
    const recovered = queueFor(repo, { nodeOrder: ["task-1"], append: (type, data) => events.push({ type, data }) });
    recovered.queue.enqueue({
      ...repo.attempts["task-1"],
      integration: {
        status: "requested",
        expectedHead: repo.baseCommit,
        resultCommit: repo.attempts["task-1"].resultCommit,
        diffSha256: repo.attempts["task-1"].diffSha256,
      },
    });
    const result = await recovered.queue.drain({ expectedHead: repo.baseCommit, ownerToken: recovered.integrationOwnerToken });

    assert.equal(result.state, "integrated");
    assert.equal(await git(repo.origin, "rev-parse", "HEAD"), integratedHead);
    assert.equal(await git(repo.origin, "rev-list", "--count", `${repo.baseCommit}..HEAD`), "1");
    assert.equal(events.filter(({ type }) => type === "integration.requested").length, 1);
    assert.equal(events.filter(({ type }) => type === "integration.finished").length, 2);
  });
});

test("blocks when a requested integration cannot be matched to the observed HEAD", async () => {
  await withFixture({}, async (repo) => {
    await writeFile(path.join(repo.origin, "unrelated.txt"), "unrelated\n");
    await git(repo.origin, "add", "unrelated.txt");
    await git(repo.origin, "commit", "-m", "unrelated head");
    const subject = queueFor(repo, { nodeOrder: ["task-1"] });
    subject.queue.enqueue({
      ...repo.attempts["task-1"],
      integration: {
        status: "requested",
        expectedHead: repo.baseCommit,
        resultCommit: repo.attempts["task-1"].resultCommit,
        diffSha256: repo.attempts["task-1"].diffSha256,
      },
    });

    const result = await subject.queue.drain({ expectedHead: repo.baseCommit, ownerToken: subject.integrationOwnerToken });

    assert.equal(result.state, "blocked");
    assert.equal(result.reason, "integration_recovery_ambiguous");
  });
});

test("does not enqueue a dependent attempt before all dependencies are integrated", async () => {
  await withFixture({}, async (repo) => {
    const dependent = { ...repo.attempts["task-2"], deps: ["task-1"] };
    dependent.validationHash = hashValidatedAttempt(dependent);
    const subject = queueFor(repo);
    assert.throws(() => subject.queue.enqueue(dependent), /dependencies.*integrated/i);
  });
});
