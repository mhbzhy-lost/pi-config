import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createPlanExecutorToolBoundary } from "../scripts/lib/plan/plan-executor-tool-boundary.mjs";
import { applyEvent, createProjection } from "../scripts/lib/plan/plan-events.mjs";
import { compileCodingDispatchIR } from "../scripts/lib/subagent-dispatch/ir.ts";

const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");

function contract(overrides = {}) {
  const { hash: contractHash, ...source } = compileCodingDispatchIR({
    version: "dispatch-ir.v1", taskId: "task-1", title: "Execute task", agent: "executor", risk: "normal", objective: "Execute the approved task.", workflow: { mode: "tdd" }, requirements: ["Change one file."],
    context: { knownFacts: [], decisions: [], relevantFiles: ["src/task-1.mjs"] }, boundaries: { writePaths: ["src/task-1.mjs"], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["Tests pass."], commands: ["node --test"] }, execution: { timeoutMs: 1000, cwd: "/attempts/attempt-1" }, ...overrides,
  }, { cwd: "/repo" });
  const contract = { ...source };
  assert.equal(Object.hasOwn(contract, "hash"), false);
  assert.equal(compileCodingDispatchIR(contract, { cwd: "/repo" }).hash, contractHash);
  return { contract, contractHash };
}

function projectionFor({ attemptId = "attempt-1", taskId = "task-1", contract, contractHash, dispatchId = "dispatch-1" } = {}) {
  const revision = { number: 1, manifestSha256: hash("manifest"), sourceBytesSha256: hash("source"), planHash: hash("plan"), irVersion: "plan-ir.v3", irHash: hash("ir"), taskHashes: { [taskId]: { full: hash(`full:${taskId}`), effective: hash(`effective:${taskId}`), scheduling: hash(`scheduling:${taskId}`) } } };
  const workspace = { path: `/attempts/${attemptId}`, branch: `branch-${attemptId}`, ownerToken: `owner-${attemptId}` };
  const tool = { agent: "executor", task: "Execute task", cwd: workspace.path, output: `/results/${attemptId}.json`, timeoutMs: 1000, context: "fresh", async: true, clarify: false, worktree: false, dependencyReceipts: [], contract };
  const dispatchContextHash = sha256({ planIrHash: revision.irHash, taskHash: revision.taskHashes[taskId].effective, schedulingHash: revision.taskHashes[taskId].scheduling, attemptId, baseCommit: "base", output: tool.output, dependencyReceipts: tool.dependencyReceipts });
  const events = [["plan.created", { workspace: { originRoot: "/repo", worktree: "/worktree", baseCommit: "base", headCommit: "base" }, tasks: [taskId], revision }], ["attempt.workspace-allocated", { attemptId, taskId, baseCommit: "base", workspace }], ["attempt.dispatch-requested", { attemptId, taskId, dispatchId, baseCommit: "base", workspace, tool, toolHash: contractHash, planIrHash: revision.irHash, taskHash: revision.taskHashes[taskId].effective, schedulingHash: revision.taskHashes[taskId].scheduling, dispatchContextHash }]];
  return events.reduce((value, [type, data], index) => applyEvent(value, { schemaVersion: "pi-plan-event.v1", eventId: `event-${index}`, planId: "plan-1", occurredAt: `2026-01-01T00:00:0${index}.000Z`, type, data }), createProjection());
}

test("authorizes exactly one matching typed Executor dispatch", () => {
  const exact = contract();
  assert.deepEqual(createPlanExecutorToolBoundary().authorize(exact.contract, { projection: projectionFor(exact), toolCallId: "call-1" }), { attemptId: "attempt-1", dispatchId: "dispatch-1", contractHash: exact.contractHash, toolCallId: "call-1", state: "executing" });
});

test("resolves the authorized dispatch into its durable spawn identity exactly once", () => {
  const exact = contract(); const boundary = createPlanExecutorToolBoundary();
  assert.equal(typeof boundary.resolveCodingSpawnIdentity, "function", "Boundary must expose resolveCodingSpawnIdentity");
  const authorization = boundary.authorize(exact.contract, { projection: projectionFor(exact), toolCallId: "identity-call" });
  const input = { toolCallId: "identity-call", contract: exact.contract, contractHash: exact.contractHash };
  assert.deepEqual(boundary.resolveCodingSpawnIdentity(input), { requestId: authorization.dispatchId, spawnKey: authorization.dispatchId });
  assert.throws(() => boundary.resolveCodingSpawnIdentity(input), /resolved|one.?shot|replay/i);
});

test("returns the frozen authoritative execution request only after resolving its tool call", () => {
  const exact = contract(); const boundary = createPlanExecutorToolBoundary(); const projection = projectionFor(exact);
  boundary.authorize(exact.contract, { projection, toolCallId: "request-call" });

  assert.equal(typeof boundary.executionRequestForToolCall, "function", "Boundary must expose executionRequestForToolCall");
  assert.throws(() => boundary.executionRequestForToolCall("request-call"), /resolved|authorize|toolCallId/i);
  boundary.resolveCodingSpawnIdentity({ toolCallId: "request-call", contract: exact.contract, contractHash: exact.contractHash });
  const request = boundary.executionRequestForToolCall("request-call");
  assert.deepEqual(request, {
    dispatchId: "dispatch-1", attemptId: "attempt-1", agent: "executor", task: "Execute task",
    cwd: "/attempts/attempt-1", output: "/results/attempt-1.json", timeoutMs: 1000,
  });
  assert.equal(Object.isFrozen(request), true);
  assert.throws(() => boundary.executionRequestForToolCall("unknown-call"), /authorized|toolCallId|unknown/i);
});

for (const [name, resolverInput] of [
  ["unknown tool call", (exact) => ({ toolCallId: "unknown-call", contract: exact.contract, contractHash: exact.contractHash })],
  ["raw contract mismatch", (exact) => ({ toolCallId: "authorized-call", contract: { ...exact.contract, title: ` ${exact.contract.title} ` }, contractHash: exact.contractHash })],
  ["contract hash mismatch", (exact) => ({ toolCallId: "authorized-call", contract: exact.contract, contractHash: hash("wrong-hash") })],
]) {
  test(`rejects ${name} without consuming an authorized spawn identity`, () => {
    const exact = contract(); const boundary = createPlanExecutorToolBoundary();
    assert.equal(typeof boundary.resolveCodingSpawnIdentity, "function", "Boundary must expose resolveCodingSpawnIdentity");
    boundary.authorize(exact.contract, { projection: projectionFor(exact), toolCallId: "authorized-call" });
    assert.throws(() => boundary.resolveCodingSpawnIdentity(resolverInput(exact)), /toolCallId|authorized|exact contract|contract identity|contract hash|identity|hash mismatch/i);
    assert.deepEqual(
      boundary.resolveCodingSpawnIdentity({ toolCallId: "authorized-call", contract: exact.contract, contractHash: exact.contractHash }),
      { requestId: "dispatch-1", spawnKey: "dispatch-1" },
    );
  });
}

test("rejects canonical-equivalent raw contract mutations without consuming the dispatch", async (t) => {
  const exact = contract();
  const mutations = [
    ["title whitespace", { ...exact.contract, title: ` ${exact.contract.title} ` }],
    ["duplicate requirement", { ...exact.contract, requirements: [...exact.contract.requirements, exact.contract.requirements[0]] }],
    ["lexical cwd alias", { ...exact.contract, execution: { ...exact.contract.execution, cwd: `${exact.contract.execution.cwd}/.` } }],
  ];
  for (const [name, mutated] of mutations) {
    await t.test(name, () => {
      assert.equal(compileCodingDispatchIR(mutated, { cwd: "/repo" }).hash, exact.contractHash);
      const boundary = createPlanExecutorToolBoundary();
      const projection = projectionFor(exact);
      assert.throws(
        () => boundary.authorize(mutated, { projection, toolCallId: `mutated-${name}` }),
        /exact contract|contract identity|contract hash/i,
      );
      assert.equal(boundary.authorize(exact.contract, { projection, toolCallId: `valid-${name}` }).state, "executing");
    });
  }
});

test("requires a non-blank toolCallId without consuming the dispatch", async (t) => {
  for (const [name, toolCallId] of [["missing", undefined], ["empty", ""], ["whitespace", "   "]]) {
    await t.test(name, () => {
      const exact = contract(); const boundary = createPlanExecutorToolBoundary(); const projection = projectionFor(exact);
      assert.throws(() => boundary.authorize(exact.contract, { projection, toolCallId }), /toolCallId|required|identity/i);
      assert.equal(boundary.authorize(exact.contract, { projection, toolCallId: `valid-${name}` }).state, "executing");
    });
  }
});

test("rejects a current revision IR hash mismatch without consuming the authorization", () => {
  const exact = contract(); const boundary = createPlanExecutorToolBoundary(); const projection = projectionFor(exact);
  const tampered = { ...projection, revision: { ...projection.revision, irHash: hash("other-ir") } };
  assert.throws(() => boundary.authorize(exact.contract, { projection: tampered, toolCallId: "call-1" }), /revision|plan IR|identity|hash mismatch/);
  assert.equal(boundary.authorize(exact.contract, { projection, toolCallId: "call-1" }).state, "executing");
});

test("rejects a dispatch context hash mismatch without consuming the authorization", () => {
  const exact = contract(); const boundary = createPlanExecutorToolBoundary(); const projection = projectionFor(exact);
  const attempt = projection.attempts.get("attempt-1");
  const tampered = { ...projection, attempts: new Map([...projection.attempts, ["attempt-1", { ...attempt, dispatchContextHash: hash("other-context") }]]) };
  assert.throws(() => boundary.authorize(exact.contract, { projection: tampered, toolCallId: "call-1" }), /dispatch context|context hash|identity/);
  assert.equal(boundary.authorize(exact.contract, { projection, toolCallId: "call-1" }).state, "executing");
});

test("fails closed for mutated, replayed, unsupported, stale, terminal, workspace, and ambiguous dispatches", () => {
  const exact = contract(); const boundary = createPlanExecutorToolBoundary(); const projection = projectionFor(exact); const mutated = contract({ risk: "high" });
  const cases = [[mutated.contract, projection, "contract hash mismatch"], [{ agent: "executor" }, projection, "Executor dispatch contract|required|unsupported"], [{ action: "status", id: "run-1" }, projection, "Executor dispatch contract|required|unsupported"], [exact.contract, { ...projection, lifecycle: "cancelled" }, "terminal|cancelled"], [exact.contract, projectionFor({ ...exact, taskId: "task-2" }), "requested|contract hash mismatch|task mismatch"], [exact.contract, projectionFor({ ...exact, attemptId: "other-attempt" }), "workspace|context"], [exact.contract, { ...projection, attempts: new Map() }, "requested"], [exact.contract, { ...projection, attempts: new Map([...projection.attempts, ["another", projection.attempts.get("attempt-1")]]) }, "requested|multiple"]];
  for (const [input, candidate, expected] of cases) assert.throws(() => boundary.authorize(input, { projection: candidate, toolCallId: "call-1" }), new RegExp(expected));
  assert.equal(boundary.authorize(exact.contract, { projection, toolCallId: "call-1" }).state, "executing");
  assert.throws(() => boundary.authorize(exact.contract, { projection, toolCallId: "call-1" }), /already authorized|replay/);
  assert.throws(() => boundary.authorize(exact.contract, { projection, toolCallId: "call-2" }), /already authorized|replay/);
});

test("authorizes independent requested Attempts once each", () => {
  const first = contract(); const second = contract({ taskId: "task-2", execution: { timeoutMs: 1000, cwd: "/attempts/attempt-2" } });
  const one = projectionFor(first); const two = projectionFor({ ...second, attemptId: "attempt-2", taskId: "task-2", dispatchId: "dispatch-2" });
  const projection = { ...one, tasks: new Map([...one.tasks, ...two.tasks]), attempts: new Map([...one.attempts, ...two.attempts]), revision: { ...one.revision, taskHashes: { ...one.revision.taskHashes, ...two.revision.taskHashes } } }; const boundary = createPlanExecutorToolBoundary();
  assert.equal(boundary.authorize(first.contract, { projection, toolCallId: "call-1" }).attemptId, "attempt-1"); assert.equal(boundary.authorize(second.contract, { projection, toolCallId: "call-2" }).attemptId, "attempt-2");
});

test("rejects a toolCallId reused by a separate requested Attempt without consuming it", () => {
  const first = contract(); const second = contract({ taskId: "task-2", execution: { timeoutMs: 1000, cwd: "/attempts/attempt-2" } });
  const one = projectionFor(first); const two = projectionFor({ ...second, attemptId: "attempt-2", taskId: "task-2", dispatchId: "dispatch-2" });
  const projection = { ...one, tasks: new Map([...one.tasks, ...two.tasks]), attempts: new Map([...one.attempts, ...two.attempts]), revision: { ...one.revision, taskHashes: { ...one.revision.taskHashes, ...two.revision.taskHashes } } };
  const boundary = createPlanExecutorToolBoundary();
  assert.equal(boundary.authorize(first.contract, { projection, toolCallId: "shared-call" }).attemptId, "attempt-1");
  assert.throws(() => boundary.authorize(second.contract, { projection, toolCallId: "shared-call" }), /toolCallId.*already|duplicate.*toolCallId/i);
  assert.equal(boundary.authorize(second.contract, { projection, toolCallId: "call-2" }).attemptId, "attempt-2");
});

test("resolves an authorized Executor result into the exact durable binding", () => {
  const exact = contract(); const boundary = createPlanExecutorToolBoundary(); const projection = projectionFor(exact);
  boundary.authorize(exact.contract, { projection, toolCallId: "result-call" });
  boundary.resolveCodingSpawnIdentity({ toolCallId: "result-call", contract: exact.contract, contractHash: exact.contractHash });
  assert.equal(typeof boundary.resolveExecutorToolResult, "function", "Boundary must expose resolveExecutorToolResult");
  assert.deepEqual(boundary.resolveExecutorToolResult({
    toolName: "subagent", toolCallId: "result-call", input: exact.contract, isError: false,
    details: { version: "coding-dispatch-handle.v1", dispatchId: "dispatch-1", taskId: "task-1", agent: "executor", title: "Execute task", contractHash: exact.contractHash, runId: "run-1", asyncDir: "/async/run-1" },
  }), { status: "spawned", binding: { runId: "run-1", asyncDir: "/async/run-1" } });
});

test("releases a cleaned Executor authorization so the same contract can be retried", () => {
  const exact = contract(); const boundary = createPlanExecutorToolBoundary(); const projection = projectionFor(exact);
  boundary.authorize(exact.contract, { projection, toolCallId: "cleaned-call" });
  assert.equal(typeof boundary.releaseExecutorToolCall, "function", "Boundary must expose releaseExecutorToolCall");
  assert.deepEqual(boundary.releaseExecutorToolCall("cleaned-call", "cleaned"), { state: "released", disposition: "cleaned" });
  assert.equal(boundary.authorize(exact.contract, { projection, toolCallId: "retry-call" }).toolCallId, "retry-call");
});

function resolvedBoundary(toolCallId = "result-call") {
  const exact = contract(); const boundary = createPlanExecutorToolBoundary(); const projection = projectionFor(exact);
  boundary.authorize(exact.contract, { projection, toolCallId });
  boundary.resolveCodingSpawnIdentity({ toolCallId, contract: exact.contract, contractHash: exact.contractHash });
  return { exact, boundary, toolCallId };
}

function boundaryMethod(boundary, name) {
  const method = boundary[name];
  assert.equal(typeof method, "function", `Boundary must expose ${name}`);
  return method.bind(boundary);
}

function validResult({ exact, toolCallId }, overrides = {}) {
  return {
    toolName: "subagent", toolCallId, input: exact.contract, isError: false,
    details: { version: "coding-dispatch-handle.v1", dispatchId: "dispatch-1", taskId: "task-1", agent: "executor", title: "Execute task", contractHash: exact.contractHash, runId: "run-1", asyncDir: "/async/run-1", ...overrides },
  };
}

test("returns error without accepting a spawn binding from an authorized Executor result", () => {
  const fixture = resolvedBoundary("error-result-call");
  assert.deepEqual(boundaryMethod(fixture.boundary, "resolveExecutorToolResult")({ ...validResult(fixture), isError: true, details: { runId: "untrusted-run", asyncDir: "/untrusted" } }), { status: "error" });
});

test("pre-resolver ping failure releases an authorized Executor dispatch", () => {
  const exact = contract(); const boundary = createPlanExecutorToolBoundary(); const projection = projectionFor(exact);
  boundary.authorize(exact.contract, { projection, toolCallId: "pre-resolver-call-1" });
  assert.deepEqual(
    boundaryMethod(boundary, "resolveExecutorToolResult")({ toolName: "subagent", toolCallId: "pre-resolver-call-1", input: exact.contract, isError: true }),
    { status: "not-started" },
  );
  assert.deepEqual(boundaryMethod(boundary, "releaseExecutorToolCall")("pre-resolver-call-1", "not-started"), { state: "released", disposition: "not-started" });
  assert.equal(boundary.authorize(exact.contract, { projection, toolCallId: "pre-resolver-call-2" }).toolCallId, "pre-resolver-call-2");
});

test("rejects every mismatched result field without consuming its tool call", async (t) => {
  for (const [name, mutate] of [
    ["raw input", (event) => ({ ...event, input: { ...event.input, title: "forged" } })],
    ["dispatchId", (event) => ({ ...event, details: { ...event.details, dispatchId: "other" } })],
    ["taskId", (event) => ({ ...event, details: { ...event.details, taskId: "other" } })],
    ["agent", (event) => ({ ...event, details: { ...event.details, agent: "reviewer" } })],
    ["contractHash", (event) => ({ ...event, details: { ...event.details, contractHash: hash("other") } })],
    ["unsupported version", (event) => ({ ...event, details: { ...event.details, version: "coding-dispatch-handle.v2" } })],
    ["missing version", (event) => { const { version, ...details } = event.details; return { ...event, details }; }],
    ["mismatched title", (event) => ({ ...event, details: { ...event.details, title: "Other task" } })],
    ["details extra field", (event) => ({ ...event, details: { ...event.details, extra: true } })],
    ["blank runId", (event) => ({ ...event, details: { ...event.details, runId: " " } })],
    ["blank asyncDir", (event) => ({ ...event, details: { ...event.details, asyncDir: "" } })],
  ]) await t.test(name, () => {
    const fixture = resolvedBoundary(`mismatch-${name}`);
    const resolveResult = boundaryMethod(fixture.boundary, "resolveExecutorToolResult");
    assert.throws(() => resolveResult(mutate(validResult(fixture))), /result|exact|dispatch|task|agent|hash|runId|asyncDir/i);
    assert.deepEqual(resolveResult(validResult(fixture)), { status: "spawned", binding: { runId: "run-1", asyncDir: "/async/run-1" } });
  });
});

test("completes a spawned result idempotently and never submits a second binding", () => {
  const fixture = resolvedBoundary("complete-result-call");
  const resolveResult = boundaryMethod(fixture.boundary, "resolveExecutorToolResult");
  const complete = boundaryMethod(fixture.boundary, "completeExecutorToolCall");
  resolveResult(validResult(fixture));
  assert.deepEqual(complete(fixture.toolCallId), { state: "completed" });
  assert.deepEqual(complete(fixture.toolCallId), { state: "completed" });
  assert.deepEqual(resolveResult(validResult(fixture)), { status: "completed" });
});

test("releases fresh not-started and cleaned calls but rejects other dispositions", async (t) => {
  for (const disposition of ["not-started", "cleaned"]) await t.test(disposition, () => {
    const exact = contract(); const boundary = createPlanExecutorToolBoundary(); const projection = projectionFor(exact);
    boundary.authorize(exact.contract, { projection, toolCallId: `${disposition}-call` });
    const release = boundaryMethod(boundary, "releaseExecutorToolCall");
    assert.deepEqual(release(`${disposition}-call`, disposition), { state: "released", disposition });
    assert.equal(boundary.authorize(exact.contract, { projection, toolCallId: `${disposition}-retry` }).toolCallId, `${disposition}-retry`);
  });
  const exact = contract(); const boundary = createPlanExecutorToolBoundary(); const projection = projectionFor(exact);
  boundary.authorize(exact.contract, { projection, toolCallId: "invalid-release" });
  const release = boundaryMethod(boundary, "releaseExecutorToolCall");
  assert.throws(() => release("invalid-release", "other"), /disposition|release/i);
  assert.throws(() => boundary.authorize(exact.contract, { projection, toolCallId: "invalid-release-retry" }), /already authorized|replay/i);
});

test("fences an uncertain call without re-exposing its spawned binding", () => {
  const fixture = resolvedBoundary("uncertain-result-call");
  const resolveResult = boundaryMethod(fixture.boundary, "resolveExecutorToolResult");
  const fence = boundaryMethod(fixture.boundary, "fenceExecutorToolCall");
  resolveResult(validResult(fixture));
  assert.deepEqual(fence(fixture.toolCallId), { state: "uncertain" });
  assert.throws(() => fixture.boundary.authorize(fixture.exact.contract, { projection: projectionFor(fixture.exact), toolCallId: "uncertain-retry" }), /uncertain|already authorized|replay/i);
  const repeated = resolveResult(validResult(fixture));
  assert.equal(repeated.status, "uncertain");
  assert.equal(Object.hasOwn(repeated, "binding"), false);
});
