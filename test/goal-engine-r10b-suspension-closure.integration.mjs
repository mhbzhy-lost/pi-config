import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { applyEvent, createProjection } from "../src/goal-engine/events.ts";
import { buildSuspensionPlan, inspectSuspensionCompletion, suspensionClosureHash } from "../src/goal-engine/suspension.ts";

const hash = (char) => char.repeat(64);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const closureHash = (closure) => createHash("sha256").update(JSON.stringify(canonical(closure))).digest("hex");

function event(type, data, number) {
  return { schemaVersion: "goal-runtime.v1", eventId: `suspension-${number}`, goalId: "goal-suspension", occurredAt: `2026-08-21T00:00:${String(number).padStart(2, "0")}.000Z`, type, data };
}

function active() {
  const projection = createProjection();
  Object.assign(projection, { goalId: "goal-suspension", eventSchemaVersion: "goal-runtime.v1", runtimeGeneration: "goal-runtime.v1", lifecycle: "active", runtimeState: "active", actionOffer: { id: "offer-1", active: true } });
  projection.tasks = new Map([
    ["task-a", { attempts: 2, executorBinding: { runId: "run-a" }, evidence: [], deps: [] }],
    ["task-unrelated", { attempts: 1, executorBinding: { runId: "run-unrelated" }, evidence: [], deps: [] }],
  ]);
  return projection;
}

const initial = { suspensionId: "suspension-1", reason: "abort", affectedTaskIds: ["task-a"], affectedRunIds: ["run-a"], requestedAt: "2026-08-21T00:00:01.000Z", resourcesQuarantined: false };
const terminal = { runId: "run-a", proofHash: hash("a"), state: "observed" };
const workspace = { taskId: "task-a", attempt: 2, proofHash: hash("b"), state: "quarantined", disposition: "preserved" };
const resource = { ownerId: "run-a", proofHash: hash("c"), state: "quarantined", debt: true };

test("suspension plan emits one sorted initial ledger event and reducer accepts only monotonic typed closure proof additions", () => {
  const plan = buildSuspensionPlan({ projection: active(), reason: "abort", affectedIds: { taskIds: ["task-z", "task-a"], runIds: ["run-z", "run-a"] } });
  assert.deepEqual(plan.events.map(({ type }) => type), ["goal.runtime_suspended"]);
  assert.deepEqual(plan.events[0].data.affectedTaskIds, ["task-a", "task-z"]);
  assert.deepEqual(plan.events[0].data.affectedRunIds, ["run-a", "run-z"]);
  assert.deepEqual(Object.keys(plan.events[0].data).sort(), ["affectedRunIds", "affectedTaskIds", "reason", "requestedAt", "resourcesQuarantined", "suspensionId"]);

  let projection = applyEvent(active(), event("goal.runtime_suspended", initial, 1));
  assert.throws(() => applyEvent(active(), event("goal.runtime_suspended", { ...initial, terminalProofRefs: [terminal] }, 2)), /suspension/i, "initial suspension must not carry closure proof refs");

  const partial = { ...initial, terminalProofRefs: [terminal], workspaceClosureProofRefs: [], resourceClosureProofRefs: [] };
  projection = applyEvent(projection, event("goal.runtime_suspended", partial, 2));
  assert.deepEqual(projection.suspension, partial);
  assert.throws(() => applyEvent(projection, event("goal.runtime_suspended", { ...partial, terminalProofRefs: [] }, 3)), /suspension|closure/i, "closure proof refs cannot be removed or replaced");

  const full = { ...initial, resourcesQuarantined: true, terminalProofRefs: [terminal], workspaceClosureProofRefs: [workspace], resourceClosureProofRefs: [resource] };
  projection = applyEvent(projection, event("goal.runtime_suspended", full, 3));
  assert.deepEqual(projection.suspension, full);
  assert.throws(() => applyEvent(projection, event("goal.runtime_suspended", { ...full, workspaceClosureProofRefs: [{ ...workspace, disposition: "discarded", state: "released" }] }, 4)), /suspension|closure/i, "a preserve receipt remains a quarantined preserved closure proof");

  assert.equal(suspensionClosureHash(full), closureHash(full));
  const resumed = applyEvent(projection, event("goal.runtime_resumed", { suspensionId: initial.suspensionId, closureHash: suspensionClosureHash(full) }, 4));
  assert.equal(resumed.runtimeState, "active");
  assert.equal(resumed.suspension, null);
  assert.throws(() => applyEvent(projection, event("goal.runtime_resumed", { suspensionId: initial.suspensionId, closureHash: hash("d") }, 5)), /resume|closure|suspension/i);
  assert.throws(() => applyEvent(projection, event("goal.runtime_resumed", {}, 6)), /resume|closure|suspension/i);
});

test("closure updates permit the released/discarded and debt-free literal while rejecting integrated, cross-identity, and debt mismatches", () => {
  const releasedWorkspace = { ...workspace, state: "released", disposition: "discarded" };
  const releasedResource = { ...resource, state: "released", debt: false };
  const full = { ...initial, terminalProofRefs: [terminal], workspaceClosureProofRefs: [releasedWorkspace], resourceClosureProofRefs: [releasedResource] };
  let projection = applyEvent(active(), event("goal.runtime_suspended", initial, 1));
  projection = applyEvent(projection, event("goal.runtime_suspended", full, 2));
  assert.deepEqual(projection.suspension, full);
  for (const invalid of [
    { ...full, workspaceClosureProofRefs: [{ ...releasedWorkspace, disposition: "integrated" }] },
    { ...full, workspaceClosureProofRefs: [{ ...releasedWorkspace, taskId: "task-unrelated" }] },
    { ...full, resourceClosureProofRefs: [{ ...releasedResource, ownerId: "run-unrelated" }] },
    { ...full, resourceClosureProofRefs: [{ ...releasedResource, debt: true }] },
  ]) assert.throws(() => applyEvent(applyEvent(active(), event("goal.runtime_suspended", initial, 3)), event("goal.runtime_suspended", invalid, 4)), /suspension|closure/i);
});

test("completion inspection uses only ledger affected identities and returns attention for missing, conflicting, or wrong closure proof identity", () => {
  const projection = { ...active(), runtimeState: "suspended", suspension: initial };
  const completion = inspectSuspensionCompletion({ projection, stopProofs: [terminal], workspaceInventories: [workspace], resourceProofs: [resource] });
  assert.equal(completion.complete, true, "an unrelated executor binding cannot block this suspension closure");
  assert.equal(completion.attention, false);

  for (const proof of [{ ...terminal, runId: "run-other" }, { ...terminal, conflict: true }, { ...terminal, proofHash: "not-a-hash" }]) {
    const inspected = inspectSuspensionCompletion({ projection, stopProofs: [proof], workspaceInventories: [workspace], resourceProofs: [resource] });
    assert.equal(inspected.complete, false);
    assert.equal(inspected.attention, true);
  }
  for (const input of [
    { workspaceInventories: [{ ...workspace, attempt: 1 }] },
    { resourceProofs: [{ ...resource, ownerId: "run-other" }] },
  ]) {
    const inspected = inspectSuspensionCompletion({ projection, stopProofs: [terminal], workspaceInventories: input.workspaceInventories || [workspace], resourceProofs: input.resourceProofs || [resource] });
    assert.equal(inspected.complete, false);
    assert.equal(inspected.attention, true);
  }
});
