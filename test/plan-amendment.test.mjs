import assert from "node:assert/strict";
import test from "node:test";

import { diffPlanRevisions, validateAmendment } from "../scripts/lib/plan/plan-amendment.mjs";

function hash(seed) {
  return seed.repeat(64).slice(0, 64);
}

function node(id, { full = id[5] ?? "a", effective = full, scheduling = full, resources = [] } = {}) {
  return { id, resources, hashes: { full: hash(full), effective: hash(effective), scheduling: hash(scheduling) } };
}

function ir(nodes, resourceCapacities = {}) {
  return { nodes, resourceCapacities };
}

function projection({ tasks = [], attempts = [] } = {}) {
  return {
    tasks: new Map(tasks.map(([id, status]) => [id, { status }])),
    attempts: new Map(attempts.map(([id, attempt]) => [id, attempt])),
  };
}

const oldIr = ir([
  node("task-1", { full: "a", effective: "a" }),
  node("task-2", { full: "b", effective: "b", resources: [{ id: "provider", mode: "shared" }] }),
], { provider: 2 });

test("diffs local contract changes separately from global effective rebounds", () => {
  const bodyChangedIr = ir([node("task-1", { full: "a", effective: "a" }), node("task-2", { full: "c", effective: "c" })]);
  const globalContextChangedIr = ir([node("task-1", { full: "a", effective: "d" }), node("task-2", { full: "b", effective: "e" })]);

  assert.deepEqual(diffPlanRevisions(oldIr, bodyChangedIr), {
    added: [], changed: ["task-2"], rebound: [], retired: [], unchanged: ["task-1"],
  });
  assert.deepEqual(diffPlanRevisions(oldIr, globalContextChangedIr), {
    added: [], changed: [], rebound: ["task-1", "task-2"], retired: [], unchanged: [],
  });
});

test("rejects changes to accepted and integrated task contracts but permits repair tasks", () => {
  const accepted = projection({ tasks: [["task-1", "accepted"]] });
  const integrated = projection({ tasks: [["task-1", "pending"]], attempts: [["attempt-1", { taskId: "task-1", status: "integrated" }]] });
  const changed = ir([node("task-1", { full: "c", effective: "c" }), oldIr.nodes[1]], { provider: 2 });
  const repair = ir([...oldIr.nodes, node("task-3", { full: "d", effective: "d" })], { provider: 2 });

  assert.throws(() => validateAmendment({ projection: accepted, oldIr, newIr: changed }), /accepted task contract is immutable: task-1/);
  assert.throws(() => validateAmendment({ projection: integrated, oldIr, newIr: changed }), /integrated task contract is immutable: task-1/);
  assert.doesNotThrow(() => validateAmendment({ projection: accepted, oldIr, newIr: repair }));
});

for (const status of ["workspace-allocated", "dispatch-requested", "active", "waiting-attention", "succeeded", "validated"]) {
  test(`collects ${status} attempts whose effective task contract changes`, () => {
    const current = projection({ attempts: [
      ["attempt-task-2", { taskId: "task-2", status }],
      ["attempt-task-1", { taskId: "task-1", status }],
    ] });
    const changed = ir([oldIr.nodes[0], node("task-2", { full: "c", effective: "c", resources: [{ id: "provider", mode: "shared" }] })], { provider: 2 });

    assert.deepEqual(validateAmendment({ projection: current, oldIr, newIr: changed }).supersededAttemptIds, ["attempt-task-2"]);
  });
}

test("does not collect released or terminal attempts whose effective task contract changes", () => {
  const settled = projection({ attempts: [
    ["attempt-integrated", { taskId: "task-1", status: "integrated" }],
    ...["released", "failed", "cancelled", "blocked", "interrupted"].map((status) => [`attempt-${status}`, { taskId: "task-2", status }]),
  ] });
  const changed = ir([oldIr.nodes[0], node("task-2", { full: "c", effective: "c", resources: [{ id: "provider", mode: "shared" }] })], { provider: 10 });

  assert.deepEqual(validateAmendment({ projection: settled, oldIr, newIr: changed }).supersededAttemptIds, []);
});

test("allows retirement only for pending tasks that have never been attempted", () => {
  const pending = projection({ tasks: [["task-2", "pending"]] });
  const attempted = projection({ tasks: [["task-2", "pending"]], attempts: [["attempt-2", { taskId: "task-2", status: "failed" }]] });
  const accepted = projection({ tasks: [["task-2", "accepted"]] });
  const retired = ir([oldIr.nodes[0]], { provider: 2 });

  assert.doesNotThrow(() => validateAmendment({ projection: pending, oldIr, newIr: retired }));
  assert.throws(() => validateAmendment({ projection: attempted, oldIr, newIr: retired }), /retired task has attempt history: task-2/);
  assert.throws(() => validateAmendment({ projection: accepted, oldIr, newIr: retired }), /accepted task cannot be deleted: task-2/);
});

test("rejects reuse of retired or historical task IDs", () => {
  const historical = projection({
    tasks: [["task-1", "pending"], ["task-2", "retired"]],
    attempts: [["attempt-2", { taskId: "task-2", status: "failed" }]],
  });
  const oldWithoutTaskTwo = ir([oldIr.nodes[0]], { provider: 2 });

  assert.throws(
    () => validateAmendment({ projection: historical, oldIr: oldWithoutTaskTwo, newIr: oldIr }),
    /historical task ID cannot be reused: task-2/,
  );
});

for (const status of ["workspace-allocated", "dispatch-requested", "validated", "succeeded", "blocked", "interrupted"]) {
  test(`rejects resource capacities below ${status} claims`, () => {
    const current = projection({ attempts: [
      ["attempt-2", { taskId: "task-2", status }],
    ] });
    const tooSmall = ir(oldIr.nodes, { provider: 0 });

    assert.throws(() => validateAmendment({ projection: current, oldIr, newIr: tooSmall }), /resource capacity is below active claims: provider/);
  });
}

for (const status of ["succeeded", "blocked", "interrupted"]) {
  test(`does not count ${status} resource claims after workspace release`, () => {
    const current = projection({ attempts: [
      ["attempt-2", { taskId: "task-2", status, workspaceReleased: true }],
    ] });

    assert.doesNotThrow(() => validateAmendment({ projection: current, oldIr, newIr: ir(oldIr.nodes, { provider: 0 }) }));
  });
}

test("rejects resource capacities below open claims, ignores settled claims, and returns new task hashes", () => {
  const active = projection({ attempts: [
    ["attempt-2", { taskId: "task-2", status: "active" }],
    ["attempt-3", { taskId: "task-3", status: "waiting-attention" }],
  ] });
  const withThirdTask = ir([...oldIr.nodes, node("task-3", { full: "c", effective: "c", resources: [{ id: "provider", mode: "shared" }] })], { provider: 2 });
  const tooSmall = ir(withThirdTask.nodes, { provider: 1 });

  assert.throws(() => validateAmendment({ projection: active, oldIr: withThirdTask, newIr: tooSmall }), /resource capacity is below active claims: provider/);
  const settled = projection({ attempts: [
    ...["failed", "cancelled", "integrated"].map((status) => [`attempt-${status}`, { taskId: "task-2", status }]),
  ] });
  assert.doesNotThrow(() => validateAmendment({ projection: settled, oldIr, newIr: ir(oldIr.nodes, { provider: 0 }) }));
  assert.deepEqual(validateAmendment({ projection: projection(), oldIr, newIr: oldIr }).taskHashes, {
    "task-1": { full: oldIr.nodes[0].hashes.full, effective: oldIr.nodes[0].hashes.effective, scheduling: oldIr.nodes[0].hashes.scheduling },
    "task-2": { full: oldIr.nodes[1].hashes.full, effective: oldIr.nodes[1].hashes.effective, scheduling: oldIr.nodes[1].hashes.scheduling },
  });
});
