import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("inspectExecutorWorkspace rejects an ancestor HEAD on the live branch", () => {
  const origin = initRepo();
  writeFileSync(join(origin, "base.txt"), "base\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "test: base");
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "ancestor", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  git(lease.path, "reset", "--hard", "HEAD^");

  const inspection = inspectExecutorWorkspace(lease);
  assert.equal(inspection.descendant, false);
  assert.equal(inspection.hasCommits, false);
  assert.deepEqual(inspection.aheadCommits, []);
});

test("inspectExecutorWorkspace reports unrelated live branch HEAD as non-descendant", () => {
  const origin = initRepo();
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "unrelated", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  git(lease.path, "checkout", "--orphan", "unrelated-root");
  git(lease.path, "rm", "-rf", ".");
  writeFileSync(join(lease.path, "unrelated.txt"), "unrelated\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "test: unrelated root");
  const unrelatedHead = git(lease.path, "rev-parse", "HEAD");
  git(lease.path, "branch", "-f", lease.branch, unrelatedHead);
  git(lease.path, "switch", lease.branch);

  const inspection = inspectExecutorWorkspace(lease);
  assert.equal(inspection.descendant, false);
  assert.equal(inspection.hasCommits, false);
  assert.equal(inspection.aheadCount, 0);
});

test("inspectExecutorWorkspace rejects empty-only descendant commits as usable", () => {
  const origin = initRepo();
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "empty", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  git(lease.path, "commit", "--allow-empty", "-m", "test: empty");

  const inspection = inspectExecutorWorkspace(lease);
  assert.equal(inspection.descendant, true);
  assert.equal(inspection.aheadCount, 1);
  assert.equal(inspection.treeChanged, false);
  assert.equal(inspection.hasCommits, false);
});

test("inspectExecutorWorkspace rejects a wrong live branch", () => {
  const origin = initRepo();
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "live-branch", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  git(lease.path, "switch", "-c", "wrong-live-branch");

  assert.throws(() => inspectExecutorWorkspace(lease), /branch|identity/i);
});

test("inspectExecutorWorkspace rejects a canonical common dir identity mismatch", () => {
  const origin = initRepo();
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "common-dir", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  const otherOrigin = initRepo();

  assert.throws(() => inspectExecutorWorkspace({ ...lease, originRoot: otherOrigin }), /common|identity|origin/i);
});

test("inspectExecutorWorkspace treats runtime to outside staged rename as dirty", () => {
  const origin = initRepo();
  mkdirSync(join(origin, ".pi-subagents"), { recursive: true });
  writeFileSync(join(origin, ".pi-subagents", "tracked.txt"), "runtime\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "test: runtime tracked");
  const lease = allocateExecutorWorkspace({ goalId: "runtime-out", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit: git(origin, "rev-parse", "HEAD") });
  mkdirSync(join(lease.path, "outside"));
  git(lease.path, "mv", ".pi-subagents/tracked.txt", "outside/rogue.txt");

  const inspection = inspectExecutorWorkspace(lease);
  assert.equal(inspection.clean, false);
  assert.deepEqual(inspection.dirtyFiles.sort(), [".pi-subagents/tracked.txt", "outside/rogue.txt"]);
});

test("inspectExecutorWorkspace treats outside to runtime staged rename as dirty", () => {
  const origin = initRepo();
  mkdirSync(join(origin, "outside"), { recursive: true });
  writeFileSync(join(origin, "outside", "tracked.txt"), "outside\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "test: outside tracked");
  const lease = allocateExecutorWorkspace({ goalId: "outside-runtime", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit: git(origin, "rev-parse", "HEAD") });
  mkdirSync(join(lease.path, ".pi-subagents"));
  git(lease.path, "mv", "outside/tracked.txt", ".pi-subagents/rogue.txt");

  const inspection = inspectExecutorWorkspace(lease);
  assert.equal(inspection.clean, false);
  assert.deepEqual(inspection.dirtyFiles.sort(), [".pi-subagents/rogue.txt", "outside/tracked.txt"]);
});

test("inspectExecutorWorkspace exempts runtime-only staged changes but keeps ordinary staged and unstaged files dirty", () => {
  const origin = initRepo();
  mkdirSync(join(origin, ".pi-subagents"), { recursive: true });
  writeFileSync(join(origin, ".pi-subagents", "tracked.txt"), "runtime\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "test: runtime tracked");
  const lease = allocateExecutorWorkspace({ goalId: "status", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit: git(origin, "rev-parse", "HEAD") });
  writeFileSync(join(lease.path, ".pi-subagents", "tracked.txt"), "runtime changed\n");
  git(lease.path, "add", ".pi-subagents/tracked.txt");
  assert.equal(inspectExecutorWorkspace(lease).clean, true);
  writeFileSync(join(lease.path, "staged.txt"), "staged\n");
  git(lease.path, "add", "staged.txt");
  writeFileSync(join(lease.path, "unstaged.txt"), "unstaged\n");
  const inspection = inspectExecutorWorkspace(lease);
  assert.equal(inspection.clean, false);
  assert.ok(inspection.dirtyFiles.includes("staged.txt"));
  assert.ok(inspection.untrackedFiles.includes("unstaged.txt"));
});

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

test("renameLimit cannot hide a forbidden copy source from the writePaths gate", () => {
  const origin = initRepo();
  const stateRoot = tmpStateRoot();
  const protectedContent = "protected copy source\n".repeat(100);
  const firstDecoyContent = "first unrelated candidate\n".repeat(100);
  const secondDecoyContent = "second unrelated candidate\n".repeat(100);
  mkdirSync(join(origin, "forbidden"), { recursive: true });
  writeFileSync(join(origin, "forbidden/source.txt"), protectedContent);
  writeFileSync(join(origin, "forbidden/decoy-one.txt"), firstDecoyContent);
  writeFileSync(join(origin, "forbidden/decoy-two.txt"), secondDecoyContent);
  git(origin, "add", ".");
  git(origin, "commit", "-m", "test: add copy detection candidates");
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "rename-limit", taskId: "t1", attempt: 1, originRoot: origin, stateRoot, baseCommit });

  git(lease.path, "config", "diff.renameLimit", "1");
  mkdirSync(join(lease.path, "allowed"), { recursive: true });
  writeFileSync(join(lease.path, "allowed/copy.txt"), `${protectedContent}destination change\n`);
  writeFileSync(join(lease.path, "allowed/decoy-one.txt"), `${firstDecoyContent}destination change\n`);
  writeFileSync(join(lease.path, "allowed/decoy-two.txt"), `${secondDecoyContent}destination change\n`);
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "test: copy protected source");
  const headCommit = git(lease.path, "rev-parse", "HEAD");

  const vulnerableDiff = spawnSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", "--find-copies-harder", `${baseCommit}..${headCommit}`],
    { cwd: lease.path, encoding: "utf8" },
  );
  assert.equal(vulnerableDiff.status, 0);
  assert.match(vulnerableDiff.stderr, /renameLimit variable|too many files|exhaustive.*rename/i, "fixture must trigger Git renameLimit degradation");
  assert.deepEqual(vulnerableDiff.stdout.split("\0").filter(Boolean), [
    "A", "allowed/copy.txt",
    "A", "allowed/decoy-one.txt",
    "A", "allowed/decoy-two.txt",
  ]);

  const degradedInspection = {
    changedFiles: vulnerableDiff.stdout.split("\0").filter((token) => token && !/^[A-Z]\d*$/.test(token)),
  };
  assert.doesNotThrow(
    () => workspace.assertWorkspaceChangesWithinPaths(degradedInspection, ["allowed/**"]),
    "without an explicit limit override, the degraded diff incorrectly lets target-only access pass",
  );

  const inspection = inspectExecutorWorkspace(lease);
  assert.deepEqual(inspection.changedFiles, [
    "allowed/copy.txt",
    "allowed/decoy-one.txt",
    "allowed/decoy-two.txt",
    "forbidden/decoy-one.txt",
    "forbidden/decoy-two.txt",
    "forbidden/source.txt",
  ]);
  assert.throws(
    () => workspace.assertWorkspaceChangesWithinPaths(inspection, ["allowed/**"]),
    /forbidden\/source\.txt/,
    "the formerly passing target-only gate must fail closed",
  );
});

test("assertWorkspaceChangesWithinPaths rejects NUL-byte paths", () => {
  const inspection = { changedFiles: ["shared/\u0000path.txt"] };

  assert.throws(
    () => workspace.assertWorkspaceChangesWithinPaths(inspection, ["shared/\u0000path.txt"]),
    /./,
  );
});

test("integration rejects a different checked-out origin ref before side effects", () => {
  const origin = initRepo();
  git(origin, "branch", "other");
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "branch-fence", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  writeFileSync(join(lease.path, "feature.ts"), "export const value = 1;\n");
  git(lease.path, "add", ".");
  git(lease.path, "commit", "-m", "test: executor result");
  const mainBefore = git(origin, "rev-parse", "main");
  const otherBefore = git(origin, "rev-parse", "other");
  git(origin, "switch", "other");

  assert.throws(() => integrateExecutorWorkspace(lease, { strategy: "cherry-pick" }), /origin ref|branch|target/i);
  assert.equal(git(origin, "rev-parse", "main"), mainBefore);
  assert.equal(git(origin, "rev-parse", "other"), otherBefore);
  assert.equal(git(origin, "status", "--porcelain=v1"), "");
});

test("allocateExecutorWorkspace rejects detached origin", () => {
  const origin = initRepo();
  const baseCommit = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "--detach");
  assert.throws(() => allocateExecutorWorkspace({ goalId: "detached", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit }), /symbolic|detached|origin ref/i);
});

test("integration preserves user cherry-pick sequencer before side effects", () => {
  const origin = initRepo();
  writeFileSync(join(origin, "conflict.txt"), "base\n"); git(origin, "add", "."); git(origin, "commit", "-m", "test: base conflict");
  git(origin, "branch", "topic"); writeFileSync(join(origin, "conflict.txt"), "main\n"); git(origin, "commit", "-am", "test: main conflict");
  git(origin, "switch", "topic"); writeFileSync(join(origin, "conflict.txt"), "topic\n"); git(origin, "commit", "-am", "test: topic conflict");
  git(origin, "switch", "main"); assert.throws(() => git(origin, "cherry-pick", "topic"));
  const baseCommit = git(origin, "rev-parse", "HEAD");
  git(origin, "cherry-pick", "--abort");
  const lease = allocateExecutorWorkspace({ goalId: "user-cherry", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  writeFileSync(join(lease.path, "feature.ts"), "x\n"); git(lease.path, "add", "."); git(lease.path, "commit", "-m", "test: result");
  assert.throws(() => git(origin, "cherry-pick", "topic"));
  const before = { head: git(origin, "rev-parse", "HEAD"), ref: git(origin, "symbolic-ref", "--quiet", "HEAD"), status: git(origin, "status", "--porcelain=v1"), marker: git(origin, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD") };
  assert.throws(() => integrateExecutorWorkspace(lease, { strategy: "cherry-pick" }), /sequencer|clean|cherry/i);
  assert.deepEqual({ head: git(origin, "rev-parse", "HEAD"), ref: git(origin, "symbolic-ref", "--quiet", "HEAD"), status: git(origin, "status", "--porcelain=v1"), marker: git(origin, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD") }, before);
});

test("integration preserves range-external ancestor cherry-pick sequencer before side effects", () => {
  const origin = initRepo();
  writeFileSync(join(origin, "conflict.txt"), "executor ancestor\n"); git(origin, "add", "."); git(origin, "commit", "-m", "test: executor ancestor");
  const markedAncestor = git(origin, "rev-parse", "HEAD");
  writeFileSync(join(origin, "base.txt"), "lease base\n"); git(origin, "add", "."); git(origin, "commit", "-m", "test: lease base");
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "range-external-cherry", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  writeFileSync(join(lease.path, "feature.ts"), "x\n"); git(lease.path, "add", "."); git(lease.path, "commit", "-m", "test: result");
  const executorHead = git(lease.path, "rev-parse", "HEAD");
  writeFileSync(join(origin, "conflict.txt"), "user operation\n"); git(origin, "commit", "-am", "test: user conflict");
  const originHeadBefore = git(origin, "rev-parse", "HEAD");
  assert.throws(() => git(origin, "cherry-pick", markedAncestor));
  const before = { head: git(origin, "rev-parse", "HEAD"), ref: git(origin, "symbolic-ref", "--quiet", "HEAD"), status: git(origin, "status", "--porcelain=v1"), marker: git(origin, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD") };
  assert.throws(() => integrateExecutorWorkspace(lease, { strategy: "cherry-pick", executorHead, originHeadBefore }), /not provably owned|sequencer/i);
  assert.deepEqual({ head: git(origin, "rev-parse", "HEAD"), ref: git(origin, "symbolic-ref", "--quiet", "HEAD"), status: git(origin, "status", "--porcelain=v1"), marker: git(origin, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD") }, before);
  assert.ok(existsSync(lease.path));
  assert.ok(existsSync(lease.leasePath));
  assert.equal(git(origin, "merge-base", "--is-ancestor", markedAncestor, executorHead), "");
  assert.equal(git(origin, "rev-list", `${baseCommit}..${executorHead}`).includes(markedAncestor), false);
});

test("integration preserves user merge sequencer before side effects", () => {
  const origin = initRepo();
  writeFileSync(join(origin, "conflict.txt"), "base\n"); git(origin, "add", "."); git(origin, "commit", "-m", "test: base conflict");
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "user-merge", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  writeFileSync(join(lease.path, "feature.ts"), "x\n"); git(lease.path, "add", "."); git(lease.path, "commit", "-m", "test: result");
  git(origin, "branch", "topic"); writeFileSync(join(origin, "conflict.txt"), "main\n"); git(origin, "commit", "-am", "test: main conflict");
  git(origin, "switch", "topic"); writeFileSync(join(origin, "conflict.txt"), "topic\n"); git(origin, "commit", "-am", "test: topic conflict"); git(origin, "switch", "main");
  assert.throws(() => git(origin, "merge", "topic"));
  const before = { head: git(origin, "rev-parse", "HEAD"), ref: git(origin, "symbolic-ref", "--quiet", "HEAD"), status: git(origin, "status", "--porcelain=v1"), marker: git(origin, "rev-parse", "-q", "--verify", "MERGE_HEAD") };
  assert.throws(() => integrateExecutorWorkspace(lease, { strategy: "merge" }), /sequencer|clean|merge/i);
  assert.deepEqual({ head: git(origin, "rev-parse", "HEAD"), ref: git(origin, "symbolic-ref", "--quiet", "HEAD"), status: git(origin, "status", "--porcelain=v1"), marker: git(origin, "rev-parse", "-q", "--verify", "MERGE_HEAD") }, before);
});

test("Goal-owned cherry-pick sequencer recovers then atomically aborts a retry conflict", () => {
  const origin = initRepo();
  writeFileSync(join(origin, "conflict.txt"), "base\n"); git(origin, "add", "."); git(origin, "commit", "-m", "test: base conflict");
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "goal-cherry", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  writeFileSync(join(lease.path, "conflict.txt"), "executor\n"); git(lease.path, "commit", "-am", "test: executor conflict");
  const executorHead = git(lease.path, "rev-parse", "HEAD");
  writeFileSync(join(origin, "conflict.txt"), "origin\n"); git(origin, "commit", "-am", "test: origin conflict");
  const originHeadBefore = git(origin, "rev-parse", "HEAD");
  assert.throws(() => git(origin, "cherry-pick", `${baseCommit}..${executorHead}`));
  assert.throws(() => integrateExecutorWorkspace(lease, { strategy: "cherry-pick", executorHead, originHeadBefore }), /cherry|conflict/i);
  assert.equal(git(origin, "rev-parse", "HEAD"), originHeadBefore);
  assert.equal(git(origin, "status", "--porcelain=v1"), "");
  assert.throws(() => git(origin, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"));
});

test("Goal-owned merge sequencer recovers then atomically aborts a retry conflict", () => {
  const origin = initRepo();
  writeFileSync(join(origin, "conflict.txt"), "base\n"); git(origin, "add", "."); git(origin, "commit", "-m", "test: base conflict");
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "goal-merge", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  writeFileSync(join(lease.path, "conflict.txt"), "executor\n"); git(lease.path, "commit", "-am", "test: executor conflict");
  const executorHead = git(lease.path, "rev-parse", "HEAD");
  writeFileSync(join(origin, "conflict.txt"), "origin\n"); git(origin, "commit", "-am", "test: origin conflict");
  const originHeadBefore = git(origin, "rev-parse", "HEAD");
  assert.throws(() => git(origin, "merge", "--no-ff", executorHead));
  assert.throws(() => integrateExecutorWorkspace(lease, { strategy: "merge", executorHead, originHeadBefore }), /merge|conflict/i);
  assert.equal(git(origin, "rev-parse", "HEAD"), originHeadBefore);
  assert.equal(git(origin, "status", "--porcelain=v1"), "");
  assert.throws(() => git(origin, "rev-parse", "-q", "--verify", "MERGE_HEAD"));
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

test("integrateExecutorWorkspace atomically rewinds a partial cherry-pick when a post-commit hook kills Git", () => {
  const origin = initRepo();
  const baseCommit = git(origin, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId: "partial-hook", taskId: "t1", attempt: 1, originRoot: origin, stateRoot: tmpStateRoot(), baseCommit });
  writeFileSync(join(lease.path, "first.txt"), "first commit\n");
  git(lease.path, "add", "first.txt");
  git(lease.path, "commit", "-m", "feat: first executor commit");
  writeFileSync(join(lease.path, "second.txt"), "second commit\n");
  git(lease.path, "add", "second.txt");
  git(lease.path, "commit", "-m", "feat: second executor commit");

  const hook = join(origin, ".git", "hooks", "post-commit");
  writeFileSync(hook, "#!/bin/sh\nrm -f \"$0\"\nkill -TERM \"$PPID\"\n");
  chmodSync(hook, 0o755);

  assert.throws(() => integrateExecutorWorkspace(lease, { strategy: "cherry-pick" }), /./);
  assert.equal(git(origin, "symbolic-ref", "--quiet", "HEAD"), lease.originRef);
  assert.equal(git(origin, "rev-parse", "HEAD"), baseCommit);
  assert.equal(git(origin, "status", "--porcelain=v1"), "");
  assert.equal(existsSync(join(origin, "first.txt")), false);
  for (const marker of ["CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD"]) {
    assert.throws(() => git(origin, "rev-parse", "-q", "--verify", marker));
  }
  assert.equal(existsSync(join(origin, ".git", "rebase-merge")), false);
  assert.equal(existsSync(join(origin, ".git", "rebase-apply")), false);
  assert.equal(existsSync(join(origin, ".git", "sequencer")), false);
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

function orphanInventoryApi() {
  assert.equal(typeof workspace.inspectOrphanedExecutorWorkspace, "function", "inspectOrphanedExecutorWorkspace must be exported");
  return workspace.inspectOrphanedExecutorWorkspace;
}

function orphanArgs(goalId = "orphan", taskId = "t1", attempt = 1) {
  const originRoot = initRepo();
  const stateRoot = tmpStateRoot();
  const baseCommit = git(originRoot, "rev-parse", "HEAD");
  const lease = allocateExecutorWorkspace({ goalId, taskId, attempt, originRoot, stateRoot, baseCommit });
  return { goalId, taskId, attempt, originRoot, stateRoot, lease };
}

function assertOrphanUnverified(result) {
  assert.equal(result.kind, "unverified");
  assert.deepEqual(Object.keys(result.resources).sort(), ["branchExists", "leaseExists", "workspaceExists"]);
  assert.ok(result.observed || result.error, "unverified inventory must retain observed evidence or an error");
}

function canonicalPath(value) {
  try {
    return typeof value === "string" ? realpathSync(value) : value;
  } catch {
    return value;
  }
}

function assertOrphanVerified(result, lease) {
  assert.equal(result.kind, "verified");
  assert.equal(result.lease.goalId, lease.goalId);
  assert.equal(result.lease.taskId, lease.taskId);
  assert.equal(result.lease.attempt, lease.attempt);
  assert.equal(result.lease.baseCommit, lease.baseCommit);
  assert.equal(result.lease.originRef, lease.originRef);
  assert.equal(result.lease.branch, lease.branch);
  assert.equal(result.lease.ownerToken, lease.ownerToken);
  assert.equal(canonicalPath(result.lease.path), canonicalPath(lease.path));
  assert.equal(canonicalPath(result.lease.originRoot), canonicalPath(lease.originRoot));
  assert.equal(canonicalPath(result.lease.stateRoot), canonicalPath(lease.stateRoot));
  assert.equal(canonicalPath(result.lease.leasePath), canonicalPath(lease.leasePath));
  assert.equal(result.inspection.hasCommits, true);
  assert.equal(result.executorHead, git(lease.path, "rev-parse", "HEAD"));
}

test("orphan inventory resource bitmap covers 000 through 111", () => {
  orphanInventoryApi();
  for (const bitmap of ["000", "001", "010", "011", "100", "101", "110", "111"]) {
    const fixture = orphanArgs(`bitmap-${bitmap}`);
    if (bitmap === "111") {
      writeFileSync(join(fixture.lease.path, "child.txt"), "child\n");
      git(fixture.lease.path, "add", "child.txt");
      git(fixture.lease.path, "commit", "-m", "test: child");
    }
    const [workspaceExists, branchExists, leaseExists] = bitmap.split("").map(Number);
    if (!workspaceExists) git(fixture.originRoot, "worktree", "remove", "--force", fixture.lease.path);
    if (!branchExists) git(fixture.originRoot, "update-ref", "-d", `refs/heads/${fixture.lease.branch}`);
    if (!leaseExists) rmSync(fixture.lease.leasePath, { force: true });
    const result = orphanInventoryApi()({ ...fixture });
    assert.deepEqual(result.resources, { workspaceExists: Boolean(workspaceExists), branchExists: Boolean(branchExists), leaseExists: Boolean(leaseExists) });
    if (bitmap === "000") assert.equal(result.kind, "none");
    else if (bitmap === "111") assertOrphanVerified(result, fixture.lease);
    else assertOrphanUnverified(result);
  }
});

test("orphan inventory persisted lease envelope rejects malformed and canonical mismatches", () => {
  orphanInventoryApi();
  for (const field of ["malformed JSON", "goalId", "taskId", "attempt", "stateRoot", "path", "originRoot", "branch"]) {
    const fixture = orphanArgs(`envelope-${field.replace(/ /g, "-")}`);
    const other = orphanArgs(`envelope-other-${field.replace(/ /g, "-")}`);
    const value = field === "attempt" ? 2 : field === "branch" ? other.lease.branch : field === "goalId" ? other.goalId : field === "taskId" ? other.taskId : field === "path" ? other.lease.path : field === "originRoot" ? other.originRoot : other.stateRoot;
    writeFileSync(fixture.lease.leasePath, field === "malformed JSON" ? "{" : JSON.stringify({ ...fixture.lease, [field]: value }));
    assertOrphanUnverified(orphanInventoryApi()(fixture));
  }
});

test("orphan inventory commit-range identity distinguishes invalid and usable histories", () => {
  orphanInventoryApi();
  for (const scenario of ["missing base", "unrelated base", "no ahead", "empty descendant", "clean non-empty descendant"]) {
    const fixture = orphanArgs(`range-${scenario.replace(/ /g, "-")}`);
    const lease = { ...fixture.lease };
    if (scenario === "missing base") lease.baseCommit = "0000000000000000000000000000000000000000";
    if (scenario === "unrelated base") {
      const unrelatedBaseTree = git(fixture.originRoot, "rev-parse", "HEAD^{tree}");
      lease.baseCommit = git(fixture.originRoot, "commit-tree", unrelatedBaseTree, "-m", "test: unrelated base");
    }
    if (scenario === "empty descendant") git(lease.path, "commit", "--allow-empty", "-m", "test: empty");
    if (scenario === "clean non-empty descendant") { writeFileSync(join(lease.path, "child.txt"), "child\n"); git(lease.path, "add", "."); git(lease.path, "commit", "-m", "test: child"); }
    writeFileSync(lease.leasePath, JSON.stringify(lease));
    const result = orphanInventoryApi()(fixture);
    if (scenario === "clean non-empty descendant") assertOrphanVerified(result, lease);
    else assertOrphanUnverified(result);
  }
});

test("orphan inventory live Git identity returns unverified without throwing", () => {
  orphanInventoryApi();
  for (const scenario of ["origin ref", "live branch", "unreadable git metadata"]) {
    const fixture = orphanArgs(`live-${scenario.replace(/ /g, "-")}`);
    if (scenario === "origin ref") git(fixture.originRoot, "switch", "-c", "other-origin");
    if (scenario === "live branch") git(fixture.lease.path, "switch", "-c", "wrong-live-branch");
    if (scenario === "unreadable git metadata") chmodSync(join(fixture.lease.path, ".git"), 0o000);
    let result;
    assert.doesNotThrow(() => { result = orphanInventoryApi()(fixture); });
    if (scenario === "unreadable git metadata") chmodSync(join(fixture.lease.path, ".git"), 0o644);
    assertOrphanUnverified(result);
  }
});

test("orphan inventory canonical roots and paths accept aliases but reject other real locations", () => {
  orphanInventoryApi();
  const fixture = orphanArgs("canonical");
  writeFileSync(join(fixture.lease.path, "child.txt"), "child\n"); git(fixture.lease.path, "add", "."); git(fixture.lease.path, "commit", "-m", "test: child");
  const originAlias = `${fixture.originRoot}-alias`; const stateAlias = `${fixture.stateRoot}-alias`;
  symlinkSync(fixture.originRoot, originAlias); symlinkSync(fixture.stateRoot, stateAlias);
  assertOrphanVerified(orphanInventoryApi()({ ...fixture, originRoot: originAlias, stateRoot: stateAlias }), fixture.lease);
  for (const field of ["path", "originRoot", "stateRoot"]) {
    const other = orphanArgs(`canonical-other-${field}`);
    const lease = { ...fixture.lease, [field]: field === "path" ? other.lease.path : other[field] };
    writeFileSync(fixture.lease.leasePath, JSON.stringify(lease));
    assertOrphanUnverified(orphanInventoryApi()(fixture));
    writeFileSync(fixture.lease.leasePath, JSON.stringify(fixture.lease));
  }
});

test("orphan inventory exact-attempt no-scan ignores complete attempt two", () => {
  orphanInventoryApi();
  const fixture = orphanArgs("no-scan", "t1", 2);
  const result = orphanInventoryApi()({ ...fixture, attempt: 1 });
  assert.equal(result.kind, "none");
  assert.deepEqual(result.resources, { workspaceExists: false, branchExists: false, leaseExists: false });
});

test("orphan inventory invalid arguments throw validation errors but runtime failures are unverified", () => {
  orphanInventoryApi();
  const fixture = orphanArgs("invalid");
  for (const args of [{ ...fixture, goalId: "../unsafe" }, { ...fixture, taskId: "bad/name" }, { ...fixture, attempt: 0 }, { ...fixture, originRoot: undefined }, { ...fixture, stateRoot: undefined }]) assert.throws(() => orphanInventoryApi()(args), /invalid|required|attempt/i);
  assertOrphanUnverified(orphanInventoryApi()({ ...fixture, originRoot: join(fixture.originRoot, "not-a-repo") }));
});
