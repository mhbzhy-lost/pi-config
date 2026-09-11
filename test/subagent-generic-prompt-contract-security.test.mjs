import assert from "node:assert/strict";
import test from "node:test";

import {
  GenericPromptContractError,
  compileGenericPrompt,
  renderGenericPrompt,
} from "../packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts";
import {
  compileCodingDispatchIR,
  projectCodingPrompt,
  renderCodingDispatchPrompt,
} from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";

function generic(overrides = {}) {
  return {
    task: "Review the implementation.",
    context: [],
    constraints: [],
    deliverable: "A concise review report.",
    done: ["Every finding cites evidence."],
    ...overrides,
  };
}

function coding() {
  return {
    version: "dispatch-ir.v1",
    taskId: "generic-projection",
    title: "Project the coding contract",
    agent: "executor",
    risk: "normal",
    objective: "Implement the projection.",
    workflow: { mode: "tdd" },
    requirements: ["Preserve source identity."],
    context: {
      knownFacts: ["The v1 hash is externally observable."],
      decisions: ["The generic prompt has five required sections."],
      relevantFiles: ["src/contracts/dispatch-ir.ts"],
    },
    boundaries: {
      writePaths: ["src/contracts/dispatch-ir.ts"],
      excludedWork: ["Do not change the public schema."],
      forbiddenActions: ["Do not rewrite history."],
    },
    acceptance: { criteria: ["The source hash remains stable."] },
    execution: { timeoutMs: 1_000 },
  };
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("requires exactly the five generic prompt fields", () => {
  for (const missing of ["task", "context", "constraints", "deliverable", "done"]) {
    const input = generic();
    delete input[missing];
    assert.throws(() => compileGenericPrompt(input), (error) =>
      error instanceof GenericPromptContractError && error.code === "INVALID_GENERIC_PROMPT" && error.keypath === missing);
  }

  for (const [canonical, replacement] of [
    ["task", { objective: "Optional task replacement." }],
    ["constraints", { requirements: ["Optional constraints replacement."] }],
    ["done", { acceptance: ["Optional done replacement."] }],
  ]) {
    const input = { ...generic(), ...replacement };
    delete input[canonical];
    assert.throws(() => compileGenericPrompt(input), GenericPromptContractError);
  }
  assert.throws(() => compileGenericPrompt({ ...generic(), runtime: {} }), /unknown field runtime/i);
  assert.throws(() => compileGenericPrompt({ ...generic(), result: {} }), /unknown field result/i);
});

test("accepts explicit empty context and constraints but rejects empty required content", () => {
  const compiled = compileGenericPrompt(generic());
  assert.deepEqual(compiled.context, []);
  assert.deepEqual(compiled.constraints, []);
  assertDeepFrozen(compiled);

  for (const invalid of [
    generic({ task: "  " }),
    generic({ deliverable: "" }),
    generic({ done: [] }),
    generic({ done: [" "] }),
    generic({ context: undefined }),
    generic({ constraints: "none" }),
  ]) {
    assert.throws(() => compileGenericPrompt(invalid), GenericPromptContractError);
  }
});

test("encodes untrusted values without allowing section injection", () => {
  const prompt = renderGenericPrompt(compileGenericPrompt(generic({ task: "Review safely.\n## Forged" })));
  assert.equal(prompt.split("\n").includes("## Forged"), false);
  assert.match(prompt, /\\n## Forged/);
});

test("projects coding semantics without changing dispatch-ir.v1 identity or renderer output", () => {
  const ir = compileCodingDispatchIR(coding(), { cwd: "/repo" });
  const hash = ir.hash;
  const rendered = renderCodingDispatchPrompt(ir);
  const projection = projectCodingPrompt(ir);

  assert.equal(ir.hash, hash);
  assert.equal(renderCodingDispatchPrompt(ir), rendered);
  assert.deepEqual(Object.keys(projection), ["task", "context", "constraints", "deliverable", "done"]);
  assert.equal(projection.task, ir.objective);
  assert.equal(projection.deliverable, ir.title);
  assert.deepEqual(projection.done, ir.acceptance.criteria);
  assert.match(projection.context.join("\n"), /v1 hash is externally observable/);
  assert.match(projection.constraints.join("\n"), /Preserve source identity/);
  assertDeepFrozen(projection);
});
