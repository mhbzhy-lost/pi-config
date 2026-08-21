import assert from "node:assert/strict";
import test from "node:test";

import { compileCodingDispatchIR as compileGoalDispatchIR, splitDispatchEnvelope } from "../scripts/lib/goal-engine/dispatch-ir.mjs";
import { compileCodingDispatchIR as compileTypedDispatchIR } from "../scripts/lib/subagent-dispatch/ir.ts";

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
      relevantFiles: ["scripts/lib/goal-engine/dispatch-ir.mjs"],
    },
    boundaries: {
      writePaths: ["scripts/lib/goal-engine/dispatch-ir.mjs"],
      excludedWork: ["Do not add model routing fields to the coding contract."],
      forbiddenActions: ["Do not alter typed runtime behavior."],
    },
    acceptance: { criteria: ["Goal and typed hashes agree."] },
    execution: { cwd: "/repo", timeoutMs: 1_800_000 },
    ...overrides,
  };
}

test("Goal and typed dispatch IR stay canonical for criteria-only contracts", () => {
  const input = criteriaOnlyContract();
  const goal = compileGoalDispatchIR(input, { cwd: "/repo" });
  const typed = compileTypedDispatchIR(input, { cwd: "/repo" });

  assert.deepEqual(splitDispatchEnvelope(goal).contract, (() => {
    const { hash: _hash, ...transport } = typed;
    return transport;
  })());
  assert.equal(goal.hash, typed.hash);
});
