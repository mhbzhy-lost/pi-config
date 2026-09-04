import assert from "node:assert/strict";
import test from "node:test";
import { buildExecutionAmendmentProposal, reconcileExecutionChange } from "../src/goal-engine/reconciliation.ts";
import { applyEvent, createProjection } from "../src/goal-engine/events.ts";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../src/goal-engine/obligation-contract.ts";

const hash = "a".repeat(64);
const task = (status, extra = {}) => ({ status, conditionIds: ["condition-a"], writePaths: ["src/a.mjs"], budgetKeys: ["max_repairs"], ...extra });
const projection = () => ({
  goalId: "goal-1", executionRevision: 4, executionContractHash: hash,
  baseHead: "b".repeat(40), sessionId: "session-1",
  tasks: new Map([["accepted", task("accepted")], ["keep", task("pending")], ["remove", task("pending")], ["reverify", task("pending")]]),
  conditions: new Map([["condition-a", { id: "condition-a" }], ["condition-b", { id: "condition-b" }]]),
});
const change = (id, intent, expected = intent === "remove" ? "removed" : { condition: "changed" }) => ({ id, intent, expected });
const capabilityFor = (proposal) => ({ prefix: "goal-user-capability.v1", goalId: "goal-1", executionRevision: 4, proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, sessionId: "session-1", userEntryId: "entry-1", nonce: "n", singleUse: true });

test("proposal task changes are deep exact, non-empty, unique, and canonically hashed", () => {
  const first = buildExecutionAmendmentProposal({ projection: projection(), reason: "user request", changes: { tasks: [change("reverify", "change")] } });
  const second = buildExecutionAmendmentProposal({ projection: projection(), reason: "user request", changes: { tasks: [{ expected: { condition: "changed" }, intent: "change", id: "reverify" }] } });
  assert.equal(first.changesHash, second.changesHash);
  for (const changes of [
    { tasks: [{ id: "reverify", intent: "change" }] },
    { tasks: [change("reverify", "change", {})] },
    { tasks: [change("reverify", "change", { unknown: true })] },
    { tasks: [change("reverify", "change", { writePolicy: { unknown: true } })] },
    { tasks: [change("reverify", "change"), change("reverify", "remove")] },
    { tasks: [{ id: "reverify", intent: "remove", expected: { condition: "no" } }] },
    { conditions: [{ id: "condition-a", intent: "change", expected: { statement: "new", unknown: true } }] },
    { writePolicy: { allowedPaths: ["src/a.mjs"], unknown: true } },
    { budget: { max_repairs: 2, unknown: 1 } },
  ]) assert.throws(() => buildExecutionAmendmentProposal({ projection: projection(), reason: "x", changes }), /invalid|empty|duplicate|permitted/);
});

test("table-driven reconciliation matrix is complete, canonical, and keeps accepted history", () => {
  const cases = [
    { name: "unaffected task", changes: { tasks: [change("reverify", "change")] }, id: "keep", action: "keep" },
    { name: "explicit removal", changes: { tasks: [change("remove", "remove")] }, id: "remove", action: "supersede" },
    { name: "definition change", changes: { tasks: [change("reverify", "change")] }, id: "reverify", action: "reverify" },
    { name: "new task", changes: { tasks: [change("new", "add", { condition: "new" })] }, id: "new", action: "add" },
    { name: "accepted future applicability change", changes: { tasks: [change("accepted", "change")] }, id: "accepted", action: "keep", applicability: true },
  ];
  for (const entry of cases) {
    const proposal = buildExecutionAmendmentProposal({ projection: projection(), reason: entry.name, changes: entry.changes });
    const result = reconcileExecutionChange({ projection: projection(), proposal, capability: capabilityFor(proposal) });
    assert.equal(result.actions.find((action) => action.entityId === entry.id).action, entry.action, entry.name);
    assert.deepEqual(result.actions.map((action) => action.entityId), [...result.actions.map((action) => action.entityId)].sort(), entry.name);
    if (entry.applicability) assert.ok(result.applicabilityFacts.some((fact) => fact.taskId === "accepted" && fact.state === "reverify_required"));
  }
});

test("condition, write policy, and budget changes trace impact and fail closed when relation is unknown", () => {
  for (const changes of [
    { conditions: [change("condition-a", "change", { statement: "new" })] },
    { writePolicy: { allowedPaths: ["src/other.mjs"] } },
    { budget: { max_repairs: 1 } },
  ]) {
    const proposal = buildExecutionAmendmentProposal({ projection: projection(), reason: "global change", changes });
    const result = reconcileExecutionChange({ projection: projection(), proposal, capability: capabilityFor(proposal) });
    assert.equal(result.actions.find((action) => action.entityId === "reverify").action, "reverify");
    assert.ok(result.conditionFacts.length > 0);
  }
  const unknown = { ...projection(), tasks: new Map([["unknown", { status: "pending" }]]) };
  const proposal = buildExecutionAmendmentProposal({ projection: unknown, reason: "unknown impact", changes: { conditions: [change("condition-a", "change", { statement: "new" })] } });
  const result = reconcileExecutionChange({ projection: unknown, proposal, capability: capabilityFor(proposal) });
  assert.equal(result.actions[0].action, "block_until_terminal");
  assert.equal(result.applyAllowed, false);
  assert.deepEqual(result.events, []);
});

test("only affected identity-bound active debt blocks and never consumes capability", () => {
  const proposal = buildExecutionAmendmentProposal({ projection: projection(), reason: "remove", changes: { tasks: [change("remove", "remove")] } });
  const unrelated = reconcileExecutionChange({ projection: projection(), proposal, capability: capabilityFor(proposal), inventories: { activeRuns: [{ taskId: "keep", runId: "run-keep", state: "active" }] } });
  assert.equal(unrelated.actions.find((action) => action.entityId === "remove").action, "supersede");
  const blocked = reconcileExecutionChange({ projection: projection(), proposal, capability: capabilityFor(proposal), inventories: { activeRuns: [{ taskId: "remove", runId: "run-remove", state: "active" }], workspaces: [{ taskId: "remove", state: "terminal", quarantined: false }], resources: [{ taskId: "remove", released: false }] } });
  assert.equal(blocked.actions.find((action) => action.entityId === "remove").action, "block_until_terminal");
  assert.equal(blocked.applyAllowed, false);
  assert.deepEqual(blocked.events, []);
  assert.ok(blocked.attention.length > 0);
});

test("durable active Task state and active projection bindings block even with empty inventories", () => {
  for (const extra of [
    { status: "dispatched" }, { status: "running" }, { status: "settling" }, { status: "disposing" },
    { workspace: { state: "active" } }, { executorBinding: { state: "active" } },
  ]) {
    const active = projection();
    active.tasks.set("remove", task(extra.status || "pending", extra));
    const proposal = buildExecutionAmendmentProposal({ projection: active, reason: "active projection", changes: { tasks: [change("remove", "remove")] } });
    const result = reconcileExecutionChange({ projection: active, proposal, capability: capabilityFor(proposal), inventories: {} });
    assert.equal(result.actions.find((action) => action.entityId === "remove").action, "block_until_terminal");
    assert.equal(result.applyAllowed, false);
    assert.deepEqual(result.events, []);
  }
});

test("Task and Condition intents must match projection existence before reconciliation", () => {
  for (const changes of [
    { tasks: [change("keep", "add", { condition: "duplicate" })] },
    { tasks: [change("missing-task", "change")] },
    { tasks: [change("missing-task", "remove")] },
    { conditions: [change("condition-a", "add", { statement: "duplicate" })] },
    { conditions: [change("missing-condition", "change", { statement: "missing" })] },
    { conditions: [change("missing-condition", "remove")] },
  ]) assert.throws(() => buildExecutionAmendmentProposal({ projection: projection(), reason: "existence mismatch", changes }), /exist|intent|projection/);
});

test("accepted remove is kept and marks only applicability, while accepted change uses real Condition IDs", () => {
  const removed = buildExecutionAmendmentProposal({ projection: projection(), reason: "accepted remove", changes: { tasks: [change("accepted", "remove")] } });
  const removeResult = reconcileExecutionChange({ projection: projection(), proposal: removed, capability: capabilityFor(removed) });
  assert.equal(removeResult.actions.find((action) => action.entityId === "accepted").action, "keep");
  assert.deepEqual(removeResult.applicabilityFacts, [{ taskId: "accepted", state: "superseded", revision: 5, reason: "task_remove" }]);
  assert.deepEqual(removeResult.conditionFacts, []);

  const fact = removeResult.applicabilityFacts[0];
  let runtime = applyEvent(createProjection(), { schemaVersion: "goal-runtime.v1", eventId: "runtime-draft", goalId: "runtime-goal", occurredAt: "2026-08-13T00:00:01.000Z", type: "goal.runtime_drafted", data: { baseHead: "b".repeat(40), runtimeInit: normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries), executionContractHash: hashRuntimeExecutionContract(normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries)), readiness: "draft" } });
  const runtimeTask = runtime.tasks.get("task-1");
  const runtimeApplicability = runtime.taskApplicability.get("task-1");
  runtime.tasks.delete("task-1");
  runtime.taskApplicability.delete("task-1");
  runtime.tasks.set("accepted", { ...runtimeTask, status: "accepted" });
  runtime.taskApplicability.set("accepted", runtimeApplicability);
  runtime.executionRevision = fact.revision;
  const applicabilityEventData = (({ taskId, state, reason }) => ({ taskId, state, reason }))(fact);
  assert.deepEqual(Object.keys(applicabilityEventData), ["taskId", "state", "reason"]);
  runtime = applyEvent(runtime, { schemaVersion: "goal-runtime.v1", eventId: "runtime-applicability", goalId: "runtime-goal", occurredAt: "2026-08-13T00:00:02.000Z", type: "task.applicability_changed", data: applicabilityEventData });
  assert.deepEqual(runtime.taskApplicability.get("accepted"), { revision: fact.revision, state: "superseded", reason: "task_remove" });
  assert.equal(runtime.tasks.get("accepted").status, "accepted");

  const changed = buildExecutionAmendmentProposal({ projection: projection(), reason: "accepted change", changes: { tasks: [change("accepted", "change")] } });
  const changeResult = reconcileExecutionChange({ projection: projection(), proposal: changed, capability: capabilityFor(changed) });
  assert.ok(changeResult.conditionFacts.length > 0);
  assert.ok(changeResult.conditionFacts.every((fact) => projection().conditions.has(fact.conditionId)));
  assert.ok(changeResult.conditionFacts.every((fact) => fact.conditionId !== "accepted"));
});

test("canonical atomic batch rejects durable nonce replay only after no-block reconciliation", () => {
  const proposal = buildExecutionAmendmentProposal({ projection: projection(), reason: "change", changes: { tasks: [change("reverify", "change")] } });
  const capability = capabilityFor(proposal);
  const result = reconcileExecutionChange({ projection: projection(), proposal, capability });
  assert.deepEqual(result.events.map((event) => event.type), ["execution.amendment_capability_consumed", "execution.amendment_applied"]);
  assert.throws(() => reconcileExecutionChange({ projection: { ...projection(), consumedCapabilityNonceDigests: new Set([result.nonceDigest]) }, proposal, capability }), /consumed/);
});
