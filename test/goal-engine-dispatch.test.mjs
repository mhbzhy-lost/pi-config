import assert from "node:assert/strict";
import test from "node:test";
import { compileCodingDispatchIR, renderDispatchPrompt, splitDispatchEnvelope } from "../scripts/lib/goal-engine/dispatch-ir.mjs";
import { compileTaskContract, assertPendingTaskContractsCompile } from "../scripts/lib/goal-engine/dispatch.mjs";
import { createProjection, applyEvent } from "../scripts/lib/goal-engine/events.mjs";
import { validateRepoRelativePath, validateTaskDefinitions } from "../scripts/lib/goal-engine/task-definition.mjs";

function makeEvent(type, data, goalId = "dispatch-test") {
  return { schemaVersion: "goal-engine.event.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data };
}

function validInput(overrides = {}) {
  return {
    version: "dispatch-ir.v1",
    taskId: "test-goal.t1",
    title: "t1: Implement token validation",
    agent: "executor",
    risk: "normal",
    objective: "Implement token validation with expiry handling",
    workflow: { mode: "tdd" },
    requirements: ["Implement token validation", "Handle expired tokens"],
    context: { knownFacts: ["Goal: Build auth"], decisions: ["Non-goal: UI"], relevantFiles: ["src/auth/token.ts"] },
    boundaries: { writePaths: ["src/auth/token.ts"], excludedWork: ["UI changes"], forbiddenActions: ["Do not modify state files"] },
    acceptance: { criteria: ["Handles expired tokens"], commands: ["node --test test/token.test.mjs"] },
    execution: { cwd: "/workspace/project", timeoutMs: 1800000 },
    ...overrides,
  };
}

test("compileCodingDispatchIR validates and hashes", () => {
  const ir = compileCodingDispatchIR(validInput(), { cwd: "/workspace/project" });
  assert.equal(ir.version, "dispatch-ir.v1");
  assert.equal(ir.taskId, "test-goal.t1");
  assert.equal(ir.agent, "executor");
  assert.ok(/^[a-f0-9]{64}$/.test(ir.hash));
});

test("splitDispatchEnvelope separates the hash from the exact subagent typed contract", () => {
  const ir = compileCodingDispatchIR(validInput(), { cwd: "/workspace/project" });

  const { contract, contractHash } = splitDispatchEnvelope(ir);

  assert.equal(Object.hasOwn(contract, "hash"), false);
  assert.equal(contractHash, ir.hash);
  assert.deepEqual(Object.keys(contract).sort(), [
    "acceptance", "agent", "boundaries", "context", "execution", "objective",
    "requirements", "risk", "taskId", "title", "version", "workflow",
  ]);
  assert.equal(compileCodingDispatchIR(contract, { cwd: contract.execution.cwd }).hash, contractHash);
  assert.equal(Object.isFrozen(contract), true);
});

test("compileCodingDispatchIR rejects unknown fields", () => {
  assert.throws(
    () => compileCodingDispatchIR(validInput({ bogus: true }), { cwd: "/workspace/project" }),
    /unknown field/,
  );
});

test("compileCodingDispatchIR rejects invalid agent", () => {
  assert.throws(
    () => compileCodingDispatchIR(validInput({ agent: "hacker" }), { cwd: "/workspace/project" }),
    /unsupported.*agent/,
  );
});

test("compileCodingDispatchIR rejects empty writePaths", () => {
  const input = validInput();
  input.boundaries.writePaths = [];
  assert.throws(
    () => compileCodingDispatchIR(input, { cwd: "/workspace/project" }),
    /writePaths/,
  );
});

test("compileCodingDispatchIR rejects path traversal in writePaths", () => {
  const input = validInput();
  input.boundaries.writePaths = ["../../etc/passwd"];
  assert.throws(
    () => compileCodingDispatchIR(input, { cwd: "/workspace/project" }),
    /repo-relative/,
  );
});

test("init writePaths and dispatch IR share the repo-relative POSIX matrix", () => {
  for (const path of ["a\0b", "src\\x", "/tmp/x", "C:\\x", "\\\\host\\share", "src/../x", "src/*", "src/?", "src/[x]", "src/**/x"]) {
    assert.throws(() => validateRepoRelativePath(path), /repo-relative|unsupported/);
    const input = validInput();
    input.boundaries.writePaths = [path];
    assert.throws(() => compileCodingDispatchIR(input, { cwd: "/workspace/project" }), /repo-relative|unsupported/);
  }
  for (const path of ["src/x.ts", "src/generated/**"]) {
    assert.equal(validateRepoRelativePath(path), path);
    const input = validInput();
    input.boundaries.writePaths = [path];
    assert.deepEqual(compileCodingDispatchIR(input, { cwd: "/workspace/project" }).boundaries.writePaths, [path]);
  }
});

test("task commands reject origin absolute cd but allow executor-relative dynamic cwd", () => {
  const task = (command) => ({ description: "task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: [command] }, workflow: "tdd" });
  for (const command of ['cd "/tmp"', "cd '/tmp'", "cd -- /tmp", "true && cd /tmp", "true || cd /tmp", "true; cd /tmp", "true | cd /tmp", "(cd /tmp)", "echo ok\ncd /tmp", "node -e 'x' # /origin/project"]) {
    assert.throws(() => validateTaskDefinitions(["t1"], { t1: task(command) }, { cwd: "/origin/project" }), /absolute cd|origin cwd/);
  }
  for (const command of ["cd relative/subdir", "echo 'cd /tmp'", "echo $PWD"]) {
    assert.doesNotThrow(() => validateTaskDefinitions(["t1"], { t1: task(command) }, { cwd: "/origin/project" }));
  }
});

test("init and dispatch enforce shared byte and collection limits", () => {
  const task = (overrides = {}) => ({ description: "task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd", ...overrides });
  for (const [field, value] of [["description", "x".repeat(4097)], ["writePaths", ["x".repeat(4097)]], ["acceptance", { criteria: ["x".repeat(4097)], commands: ["true"] }], ["acceptance", { criteria: ["works"], commands: ["x".repeat(4097)] }]]) {
    assert.throws(() => validateTaskDefinitions(["t1"], { t1: task({ [field]: value }) }), /4096|bytes/);
  }
  for (const [field, value] of [["tasks", Array.from({ length: 33 }, (_, i) => `t${i}`)], ["deps", Array.from({ length: 33 }, (_, i) => `d${i}`)], ["writePaths", Array.from({ length: 33 }, (_, i) => `src/${i}`)], ["criteria", Array.from({ length: 33 }, (_, i) => `c${i}`)], ["commands", Array.from({ length: 33 }, () => "true")]]) {
    const def = task(field === "deps" ? { deps: value } : field === "writePaths" ? { writePaths: value } : field === "criteria" ? { acceptance: { criteria: value, commands: ["true"] } } : field === "commands" ? { acceptance: { criteria: ["works"], commands: value } } : {});
    const tasks = field === "tasks" ? value : ["t1"];
    const defs = field === "tasks" ? Object.fromEntries(value.map((id) => [id, task()])) : { t1: def };
    assert.throws(() => validateTaskDefinitions(tasks, defs), /32/);
  }
  const input = validInput({ title: "x".repeat(4097) });
  assert.throws(() => compileCodingDispatchIR(input, { cwd: "/workspace/project" }), /4096.*bytes/);
  input.title = "ok";
  input.requirements = Array.from({ length: 33 }, (_, i) => `r${i}`);
  assert.throws(() => compileCodingDispatchIR(input, { cwd: "/workspace/project" }), /32/);
});

test("task commands reject wrapper absolute cd and origin aliases conservatively", () => {
  const task = (command) => ({ description: "task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: [command] }, workflow: "tdd" });
  for (const command of ["sh -c 'cd /tmp'", 'bash -lc "cd /tmp"', "eval 'cd /tmp'", "xargs sh -c 'cd /tmp'", "cd /physical/origin"]) {
    assert.throws(() => validateTaskDefinitions(["t1"], { t1: task(command) }, { cwd: "/origin", realpathCwd: "/physical/origin" }), /absolute cd|origin cwd/);
  }
  for (const command of ["echo 'cd /tmp'", "cd relative", "echo $PWD"]) assert.doesNotThrow(() => validateTaskDefinitions(["t1"], { t1: task(command) }, { cwd: "/origin", realpathCwd: "/physical/origin" }));
});

test("renderDispatchPrompt produces structured markdown", () => {
  const ir = compileCodingDispatchIR(validInput(), { cwd: "/workspace/project" });
  const prompt = renderDispatchPrompt(ir);
  assert.match(prompt, /# Coding Dispatch Contract/);
  assert.match(prompt, /token validation/);
  assert.match(prompt, /src\/auth\/token\.ts/);
  assert.match(prompt, /node --test test\/token\.test\.mjs/);
  assert.ok(prompt.length < 64 * 1024);
});

// --- compileTaskContract tests ---

function buildProjection() {
  let p = createProjection();
  p = applyEvent(p, makeEvent("goal.created", {
    objective: "Build auth module",
    scope: ["src/auth/"],
    nonGoals: ["UI changes", "Database migration"],
    dod: ["All auth tests pass", "No hardcoded secrets"],
    tasks: ["t1", "t2"],
    taskDefs: {
      t1: {
        description: "Implement token validation with expiry handling",
        deps: [],
        writePaths: ["src/auth/token.ts", "test/auth/token.test.mjs"],
        acceptance: { criteria: ["Handles expired tokens", "Rejects malformed tokens"], commands: ["node --test test/auth/token.test.mjs"] },
        workflow: "tdd",
      },
      t2: {
        description: "Add session management layer",
        deps: ["t1"],
        writePaths: ["src/auth/session.ts"],
        acceptance: { criteria: ["Session persists across requests"], commands: ["node --test test/auth/session.test.mjs"] },
        workflow: "tdd",
      },
    },
  }), { replay: true });
  return p;
}

test("compileTaskContract includes mandatory clean commit requirement", () => {
  const p = buildProjection();
  const contract = compileTaskContract(p, "t1", "/workspace/project");

  assert.equal(contract.version, "dispatch-ir.v1");
  assert.equal(contract.taskId, "dispatch-test.t1");
  assert.equal(contract.agent, "executor");
  assert.equal(contract.risk, "normal");
  assert.match(contract.objective, /token validation/i);
  assert.ok(contract.requirements.length >= 2);
  assert.ok(contract.requirements.includes(
    "Before reporting completed, create at least one clean commit containing only approved writePaths; if no commit is warranted, return NEEDS_CONTEXT instead of completed.",
  ));
  assert.deepEqual(contract.boundaries.writePaths, ["src/auth/token.ts", "test/auth/token.test.mjs"]);
  assert.deepEqual(contract.acceptance.commands, ["node --test test/auth/token.test.mjs"]);
  assert.equal(contract.workflow.mode, "tdd");
  assert.equal(Object.hasOwn(contract.workflow, "reason"), false);
  assert.equal(contract.execution.cwd, "/workspace/project");
  assert.ok(contract.hash);
});

test("compileTaskContract adds a reason for existing-tests workflow", () => {
  const p = buildProjection();
  p.tasks.get("t1").workflow = "existing-tests";

  const contract = compileTaskContract(p, "t1", "/workspace/project");

  assert.equal(contract.workflow.mode, "existing-tests");
  assert.ok(contract.workflow.reason);
  assert.match(contract.workflow.reason, /acceptance|existing test/i);
});

test("compileTaskContract adds a reason for docs-only workflow", () => {
  const p = buildProjection();
  p.tasks.get("t1").workflow = "docs-only";

  const contract = compileTaskContract(p, "t1", "/workspace/project");

  assert.equal(contract.workflow.mode, "docs-only");
  assert.match(contract.workflow.reason, /documentation|review|report/i);
});

test("compileTaskContract includes goal context as knownFacts", () => {
  const p = buildProjection();
  const contract = compileTaskContract(p, "t1", "/workspace/project");

  assert.ok(contract.context.knownFacts.some((f) => f.includes("src/auth/")));
  assert.ok(contract.context.decisions.some((d) => d.includes("UI changes")));
});

test("compileTaskContract includes completed task evidence as context", () => {
  let p = buildProjection();
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  p = applyEvent(p, makeEvent("task.settled", {
    taskId: "t1", outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/auth/token.ts" },
    evidenceSource: "self_produced",
    nextAction: "Accept t1 and dispatch t2 for session management implementation",
  }));
  p = applyEvent(p, makeEvent("task.accepted", { taskId: "t1" }));

  const contract = compileTaskContract(p, "t2", "/workspace/project");
  assert.ok(contract.context.knownFacts.some((f) => f.includes("t1")));
  assert.ok(contract.context.relevantFiles.includes("src/auth/token.ts"));
});

test("compileTaskContract rejects non-pending task", () => {
  let p = buildProjection();
  p = applyEvent(p, makeEvent("task.dispatched", { taskId: "t1", contractHash: "h1" }));
  assert.throws(
    () => compileTaskContract(p, "t1", "/workspace"),
    /not pending/,
  );
});

test("pending contract oracle catches derived composite ids and requirement combinations", () => {
  const p = buildProjection();
  p.goalId = "g".repeat(160);
  assert.throws(() => assertPendingTaskContractsCompile(p, "/workspace/project"), /taskId.*160/);
  p.goalId = "dispatch-test";
  p.tasks.get("t1").acceptance.criteria = Array.from({ length: 31 }, (_, i) => `criterion ${i}`);
  assert.throws(() => assertPendingTaskContractsCompile(p, "/workspace/project"), /requirements.*32/);
});

test("completed optional context retains ordered facts/files and makes every omission explicit", () => {
  const p = buildProjection();
  const completed = p.tasks.get("t1");
  completed.status = "accepted";
  completed.evidence = [{ type: "log", ref: "证".repeat(2049) }, ...Array.from({ length: 31 }, (_, i) => ({ type: "log", ref: `evidence-${i}` }))];
  completed.writePaths = ["src/ok.ts", "src/ok.ts", ...Array.from({ length: 32 }, (_, i) => `src/${i}.ts`)];
  const first = compileTaskContract(p, "t2", "/workspace/project");
  const second = compileTaskContract(p, "t2", "/workspace/project");
  assert.deepEqual(first.context.knownFacts.slice(0, 2), ["Goal: Build auth module", "Scope: src/auth/"]);
  assert.match(first.context.knownFacts.at(-1), /Context omitted: facts=4; files=2/);
  assert.deepEqual(first.context.relevantFiles.slice(0, 2), ["src/ok.ts", "src/0.ts"]);
  assert.equal(first.context.knownFacts.length, 32);
  assert.equal(first.context.relevantFiles.length, 32);
  assert.ok(first.context.knownFacts.every((fact) => Buffer.byteLength(fact, "utf8") <= 4096));
  assert.ok(first.context.knownFacts.every((fact) => !fact.endsWith("证")));
  assert.deepEqual(first.context, second.context);
});


test("planned criteria transport is canonical and never carries commands", () => {
  const criterion = { id: "criterion-1", statement: "Ship the feature", evidenceKinds: ["tests", "changed-files"] };
  const projection = {
    goalId: "planned-goal", objective: "planned objective", scope: [], nonGoals: [], dod: [],
    tasks: new Map([["t1", { description: "planned task", deps: [], writePaths: ["src/x.mjs"], acceptance: { criteria: [criterion] }, workflow: "tdd", status: "pending", evidence: [] }]]),
  };
  const first = compileTaskContract(projection, "t1", "/workspace/project");
  const second = compileTaskContract(projection, "t1", "/workspace/project");
  const encoded = JSON.stringify({ id: "criterion-1", statement: "Ship the feature", evidenceKinds: ["tests", "changed-files"] });
  assert.deepEqual(first.acceptance, { criteria: [encoded] });
  assert.deepEqual(first.acceptance, second.acceptance);
  assert.ok(first.requirements.includes(encoded));
  assert.equal(JSON.stringify(first).includes("commands"), false);
});

test("planned task definitions require exact structured criteria", () => {
  const valid = { description: "planned task", deps: [], writePaths: ["src/x.mjs"], workflow: "tdd", acceptance: { criteria: [{ id: "proof", statement: "Prove it", evidenceKinds: ["tests"] }] } };
  assert.doesNotThrow(() => validateTaskDefinitions(["t1"], { t1: valid }, { planned: true }));
  for (const acceptance of [
    { criteria: [{ id: "proof", statement: "Prove it", evidenceKinds: ["tests"], extra: true }] },
    { criteria: [{ id: "proof", statement: "Prove it", evidenceKinds: ["unknown"] }] },
    { criteria: [{ id: "proof", statement: "Prove it", evidenceKinds: ["tests"] }, { id: "proof", statement: "Again", evidenceKinds: ["tests"] }] },
    { criteria: [{ id: "proof", statement: "Prove it", evidenceKinds: ["tests"] }], commands: ["true"] },
  ]) assert.throws(() => validateTaskDefinitions(["t1"], { t1: { ...valid, acceptance } }, { planned: true }), /criteria|acceptance|duplicate|invalid/);
});
