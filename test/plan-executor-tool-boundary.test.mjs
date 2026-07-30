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
  const tool = { agent: "executor", task: "Execute task", cwd: workspace.path, output: `/results/${attemptId}.json`, timeoutMs: 1000, context: "fresh", async: true, clarify: false, worktree: false, contract };
  const dispatchContextHash = sha256({ planIrHash: revision.irHash, taskHash: revision.taskHashes[taskId].effective, schedulingHash: revision.taskHashes[taskId].scheduling, attemptId, baseCommit: "base", output: tool.output, dependencyReceipts: [] });
  const events = [["plan.created", { workspace: { originRoot: "/repo", worktree: "/worktree", baseCommit: "base", headCommit: "base" }, tasks: [taskId], revision }], ["attempt.workspace-allocated", { attemptId, taskId, baseCommit: "base", workspace }], ["attempt.dispatch-requested", { attemptId, taskId, dispatchId, baseCommit: "base", workspace, tool, toolHash: contractHash, planIrHash: revision.irHash, taskHash: revision.taskHashes[taskId].effective, schedulingHash: revision.taskHashes[taskId].scheduling, dispatchContextHash }]];
  return events.reduce((value, [type, data], index) => applyEvent(value, { schemaVersion: "pi-plan-event.v1", eventId: `event-${index}`, planId: "plan-1", occurredAt: `2026-01-01T00:00:0${index}.000Z`, type, data }), createProjection());
}

test("authorizes exactly one matching typed Executor dispatch", () => {
  const exact = contract();
  assert.deepEqual(createPlanExecutorToolBoundary().authorize(exact.contract, { projection: projectionFor(exact), toolCallId: "call-1" }), { attemptId: "attempt-1", dispatchId: "dispatch-1", contractHash: exact.contractHash, toolCallId: "call-1", state: "executing" });
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
