import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as workspace from "../scripts/lib/goal-engine/workspace.mjs";
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

test("inspectExecutorWorkspace ignores untracked subagent runtime artifacts", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });

  mkdirSync(join(lease.path, ".pi-subagents/artifacts"), { recursive: true });
  writeFileSync(join(lease.path, ".pi-subagents/artifacts/run.json"), "{}\n");

  const inspection = inspectExecutorWorkspace(lease);
  assert.deepEqual(inspection.untrackedFiles, []);
  assert.equal(inspection.clean, true);
});

test("inspectExecutorWorkspace keeps ordinary untracked files dirty", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });

  writeFileSync(join(lease.path, "untracked.txt"), "user output\n");

  const inspection = inspectExecutorWorkspace(lease);
  assert.deepEqual(inspection.untrackedFiles, ["untracked.txt"]);
  assert.equal(inspection.clean, false);
});

test("inspectExecutorWorkspace reports changed files and write path boundaries", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });

  mkdirSync(join(lease.path, "src"), { recursive: true });
  writeFileSync(join(lease.path, "README.md"), "updated\n");
  writeFileSync(join(lease.path, "src/allowed.ts"), "export const allowed = true;\n");
  writeFileSync(join(lease.path, "src/allowed.ts.bak"), "export const sibling = true;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: update scoped files");

  const inspection = inspectExecutorWorkspace(lease);
  assert.ok(Array.isArray(inspection.changedFiles), "inspectExecutorWorkspace must return changedFiles");
  assert.deepEqual([...inspection.changedFiles].sort(), ["README.md", "src/allowed.ts", "src/allowed.ts.bak"]);

  const { assertWorkspaceChangesWithinPaths } = workspace;
  assert.equal(
    typeof assertWorkspaceChangesWithinPaths,
    "function",
    "assertWorkspaceChangesWithinPaths must be exported",
  );
  assert.throws(
    () => assertWorkspaceChangesWithinPaths(inspection, ["src/**"]),
    /README\.md.*writePaths/i,
  );
  assert.throws(
    () => assertWorkspaceChangesWithinPaths(inspection, ["src/allowed.ts"]),
    /src\/allowed\.ts\.bak|writePaths|sibling/i,
  );
  assert.throws(
    () => assertWorkspaceChangesWithinPaths(inspection, [join(lease.path, "README.md")]),
    /absolute|repo-relative|writePaths|path/i,
  );
  assert.throws(
    () => assertWorkspaceChangesWithinPaths(inspection, ["../README.md"]),
    /\.\.|path|relative|writePaths/i,
  );
  assert.throws(
    () => assertWorkspaceChangesWithinPaths(inspection, ["src/*.ts"]),
    /pattern|glob|unsupported|writePaths/i,
  );
  assert.doesNotThrow(() => assertWorkspaceChangesWithinPaths(inspection, ["README.md", "src/allowed.ts", "src/allowed.ts.bak"]));

  const globLease = allocateExecutorWorkspace({ goalId: "g", taskId: "t2", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  mkdirSync(join(globLease.path, "src"), { recursive: true });
  writeFileSync(join(globLease.path, "src/only.ts"), "export const only = true;\n");
  git(globLease.path, "add", ".");
  git(globLease.path, "commit", "-m", "feat: add src-only file");

  const globInspection = inspectExecutorWorkspace(globLease);
  assert.ok(Array.isArray(globInspection.changedFiles), "inspectExecutorWorkspace must return changedFiles");
  assert.deepEqual([...globInspection.changedFiles].sort(), ["src/only.ts"]);
  assert.doesNotThrow(() => assertWorkspaceChangesWithinPaths(globInspection, ["src/**"]));
});

test("writePaths requires both sides of rename and copy to be owned", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  mkdirSync(join(origin, "forbidden"), { recursive: true });
  writeFileSync(join(origin, "forbidden/secret.txt"), "secret\n");
  writeFileSync(join(origin, "forbidden/source.txt"), "copy source content that is long enough to be detected reliably\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "test: add protected sources");
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const renameLease = allocateExecutorWorkspace({ goalId: "rename-gate", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  mkdirSync(join(renameLease.path, "allowed"), { recursive: true });
  git(renameLease.path, "mv", "forbidden/secret.txt", "allowed/secret.txt");
  git(renameLease.path, "commit", "-m", "test: move secret");
  const renameInspection = inspectExecutorWorkspace(renameLease);
  assert.deepEqual(renameInspection.changedFiles, ["allowed/secret.txt", "forbidden/secret.txt"]);
  assert.throws(() => workspace.assertWorkspaceChangesWithinPaths(renameInspection, ["allowed/**"]), /forbidden\/secret\.txt/);
  assert.doesNotThrow(() => workspace.assertWorkspaceChangesWithinPaths(renameInspection, ["allowed/**", "forbidden/**"]));

  const copyLease = allocateExecutorWorkspace({ goalId: "copy-gate", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  mkdirSync(join(copyLease.path, "allowed"), { recursive: true });
  writeFileSync(join(copyLease.path, "allowed/copy.txt"), "copy source content that is long enough to be detected reliably\n");
  git(copyLease.path, "add", ".");
  git(copyLease.path, "commit", "-m", "test: copy secret");
  const copyInspection = inspectExecutorWorkspace(copyLease);
  assert.deepEqual(copyInspection.changedFiles, ["allowed/copy.txt", "forbidden/source.txt"]);
  assert.throws(() => workspace.assertWorkspaceChangesWithinPaths(copyInspection, ["allowed/**"]), /forbidden\/source\.txt/);
  assert.doesNotThrow(() => workspace.assertWorkspaceChangesWithinPaths(copyInspection, ["allowed/**", "forbidden/**"]));
});

test("assertWorkspaceChangesWithinPaths rejects NUL-byte paths", () => {
  const inspection = { changedFiles: ["shared/\u0000path.txt"] };

  assert.throws(
    () => workspace.assertWorkspaceChangesWithinPaths(inspection, ["shared/\u0000path.txt"]),
    /./,
  );
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

test("integrateExecutorWorkspace with expected executor head must reject head mismatch before origin side effects", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 2, originRoot: origin, stateRoot, baseCommit });

  writeFileSync(join(lease.path, "expected-head-first.ts"), "export const first = true;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: first commit");
  const firstHead = git(lease.path, "rev-parse", "HEAD");

  writeFileSync(join(lease.path, "expected-head-second.ts"), "export const second = true;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: second commit");

  const originHeadBefore = git(origin, "rev-parse", "HEAD");
  const originStatusBefore = git(origin, "status", "--porcelain");

  assert.throws(
    () => integrateExecutorWorkspace(lease, { strategy: "cherry-pick", executorHead: firstHead }),
    /executor.*HEAD|HEAD.*expected|HEAD.*changed/i,
  );
  assert.equal(git(origin, "rev-parse", "HEAD"), originHeadBefore);
  assert.equal(git(origin, "status", "--porcelain"), originStatusBefore);
  assert.equal(existsSync(join(origin, "expected-head-first.ts")), false);
  assert.equal(existsSync(join(origin, "expected-head-second.ts")), false);
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

test("releaseExecutorWorkspace(discarded-cleanup) partial cleanup should restore workspace, branch, and lease", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t2", attempt: 1, originRoot: origin, stateRoot, baseCommit });

  rmSync(lease.path, { recursive: true, force: true });
  assert.equal(existsSync(lease.path), false);
  assert.ok(git(origin, "branch", "--list", lease.branch).includes(lease.branch));
  assert.equal(existsSync(lease.leasePath), true);

  assert.equal(
    typeof workspace.inspectExecutorWorkspaceResources,
    "function",
    "inspectExecutorWorkspaceResources must be exported",
  );
  assert.deepEqual(workspace.inspectExecutorWorkspaceResources(lease), {
    workspaceExists: false,
    branchExists: true,
    leaseExists: true,
  });

  releaseExecutorWorkspace(lease, { disposition: "discarded-cleanup" });
  assert.deepEqual(workspace.inspectExecutorWorkspaceResources(lease), {
    workspaceExists: false,
    branchExists: false,
    leaseExists: false,
  });
});

test("isExecutorWorkspaceIntegrated detects cherry-pick patch equivalence", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  writeFileSync(join(lease.path, "feature.ts"), "export const f = true;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: add feature");

  writeFileSync(join(lease.path, "feature2.ts"), "export const g = true;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: add second feature");

  const executorHead = git(lease.path, "rev-parse", "HEAD");

  writeFileSync(join(origin, "upstream.txt"), "upstream change\n");
  git(origin, "add", "upstream.txt");
  git(origin, "commit", "-m", "chore: add unrelated commit");
  const originHeadBefore = git(origin, "rev-parse", "HEAD");

  assert.equal(
    typeof workspace.isExecutorWorkspaceIntegrated,
    "function",
    "isExecutorWorkspaceIntegrated must be exported",
  );
  assert.equal(workspace.isExecutorWorkspaceIntegrated(lease, { strategy: "cherry-pick", executorHead }), false);

  const result = integrateExecutorWorkspace(lease, { strategy: "cherry-pick" });
  assert.equal(result.integrated, true);
  assert.equal(result.strategy, "cherry-pick");
  assert.equal(result.executorHead, executorHead);
  assert.equal(result.originHeadBefore, originHeadBefore);
  assert.equal(result.newHead, git(origin, "rev-parse", "HEAD"));

  const cherryOutput = git(origin, "cherry", "HEAD", executorHead, baseCommit);
  const cherryLines = cherryOutput ? cherryOutput.split("\n").filter((line) => line.length > 0) : [];
  assert.equal(cherryLines.length, 2);
  assert.ok(cherryLines.every((line) => line.startsWith("-")));

  assert.equal(workspace.isExecutorWorkspaceIntegrated(lease, { strategy: "cherry-pick", executorHead }), true);
});

test("isExecutorWorkspaceIntegrated treats ff-only first-parent integration as cherry-pick-equivalent", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t2", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  writeFileSync(join(lease.path, "merge.ts"), "export const m = true;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: merge commit");

  const executorHead = git(lease.path, "rev-parse", "HEAD");
  git(origin, "merge", "--ff-only", executorHead);

  const cherryOutput = git(origin, "cherry", "HEAD", executorHead, baseCommit);
  assert.equal(cherryOutput, "");

  assert.equal(
    typeof workspace.isExecutorWorkspaceIntegrated,
    "function",
    "isExecutorWorkspaceIntegrated must be exported",
  );
  assert.equal(workspace.isExecutorWorkspaceIntegrated(lease, { strategy: "cherry-pick", executorHead }), true);
});

test("isExecutorWorkspaceIntegrated detects merge ancestry once merged", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t2", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  writeFileSync(join(lease.path, "merge.ts"), "export const m = true;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: merge commit");

  const executorHead = git(lease.path, "rev-parse", "HEAD");

  assert.equal(
    typeof workspace.isExecutorWorkspaceIntegrated,
    "function",
    "isExecutorWorkspaceIntegrated must be exported",
  );
  assert.equal(workspace.isExecutorWorkspaceIntegrated(lease, { strategy: "merge", executorHead }), false);

  integrateExecutorWorkspace(lease, { strategy: "merge" });
  assert.equal(workspace.isExecutorWorkspaceIntegrated(lease, { strategy: "merge", executorHead }), true);
});

test("isExecutorWorkspaceIntegrated with merge strategy throws for unknown executor head", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t2", attempt: 2, originRoot: origin, stateRoot, baseCommit });
  assert.throws(
    () => workspace.isExecutorWorkspaceIntegrated(lease, { strategy: "merge", executorHead: "0000000000000000000000000000000000000000" }),
    /./,
  );
});

test("isExecutorWorkspaceIntegrated(cherry-pick) stays false after merge integration", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t4", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  writeFileSync(join(lease.path, "merge.ts"), "export const m = true;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "feat: merge for probe");

  const executorHead = git(lease.path, "rev-parse", "HEAD");
  integrateExecutorWorkspace(lease, { strategy: "merge" });
  assert.equal(workspace.isExecutorWorkspaceIntegrated(lease, { strategy: "cherry-pick", executorHead }), false);
});

test("integrateExecutorWorkspace throws atomically when second cherry-pick conflicts", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  writeFileSync(join(origin, "shared.txt"), "shared baseline\n");
  git(origin, "add", "shared.txt");
  git(origin, "commit", "-m", "seed shared base");

  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t5", attempt: 1, originRoot: origin, stateRoot, baseCommit });

  writeFileSync(join(lease.path, "first.txt"), "first commit\n");
  git(lease.path, "add", "first.txt");
  git(lease.path, "commit", "-m", "feat: first commit");

  writeFileSync(join(lease.path, "shared.txt"), "workspace shared update\n");
  git(lease.path, "add", "shared.txt");
  git(lease.path, "commit", "-m", "feat: conflicting second commit");

  writeFileSync(join(origin, "shared.txt"), "origin diverged\n");
  git(origin, "add", "shared.txt");
  git(origin, "commit", "-m", "parallel shared diverge");

  const originHeadBefore = git(origin, "rev-parse", "HEAD");
  assert.throws(() => integrateExecutorWorkspace(lease, { strategy: "cherry-pick" }), /./);

  assert.equal(git(origin, "rev-parse", "HEAD"), originHeadBefore);
  assert.equal(git(origin, "status", "--porcelain"), "");
  assert.equal(existsSync(join(origin, "first.txt")), false);
});

test("integrateExecutorWorkspace throws atomically on merge conflict", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  writeFileSync(join(origin, "shared.txt"), "shared baseline\n");
  git(origin, "add", "shared.txt");
  git(origin, "commit", "-m", "seed shared for merge conflict");

  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "g", taskId: "t6", attempt: 1, originRoot: origin, stateRoot, baseCommit });

  writeFileSync(join(lease.path, "shared.txt"), "workspace shared change\n");
  git(lease.path, "add", "shared.txt");
  git(lease.path, "commit", "-m", "feat: workspace shared change");

  writeFileSync(join(origin, "shared.txt"), "origin shared change\n");
  git(origin, "add", "shared.txt");
  git(origin, "commit", "-m", "origin conflicting change");

  const originHeadBefore = git(origin, "rev-parse", "HEAD");
  assert.throws(() => integrateExecutorWorkspace(lease, { strategy: "merge" }), /./);

  assert.equal(git(origin, "rev-parse", "HEAD"), originHeadBefore);
  assert.equal(git(origin, "status", "--porcelain"), "");
});

test("inspectExecutorWorkspaceResources tracks workspace, branch, and lease lifecycle", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(origin, "rev-parse", "HEAD");

  assert.equal(
    typeof workspace.inspectExecutorWorkspaceResources,
    "function",
    "inspectExecutorWorkspaceResources must be exported",
  );

  const releaseLease = allocateExecutorWorkspace({ goalId: "g", taskId: "t3", attempt: 1, originRoot: origin, stateRoot, baseCommit });
  assert.deepEqual(workspace.inspectExecutorWorkspaceResources(releaseLease), {
    workspaceExists: true,
    branchExists: true,
    leaseExists: true,
  });

  assert.deepEqual(
    workspace.inspectExecutorWorkspaceResources({ ...releaseLease, branch: "ge/nonexistent-branch" }),
    {
      workspaceExists: true,
      branchExists: false,
      leaseExists: true,
    },
  );

  assert.throws(
    () => workspace.inspectExecutorWorkspaceResources({ ...releaseLease, originRoot: join(stateRoot, "missing-origin-root") }),
    /./,
  );

  releaseExecutorWorkspace(releaseLease, { disposition: "integrated-cleanup" });
  assert.deepEqual(workspace.inspectExecutorWorkspaceResources(releaseLease), {
    workspaceExists: false,
    branchExists: false,
    leaseExists: false,
  });

  const preserveLease = allocateExecutorWorkspace({ goalId: "g", taskId: "t3", attempt: 2, originRoot: origin, stateRoot, baseCommit });
  assert.deepEqual(workspace.inspectExecutorWorkspaceResources(preserveLease), {
    workspaceExists: true,
    branchExists: true,
    leaseExists: true,
  });

  releaseExecutorWorkspace(preserveLease, { disposition: "preserved" });
  assert.deepEqual(workspace.inspectExecutorWorkspaceResources(preserveLease), {
    workspaceExists: true,
    branchExists: true,
    leaseExists: true,
  });
});
