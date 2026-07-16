import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createPlanWorkspace,
  inspectPlanWorkspace,
  removePlanWorkspace,
  rollbackPlanWorkspace,
} from "../scripts/lib/plan/workspace.mjs";

const execFile = promisify(execFileCallback);

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function createRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-workspace-"));
  const originRoot = path.join(root, "origin");
  const stateRoot = path.join(root, "state");
  await mkdir(originRoot, { recursive: true });
  await git(originRoot, "init");
  await git(originRoot, "config", "user.email", "test@example.com");
  await git(originRoot, "config", "user.name", "Test User");
  await writeFile(path.join(originRoot, "tracked.txt"), "base\n");
  await git(originRoot, "add", "tracked.txt");
  await git(originRoot, "commit", "-m", "base");
  return {
    root,
    originRoot,
    stateRoot,
    baseCommit: await git(originRoot, "rev-parse", "HEAD"),
  };
}

async function withRepository(fn) {
  const repository = await createRepository();
  try {
    await fn(repository);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
}

test("creates an isolated workspace at the fixed base without origin dirty state", async () => {
  await withRepository(async ({ originRoot, stateRoot, baseCommit }) => {
    await writeFile(path.join(originRoot, "tracked.txt"), "origin dirty\n");

    const lease = await createPlanWorkspace({
      originRoot,
      stateRoot,
      planId: "task-7",
      baseCommit,
    });
    const inspection = await inspectPlanWorkspace(lease);

    assert.equal(lease.branch, "pi-plan/task-7");
    assert.equal(lease.baseCommit, baseCommit);
    assert.equal(lease.workspacePath, path.join(stateRoot, "var", "plan-worktrees", "task-7"));
    assert.equal(await readFile(path.join(lease.workspacePath, "tracked.txt"), "utf8"), "base\n");
    assert.equal(inspection.committedDiff, "");
    assert.deepEqual(inspection.dirtyTrackedFiles, []);
  });
});

test("isolates another worktree and includes plan untracked files in the gate hash", async () => {
  await withRepository(async ({ originRoot, stateRoot, baseCommit }) => {
    const otherPath = path.join(stateRoot, "other-worktree");
    await git(originRoot, "worktree", "add", "--detach", otherPath, baseCommit);
    await writeFile(path.join(otherPath, "other.txt"), "invisible\n");

    const lease = await createPlanWorkspace({ originRoot, stateRoot, planId: "isolated", baseCommit });
    await writeFile(path.join(lease.workspacePath, "evidence.txt"), "visible\n");
    await mkdir(path.join(lease.workspacePath, ".pi-subagents", "artifacts"), { recursive: true });
    await writeFile(path.join(lease.workspacePath, ".pi-subagents", "artifacts", "runtime.json"), "{}\n");
    const inspection = await inspectPlanWorkspace(lease);

    assert.deepEqual(inspection.untrackedFiles, ["evidence.txt"]);
    assert.equal(inspection.dirtyTrackedFiles.length, 0);
    assert.notEqual(inspection.gateChangeSetHash, "");
  });
});

test("marks a prior gate inspection stale when the plan HEAD changes", async () => {
  await withRepository(async ({ originRoot, stateRoot, baseCommit }) => {
    const lease = await createPlanWorkspace({ originRoot, stateRoot, planId: "stale", baseCommit });
    const inspection = await inspectPlanWorkspace(lease);
    await writeFile(path.join(lease.workspacePath, "committed.txt"), "next\n");
    await git(lease.workspacePath, "add", "committed.txt");
    await git(lease.workspacePath, "commit", "-m", "next");

    await assert.rejects(
      removePlanWorkspace(lease, { requireValidatedHead: inspection.headCommit }),
      /validated head/i,
    );
  });
});

for (const dirtyState of ["tracked", "untracked"]) {
  test(`refuses to remove a validated workspace with ${dirtyState} changes`, async () => {
    await withRepository(async ({ originRoot, stateRoot, baseCommit }) => {
      const lease = await createPlanWorkspace({ originRoot, stateRoot, planId: `dirty-${dirtyState}`, baseCommit });
      const inspection = await inspectPlanWorkspace(lease);
      const changedFile = dirtyState === "tracked" ? "tracked.txt" : "untracked.txt";
      await writeFile(path.join(lease.workspacePath, changedFile), "must survive\n");

      await assert.rejects(
        removePlanWorkspace(lease, { requireValidatedHead: inspection.headCommit }),
        /clean/i,
      );
      assert.equal(await readFile(path.join(lease.workspacePath, changedFile), "utf8"), "must survive\n");
    });
  });
}

test("rejects forged leases, escaped plan IDs, and deletion outside the owned workspace", async () => {
  await withRepository(async ({ originRoot, stateRoot, baseCommit }) => {
    await assert.rejects(
      createPlanWorkspace({ originRoot, stateRoot, planId: "../escape", baseCommit }),
      /planId/i,
    );

    const lease = await createPlanWorkspace({ originRoot, stateRoot, planId: "owner", baseCommit });
    await assert.rejects(inspectPlanWorkspace({ ...lease, planId: "other" }), /owner|lease/i);
    await assert.rejects(
      removePlanWorkspace({ ...lease, workspacePath: originRoot }, { requireValidatedHead: lease.baseCommit }),
      /owner|lease/i,
    );
  });
});

test("rolls back a clean startup workspace, branch, and lease", async () => {
  await withRepository(async ({ originRoot, stateRoot, baseCommit }) => {
    const lease = await createPlanWorkspace({ originRoot, stateRoot, planId: "startup", baseCommit });
    await rollbackPlanWorkspace(lease);
    await assert.rejects(git(originRoot, "rev-parse", "--verify", "pi-plan/startup"));
    await assert.rejects(readFile(path.join(stateRoot, "var", "plan-worktrees", ".startup.lease.json")), /ENOENT/);
  });
});

for (const dirtyState of ["tracked", "untracked"]) {
  test(`refuses startup rollback with ${dirtyState} changes`, async () => {
    await withRepository(async ({ originRoot, stateRoot, baseCommit }) => {
      const lease = await createPlanWorkspace({ originRoot, stateRoot, planId: `rollback-${dirtyState}`, baseCommit });
      await writeFile(path.join(lease.workspacePath, dirtyState === "tracked" ? "tracked.txt" : "new.txt"), "dirty\n");
      await assert.rejects(rollbackPlanWorkspace(lease), /clean/i);
    });
  });
}

test("rejects forged leases during startup rollback", async () => {
  await withRepository(async ({ originRoot, stateRoot, baseCommit }) => {
    const lease = await createPlanWorkspace({ originRoot, stateRoot, planId: "rollback-owner", baseCommit });
    await assert.rejects(rollbackPlanWorkspace({ ...lease, token: "forged" }), /owner|lease/i);
  });
});

test("refuses startup rollback after clean committed work to preserve evidence", async () => {
  await withRepository(async ({ originRoot, stateRoot, baseCommit }) => {
    const lease = await createPlanWorkspace({ originRoot, stateRoot, planId: "rollback-committed", baseCommit });
    await writeFile(path.join(lease.workspacePath, "evidence.txt"), "committed\n");
    await git(lease.workspacePath, "add", "evidence.txt");
    await git(lease.workspacePath, "commit", "-m", "evidence");
    await assert.rejects(rollbackPlanWorkspace(lease), /base|head|rollback/i);
    assert.equal(await git(lease.workspacePath, "rev-parse", "HEAD"), await git(lease.workspacePath, "rev-parse", "pi-plan/rollback-committed"));
  });
});
