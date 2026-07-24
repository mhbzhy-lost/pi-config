import assert from "node:assert/strict";
import test from "node:test";

import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";

const contract = (overrides = {}) => JSON.stringify({
  schemaVersion: "pi-plan.v1",
  verification: ["node --test"],
  requiredGates: ["deterministic", "plan-audit", "external-review", "final-completeness"],
  ...overrides,
}, null, 2);

function document({ executionContract = contract(), tasks } = {}) {
  return `# Release plan\n\n## Execution Contract\n\n\`\`\`json\n${executionContract}\n\`\`\`\n\n${tasks ?? "### Task 1: First\n\n**Files:**\n- Create: `src/first.mjs`\n"}`;
}

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
  assert.match(plan.sha256, /^[a-f0-9]{64}$/);
});

test("rejects missing or duplicate top-level execution contracts", () => {
  assert.throws(() => parsePlanDocument("# Plan\n\n### Task 1: First\n\n**Files:**\n- Create: `a.mjs`", "/plans/missing.md"), /\/plans\/missing\.md.*Execution Contract/);
  assert.throws(() => parsePlanDocument(`${document()}\n## Execution Contract\n\n\`\`\`json\n${contract()}\n\`\`\``, "/plans/duplicate.md"), /\/plans\/duplicate\.md.*Execution Contract/);
});

test("rejects invalid contract schema, verification, and required gates", () => {
  for (const [name, value] of [
    ["schema", contract({ schemaVersion: "pi-plan.v2" })],
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
