import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compilePlanToIR, runnableFrontier } from "../scripts/lib/plan/ir/index.mjs";
import { pathsOverlap } from "../scripts/lib/plan/ir/compile.mjs";

function makePlan(tasks, overrides = {}) {
  return {
    schemaVersion: "pi-plan.v1",
    title: "Test Plan",
    tasks,
    verification: ["echo ok"],
    sha256: "abc123",
    ...overrides,
  };
}

describe("compilePlanToIR", () => {
  it("compiles a linear dependency chain", () => {
    const plan = makePlan([
      { id: "task-1", title: "First", deps: [], files: ["a.ts"], body: "" },
      { id: "task-2", title: "Second", deps: ["task-1"], files: ["b.ts"], body: "" },
      { id: "task-3", title: "Third", deps: ["task-2"], files: ["c.ts"], body: "" },
    ]);
    const ir = compilePlanToIR(plan);
    assert.equal(ir.version, "plan-ir.v1");
    assert.equal(ir.nodes.length, 3);
    assert.deepEqual(ir.nodes.map(n => n.id), ["task-1", "task-2", "task-3"]);
    assert.equal(ir.edges.length, 2);
  });

  it("compiles a parallel DAG with multiple roots", () => {
    const plan = makePlan([
      { id: "task-1", title: "A", deps: [], files: ["a.ts"], body: "" },
      { id: "task-2", title: "B", deps: [], files: ["b.ts"], body: "" },
      { id: "task-3", title: "C", deps: ["task-1", "task-2"], files: ["c.ts"], body: "" },
    ]);
    const ir = compilePlanToIR(plan);
    assert.equal(ir.nodes.length, 3);
    assert.equal(ir.edges.length, 2);
  });

  it("compiles v2 ownership and resources into deterministic hashes", () => {
    const tasks = [
      {
        id: "task-1",
        title: "Build",
        deps: [],
        files: ["scripts/lib/runner/**", "test/runner.test.mjs"],
        allowedPaths: ["scripts/lib/runner/**", "test/runner.test.mjs"],
        resources: [{ id: "xcode", mode: "exclusive" }, { id: "provider:tbctx7", mode: "shared" }],
        body: "",
      },
    ];
    const ir = compilePlanToIR(makePlan(tasks, {
      schemaVersion: "pi-plan.v2",
      resourceCapacities: { xcode: 1, "provider:tbctx7": 4 },
    }));

    assert.equal(ir.version, "plan-ir.v2");
    assert.deepEqual(ir.resourceCapacities, { "provider:tbctx7": 4, xcode: 1 });
    assert.deepEqual(ir.nodes[0], {
      id: "task-1",
      title: "Build",
      deps: [],
      allowedPaths: ["scripts/lib/runner/**", "test/runner.test.mjs"],
      resources: [{ id: "provider:tbctx7", mode: "shared" }, { id: "xcode", mode: "exclusive" }],
      agent: "executor",
    });
    assert.match(ir.hash, /^[a-f0-9]{64}$/);
    assert.match(ir.nodeFingerprints["task-1"], /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(ir.resourceCapacities), true);
    assert.equal(Object.isFrozen(ir.nodes[0].allowedPaths), true);
    assert.equal(Object.isFrozen(ir.nodes[0].resources), true);
    assert.equal(Object.isFrozen(ir.nodeFingerprints), true);
  });

  it("keeps v2 hashes stable across resource declaration order", () => {
    const task = (resources) => ({
      id: "task-1",
      title: "Build",
      deps: [],
      files: ["src/**"],
      allowedPaths: ["src/**"],
      resources,
      body: "",
    });
    const left = compilePlanToIR(makePlan([
      task([{ id: "xcode", mode: "exclusive" }, { id: "provider:tbctx7", mode: "shared" }]),
    ], {
      schemaVersion: "pi-plan.v2",
      resourceCapacities: { xcode: 1, "provider:tbctx7": 4 },
    }));
    const right = compilePlanToIR(makePlan([
      task([{ id: "provider:tbctx7", mode: "shared" }, { id: "xcode", mode: "exclusive" }]),
    ], {
      schemaVersion: "pi-plan.v2",
      resourceCapacities: { "provider:tbctx7": 4, xcode: 1 },
    }));

    assert.equal(left.hash, right.hash);
    assert.deepEqual(left.nodeFingerprints, right.nodeFingerprints);
  });

  it("rejects overlapping ownership for nodes that can run concurrently", () => {
    const plan = makePlan([
      { id: "task-1", title: "A", deps: [], files: ["src/**"], allowedPaths: ["src/**"], resources: [], body: "" },
      { id: "task-2", title: "B", deps: [], files: ["src/feature.mjs"], allowedPaths: ["src/feature.mjs"], resources: [], body: "" },
    ], { schemaVersion: "pi-plan.v2", resourceCapacities: {} });

    assert.throws(
      () => compilePlanToIR(plan),
      (error) => error.code === "PATH_OWNERSHIP_CONFLICT" && error.detail === "task-1:src/** <-> task-2:src/feature.mjs",
    );
  });

  it("allows overlapping ownership when nodes have a transitive dependency", () => {
    const ir = compilePlanToIR(makePlan([
      { id: "task-1", title: "A", deps: [], files: ["src/**"], allowedPaths: ["src/**"], resources: [], body: "" },
      { id: "task-2", title: "B", deps: ["task-1"], files: ["middle.mjs"], allowedPaths: ["middle.mjs"], resources: [], body: "" },
      { id: "task-3", title: "C", deps: ["task-2"], files: ["src/feature.mjs"], allowedPaths: ["src/feature.mjs"], resources: [], body: "" },
    ], { schemaVersion: "pi-plan.v2", resourceCapacities: {} }));

    assert.equal(ir.nodes.length, 3);
  });

  it("rejects overlapping siblings even when they share an ancestor", () => {
    const plan = makePlan([
      { id: "task-1", title: "Root", deps: [], files: ["root.mjs"], allowedPaths: ["root.mjs"], resources: [], body: "" },
      { id: "task-2", title: "Left", deps: ["task-1"], files: ["src/**"], allowedPaths: ["src/**"], resources: [], body: "" },
      { id: "task-3", title: "Right", deps: ["task-1"], files: ["src/right.mjs"], allowedPaths: ["src/right.mjs"], resources: [], body: "" },
    ], { schemaVersion: "pi-plan.v2", resourceCapacities: {} });

    assert.throws(() => compilePlanToIR(plan), (error) => error.code === "PATH_OWNERSHIP_CONFLICT");
  });

  it("throws CYCLE_DETECTED for circular dependencies", () => {
    const plan = makePlan([
      { id: "task-1", title: "A", deps: ["task-2"], files: ["a.ts"], body: "" },
      { id: "task-2", title: "B", deps: ["task-1"], files: ["b.ts"], body: "" },
    ]);
    assert.throws(() => compilePlanToIR(plan), (err) => err.code === "CYCLE_DETECTED");
  });

  it("throws DANGLING_DEP for unknown dependency", () => {
    const plan = makePlan([
      { id: "task-1", title: "A", deps: ["task-99"], files: ["a.ts"], body: "" },
    ]);
    assert.throws(() => compilePlanToIR(plan), (err) => err.code === "DANGLING_DEP");
  });

  it("throws DUPLICATE_ID for repeated task ids", () => {
    const plan = makePlan([
      { id: "task-1", title: "A", deps: [], files: ["a.ts"], body: "" },
      { id: "task-1", title: "B", deps: [], files: ["b.ts"], body: "" },
    ]);
    assert.throws(() => compilePlanToIR(plan), (err) => err.code === "DUPLICATE_ID");
  });

  it("produces a frozen IR object", () => {
    const plan = makePlan([
      { id: "task-1", title: "A", deps: [], files: ["a.ts"], body: "" },
    ]);
    const ir = compilePlanToIR(plan);
    assert.equal(Object.isFrozen(ir), true);
    assert.equal(Object.isFrozen(ir.nodes), true);
    assert.equal(Object.isFrozen(ir.edges), true);
  });
});

describe("pathsOverlap", () => {
  it("matches exact paths and descendant prefix globs", () => {
    assert.equal(pathsOverlap("src/a.mjs", "src/a.mjs"), true);
    assert.equal(pathsOverlap("src/**", "src/a.mjs"), true);
    assert.equal(pathsOverlap("src/nested/**", "src/**"), true);
  });

  it("does not confuse adjacent prefixes", () => {
    assert.equal(pathsOverlap("src/**", "src2/a.mjs"), false);
    assert.equal(pathsOverlap("src/a.mjs", "src/b.mjs"), false);
  });
});

describe("runnableFrontier", () => {
  const plan = makePlan([
    { id: "task-1", title: "A", deps: [], files: ["a.ts"], body: "" },
    { id: "task-2", title: "B", deps: [], files: ["b.ts"], body: "" },
    { id: "task-3", title: "C", deps: ["task-1", "task-2"], files: ["c.ts"], body: "" },
    { id: "task-4", title: "D", deps: ["task-3"], files: ["d.ts"], body: "" },
  ]);
  const ir = compilePlanToIR(plan);

  it("returns all root nodes when nothing is completed", () => {
    const frontier = runnableFrontier(ir, new Set());
    assert.deepEqual(frontier.map(n => n.id).sort(), ["task-1", "task-2"]);
  });

  it("unlocks dependent nodes when deps are completed", () => {
    const frontier = runnableFrontier(ir, new Set(["task-1", "task-2"]));
    assert.deepEqual(frontier.map(n => n.id), ["task-3"]);
  });

  it("returns empty when all tasks are completed", () => {
    const frontier = runnableFrontier(ir, new Set(["task-1", "task-2", "task-3", "task-4"]));
    assert.deepEqual(frontier, []);
  });

  it("excludes active tasks from frontier", () => {
    const frontier = runnableFrontier(ir, new Set(), new Set(["task-1"]));
    assert.deepEqual(frontier.map(n => n.id), ["task-2"]);
  });

  it("does not unlock a node if only some deps are completed", () => {
    const frontier = runnableFrontier(ir, new Set(["task-1"]));
    assert.deepEqual(frontier.map(n => n.id), ["task-2"]);
  });
});
