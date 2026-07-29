import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";
import {
  PLAN_IR_V3,
  assertPlanIRV3,
  compilePlanToIR,
  selectExecutionView,
  selectSchedulingView,
  selectVerificationView,
} from "../scripts/lib/plan/ir/index.mjs";

const contract = {
  schemaVersion: "pi-plan.v3", revision: 1, parentPlanHash: null,
  verification: [{ id: "plan:test", command: "node --test", cwd: ".", timeoutMs: 900_000 }],
  requiredGates: ["deterministic", "plan-audit", "external-review", "final-completeness"],
  resourceCapacities: {},
  executionDefaults: { agent: "executor", risk: "normal", workflow: { mode: "inherit-repository" }, timeoutMs: 900_000 },
  taskExecution: {},
  taskAcceptance: { "task-1": { strategy: "commands", commandIds: ["plan:test"] } },
};

function makePlan() {
  return parsePlanDocument(`# Complete IR plan

**Goal:** preserve every approved instruction

**Architecture:** one canonical IR

## Execution Contract

\`\`\`json
${JSON.stringify(contract, null, 2)}
\`\`\`

### Task 1: Compile semantics

**Files:**
- Modify: \`src/ir.mjs\`

- [ ] Write the failing semantic hash test first
`, "/plans/v3.md");
}

function compileVariant(plan, mutate) {
  const copy = structuredClone(plan);
  mutate(copy);
  delete copy.sha256;
  copy.sha256 = createHash("sha256").update(JSON.stringify(copy)).digest("hex");
  return compilePlanToIR(copy);
}

describe("plan-ir.v3 schema", () => {
  it("compiles the complete frozen domain IR and enforces its hash change matrix", () => {
    const plan = makePlan();
    const ir = compilePlanToIR(plan);
    const bodyChanged = compileVariant(plan, (copy) => { copy.tasks[0].body += "\nChanged requirement"; });
    const pathChanged = compileVariant(plan, (copy) => { copy.tasks[0].allowedPaths = ["src/**"]; });
    const contextChanged = compileVariant(plan, (copy) => { copy.instructions += "\nNew global constraint"; });
    const verificationChanged = compileVariant(plan, (copy) => { copy.verification[0].command = "node --test test/other.test.mjs"; });

    assert.equal(ir.version, PLAN_IR_V3);
    assert.equal(ir.source.planHash, plan.sha256);
    assert.equal(ir.nodes[0].body, plan.tasks[0].body);
    assert.deepEqual(ir.nodes[0].acceptance, plan.tasks[0].acceptance);
    assert.match(ir.hash, /^[a-f0-9]{64}$/);
    assert.equal(ir.hash, ir.hashes.full);
    assert.equal(Object.isFrozen(ir.nodes[0].execution.workflow), true);
    assert.equal(assertPlanIRV3(ir), ir);

    assert.equal(bodyChanged.nodes[0].hashes.scheduling, ir.nodes[0].hashes.scheduling);
    assert.notEqual(bodyChanged.nodes[0].hashes.semantics, ir.nodes[0].hashes.semantics);
    assert.notEqual(bodyChanged.nodes[0].hashes.full, ir.nodes[0].hashes.full);
    assert.notEqual(bodyChanged.nodes[0].hashes.effective, ir.nodes[0].hashes.effective);
    assert.notEqual(pathChanged.nodes[0].hashes.scheduling, ir.nodes[0].hashes.scheduling);
    assert.notEqual(pathChanged.nodes[0].hashes.full, ir.nodes[0].hashes.full);
    assert.notEqual(pathChanged.nodes[0].hashes.effective, ir.nodes[0].hashes.effective);
    assert.equal(contextChanged.nodes[0].hashes.semantics, ir.nodes[0].hashes.semantics);
    assert.equal(contextChanged.nodes[0].hashes.full, ir.nodes[0].hashes.full);
    assert.notEqual(contextChanged.nodes[0].hashes.effective, ir.nodes[0].hashes.effective);
    assert.equal(verificationChanged.nodes[0].hashes.full, ir.nodes[0].hashes.full);
    assert.notEqual(verificationChanged.nodes[0].hashes.effective, ir.nodes[0].hashes.effective);
  });

  it("returns stateless unversioned temporary views", () => {
    const ir = compilePlanToIR(makePlan());
    const scheduling = selectSchedulingView(ir);
    const execution = selectExecutionView(ir, "task-1");
    const verification = selectVerificationView(ir, "task-1");

    assert.deepEqual(scheduling.nodes[0].deps, []);
    assert.equal(execution.task, ir.nodes[0]);
    assert.equal(verification.acceptance, ir.nodes[0].acceptance);
    for (const view of [scheduling, execution, verification]) {
      assert.equal(Object.hasOwn(view, "version"), false);
      assert.equal(Object.hasOwn(view, "hash"), false);
      assert.equal(Object.isFrozen(view), true);
    }
  });
});
