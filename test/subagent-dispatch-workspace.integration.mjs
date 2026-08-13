import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";
import { createSubagentWorkspace, discardSubagentWorkspace, integrateSubagentWorkspace, preserveSubagentWorkspace, releasePreservedSubagentWorkspace, snapshotSubagentWorkspace } from "../scripts/lib/subagent-dispatch/workspace.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const arena = createTemporaryArenaSync("subagent-workspace-");
test.after(() => arena.disposeSync());

function repo() {
  const root = arena.mkdtempSync("repo-");
  git(root, "init");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "user.name", "Test");
  mkdirSync(join(root, "packages", "child"), { recursive: true });
  writeFileSync(join(root, "packages", "child", "input.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  return root;
}

// Break caught: allocating outside managed lifecycle, or mapping child cwd from
// the origin rather than the managed workspace, loses isolation.
test("createSubagentWorkspace creates an owner-CAS worktree and maps requested child cwd", () => {
  const originRoot = repo();
  const baseCommit = git(originRoot, "rev-parse", "HEAD");
  const handle = createSubagentWorkspace({
    workspaceId: "ws-create-1",
    kind: "coding",
    originRoot,
    originRef: git(originRoot, "symbolic-ref", "--quiet", "HEAD"),
    originHeadAtAllocation: baseCommit,
    baseCommit,
    requestedCwd: join(originRoot, "packages", "child"),
    branch: "subagent/ws-create-1",
    writePaths: ["packages/child/**"],
  });

  assert.equal(handle.owner.kind, "typed-subagent-workspace");
  assert.equal(handle.owner.id, "ws-create-1");
  assert.equal(handle.dispatchCwd, join(handle.path, "packages", "child"));
  assert.ok(existsSync(handle.dispatchCwd));
  assert.equal(git(handle.path, "symbolic-ref", "--quiet", "HEAD"), "refs/heads/subagent/ws-create-1");
});

test("coding workspace integrates a clean committed write inside writePaths", () => {
  const originRoot = repo();
  const baseCommit = git(originRoot, "rev-parse", "HEAD");
  const lease = createSubagentWorkspace({ workspaceId: "ws-integrate-1", kind: "coding", originRoot,
    originRef: git(originRoot, "symbolic-ref", "--quiet", "HEAD"), originHeadAtAllocation: baseCommit, baseCommit,
    requestedCwd: join(originRoot, "packages", "child"), branch: "subagent/ws-integrate-1", writePaths: ["packages/child/**"] });
  writeFileSync(join(lease.path, "packages", "child", "result.txt"), "done\n");
  git(lease.path, "add", "."); git(lease.path, "commit", "-m", "child result");
  const snapshot = snapshotSubagentWorkspace({ lease, terminalProof: { state: "observed", conflict: false, proofHash: "proof-1" } });
  const result = integrateSubagentWorkspace({ lease, snapshot });
  assert.equal(result.integrated, true);
  assert.equal(git(originRoot, "show", "HEAD:packages/child/result.txt"), "done");
});

test("discard releases only an observed clean workspace and keeps its branch", () => {
  const originRoot = repo(); const baseCommit = git(originRoot, "rev-parse", "HEAD");
  const lease = createSubagentWorkspace({ workspaceId: "ws-discard-1", kind: "generic", originRoot,
    originRef: git(originRoot, "symbolic-ref", "--quiet", "HEAD"), originHeadAtAllocation: baseCommit, baseCommit,
    requestedCwd: originRoot, branch: "subagent/ws-discard-1", writePaths: null });
  const snapshot = snapshotSubagentWorkspace({ lease, terminalProof: { state: "observed", conflict: false, proofHash: "proof-2" } });
  assert.equal(discardSubagentWorkspace({ lease, snapshot }).released, true);
  assert.ok(!existsSync(lease.path));
  assert.equal(git(originRoot, "show-ref", "--verify", "--quiet", lease.branchRef), "");
});

test("generic workspaces cannot integrate and preserve retains dirty resources", () => {
  const originRoot = repo(); const baseCommit = git(originRoot, "rev-parse", "HEAD");
  const lease = createSubagentWorkspace({ workspaceId: "ws-preserve-1", kind: "generic", originRoot,
    originRef: git(originRoot, "symbolic-ref", "--quiet", "HEAD"), originHeadAtAllocation: baseCommit, baseCommit,
    requestedCwd: originRoot, branch: "subagent/ws-preserve-1", writePaths: null });
  writeFileSync(join(lease.path, "dirty.txt"), "keep\n");
  const snapshot = snapshotSubagentWorkspace({ lease, terminalProof: { state: "observed", conflict: false, proofHash: "proof-3" } });
  assert.throws(() => integrateSubagentWorkspace({ lease, snapshot }), (error) => error?.code === "WORKTREE_INTEGRATE_FORBIDDEN");
  assert.deepEqual(preserveSubagentWorkspace({ lease, snapshot }), { preserved: true, released: false });
  assert.ok(existsSync(lease.path));
});

// Regression: pending/unknown terminal state is not authority for destructive actions,
// but retaining the managed resource must remain possible for later recovery.
test("pending terminal proof can snapshot and preserve but cannot discard or integrate", () => {
  const originRoot = repo(); const baseCommit = git(originRoot, "rev-parse", "HEAD");
  const lease = createSubagentWorkspace({ workspaceId: "ws-pending-1", kind: "coding", originRoot,
    originRef: git(originRoot, "symbolic-ref", "--quiet", "HEAD"), originHeadAtAllocation: baseCommit, baseCommit,
    requestedCwd: originRoot, branch: "subagent/ws-pending-1", writePaths: ["input.txt"] });
  const snapshot = snapshotSubagentWorkspace({ lease, terminalProof: { state: "pending", conflict: false } });
  assert.deepEqual(preserveSubagentWorkspace({ lease, snapshot }), { preserved: true, released: false });
  assert.throws(() => discardSubagentWorkspace({ lease, snapshot }), (error) => error?.code === "WORKTREE_TERMINAL_UNOBSERVED");
  assert.throws(() => integrateSubagentWorkspace({ lease, snapshot }), (error) => error?.code === "WORKTREE_TERMINAL_UNOBSERVED");
});

test("rename source outside writePaths cannot enter origin", () => {
  const originRoot = repo(); const baseCommit = git(originRoot, "rev-parse", "HEAD");
  writeFileSync(join(originRoot, "outside.txt"), "outside\n"); git(originRoot, "add", "."); git(originRoot, "commit", "-m", "outside base");
  const allocationHead = git(originRoot, "rev-parse", "HEAD");
  const lease = createSubagentWorkspace({ workspaceId: "ws-rename-1", kind: "coding", originRoot,
    originRef: git(originRoot, "symbolic-ref", "--quiet", "HEAD"), originHeadAtAllocation: allocationHead, baseCommit: allocationHead,
    requestedCwd: originRoot, branch: "subagent/ws-rename-1", writePaths: ["packages/child/**"] });
  git(lease.path, "mv", "outside.txt", "packages/child/outside.txt"); git(lease.path, "commit", "-m", "move outside");
  const snapshot = snapshotSubagentWorkspace({ lease, terminalProof: { state: "observed", conflict: false, proofHash: "proof-rename" } });
  assert.throws(() => integrateSubagentWorkspace({ lease, snapshot }), /writePaths mismatch/);
  assert.equal(git(originRoot, "show", "HEAD:outside.txt"), "outside");
  assert.ok(!git(originRoot, "ls-tree", "--name-only", "HEAD", "packages/child/outside.txt").includes("outside.txt"));
});

test("createSubagentWorkspace refuses a dirty source except declared runtime state", () => {
  const originRoot = repo();
  writeFileSync(join(originRoot, "ordinary.txt"), "dirty\n");
  const baseCommit = git(originRoot, "rev-parse", "HEAD");
  assert.throws(() => createSubagentWorkspace({
    workspaceId: "ws-dirty-1", kind: "coding", originRoot, originRef: git(originRoot, "symbolic-ref", "--quiet", "HEAD"),
    originHeadAtAllocation: baseCommit, baseCommit, requestedCwd: originRoot,
    branch: "subagent/ws-dirty-1", writePaths: ["input.txt"],
  }), (error) => error?.code === "WORKTREE_SOURCE_DIRTY");
});

test("integration tolerates a clean forward origin advance", () => {
  const originRoot = repo(); const baseCommit = git(originRoot, "rev-parse", "HEAD");
  const lease = createSubagentWorkspace({ workspaceId: "ws-forward-1", kind: "coding", originRoot,
    originRef: git(originRoot, "symbolic-ref", "--quiet", "HEAD"), originHeadAtAllocation: baseCommit, baseCommit,
    requestedCwd: originRoot, branch: "subagent/ws-forward-1", writePaths: ["packages/child/**"] });
  writeFileSync(join(lease.path, "packages", "child", "result.txt"), "done\n"); git(lease.path, "add", "."); git(lease.path, "commit", "-m", "child result");
  writeFileSync(join(originRoot, "README.md"), "advance\n"); git(originRoot, "add", "README.md"); git(originRoot, "commit", "-m", "advance origin");
  const snapshot = snapshotSubagentWorkspace({ lease, terminalProof: { state: "observed", conflict: false, proofHash: "proof-forward" } });
  assert.equal(integrateSubagentWorkspace({ lease, snapshot }).integrated, true);
  assert.equal(git(originRoot, "show", "HEAD:packages/child/result.txt"), "done");
});

test("releasePreservedSubagentWorkspace releases a preserved worktree", () => {
  const originRoot = repo(); const baseCommit = git(originRoot, "rev-parse", "HEAD");
  const lease = createSubagentWorkspace({ workspaceId: "ws-release-1", kind: "generic", originRoot,
    originRef: git(originRoot, "symbolic-ref", "--quiet", "HEAD"), originHeadAtAllocation: baseCommit, baseCommit,
    requestedCwd: originRoot, branch: "subagent/ws-release-1", writePaths: null });
  const snapshot = snapshotSubagentWorkspace({ lease, terminalProof: { state: "pending", conflict: false } });
  preserveSubagentWorkspace({ lease, snapshot });
  releasePreservedSubagentWorkspace({ lease });
  assert.equal(existsSync(lease.path), false);
});
