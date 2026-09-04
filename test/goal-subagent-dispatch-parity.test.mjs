import assert from "node:assert/strict";
import test from "node:test";

import { compileCodingDispatchIR, splitDispatchEnvelope } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";
import { bindGoalExecutorCoordinator } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import { compileTaskContract } from "../src/goal-engine/dispatch.ts";

function criteriaOnlyContract(overrides = {}) {
  return {
    version: "dispatch-ir.v1",
    taskId: "goal-parity.task-one",
    title: "Compile an exact Goal executor contract",
    agent: "executor",
    risk: "normal",
    objective: "Keep Goal and typed executor contracts byte-for-byte equivalent.",
    workflow: { mode: "tdd" },
    requirements: ["Compile the bounded task without changing its acceptance transport."],
    context: {
      knownFacts: ["Goal tasks have already been bounded by the planner."],
      decisions: ["Acceptance transport is criteria-only."],
      relevantFiles: ["packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts"],
    },
    boundaries: {
      writePaths: ["packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts"],
      excludedWork: ["Do not add model routing fields to the coding contract."],
      forbiddenActions: ["Do not alter typed runtime behavior."],
    },
    acceptance: { criteria: ["Goal and typed hashes agree."] },
    execution: { cwd: "/repo", timeoutMs: 1_800_000 },
    ...overrides,
  };
}

function goalProjection() {
  return {
    goalId: "goal-parity",
    objective: "Keep Goal and typed executor contracts byte-for-byte equivalent.",
    scope: ["packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts"],
    nonGoals: ["Do not add model routing fields to the coding contract."],
    dod: ["Goal output recompiles through the canonical codec."],
    tasks: new Map([["task-one", {
      status: "pending",
      description: "Compile an exact Goal executor contract.",
      workflow: "tdd",
      deps: [],
      writePaths: ["packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts"],
      acceptance: { criteria: ["Goal and canonical hashes agree."] },
    }]]),
  };
}

test("real Goal task output recompiles through the canonical package codec", () => {
  const goal = compileTaskContract(goalProjection(), "task-one", "/repo");
  const { contract, contractHash } = splitDispatchEnvelope(goal);
  const canonical = compileCodingDispatchIR(contract, { cwd: "/repo" });

  assert.deepEqual(canonical, goal);
  assert.equal(canonical.hash, contractHash);
  assert.equal(canonical.execution.worktree, true);
  assert.equal(Object.hasOwn(canonical.acceptance, "commands"), false);
});

test("canonical dispatch hashes retain the worktree request but exclude runtime allocation facts", () => {
  const source = criteriaOnlyContract({ execution: { cwd: "/repo", timeoutMs: 1_800_000, worktree: true } });
  const canonical = compileCodingDispatchIR(source, { cwd: "/repo" });

  assert.equal(canonical.execution.worktree, true);
  assert.equal(Object.hasOwn(canonical.execution, "dispatchCwd"), false);
  assert.equal(Object.hasOwn(canonical, "leaseId"), false);
  assert.throws(
    () => compileCodingDispatchIR({ ...source, leaseId: "private" }, { cwd: "/repo" }),
    /unknown field/i,
  );
  assert.throws(
    () => compileCodingDispatchIR({ ...source, execution: { ...source.execution, dispatchCwd: "/runtime" } }, { cwd: "/repo" }),
    /unknown field/i,
  );
});

test("Goal coordinator registry rejects legacy two-stage coordinators", () => {
  const legacy = { prepareSpawn() {}, bindSpawn() {} };
  assert.throws(() => bindGoalExecutorCoordinator({}, legacy), /coordinator/i);
});

test("Goal coordinator registry requires every four-stage workspace callback", () => {
  const coordinator = {
    prepareSpawn() {},
    workspaceAllocated() {},
    confirmSpawn() {},
    bindSpawn() {},
  };

  for (const method of Object.keys(coordinator)) {
    const invalid = { ...coordinator };
    delete invalid[method];
    assert.throws(() => bindGoalExecutorCoordinator({}, invalid), /coordinator/i);
  }
  bindGoalExecutorCoordinator({}, coordinator);
});
