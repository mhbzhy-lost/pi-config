import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createManagedWorkspaceRequest,
  deterministicGoalWorkspaceId,
  publicManagedWorkspaceReceipt,
  validateManagedWorkspaceReceipt,
} from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";

const sha40 = (character) => character.repeat(40);
const sha64 = (character) => character.repeat(64);

function goalOwner(overrides = {}) {
  return {
    kind: "goal-task",
    rootSessionId: "root-1",
    goalId: "goal-1",
    taskId: "task-1",
    attempt: 1,
    executionRevision: 2,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    workspaceId: "goal-workspace-1",
    owner: goalOwner(),
    originRoot: "/repo",
    requestedCwd: "/repo/packages/app",
    originRef: "refs/heads/main",
    baseCommit: sha40("b"),
    contractHash: sha64("a"),
    mode: "coding",
    writePaths: ["packages/app/**"],
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    schemaVersion: "managed-workspace.v1",
    workspaceId: "goal-workspace-1",
    leaseId: sha64("c"),
    owner: goalOwner(),
    originRoot: "/repo",
    requestedCwd: "/repo/packages/app",
    originRef: "refs/heads/main",
    baseCommit: sha40("b"),
    path: "/state/repositories/repo/worktrees/goal-workspace-1",
    dispatchCwd: "/state/repositories/repo/worktrees/goal-workspace-1/packages/app",
    branchRef: "refs/heads/pi-managed/goal-workspace-1",
    state: "active",
    run: null,
    disposition: null,
    cleanupDebt: null,
    ...overrides,
  };
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("managed workspace requests accept each exact owner variant and freeze the result", () => {
  const variants = [
    request(),
    request({
      workspaceId: "standalone-1",
      owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1" },
    }),
    request({
      workspaceId: "validation-1",
      owner: { kind: "goal-validation", rootSessionId: "root-1", goalId: "goal-1", validationId: "validation-1", executionRevision: 2 },
      mode: "validation",
      writePaths: [],
    }),
  ];

  for (const input of variants) {
    const actual = createManagedWorkspaceRequest(input);
    assert.deepEqual(actual, input);
    assert.notStrictEqual(actual, input);
    assertDeepFrozen(actual);
  }
});

test("managed workspace requests reject incomplete, mixed, and unknown owner fields", () => {
  const invalidOwners = [
    { kind: "goal-task", taskId: "task-1" },
    { ...goalOwner(), toolCallId: "tool-1" },
    { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1", goalId: "goal-1" },
    { kind: "goal-validation", rootSessionId: "root-1", goalId: "goal-1", validationId: "validation-1", executionRevision: 2, taskId: "task-1" },
    { kind: "unknown", rootSessionId: "root-1" },
  ];

  for (const owner of invalidOwners) {
    assert.throws(() => createManagedWorkspaceRequest(request({ owner })), /owner/i);
  }
});

test("managed workspace requests fail closed on fields, paths, refs, hashes, and mode invariants", () => {
  const invalid = [
    { ...request(), unexpected: true },
    request({ originRoot: "repo" }),
    request({ requestedCwd: "/outside" }),
    request({ originRef: "main" }),
    request({ baseCommit: "short" }),
    request({ contractHash: sha40("a") }),
    request({ mode: "generic", owner: goalOwner() }),
    request({ mode: "coding", writePaths: [] }),
    request({ mode: "validation", writePaths: ["src/**"], owner: { kind: "goal-validation", rootSessionId: "root-1", goalId: "goal-1", validationId: "validation-1", executionRevision: 2 } }),
  ];

  for (const value of invalid) {
    assert.throws(() => createManagedWorkspaceRequest(value));
  }
});

test("managed workspace receipts validate exact public fields and nested run data", () => {
  const input = receipt({ run: { runId: "run-1", asyncDir: "/async/run-1" } });
  const actual = validateManagedWorkspaceReceipt(input);
  assert.deepEqual(actual, input);
  assert.notStrictEqual(actual, input);
  assertDeepFrozen(actual);

  for (const invalid of [
    { ...input, extra: true },
    { ...input, ownerToken: `managed-workspace-owner.v1:${sha64("d")}` },
    receipt({ schemaVersion: "managed-workspace.v2" }),
    receipt({ leaseId: "lease-secret" }),
    receipt({ path: "relative/worktree" }),
    receipt({ dispatchCwd: "/outside/worktree" }),
    receipt({ branchRef: "pi-managed/workspace" }),
    receipt({ state: "unknown" }),
    receipt({ run: { runId: "run-1", asyncDir: "/async/run-1", pid: 10 } }),
    receipt({ cleanupDebt: { phase: "git-add", code: "EIO" } }),
  ]) assert.throws(() => validateManagedWorkspaceReceipt(invalid));
});

test("public workspace receipts strip the validated owner secret and bind its digest", () => {
  const ownerToken = `managed-workspace-owner.v1:${sha64("d")}`;
  const leaseId = createHash("sha256").update(ownerToken).digest("hex");
  const result = publicManagedWorkspaceReceipt({ ...receipt({ leaseId }), ownerToken });

  assert.deepEqual(result, receipt({ leaseId }));
  assert.equal(Object.hasOwn(result, "ownerToken"), false);
  assert.throws(
    () => publicManagedWorkspaceReceipt({ ...receipt(), ownerToken }),
    /lease/i,
  );
  assert.throws(
    () => publicManagedWorkspaceReceipt({ ...receipt({ leaseId }), ownerToken, actionToken: "private" }),
    /field|unknown/i,
  );
});

test("cleanup debt and disposition are strict discriminated receipt values", () => {
  const disposing = validateManagedWorkspaceReceipt(receipt({
    state: "disposing",
    disposition: { action: "integrate", strategy: "cherry-pick" },
  }));
  assert.equal(disposing.disposition.action, "integrate");

  const debt = validateManagedWorkspaceReceipt(receipt({
    state: "cleanup-debt",
    cleanupDebt: { phase: "worktree-remove", code: "EIO", message: "release incomplete" },
  }));
  assert.equal(debt.cleanupDebt.code, "EIO");

  for (const invalid of [
    receipt({ disposition: { action: "discard", strategy: "merge" } }),
    receipt({ disposition: { action: "preserve", reason: "keep", extra: true } }),
    receipt({ state: "cleanup-debt", cleanupDebt: null }),
    receipt({ state: "active", cleanupDebt: { phase: "git", code: "EIO", message: "failed" } }),
  ]) assert.throws(() => validateManagedWorkspaceReceipt(invalid));
});

test("deterministic Goal workspace ids are stable and sensitive to every execution fact", () => {
  const facts = {
    goalId: "goal-1",
    taskId: "task-1",
    attempt: 1,
    executionRevision: 2,
    contractHash: sha64("a"),
    baseCommit: sha40("b"),
  };
  const expected = "goal-3bf418189020631cc85d9474b8bf26e3251876fb39c3c7e4ae07e9b8be88f9e5";

  assert.equal(deterministicGoalWorkspaceId(facts), expected);
  assert.equal(deterministicGoalWorkspaceId({ ...facts }), expected);
  for (const changed of [
    { attempt: 2 },
    { executionRevision: 3 },
    { contractHash: sha64("c") },
    { baseCommit: sha40("d") },
  ]) assert.notEqual(deterministicGoalWorkspaceId({ ...facts, ...changed }), expected);

  assert.throws(() => deterministicGoalWorkspaceId({ ...facts, extra: true }));
});
