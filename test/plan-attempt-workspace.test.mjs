import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  allocateAttemptWorkspace,
  inspectAttemptWorkspace,
  releaseAttemptWorkspace,
} from "../scripts/lib/plan/attempt-workspace.mjs";

const execFile = promisify(execFileCallback);

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function createRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-attempt-workspace-"));
  const originRoot = path.join(root, "origin");
  const stateRoot = path.join(root, "state");
  await mkdir(originRoot, { recursive: true });
  await git(originRoot, "init");
  await git(originRoot, "config", "user.email", "test@example.com");
  await git(originRoot, "config", "user.name", "Test User");
  await writeFile(path.join(originRoot, "tracked.txt"), "base\n");
  await git(originRoot, "add", "tracked.txt");
  await git(originRoot, "commit", "-m", "base");
  return { root, originRoot, stateRoot, baseCommit: await git(originRoot, "rev-parse", "HEAD") };
}

async function withRepository(fn) {
  const repository = await createRepository();
  try {
    await fn(repository);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
}

function input(repository, overrides = {}) {
  return {
    originRoot: repository.originRoot,
    stateRoot: repository.stateRoot,
    planId: "plan-1",
    taskId: "task-2",
    attemptId: "attempt-plan-1-task-2-1",
    baseCommit: repository.baseCommit,
    ...overrides,
  };
}

async function authorizeRelease(lease, disposition, status = "integrated") {
  const statusPath = path.join(lease.stateRoot, "var", "plan-runs", lease.planId, "status.json");
  await mkdir(path.dirname(statusPath), { recursive: true });
  await writeFile(statusPath, JSON.stringify({
    schemaVersion: "pi-plan-status.v1",
    derived: true,
    planId: lease.planId,
    tasks: [{
      taskId: lease.taskId,
      attempts: [{
        attemptId: lease.attemptId,
        status,
        workspaceReleased: true,
        workspaceDisposition: disposition,
      }],
    }],
  }));
}

test("allocates isolated attempt worktrees and writes private authoritative leases", async () => {
  await withRepository(async (repository) => {
    const first = await allocateAttemptWorkspace(input(repository));
    const second = await allocateAttemptWorkspace(input(repository, {
      taskId: "task-3",
      attemptId: "attempt-plan-1-task-3-1",
    }));

    assert.equal(first.baseCommit, repository.baseCommit);
    assert.equal(first.branch, "pi-plan-attempt/plan-1/task-2/1");
    assert.equal(first.path, path.join(repository.stateRoot, "var", "plan-worktrees", "plan-1", "attempts", first.attemptId));
    assert.notEqual(first.path, second.path);
    assert.notEqual(first.ownerToken, second.ownerToken);
    assert.equal(await git(first.path, "rev-parse", "HEAD"), repository.baseCommit);
    assert.equal(await git(second.path, "rev-parse", "HEAD"), repository.baseCommit);
    assert.equal((await stat(first.leasePath)).mode & 0o777, 0o600);
    assert.deepEqual(await inspectAttemptWorkspace(first), {
      headCommit: repository.baseCommit,
      dirtyTrackedFiles: [],
      untrackedFiles: [],
      clean: true,
    });
  });
});

test("rejects existing branches, escaped identities, and forged owner tokens", async () => {
  await withRepository(async (repository) => {
    await git(repository.originRoot, "branch", "pi-plan-attempt/plan-1/task-2/1", repository.baseCommit);
    await assert.rejects(allocateAttemptWorkspace(input(repository)), /branch|exists/i);
    await assert.rejects(allocateAttemptWorkspace(input(repository, { attemptId: "../escape-1" })), /attemptId/i);

    await git(repository.originRoot, "branch", "-d", "pi-plan-attempt/plan-1/task-2/1");
    const lease = await allocateAttemptWorkspace(input(repository));
    await authorizeRelease(lease, "cancelled-cleanup", "cancelled");
    await assert.rejects(
      releaseAttemptWorkspace(lease, { ownerToken: "forged", disposition: "cancelled-cleanup" }),
      /owner/i,
    );
    await access(lease.path);
  });
});

test("refuses active, unauthorized, or dirty cleanup and records failure evidence", async () => {
  await withRepository(async (repository) => {
    const lease = await allocateAttemptWorkspace(input(repository));
    await assert.rejects(
      releaseAttemptWorkspace(lease, { ownerToken: lease.ownerToken, disposition: "integrated-cleanup" }),
      /status|event|authorized/i,
    );

    await authorizeRelease(lease, "integrated-cleanup", "active");
    await assert.rejects(
      releaseAttemptWorkspace(lease, { ownerToken: lease.ownerToken, disposition: "integrated-cleanup" }),
      /active|status/i,
    );

    await authorizeRelease(lease, "integrated-cleanup", "integrated");
    await writeFile(path.join(lease.path, "tracked.txt"), "dirty\n");
    await assert.rejects(
      releaseAttemptWorkspace(lease, { ownerToken: lease.ownerToken, disposition: "integrated-cleanup" }),
      /clean/i,
    );
    const failure = JSON.parse(await readFile(path.join(path.dirname(lease.leasePath), "release-failure.json"), "utf8"));
    assert.equal(failure.attemptId, lease.attemptId);
    assert.equal(failure.disposition, "integrated-cleanup");
    await access(lease.path);
  });
});

test("retries cleanup after the worktree becomes clean and deletes only the owned branch", async () => {
  await withRepository(async (repository) => {
    const lease = await allocateAttemptWorkspace(input(repository));
    await authorizeRelease(lease, "integrated-cleanup", "integrated");
    await writeFile(path.join(lease.path, "tracked.txt"), "dirty\n");
    await assert.rejects(
      releaseAttemptWorkspace(lease, { ownerToken: lease.ownerToken, disposition: "integrated-cleanup" }),
      /clean/i,
    );
    await git(lease.path, "restore", "tracked.txt");
    await writeFile(path.join(lease.path, "result.txt"), "committed result\n");
    await git(lease.path, "add", "result.txt");
    await git(lease.path, "commit", "-m", "attempt result");
    const resultCommit = await git(lease.path, "rev-parse", "HEAD");
    assert.notEqual(resultCommit, repository.baseCommit);

    const released = await releaseAttemptWorkspace(lease, {
      ownerToken: lease.ownerToken,
      disposition: "integrated-cleanup",
    });
    assert.deepEqual(released, { released: true, preserved: false, disposition: "integrated-cleanup" });
    await assert.rejects(access(lease.path));
    await assert.rejects(git(repository.originRoot, "rev-parse", "--verify", lease.branch));
    await assert.rejects(
      releaseAttemptWorkspace(lease, { ownerToken: lease.ownerToken, disposition: "integrated-cleanup" }),
      /lease|owner/i,
    );
  });
});

test("removes only ignored pi-subagents runtime artifacts before clean release", async () => {
  await withRepository(async (repository) => {
    const lease = await allocateAttemptWorkspace(input(repository));
    await authorizeRelease(lease, "integrated-cleanup", "integrated");
    const artifacts = path.join(lease.path, ".pi-subagents", "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, "executor-output.md"), "runtime evidence\n");
    assert.equal((await inspectAttemptWorkspace(lease)).clean, true);

    const released = await releaseAttemptWorkspace(lease, {
      ownerToken: lease.ownerToken,
      disposition: "integrated-cleanup",
    });
    assert.deepEqual(released, { released: true, preserved: false, disposition: "integrated-cleanup" });
    await assert.rejects(access(lease.path));
  });
});

test("preserve dispositions retain the worktree and authoritative lease", async () => {
  await withRepository(async (repository) => {
    const lease = await allocateAttemptWorkspace(input(repository));
    await authorizeRelease(lease, "failed-preserve", "failed");
    const result = await releaseAttemptWorkspace(lease, {
      ownerToken: lease.ownerToken,
      disposition: "failed-preserve",
    });

    assert.deepEqual(result, { released: false, preserved: true, disposition: "failed-preserve" });
    await access(lease.path);
    await access(lease.leasePath);
  });
});

test("authoritative lease fields cannot be changed through the caller object", async () => {
  await withRepository(async (repository) => {
    const lease = await allocateAttemptWorkspace(input(repository));
    await chmod(lease.leasePath, 0o600);
    await assert.rejects(
      inspectAttemptWorkspace({ ...lease, path: repository.originRoot }),
      /owner|lease/i,
    );
  });
});
