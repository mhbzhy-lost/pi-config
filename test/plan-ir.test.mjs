import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compilePlanToIR, runnableFrontier } from "../scripts/lib/plan/ir/index.mjs";

function makePlan(tasks) {
  return { title: "Test Plan", tasks, verification: ["echo ok"], sha256: "abc123" };
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
