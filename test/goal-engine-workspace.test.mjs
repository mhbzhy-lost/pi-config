import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allocateExecutorWorkspace, inspectExecutorWorkspace, integrateExecutorWorkspace, releaseExecutorWorkspace } from "../scripts/lib/goal-engine/workspace.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ge-ws-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  return dir;
}

function tmpStateRoot() {
  return mkdtempSync(join(tmpdir(), "ge-ws-state-"));
}

test("allocateExecutorWorkspace creates worktree on new branch", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({
    goalId: "test-goal",
    taskId: "t1",
    attempt: 1,
    originRoot: origin,
    stateRoot,
    baseCommit,
  });

  assert.ok(existsSync(lease.path));
  assert.equal(lease.branch, "ge/test-goal/t1/1");
  assert.equal(lease.baseCommit, baseCommit);
  assert.equal(git(lease.path, "rev-parse", "HEAD"), baseCommit);
  assert.equal(git(lease.path, "branch", "--show-current"), "ge/test-goal/t1/1");
});

test("allocateExecutorWorkspace rejects duplicate allocation", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  assert.throws(
    () => allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit }),
    /already exists/,
  );
});

test("inspectExecutorWorkspace reports diff after executor commits", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });

  mkdirSync(join(lease.path, "src"), { recursive: true });
  writeFileSync(join(lease.path, "src/new.ts"), "export const x = 1;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: add new.ts");

  const inspection = inspectExecutorWorkspace(lease);
  assert.notEqual(inspection.headCommit, baseCommit);
  assert.ok(inspection.diff.includes("src/new.ts"));
  assert.equal(inspection.dirtyFiles.length, 0);
  assert.equal(inspection.hasCommits, true);
  assert.equal(inspection.clean, true);
});

test("integrateExecutorWorkspace cherry-picks executor commit into origin", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });

  writeFileSync(join(lease.path, "feature.ts"), "export const f = true;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: add feature");

  const result = integrateExecutorWorkspace(lease, { strategy: "cherry-pick" });
  assert.equal(result.integrated, true);
  assert.notEqual(git(origin, "rev-parse", "HEAD"), baseCommit);
  assert.ok(existsSync(join(origin, "feature.ts")));
});

test("releaseExecutorWorkspace removes worktree and branch", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  const branch = lease.branch;

  releaseExecutorWorkspace(lease, { disposition: "integrated-cleanup" });
  assert.equal(existsSync(lease.path), false);
  assert.equal(git(origin, "branch", "--list", branch), "");
});
