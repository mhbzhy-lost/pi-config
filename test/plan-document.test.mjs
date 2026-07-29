import assert from "node:assert/strict";
import test from "node:test";

import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";

const contract = (overrides = {}) => JSON.stringify({
  schemaVersion: "pi-plan.v1",
  verification: ["node --test"],
  requiredGates: ["deterministic", "plan-audit", "external-review", "final-completeness"],
  ...overrides,
}, null, 2);

const v2Contract = (overrides = {}) => contract({
  schemaVersion: "pi-plan.v2",
  resourceCapacities: { xcode: 1, "provider:tbctx7": 4 },
  ...overrides,
});

function document({ executionContract = contract(), tasks } = {}) {
  return `# Release plan\n\n## Execution Contract\n\n\`\`\`json\n${executionContract}\n\`\`\`\n\n${tasks ?? "### Task 1: First\n\n**Files:**\n- Create: `src/first.mjs`\n"}`;
}

const v3Contract = JSON.stringify({
  schemaVersion: "pi-plan.v3",
  revision: 1,
  parentPlanHash: null,
  verification: [
    { id: "plan:test", command: "node --test", cwd: ".", timeoutMs: 900_000 },
  ],
  requiredGates: ["deterministic", "plan-audit", "external-review", "final-completeness"],
  resourceCapacities: {},
  executionDefaults: {
    agent: "executor",
    risk: "normal",
    workflow: { mode: "inherit-repository" },
    timeoutMs: 900_000,
  },
  taskExecution: {
    "task-1": { risk: "high", workflow: { mode: "tdd" }, timeoutMs: 1_200_000 },
  },
  taskAcceptance: {
    "task-1": { strategy: "commands", commandIds: ["plan:test"] },
  },
}, null, 2);

function makeV3Document({
  planInstructions = "**Goal:** preserve every approved instruction\n\n**Architecture:** one canonical IR",
  taskInstructions = "- [ ] Write the failing semantic hash test first",
  executionContract = v3Contract,
} = {}) {
  return `# Complete IR plan\n\n${planInstructions}\n\n## Execution Contract\n\n\`\`\`json\n${executionContract}\n\`\`\`\n\n### Task 1: Compile semantics\n\n**Files:**\n- Modify: \`src/ir.mjs\`\n\n${taskInstructions}\n`;
}

test("parses v3 instructions, execution, and acceptance into canonical data", () => {
  const plan = parsePlanDocument(makeV3Document(), "/plans/v3.md");

  assert.equal(plan.schemaVersion, "pi-plan.v3");
  assert.equal(plan.revision, 1);
  assert.equal(plan.parentPlanHash, null);
  assert.match(plan.instructions, /\*\*Goal:\*\* preserve every approved instruction/);
  assert.match(plan.instructions, /\*\*Architecture:\*\* one canonical IR/);
  assert.match(plan.tasks[0].body, /Write the failing semantic hash test/);
  assert.deepEqual(plan.tasks[0].acceptance, { strategy: "commands", commandIds: ["plan:test"], reason: null });
  assert.deepEqual(plan.tasks[0].execution, {
    agent: "executor", risk: "high", workflow: { mode: "tdd" }, timeoutMs: 1_200_000,
  });
  assert.deepEqual(plan.requiredGates, ["deterministic", "plan-audit", "external-review", "final-completeness"]);

  assert.notEqual(plan.sha256, parsePlanDocument(makeV3Document({ planInstructions: "**Goal:** changed" }), "/plans/v3-instructions.md").sha256);
  assert.notEqual(plan.sha256, parsePlanDocument(makeV3Document({ taskInstructions: "- [ ] Changed task meaning" }), "/plans/v3-body.md").sha256);
  const deferredContract = JSON.parse(v3Contract);
  deferredContract.taskAcceptance["task-1"] = { strategy: "inherit-final", reason: "only verified after final integration" };
  assert.notEqual(plan.sha256, parsePlanDocument(makeV3Document({ executionContract: JSON.stringify(deferredContract) }), "/plans/v3-acceptance.md").sha256);
  const changedCommand = JSON.parse(v3Contract);
  changedCommand.verification[0].command = "node --test test";
  assert.notEqual(plan.sha256, parsePlanDocument(makeV3Document({ executionContract: JSON.stringify(changedCommand) }), "/plans/v3-command.md").sha256);
});

test("rejects incomplete and unsafe v3 contracts", () => {
  assert.throws(() => parsePlanDocument(makeV3Document({ planInstructions: "" }), "/plans/v3-no-plan.md"), /Plan instructions must be non-empty/);
  assert.throws(() => parsePlanDocument(makeV3Document({ taskInstructions: "" }), "/plans/v3-no-task.md"), /task-1: Task instructions must be non-empty/);

  const invalid = (name, mutate, expected) => {
    const value = JSON.parse(v3Contract);
    mutate(value);
    assert.throws(() => parsePlanDocument(makeV3Document({ executionContract: JSON.stringify(value) }), `/plans/${name}.md`), expected);
  };
  invalid("unknown", (value) => { value.extra = true; }, /unknown field extra/);
  invalid("missing", (value) => { delete value.revision; }, /missing field revision/);
  invalid("duplicate-command", (value) => { value.verification.push({ ...value.verification[0] }); }, /id is invalid or duplicated/);
  invalid("unsafe-cwd", (value) => { value.verification[0].cwd = "../outside"; }, /invalid repo-relative path/);
  invalid("timeout", (value) => { value.executionDefaults.timeoutMs = 999; }, /timeoutMs must be between/);
  invalid("unknown-acceptance-task", (value) => { value.taskAcceptance["task-2"] = value.taskAcceptance["task-1"]; }, /taskAcceptance.*unknown task/);
  invalid("missing-acceptance", (value) => { value.taskAcceptance = {}; }, /taskAcceptance must cover/);
  invalid("unknown-command", (value) => { value.taskAcceptance["task-1"].commandIds = ["missing"]; }, /unknown verification command/);
  invalid("workflow", (value) => { value.executionDefaults.workflow = { mode: "unsafe" }; }, /workflow is invalid/);
  invalid("risk", (value) => { value.executionDefaults.risk = "unsafe"; }, /risk is invalid/);
});

test("parses the strict task format into canonical plan data", () => {
  const plan = parsePlanDocument(document({
    tasks: "### Task 1: First\n\n**Files:**\n- Create: `src/first.mjs`\n\n### Task 2: Second\n\n**Deps:** Task 1\n\n**Files:**\n- Modify: `src/second.mjs`\n",
  }), "/plans/release.md");

  assert.deepEqual(plan.tasks, [
    { id: "task-1", title: "First", deps: [], files: ["src/first.mjs"], body: "**Files:**\n- Create: `src/first.mjs`" },
    { id: "task-2", title: "Second", deps: ["task-1"], files: ["src/second.mjs"], body: "**Deps:** Task 1\n\n**Files:**\n- Modify: `src/second.mjs`" },
  ]);
  assert.equal(plan.schemaVersion, "pi-plan.v1");
  assert.deepEqual(plan.verification, ["node --test"]);
  assert.equal(plan.sha256, "3d971d5f83ae301b1a91ceece02667d2aca37c48444e7aa0530957d187798ed8");
});

test("parses v2 path ownership, sorted resources, and capacities", () => {
  const plan = parsePlanDocument(document({
    executionContract: v2Contract(),
    tasks: "### Task 1: Build runner\n\n**Files:**\n- Create: `scripts/lib/runner/**`\n- Modify: `test/runner.test.mjs`\n\n**Resources:**\n- `xcode`: `exclusive`\n- `provider:tbctx7`: `shared`\n",
  }), "/plans/v2.md");

  assert.equal(plan.schemaVersion, "pi-plan.v2");
  assert.deepEqual(plan.tasks[0].allowedPaths, ["scripts/lib/runner/**", "test/runner.test.mjs"]);
  assert.deepEqual(plan.tasks[0].resources, [
    { id: "provider:tbctx7", mode: "shared" },
    { id: "xcode", mode: "exclusive" },
  ]);
  assert.deepEqual(plan.resourceCapacities, { "provider:tbctx7": 4, xcode: 1 });
  assert.match(plan.sha256, /^[a-f0-9]{64}$/);
});

test("parses v2 task verification command IDs into canonical data", () => {
  const plan = parsePlanDocument(document({
    executionContract: v2Contract({ taskVerification: { "task-1": ["contract:verification:1", "package:test"] } }),
  }), "/plans/task-verification.md");
  assert.deepEqual(plan.taskVerification, { "task-1": ["contract:verification:1", "package:test"] });

  for (const taskVerification of [
    { "task-2": ["package:test"] },
    { "task-1": [] },
    { "task-1": ["unsafe command"] },
  ]) {
    assert.throws(
      () => parsePlanDocument(document({ executionContract: v2Contract({ taskVerification }) }), "/plans/invalid-task-verification.md"),
      /taskVerification/i,
    );
  }
});

test("rejects invalid v2 path ownership declarations", () => {
  for (const [name, file] of [
    ["absolute", "/tmp/output"],
    ["parent", "src/../secrets"],
    ["git", ".git/**"],
    ["backslash", "src\\output.mjs"],
    ["middle-glob", "src/**/output.mjs"],
  ]) {
    const tasks = `### Task 1: Invalid path\n\n**Files:**\n- Create: \`${file}\`\n`;
    assert.throws(() => parsePlanDocument(document({ executionContract: v2Contract(), tasks }), `/plans/${name}.md`), new RegExp(`/plans/${name}\\.md.*task-1`));
  }
  assert.throws(
    () => parsePlanDocument(document({ executionContract: v2Contract(), tasks: "### Task 1: Empty\n\n**Files:**\n- Create: ``\n" }), "/plans/empty.md"),
    /\/plans\/empty\.md.*task-1/,
  );
});

test("rejects invalid v2 resources and capacities", () => {
  for (const [name, executionContract] of [
    ["zero-capacity", v2Contract({ resourceCapacities: { xcode: 0 } })],
    ["fraction-capacity", v2Contract({ resourceCapacities: { xcode: 1.5 } })],
    ["invalid-capacities", v2Contract({ resourceCapacities: [] })],
  ]) {
    assert.throws(() => parsePlanDocument(document({ executionContract }), `/plans/${name}.md`), new RegExp(`/plans/${name}\\.md`));
  }

  for (const [name, resources] of [
    ["unknown-mode", "- `xcode`: `sometimes`"],
    ["duplicate-resource", "- `xcode`: `exclusive`\n- `xcode`: `shared`"],
  ]) {
    const tasks = `### Task 1: Invalid resource\n\n**Files:**\n- Create: \`src/output.mjs\`\n\n**Resources:**\n${resources}\n`;
    assert.throws(() => parsePlanDocument(document({ executionContract: v2Contract(), tasks }), `/plans/${name}.md`), new RegExp(`/plans/${name}\\.md.*task-1`));
  }
  const missingCapacityTasks = "### Task 1: Missing capacity\n\n**Files:**\n- Create: `src/output.mjs`\n\n**Resources:**\n- `simulator`: `exclusive`\n";
  assert.throws(
    () => parsePlanDocument(document({ executionContract: v2Contract(), tasks: missingCapacityTasks }), "/plans/missing-capacity.md"),
    /\/plans\/missing-capacity\.md.*task-1.*simulator/,
  );
});

test("rejects missing or duplicate top-level execution contracts", () => {
  assert.throws(() => parsePlanDocument("# Plan\n\n### Task 1: First\n\n**Files:**\n- Create: `a.mjs`", "/plans/missing.md"), /\/plans\/missing\.md.*Execution Contract/);
  assert.throws(() => parsePlanDocument(`${document()}\n## Execution Contract\n\n\`\`\`json\n${contract()}\n\`\`\``, "/plans/duplicate.md"), /\/plans\/duplicate\.md.*Execution Contract/);
});

test("rejects invalid contract schema, verification, and required gates", () => {
  for (const [name, value] of [
    ["schema", contract({ schemaVersion: "pi-plan.v3" })],
    ["verification", contract({ verification: [] })],
    ["gates", contract({ requiredGates: ["deterministic"] })],
  ]) {
    assert.throws(() => parsePlanDocument(document({ executionContract: value }), `/plans/${name}.md`), new RegExp(`/plans/${name}\\.md`));
  }
});

test("parses multiple task dependencies in declaration order", () => {
  const plan = parsePlanDocument(document({
    tasks: "### Task 1: One\n\n**Files:**\n- Create: `a.mjs`\n\n### Task 2: Two\n\n**Files:**\n- Create: `b.mjs`\n\n### Task 3: Three\n\n**Deps:** Task 1, Task 2\n\n**Files:**\n- Create: `c.mjs`\n",
  }), "/plans/multi-deps.md");

  assert.deepEqual(plan.tasks[2].deps, ["task-1", "task-2"]);
});

test("rejects duplicate, unknown, and self task dependencies with plan path and task id", () => {
  for (const [name, tasks, taskId] of [
    ["duplicate", "### Task 1: One\n\n**Files:**\n- Create: `a.mjs`\n\n### Task 1: Again\n\n**Files:**\n- Create: `b.mjs`", "task-1"],
    ["unknown", "### Task 1: One\n\n**Deps:** Task 2\n\n**Files:**\n- Create: `a.mjs`", "task-1"],
    ["self", "### Task 1: One\n\n**Deps:** Task 1\n\n**Files:**\n- Create: `a.mjs`", "task-1"],
  ]) {
    assert.throws(() => parsePlanDocument(document({ tasks }), `/plans/${name}.md`), new RegExp(`/plans/${name}\\.md.*${taskId}`));
  }
});

test("rejects task sections without non-empty Files and ignores Run prose", () => {
  assert.throws(() => parsePlanDocument(document({ tasks: "### Task 1: One\n\n**Files:**\n" }), "/plans/files.md"), /\/plans\/files\.md.*task-1/);
  const plan = parsePlanDocument(document({ tasks: "Run: `wrong command`\n\n### Task 1: One\n\n**Files:**\n- Create: `a.mjs`\n" }), "/plans/run.md");
  assert.deepEqual(plan.verification, ["node --test"]);
});

test("normalizes CRLF and trailing whitespace before hashing canonical JSON", () => {
  const lf = document({ tasks: "### Task 1: One\n\n**Files:**\n- Create: `a.mjs`\n" });
  const crlf = lf.replace(/\n/g, "\r\n").replace("# Release plan", "# Release plan   ");

  assert.equal(parsePlanDocument(lf, "/plans/lf.md").sha256, parsePlanDocument(crlf, "/plans/crlf.md").sha256);
});
