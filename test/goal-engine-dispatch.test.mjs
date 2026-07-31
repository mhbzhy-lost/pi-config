import assert from "node:assert/strict";
import test from "node:test";
import { compileCodingDispatchIR, renderDispatchPrompt } from "../scripts/lib/goal-engine/dispatch-ir.mjs";
import { compileTaskContract } from "../scripts/lib/goal-engine/dispatch.mjs";
import { createProjection, applyEvent } from "../scripts/lib/goal-engine/events.mjs";

function makeEvent(type, data, goalId = "dispatch-test") {
  return { schemaVersion: "goal-engine.event.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data };
}

function validInput(overrides = {}) {
  return {
    version: "dispatch-ir.v1",
    taskId: "test-goal.t1",
    title: "t1: Implement token validation",
    agent: "executor",
    risk: "normal",
    objective: "Implement token validation with expiry handling",
    workflow: { mode: "tdd" },
    requirements: ["Implement token validation", "Handle expired tokens"],
    context: { knownFacts: ["Goal: Build auth"], decisions: ["Non-goal: UI"], relevantFiles: ["src/auth/token.ts"] },
    boundaries: { writePaths: ["src/auth/token.ts"], excludedWork: ["UI changes"], forbiddenActions: ["Do not modify state files"] },
    acceptance: { criteria: ["Handles expired tokens"], commands: ["node --test test/token.test.mjs"] },
    execution: { cwd: "/workspace/project", timeoutMs: 1800000 },
    ...overrides,
  };
}

test("compileCodingDispatchIR validates and hashes", () => {
  const ir = compileCodingDispatchIR(validInput(), { cwd: "/workspace/project" });
  assert.equal(ir.version, "dispatch-ir.v1");
  assert.equal(ir.taskId, "test-goal.t1");
  assert.equal(ir.agent, "executor");
  assert.ok(/^[a-f0-9]{64}$/.test(ir.hash));
});

test("compileCodingDispatchIR rejects unknown fields", () => {
  assert.throws(
    () => compileCodingDispatchIR(validInput({ bogus: true }), { cwd: "/workspace/project" }),
    /unknown field/,
  );
});

test("compileCodingDispatchIR rejects invalid agent", () => {
  assert.throws(
    () => compileCodingDispatchIR(validInput({ agent: "hacker" }), { cwd: "/workspace/project" }),
    /unsupported.*agent/,
  );
});

test("compileCodingDispatchIR rejects empty writePaths", () => {
  const input = validInput();
  input.boundaries.writePaths = [];
  assert.throws(
    () => compileCodingDispatchIR(input, { cwd: "/workspace/project" }),
    /writePaths/,
  );
});

test("compileCodingDispatchIR rejects path traversal in writePaths", () => {
  const input = validInput();
  input.boundaries.writePaths = ["../../etc/passwd"];
  assert.throws(
    () => compileCodingDispatchIR(input, { cwd: "/workspace/project" }),
    /repo-relative/,
  );
});

test("renderDispatchPrompt produces structured markdown", () => {
  const ir = compileCodingDispatchIR(validInput(), { cwd: "/workspace/project" });
  const prompt = renderDispatchPrompt(ir);
  assert.match(prompt, /# Coding Dispatch Contract/);
  assert.match(prompt, /token validation/);
  assert.match(prompt, /src\/auth\/token\.ts/);
  assert.match(prompt, /node --test test\/token\.test\.mjs/);
  assert.ok(prompt.length < 64 * 1024);
});

// --- compileTaskContract tests ---

function buildProjection() {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Build auth module",
    scope: ["src/auth/"],
    nonGoals: ["UI changes", "Database migration"],
    dod: ["All auth tests pass", "No hardcoded secrets"],
    tasks: ["t1", "t2"],
    taskDefs: {
      t1: {
        description: "Implement token validation with expiry handling",
        deps: [],
        writePaths: ["src/auth/token.ts", "test/auth/token.test.mjs"],
        acceptance: { criteria: ["Handles expired tokens", "Rejects malformed tokens"], commands: ["node --test test/auth/token.test.mjs"] },
        workflow: "tdd",
      },
      t2: {
        description: "Add session management layer",
        deps: ["t1"],
        writePaths: ["src/auth/session.ts"],
        acceptance: { criteria: ["Session persists across requests"], commands: ["node --test test/auth/session.test.mjs"] },
        workflow: "tdd",
      },
    },
  }));
  return p;
}

test("compileTaskContract produces valid dispatch-ir.v1", () => {
  const p = buildProjection();
  const contract = compileTaskContract(p, "t1", "/workspace/project");

  assert.equal(contract.version, "dispatch-ir.v1");
  assert.equal(contract.taskId, "dispatch-test.t1");
  assert.equal(contract.agent, "executor");
  assert.equal(contract.risk, "normal");
  assert.match(contract.objective, /token validation/i);
  assert.ok(contract.requirements.length >= 2);
  assert.deepEqual(contract.boundaries.writePaths, ["src/auth/token.ts", "test/auth/token.test.mjs"]);
  assert.deepEqual(contract.acceptance.commands, ["node --test test/auth/token.test.mjs"]);
  assert.equal(contract.workflow.mode, "tdd");
  assert.equal(contract.execution.cwd, "/workspace/project");
  assert.ok(contract.hash);
});

test("compileTaskContract includes goal context as knownFacts", () => {
  const p = buildProjection();
  const contract = compileTaskContract(p, "t1", "/workspace/project");

  assert.ok(contract.context.knownFacts.some((f) => f.includes("src/auth/")));
  assert.ok(contract.context.decisions.some((d) => d.includes("UI changes")));
});

test("compileTaskContract includes completed task evidence as context", () => {
  let p = buildProjection();
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", {
    taskId: "t1", outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/auth/token.ts" },
    evidenceSource: "self_produced",
    nextAction: "Accept t1 and dispatch t2 for session management implementation",
  }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));

  const contract = compileTaskContract(p, "t2", "/workspace/project");
  assert.ok(contract.context.knownFacts.some((f) => f.includes("t1")));
  assert.ok(contract.context.relevantFiles.includes("src/auth/token.ts"));
});

test("compileTaskContract rejects non-pending task", () => {
  let p = buildProjection();
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  assert.throws(
    () => compileTaskContract(p, "t1", "/workspace"),
    /not pending/,
  );
});
