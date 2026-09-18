import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import * as workspaceContract from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";

const {
  createManagedWorkspaceRequestV2,
  deterministicGoalWorkspaceId,
} = workspaceContract;

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

function requestV2(overrides = {}) {
  return {
    workspaceId: "workspace-v2-1",
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1" },
    originRoot: "/repo",
    requestedCwd: "/repo/packages/app",
    originRef: "refs/heads/main",
    baseCommit: sha64("b"),
    contractHash: sha64("a"),
    policy: { publication: "allowed", application: "allowed", writePaths: ["packages/app/**"] },
    ...overrides,
  };
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("the v1 codec surface is fully removed", () => {
  assert.equal(typeof workspaceContract.createManagedWorkspaceRequest, "undefined", "v1 request codec must not exist");
  assert.equal(typeof workspaceContract.validateManagedWorkspaceReceipt, "undefined", "v1 receipt codec must not exist");
  assert.equal(typeof workspaceContract.publicManagedWorkspaceReceipt, "undefined", "v1 receipt codec must not exist");
  assert.throws(() => createManagedWorkspaceRequestV2(requestV2({ mode: "coding" })), /unknown field mode|policy/i);
  assert.throws(() => createManagedWorkspaceRequestV2(requestV2({ writePaths: ["packages/app/**"] })), /unknown field writePaths|missing required field policy|policy/i);
});

test("managed workspace requests accept each exact owner variant and freeze the result", () => {
  const variants = [
    requestV2(),
    requestV2({
      workspaceId: "goal-1",
      owner: goalOwner(),
      policy: { publication: "allowed", application: "forbidden", writePaths: ["packages/app/**"] },
    }),
    requestV2({
      workspaceId: "validation-1",
      owner: { kind: "goal-validation", rootSessionId: "root-1", goalId: "goal-1", validationId: "validation-1", executionRevision: 2 },
      policy: { publication: "forbidden", application: "forbidden", writePaths: [] },
    }),
  ];

  for (const input of variants) {
    const actual = createManagedWorkspaceRequestV2(input);
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
    assert.throws(() => createManagedWorkspaceRequestV2(requestV2({ owner })), /owner/i);
  }
});

test("managed workspace requests fail closed on fields, paths, refs, and hashes", () => {
  const invalid = [
    { ...requestV2(), unexpected: true },
    requestV2({ originRoot: "repo" }),
    requestV2({ requestedCwd: "/outside" }),
    requestV2({ originRef: "main" }),
    requestV2({ baseCommit: "short" }),
    requestV2({ contractHash: sha40("a") }),
  ];

  for (const value of invalid) {
    assert.throws(() => createManagedWorkspaceRequestV2(value));
  }
});

test("workspace policy is independent from owner and rejects invalid capability combinations", () => {
  const valid = [
    { publication: "forbidden", application: "forbidden", writePaths: [] },
    { publication: "allowed", application: "forbidden", writePaths: [] },
    { publication: "allowed", application: "forbidden", writePaths: ["packages/app/**"] },
    { publication: "allowed", application: "allowed", writePaths: ["packages/app/**"] },
  ];
  for (const policy of valid) {
    assert.equal(typeof createManagedWorkspaceRequestV2, "function");
    const actual = createManagedWorkspaceRequestV2(requestV2({ policy }));
    assert.deepEqual(actual.policy, policy);
    assert.equal(Object.hasOwn(actual, "mode"), false);
    assertDeepFrozen(actual);
  }

  const invalid = [
    { publication: "forbidden", application: "allowed", writePaths: [] },
    { publication: "forbidden", application: "allowed", writePaths: ["packages/app/**"] },
    { publication: "allowed", application: "allowed", writePaths: [] },
    { publication: "allowed", application: "forbidden", writePaths: ["../outside"] },
  ];
  for (const policy of invalid) assert.throws(() => createManagedWorkspaceRequestV2(requestV2({ policy })), /policy|writePaths|unknown/i);
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
