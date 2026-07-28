import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  createResourceClaimSet,
  selectAuthorizedFrontier,
} from "../scripts/lib/plan/resource-locks.mjs";
import { authorizedFrontier } from "../scripts/lib/plan/ir/index.mjs";

function node(id, { allowedPaths = [`src/${id}/**`], resources = [], planOrder } = {}) {
  return { id, deps: [], allowedPaths, resources, ...(planOrder === undefined ? {} : { planOrder }) };
}

describe("selectAuthorizedFrontier", () => {
  it("greedily authorizes exclusive resources in plan order while preserving unrelated work", () => {
    const nodes = [
      node("task-a", { resources: [{ id: "xcode", mode: "exclusive" }] }),
      node("task-b", { resources: [{ id: "xcode", mode: "exclusive" }] }),
      node("task-c", { allowedPaths: ["docs/**"] }),
    ];
    assert.deepEqual(
      selectAuthorizedFrontier(nodes, { capacities: { xcode: 1 }, claims: [] }).map((candidate) => candidate.id),
      ["task-a", "task-c"],
    );
  });

  it("uses one capacity unit per shared claim and lets exclusive claims consume the whole resource", () => {
    const shared = [
      node("task-a", { resources: [{ id: "provider", mode: "shared" }] }),
      node("task-b", { resources: [{ id: "provider", mode: "shared" }] }),
      node("task-c", { resources: [{ id: "provider", mode: "shared" }] }),
    ];
    assert.deepEqual(
      selectAuthorizedFrontier(shared, { capacities: { provider: 2 }, claims: [] }).map(({ id }) => id),
      ["task-a", "task-b"],
    );
    assert.deepEqual(
      selectAuthorizedFrontier([
        node("task-exclusive", { resources: [{ id: "provider", mode: "exclusive" }] }),
        ...shared,
      ], { capacities: { provider: 3 }, claims: [] }).map(({ id }) => id),
      ["task-exclusive"],
    );
  });

  it("treats overlapping path ownership as exclusive", () => {
    const nodes = [
      node("task-a", { allowedPaths: ["src/**"] }),
      node("task-b", { allowedPaths: ["src/feature.mjs"] }),
      node("task-c", { allowedPaths: ["test/**"] }),
    ];
    assert.deepEqual(
      selectAuthorizedFrontier(nodes, { capacities: {}, claims: [] }).map(({ id }) => id),
      ["task-a", "task-c"],
    );
  });

  it("loads active claims, rejects unknown resources, and releases every claim for an attempt", () => {
    const claims = createResourceClaimSet({ capacities: { xcode: 1 } });
    const first = node("task-a", { resources: [{ id: "xcode", mode: "exclusive" }] });
    const second = node("task-b", { resources: [{ id: "xcode", mode: "shared" }] });
    claims.acquire(first, "attempt-a");
    assert.equal(claims.canAcquire(second), false);
    assert.throws(
      () => claims.canAcquire(node("task-c", { resources: [{ id: "unknown", mode: "shared" }] })),
      (error) => error.code === "UNKNOWN_RESOURCE",
    );
    assert.deepEqual(claims.snapshot().map((claim) => claim.resourceId), ["path:src/task-a/**", "xcode"]);
    claims.release("attempt-a");
    assert.equal(claims.canAcquire(second), true);
  });

  it("is stable when candidates are shuffled but retain plan order", () => {
    const a = node("task-a", { planOrder: 0, resources: [{ id: "xcode", mode: "exclusive" }] });
    const b = node("task-b", { planOrder: 1, resources: [{ id: "xcode", mode: "exclusive" }] });
    const select = (nodes) => selectAuthorizedFrontier(nodes, { capacities: { xcode: 1 }, claims: [] }).map(({ id }) => id);
    assert.deepEqual(select([a, b]), ["task-a"]);
    assert.deepEqual(select([b, a]), ["task-a"]);
  });

  it("rejects conflicting hydrated snapshots instead of overcommitting after recovery", () => {
    assert.throws(
      () => createResourceClaimSet({
        capacities: { xcode: 1 },
        claims: [
          { attemptId: "attempt-a", nodeId: "task-a", resourceId: "xcode", mode: "shared" },
          { attemptId: "attempt-b", nodeId: "task-b", resourceId: "xcode", mode: "shared" },
        ],
      }),
      (error) => error.code === "CLAIM_SNAPSHOT_CONFLICT",
    );
    assert.throws(
      () => createResourceClaimSet({
        capacities: {},
        claims: [
          { attemptId: "attempt-a", nodeId: "task-a", resourceId: "path:src/**", mode: "exclusive", path: "src/**" },
          { attemptId: "attempt-b", nodeId: "task-b", resourceId: "path:src/a.mjs", mode: "exclusive", path: "src/a.mjs" },
        ],
      }),
      (error) => error.code === "CLAIM_SNAPSHOT_CONFLICT",
    );
  });

  it("hydrates an existing active claim snapshot", () => {
    const active = createResourceClaimSet({ capacities: { xcode: 1 } });
    active.acquire(node("active", { allowedPaths: ["other/**"], resources: [{ id: "xcode", mode: "exclusive" }] }), "attempt-active");
    const candidates = [
      node("blocked", { resources: [{ id: "xcode", mode: "shared" }] }),
      node("free", { allowedPaths: ["docs/**"] }),
    ];
    assert.deepEqual(
      selectAuthorizedFrontier(candidates, { capacities: { xcode: 1 }, claims: active.snapshot() }).map(({ id }) => id),
      ["free"],
    );
  });
});

test("authorizedFrontier rebuilds active claims and returns an empty frontier while work can release them", () => {
  const ir = {
    version: "plan-ir.v2",
    resourceCapacities: { xcode: 1 },
    nodes: [
      { ...node("task-a", { resources: [{ id: "xcode", mode: "exclusive" }] }), deps: [] },
      { ...node("task-b", { resources: [{ id: "xcode", mode: "exclusive" }] }), deps: [] },
    ],
  };
  const projection = {
    tasks: new Map([["task-a", { status: "pending" }], ["task-b", { status: "pending" }]]),
    attempts: new Map([["attempt-a", {
      attemptId: "attempt-a",
      taskId: "task-a",
      status: "active",
      workspaceReleased: false,
    }]]),
  };
  assert.deepEqual(authorizedFrontier(ir, projection), []);

  projection.attempts.get("attempt-a").workspaceReleased = true;
  assert.deepEqual(authorizedFrontier(ir, projection).map(({ id }) => id), ["task-a"]);
});

test("authorizedFrontier returns a structured deadlock when no active attempt can make progress", () => {
  const ir = {
    version: "plan-ir.v2",
    resourceCapacities: {},
    nodes: [
      { ...node("task-a"), deps: [] },
      { ...node("task-b"), deps: ["task-a"] },
    ],
  };
  const projection = {
    tasks: new Map([["task-a", { status: "cancelled" }], ["task-b", { status: "pending" }]]),
    attempts: new Map(),
  };
  assert.deepEqual(authorizedFrontier(ir, projection), {
    code: "PLAN_AUTHORIZATION_DEADLOCK",
    remainingTaskIds: ["task-b"],
    reason: "dependencies cannot reach an integrated state",
  });
});
