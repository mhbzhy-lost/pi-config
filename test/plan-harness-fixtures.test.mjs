import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourcePlan = path.join(repoRoot, "test", "fixtures", "plan-harness", "plans", "parallel-success.md");
const sourceResourcePlan = path.join(repoRoot, "test", "fixtures", "plan-harness", "plans", "resource-serialized.md");

test("parallel and resource Harness fixtures are strict v3 contracts", async () => {
  const [parallel, resource] = await Promise.all([
    readFile(sourcePlan, "utf8").then((source) => parsePlanDocument(source, sourcePlan)),
    readFile(sourceResourcePlan, "utf8").then((source) => parsePlanDocument(source, sourceResourcePlan)),
  ]);

  for (const plan of [parallel, resource]) {
    assert.equal(plan.schemaVersion, "pi-plan.v3");
    assert.equal(plan.revision, 1);
    assert.equal(plan.parentPlanHash, null);
    assert.ok(plan.instructions.length > 0);
    assert.equal(plan.verification[0].cwd, ".");
    assert.equal(plan.verification[0].timeoutMs, 120_000);
    assert.ok(plan.tasks.every((task) => task.execution.agent === "executor" && task.execution.timeoutMs === 120_000));
    assert.equal(plan.tasks.length, 2);
    assert.ok(plan.tasks.every((task) => task.body.length > 0));
  }
  assert.deepEqual(parallel.verification.map((command) => command.id), ["plan:worker-1", "plan:worker-2"]);
  assert.deepEqual(parallel.tasks.map((task) => task.acceptance.commandIds), [["plan:worker-1"], ["plan:worker-2"]]);
  assert.equal(resource.verification[0].command, "test -f one.txt && test -f two.txt");
  assert.deepEqual(resource.resourceCapacities, { xcode: 1 });
  assert.ok(resource.tasks.every((task) => task.resources.some((resource) => resource.id === "xcode" && resource.mode === "exclusive")));
  assert.ok(resource.tasks.every((task) => task.acceptance.strategy === "structural-only"
    && task.acceptance.reason === "Harness 仅验证资源串行与路径所有权，文件组合在最终 Gate 验证"));
});
