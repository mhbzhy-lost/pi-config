import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveInitialShape, hashRuntimeExecutionContract, normalizeRuntimeGoalInit, validateRuntimeReadiness,
} from "../src/goal-engine/obligation-contract.ts";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

test("normalizes a strictly registered runtime contract and derives only its initial shape", () => {
  const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
  assert.equal(contract.execution.schema, "goal-runtime.v1");
  assert.equal(deriveInitialShape(contract), "hybrid");
  assert.equal(contract.initialShape, undefined);
  assert.ok(Object.isFrozen(contract));
  assert.equal(validateRuntimeReadiness(contract, runtimeRegistries).readiness, "ready");
});

test("rejects authority-bearing caller fields and invalid obligation contracts before any state append", () => {
  const cases = [
    runtimeInit({ profile: "active" }), runtimeInit({ initialShape: "planned" }),
    { ...runtimeInit(), tasks: ["legacy"] }, runtimeInit({ execution: { ...runtimeInit().execution, tasks: [], conditions: [] } }),
    runtimeInit({ execution: { ...runtimeInit().execution, command: "secret-command" } }),
    runtimeInit({ execution: { ...runtimeInit().execution, write_policy: { allowed_paths: ["../unsafe"] } } }),
    runtimeInit({ execution: { ...runtimeInit().execution, conditions: [{ ...runtimeInit().execution.conditions[0], remediation: { policy: "autonomous", allowed_paths: ["other/**"], max_attempts: 1 } }] } }),
    runtimeInit({ execution: { ...runtimeInit().execution, conditions: [{ ...runtimeInit().execution.conditions[0], oracle_ref: "unknown" }] } }),
    runtimeInit({ execution: { ...runtimeInit().execution, conditions: [{ ...runtimeInit().execution.conditions[0], stability: { mode: "single", require_fresh_environment: true } }] } }),
  ];
  const nondeterministic = { ...runtimeRegistries, adapters: { oracle: { deterministic: false } } };
  for (const candidate of cases.slice(0, -1)) assert.throws(() => normalizeRuntimeGoalInit(candidate, runtimeRegistries));
  assert.throws(() => normalizeRuntimeGoalInit(cases.at(-1), nondeterministic), /deterministic/);
});

test("runtime tasks preserve the full criteria-only PlannedTask contract and reject task escapes", () => {
  const base = runtimeInit();
  const full = normalizeRuntimeGoalInit(base, runtimeRegistries);
  assert.deepEqual(full.execution.tasks[0], base.execution.tasks[0]);
  const task = base.execution.tasks[0];
  const cases = [
    { ...task, description: undefined },
    { ...task, acceptance: { criteria: task.acceptance.criteria, commands: ["node --test"] } },
    { ...task, metadata: { kind: "remediation" } },
    { ...task, writePaths: ["outside/**"] },
    { ...task, deps: ["missing"] },
  ];
  for (const badTask of cases) assert.throws(() => normalizeRuntimeGoalInit(runtimeInit({ execution: { ...base.execution, tasks: [badTask] } }), runtimeRegistries));
  const pair = [task, { ...task, id: "task-2", deps: ["task-1"] }];
  assert.throws(() => normalizeRuntimeGoalInit(runtimeInit({ execution: { ...base.execution, tasks: [{ ...task, deps: ["task-2"] }, pair[1]] } }), runtimeRegistries), /cycle/);
});

test("rejects duplicate, unknown, cyclic condition references and hash is canonical but semantic", () => {
  const base = runtimeInit();
  const duplicate = { ...base, execution: { ...base.execution, conditions: [base.execution.conditions[0], { ...base.execution.conditions[0] }] } };
  const unknown = { ...base, execution: { ...base.execution, conditions: [{ ...base.execution.conditions[0], depends_on: [{ kind: "condition", id: "missing" }] }] } };
  const first = { ...base.execution.conditions[0], id: "a", depends_on: [{ kind: "condition", id: "b" }] };
  const second = { ...base.execution.conditions[0], id: "b", depends_on: [{ kind: "condition", id: "a" }] };
  const cycle = { ...base, execution: { ...base.execution, conditions: [first, second] } };
  for (const candidate of [duplicate, unknown, cycle]) assert.throws(() => normalizeRuntimeGoalInit(candidate, runtimeRegistries));
  const contract = normalizeRuntimeGoalInit(base, runtimeRegistries);
  assert.equal(hashRuntimeExecutionContract(contract), hashRuntimeExecutionContract(JSON.parse(JSON.stringify(contract))));
  assert.notEqual(hashRuntimeExecutionContract(contract), hashRuntimeExecutionContract({ ...contract, objective: "Different" }));
});

test("readiness is pure and reports registry blockers without executing anything", () => {
  const contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
  assert.deepEqual(validateRuntimeReadiness(contract, { ...runtimeRegistries, environments: { local: { available: false } } }), {
    readiness: "environment_blocked", reasons: ["environment local is unavailable"],
  });
  assert.deepEqual(validateRuntimeReadiness(contract, { ...runtimeRegistries, adapters: {} }), {
    readiness: "needs_clarification", reasons: ["unknown adapter oracle"],
  });
});
