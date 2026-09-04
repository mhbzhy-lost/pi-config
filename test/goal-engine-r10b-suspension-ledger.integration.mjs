import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { applyEvent, createProjection } from "../src/goal-engine/events.ts";
import { issueActionOffer, verifyAndConsumeActionOffer } from "../src/goal-engine/action-offer.ts";
import { actionableFrontier } from "../src/goal-engine/obligation-policy.ts";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../src/goal-engine/obligation-contract.ts";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const runtimeEvent = (type, data, sequence) => ({ schemaVersion: "goal-runtime.v1", eventId: `r10b-${sequence}`, goalId: "r10b-goal", occurredAt: `2026-08-20T00:00:${String(sequence).padStart(2, "0")}.000Z`, type, data });
const contract = () => {
  const fixture = runtimeInit();
  const tasks = ["task-1", "integrate", "discard", "preserve", "accept", "dispatch"].map((id) => ({ ...fixture.execution.tasks[0], id }));
  const condition = { ...fixture.execution.conditions[0], depends_on: [] };
  return normalizeRuntimeGoalInit(runtimeInit({ execution: { ...fixture.execution, tasks, conditions: [condition] } }), runtimeRegistries);
};

function drafted() {
  const runtimeInit = contract();
  let projection = applyEvent(createProjection(), runtimeEvent("goal.runtime_drafted", { runtimeInit, executionContractHash: hashRuntimeExecutionContract(runtimeInit), baseHead: "a".repeat(40) }, 1));
  return applyEvent(projection, runtimeEvent("goal.session_bound", { sessionId: "r10b-session", leafId: "r10b-leaf" }, 2));
}
function awaitingApproval() { return applyEvent(drafted(), runtimeEvent("goal.runtime_readiness_recorded", { readiness: "ready", reasons: [] }, 3)); }
function calibrating() {
  const projection = awaitingApproval();
  const approval = { proposalId: "r10b-proposal", executionContractHash: projection.executionContractHash, baseHead: projection.runtimeBaseHead, sessionId: "r10b-session" };
  const proposalHash = hash(JSON.stringify(Object.fromEntries(Object.entries({ ...approval, goalId: projection.goalId }).sort())));
  return applyEvent(projection, runtimeEvent("goal.runtime_approval_recorded", { ...approval, proposalHash, userEntryId: "r10b-entry", capabilityDigest: "b".repeat(64) }, 4));
}
function observationEvents(projection, { runId, evidenceId, cycle, start, recorded = false }) {
  const data = { runId, conditionId: "condition-1" };
  const request = { ...data, cycle, head: "a".repeat(40), executionRevision: projection.executionRevision, executionContractHash: projection.executionContractHash, conditionHash: projection.conditions.get("condition-1").conditionHash, adapter: { ref: "oracle", version: "1" }, worldSnapshotHash: String(start).padStart(64, "0"), resourceClaimsHash: String(start + 1).padStart(64, "0") };
  const events = [runtimeEvent("condition.observation_requested", request, start), runtimeEvent("condition.observation_lease_allocated", { ...data, allocationId: `lease-${runId}`, leaseReceiptHash: String(start + 2).padStart(64, "0") }, start + 1), runtimeEvent("condition.observation_process_bound", { ...data, processIdentityHash: String(start + 3).padStart(64, "0") }, start + 2), runtimeEvent("condition.observation_terminal", { ...data, terminalProofHash: String(start + 4).padStart(64, "0") }, start + 3)];
  if (recorded) events.push(runtimeEvent("condition.observation_recorded", { ...data, evidenceId, verdict: { kind: "passed" }, evidence: { executionRevision: projection.executionRevision, executionContractHash: projection.executionContractHash, conditionHash: projection.conditions.get("condition-1").conditionHash, head: "a".repeat(40), adapter: { ref: "oracle", version: "1" }, environment: { ref: "local", fingerprint: "environment-r10b" }, fixtures: [{ ref: "sample", fingerprint: "fixture-r10b" }], artifact: { id: `artifact-${runId}`, hash: "d".repeat(64) } } }, start + 4));
  return events;
}
function applyAll(projection, events) { for (const event of events) projection = applyEvent(projection, event); return projection; }
function active() {
  let projection = calibrating();
  projection = applyAll(projection, observationEvents(projection, { runId: "calibration-run", evidenceId: "e".repeat(64), cycle: 0, start: 5, recorded: true }));
  return applyEvent(projection, runtimeEvent("goal.runtime_activated", {}, 10));
}
function suspensionData(overrides = {}) { return { suspensionId: "r10b-suspension", reason: "host_pause", affectedTaskIds: ["task-1"], affectedRunIds: ["run-1"], requestedAt: "2026-08-20T00:00:06.000Z", resourcesQuarantined: false, ...overrides }; }
function world() { return { safe: true, repo: { head: "a".repeat(40) }, resources: [], activeRuns: [], capturedAt: "2026-08-20T00:01:00.000Z" }; }

// Break caught: retaining a live offer after its canonical suspension lets its old token mutate the new ledger.
test("canonical runtime suspension atomically clears a projection-version-bound offered action", () => {
  let projection = active();
  const offer = issueActionOffer(projection, { tool: "goal_dispatch", params: { task_id: "task-1" } }, "r10b-session");
  projection = applyEvent(projection, runtimeEvent("goal.action_offered", offer, 11));
  const suspended = applyEvent(projection, runtimeEvent("goal.runtime_suspended", suspensionData(), 12));
  assert.equal(suspended.runtimeState, "suspended");
  assert.equal(suspended.actionOffer, null);
  assert.throws(() => verifyAndConsumeActionOffer(suspended, { token: offer.token, tool: offer.tool, params: offer.params, sessionId: "r10b-session" }), /no action offer/);
});

test("runtime suspension accepts only the six-field initial SuspensionState", () => {
  const suspended = applyEvent(active(), runtimeEvent("goal.runtime_suspended", suspensionData(), 11));
  assert.deepEqual(suspended.suspension, suspensionData());
});

for (const [name, data] of [
  ["unknown reason", suspensionData({ reason: "pause" })],
  ["duplicate task IDs", suspensionData({ affectedTaskIds: ["task-1", "task-1"] })],
  ["unsorted run IDs", suspensionData({ affectedRunIds: ["run-2", "run-1"] })],
  ["non-ISO requestedAt", suspensionData({ requestedAt: "tomorrow" })],
  ["pre-quarantined resources", suspensionData({ resourcesQuarantined: true })],
  ["extra proof field", { ...suspensionData(), proof: "later-lane" }],
]) test(`runtime suspension rejects ${name}`, () => {
  assert.throws(() => applyEvent(active(), runtimeEvent("goal.runtime_suspended", data, 11)), /suspension|exact|invalid/i);
});

for (const [name, projection] of [["draft", drafted()], ["awaiting approval", awaitingApproval()], ["calibrating", calibrating()]]) test(`runtime suspension rejects ${name} rather than active runtime`, () => {
  assert.throws(() => applyEvent(projection, runtimeEvent("goal.runtime_suspended", suspensionData(), 9)), /suspension|active/i);
});

// Initial suspension closure data is a test-only incomplete projection (AGENTS category 2), so it must not preserve the old resume behavior.
test("suspended frontier exposes incomplete closure blockers and only resumes after full closure", () => {
  let projection = active();
  projection = applyAll(projection, observationEvents(projection, { runId: "terminal-run", evidenceId: "f".repeat(64), cycle: 1, start: 11 }));
  projection = applyAll(projection, observationEvents(projection, { runId: "recorded-run", evidenceId: "1".repeat(64), cycle: 2, start: 15, recorded: true }));
  projection = applyEvent(projection, runtimeEvent("goal.runtime_suspended", suspensionData(), 20));
  const taskActions = new Map([
    ["task-1", { requiredNextAction: { tool: "goal_settle", params: {}, reason: "terminal executor fact" } }],
    ["integrate", { requiredNextAction: { tool: "goal_integrate", params: { action: "integrate" }, reason: "business integration" } }],
    ["discard", { requiredNextAction: { tool: "goal_integrate", params: { action: "discard" }, reason: "workspace safety debt" } }],
    ["preserve", { requiredNextAction: { tool: "goal_integrate", params: { action: "preserve" }, reason: "workspace safety debt" } }],
    ["accept", { requiredNextAction: { tool: "goal_accept", params: {}, reason: "business acceptance" } }],
    ["dispatch", { requiredNextAction: { tool: "goal_dispatch", params: {}, reason: "business dispatch" } }],
  ]);
  const frontier = actionableFrontier({ projection, worldSnapshot: world(), taskActions, observationInventory: { claims: new Map() } });
  assert.deepEqual(frontier.actions.map(({ tool, params }) => [tool, params]), [
    ["goal_amend", { operation: "abandon_runtime" }],
  ]);
  assert.equal(frontier.actions.some(({ tool }) => tool !== "goal_amend"), false);
  assert.equal(frontier.actions.some(({ tool, params }) => tool === "goal_amend" && params.operation !== "abandon_runtime"), false);
  assert.deepEqual(frontier.blocking.map(item => item.code).filter(code => code.startsWith("SUSPENSION_")).sort(), ["SUSPENSION_RESOURCE_CLOSURE_PENDING", "SUSPENSION_TERMINAL_PROOF_PENDING", "SUSPENSION_WORKSPACE_CLOSURE_PENDING"]);

  const closure = {
    ...suspensionData(),
    resourcesQuarantined: true,
    terminalProofRefs: [{ runId: "run-1", proofHash: "a".repeat(64), state: "observed" }],
    workspaceClosureProofRefs: [{ taskId: "task-1", attempt: projection.tasks.get("task-1").attempts, proofHash: "b".repeat(64), state: "quarantined", disposition: "preserved" }],
    resourceClosureProofRefs: [{ ownerId: "run-1", proofHash: "c".repeat(64), state: "quarantined", debt: true }],
  };
  projection = applyEvent(projection, runtimeEvent("goal.runtime_suspended", closure, 21));
  const complete = actionableFrontier({ projection, worldSnapshot: world(), taskActions, observationInventory: { claims: new Map() } });
  assert.equal(complete.actions.filter(({ tool, params }) => tool === "goal_amend" && params.operation === "resume_runtime").length, 1);
});
