import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequest } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { inventoryManagedWorkspaces } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { createGoalManagedWorkspaceInspector, goalWorkspaceTerminalProof, sameManagedWorkspaceSnapshot } from "../src/goal-engine/managed-workspace.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixture() {
  const originRoot = mkdtempSync(join(tmpdir(), "goal-managed-workspace-origin-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "goal-managed-workspace-state-"));
  git(originRoot, "init", "--initial-branch=main");
  git(originRoot, "config", "user.email", "test@example.invalid");
  git(originRoot, "config", "user.name", "Goal Engine Test");
  writeFileSync(join(originRoot, "README.md"), "fixture\n");
  git(originRoot, "add", "README.md");
  git(originRoot, "commit", "-m", "test: initialize workspace fixture");
  return { originRoot, stateRoot, baseCommit: git(originRoot, "rev-parse", "HEAD") };
}

test("managed workspace orphan inspector maps the verified goal-task owner attempt to its lease", () => {
  const f = fixture();
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const goalId = "goal-1";
  const taskId = "task-1";
  const attempt = 1;
  const receipt = service.ensureAllocated(createManagedWorkspaceRequest({
    workspaceId: "goal-1-task-1-attempt-1",
    owner: { kind: "goal-task", rootSessionId: "root-1", goalId, taskId, attempt, executionRevision: 1 },
    originRoot: f.originRoot,
    requestedCwd: f.originRoot,
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: "a".repeat(64),
    mode: "coding",
    writePaths: ["src/result.ts"],
  }));
  const branchRef = receipt.branchRef;
  const snapshot = service.status({ workspaceId: receipt.workspaceId });
  const inventory = inventoryManagedWorkspaces({ stateRoot: f.stateRoot });
  assert.equal(inventory.workspaces.length, 1);
  assert.deepEqual(inventory.workspaces[0].receipt.owner, receipt.owner);
  assert.equal(inventory.workspaces[0].identity, true);

  const inspected = createGoalManagedWorkspaceInspector({ workspaceService: service })({
    goalId, taskId, attempt, originRoot: f.originRoot,
    expectedWorkspaceId: receipt.workspaceId, expectedExecutionRevision: 1, expectedRootSessionId: "root-1",
  });

  assert.equal(inspected.kind, "verified");
  assert.equal(inspected.lease.attempt, attempt);
  assert.equal(inspected.lease.branch, branchRef);
  assert.deepEqual(inspected.lease.owner, receipt.owner);
  assert.equal(inspected.lease.workspaceId, receipt.workspaceId);
  assert.equal(inspected.lease.leaseId, receipt.leaseId);
  assert.deepEqual(inspected.resources, { workspaceExists: true, branchExists: true, leaseExists: true });
  assert.equal(inspected.executorHead, snapshot.inspection.headCommit);
  assert.equal(Object.hasOwn(receipt, "phase"), false, "RED provenance: real public receipt has no legacy phase");
  assert.equal(Object.hasOwn(receipt, "released"), false, "RED provenance: real public receipt has no legacy released flag");
  assert.equal(typeof receipt.disposition, "object", "RED provenance: public disposition is never a legacy string");
});

test("Goal terminal adapter derives the exact service proof solely from the settled official proof", () => {
  const official = Object.freeze({
    runId: "run-1", proofId: "f".repeat(64), rootSessionId: "root-1", observedAt: 1_700_000_000_000, outcome: "succeeded",
  });
  assert.deepEqual(goalWorkspaceTerminalProof(official), { state: "observed", conflict: false, proofHash: official.proofId });
  assert.deepEqual(goalWorkspaceTerminalProof(null), { state: "pending" });
  assert.deepEqual(goalWorkspaceTerminalProof({ ...official, outcome: "failed" }), { state: "observed", conflict: false, proofHash: official.proofId }, "a verified failed task remains discardable; outcome is not proof conflict");
  assert.throws(() => goalWorkspaceTerminalProof({ ...official, status: "complete" }), /official executor proof/i);
});

test("an official observed Goal proof reaches dirty-origin preflight after terminal eligibility", () => {
  const f = fixture(), service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const receipt = service.ensureAllocated(createManagedWorkspaceRequest({
    workspaceId: "goal-dirty-origin-task-attempt-1",
    owner: { kind: "goal-task", rootSessionId: "root-1", goalId: "goal-dirty-origin", taskId: "task", attempt: 1, executionRevision: 1 },
    originRoot: f.originRoot, requestedCwd: f.originRoot, originRef: "refs/heads/main", baseCommit: f.baseCommit,
    contractHash: "a".repeat(64), mode: "coding", writePaths: ["src/result.ts"],
  }));
  service.bindRun({ workspaceId: receipt.workspaceId, run: { runId: "run-1", asyncDir: "/tmp/run-1" } });
  const workspace = receipt.path;
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "result.ts"), "export const done = true;\n", { flag: "w" });
  git(workspace, "add", "src/result.ts");
  git(workspace, "commit", "-m", "test: executor result");
  writeFileSync(join(f.originRoot, "README.md"), "dirty origin\n");

  const status = service.status({ workspaceId: receipt.workspaceId, terminalProof: goalWorkspaceTerminalProof({
    runId: "run-1", proofId: "f".repeat(64), rootSessionId: "root-1", observedAt: 1_700_000_000_000, outcome: "succeeded",
  }) });
  assert.deepEqual(status.terminalProof, { state: "observed", conflict: false, proofHash: "f".repeat(64) });
  assert.ok(status.blockedReasons.includes("origin-dirty"));
  assert.deepEqual(status.allowedDispositions, ["preserve", "discard"]);
  const failedTaskStatus = service.status({ workspaceId: receipt.workspaceId, terminalProof: goalWorkspaceTerminalProof({
    runId: "run-1", proofId: "e".repeat(64), rootSessionId: "root-1", observedAt: 1_700_000_000_000, outcome: "failed",
  }) });
  assert.deepEqual(failedTaskStatus.allowedDispositions, ["preserve", "discard"], "verified failed/blocked settlement remains discardable");
});

test("canonical orphan inspection rejects a same-id snapshot whose public receipt changed", () => {
  const f = fixture(), service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const receipt = service.ensureAllocated(createManagedWorkspaceRequest({
    workspaceId: "goal-snapshot-task-attempt-1",
    owner: { kind: "goal-task", rootSessionId: "root-1", goalId: "goal-snapshot", taskId: "task", attempt: 1, executionRevision: 1 },
    originRoot: f.originRoot, requestedCwd: f.originRoot, originRef: "refs/heads/main", baseCommit: f.baseCommit,
    contractHash: "a".repeat(64), mode: "coding", writePaths: ["src/result.ts"],
  }));
  const actual = service.status({ workspaceId: receipt.workspaceId });
  assert.equal(sameManagedWorkspaceSnapshot(receipt, actual.receipt), true);
  const mismatchedService = { ...service, status: () => ({ ...actual, receipt: { ...actual.receipt, leaseId: "b".repeat(64) } }) };
  const inspected = createGoalManagedWorkspaceInspector({ workspaceService: mismatchedService })({
    goalId: "goal-snapshot", taskId: "task", attempt: 1, originRoot: f.originRoot,
    expectedWorkspaceId: receipt.workspaceId, expectedExecutionRevision: 1, expectedRootSessionId: "root-1",
  });
  assert.equal(inspected.kind, "unverified");
  assert.match(inspected.observed, /facts changed/);
});
