import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";

function createMockPi(cwd) {
  const tools = [];
  const hooks = { tool_result: [] };
  return {
    tools, hooks, cwd,
    registerTool(def) { tools.push(def); },
    on(event, handler) { if (hooks[event]) hooks[event].push(handler); },
  };
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), "ge-ext-"));
}

function initGitRepo(cwd) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init");
  git("config", "user.email", "t@t.com");
  git("config", "user.name", "T");
  writeFileSync(join(cwd, "README.md"), "x\n");
  git("add", ".");
  git("commit", "-m", "init");
  return git;
}

test("registers seven goal engine tools", () => {
  const pi = createMockPi(tmpCwd());
  createGoalEngineExtension(pi);
  const names = pi.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["goal_accept", "goal_amend", "goal_dispatch", "goal_init", "goal_integrate", "goal_settle", "goal_status"]);
});

test("goal_init creates goal and returns runnable frontier", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  const result = JSON.parse(await init.handler({
    objective: "Build the authentication module with token validation",
    dod: ["All auth tests pass"],
    tasks: [
      { id: "t1", description: "Implement token validation logic", deps: [], writePaths: ["src/auth/token.ts"], acceptance: { criteria: ["Handles expiry"], commands: ["node --test test/token.test.mjs"] }, workflow: "tdd" },
      { id: "t2", description: "Add session management layer", deps: ["t1"], writePaths: ["src/auth/session.ts"], acceptance: { criteria: ["Session persists"], commands: ["node --test test/session.test.mjs"] }, workflow: "tdd" },
    ],
  }));

  assert.equal(result.goalId, "build-the-authentication-module-with-token-validation");
  assert.equal(result.lifecycle, "active");
  assert.deepEqual(result.runnable, ["t1"]);
  assert.equal(result.total_tasks, 2);
});

test("goal_status returns full recovery context", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Status recovery test goal",
    tasks: [{ id: "t1", description: "First task work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  const status = pi.tools.find((t) => t.name === "goal_status");
  const result = JSON.parse(await status.handler({}));
  assert.equal(result.goalId, "status-recovery-test-goal");
  assert.equal(result.lifecycle, "active");
  assert.ok(result.objective);
  assert.ok(Array.isArray(result.runnable));
  assert.ok(result.progress);
  assert.ok(result.tasks.t1);
  assert.equal(result.tasks.t1.status, "pending");
  assert.deepEqual(result.tasks.t1.writePaths, ["a.ts"]);
});

test("goal_status returns NO_ACTIVE_GOAL when none", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const status = pi.tools.find((t) => t.name === "goal_status");
  assert.equal(await status.handler({}), "NO_ACTIVE_GOAL");
});

test("goal_dispatch allocates worktree and returns dispatch-ir.v1 contract", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Dispatch IR test goal",
    tasks: [{ id: "t1", description: "Implement the widget parser module", deps: [], writePaths: ["src/parser.ts"], acceptance: { criteria: ["Parses valid input"], commands: ["node --test test/parser.test.mjs"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const result = JSON.parse(await dispatch.handler({ task_id: "t1" }));

  assert.equal(result.status, "dispatched");
  assert.ok(result.contract);
  assert.equal(result.contract.version, "dispatch-ir.v1");
  assert.equal(result.contract.agent, "executor");
  assert.ok(result.contract.hash);
  assert.deepEqual(result.contract.boundaries.writePaths, ["src/parser.ts"]);
  assert.deepEqual(result.contract.acceptance.commands, ["node --test test/parser.test.mjs"]);
  assert.ok(result.workspace);
  assert.ok(result.workspace.path.includes("worktrees"));
  assert.ok(result.workspace.branch.startsWith("ge/"));
  assert.notEqual(result.contract.execution.cwd, cwd);
  assert.equal(result.contract.execution.cwd, result.workspace.path);
});

test("goal_dispatch supports docs-only tasks with a workflow reason", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Independent documentation review goal",
    tasks: [{ id: "review", description: "Review implementation and write the acceptance report", deps: [], writePaths: ["reports/review.md"], acceptance: { criteria: ["Report has verdict"], commands: ["test -f reports/review.md"] }, workflow: "docs-only" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const result = JSON.parse(await dispatch.handler({ task_id: "review" }));

  assert.equal(result.contract.workflow.mode, "docs-only");
  assert.match(result.contract.workflow.reason, /documentation|review|report/i);
});

test("goal_dispatch cleans the workspace when contract compilation fails", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Dispatch cleanup test goal",
    tasks: [{ id: "t1", description: "Compile an invalid path-boundary contract", deps: [], writePaths: ["../../etc/passwd"], acceptance: { criteria: ["Compilation fails"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  await assert.rejects(() => dispatch.handler({ task_id: "t1" }), /repo-relative/);

  const worktreesRoot = join(cwd, ".state/goal-engine/worktrees");
  assert.equal(existsSync(join(worktreesRoot, "dispatch-cleanup-test-goal-t1-1")), false);
  assert.equal(existsSync(join(worktreesRoot, ".dispatch-cleanup-test-goal-t1-1.lease.json")), false);
  assert.equal(git("branch", "--list", "ge/dispatch-cleanup-test-goal/t1/1"), "");

  const status = pi.tools.find((t) => t.name === "goal_status");
  const projection = JSON.parse(await status.handler({}));
  assert.equal(projection.tasks.t1.status, "pending");
  assert.equal(projection.tasks.t1.attempts, 0);
});

test("goal_integrate recovers a persisted workspace lease after extension restart", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);

  const firstPi = createMockPi(cwd);
  createGoalEngineExtension(firstPi);
  const init = firstPi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Restart integration test goal",
    tasks: [{ id: "t1", description: "Create a persisted executor artifact", deps: [], writePaths: ["src/result.ts"], acceptance: { criteria: ["result exists"], commands: ["test -f src/result.ts"] }, workflow: "tdd" }],
  });

  const dispatch = firstPi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await dispatch.handler({ task_id: "t1" }));
  mkdirSync(join(dispatched.workspace.path, "src"), { recursive: true });
  writeFileSync(join(dispatched.workspace.path, "src/result.ts"), "export const result = true;\n");
  execFileSync("git", ["add", "."], { cwd: dispatched.workspace.path });
  execFileSync("git", ["commit", "-m", "feat: add persisted result"], { cwd: dispatched.workspace.path });

  const settle = firstPi.tools.find((t) => t.name === "goal_settle");
  await settle.handler({
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/result.ts" },
    evidence_source: "self_produced",
    next_action: "Recover the persisted lease and integrate the executor result",
  });

  const restartedPi = createMockPi(cwd);
  createGoalEngineExtension(restartedPi);
  const integrate = restartedPi.tools.find((t) => t.name === "goal_integrate");
  const result = JSON.parse(await integrate.handler({ task_id: "t1", action: "integrate" }));

  assert.equal(result.action, "integrated");
  assert.equal(result.released, true);
  assert.ok(existsSync(join(cwd, "src/result.ts")));
  assert.equal(git("branch", "--list", dispatched.workspace.branch), "");
});

test("goal_settle + goal_accept full cycle", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Full cycle test goal",
    tasks: [{ id: "t1", description: "The only task in this goal", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  await dispatch.handler({ task_id: "t1" });

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  const settleResult = JSON.parse(await settle.handler({
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/x.ts" },
    evidence_source: "self_produced",
    next_action: "Accept t1 and verify all acceptance criteria are satisfied for completion",
  }));
  assert.equal(settleResult.status, "succeeded");

  const accept = pi.tools.find((t) => t.name === "goal_accept");
  const acceptResult = JSON.parse(await accept.handler({ task_id: "t1" }));
  assert.equal(acceptResult.status, "accepted");
  assert.equal(acceptResult.goal_complete, true);
  assert.equal(acceptResult.completion_verdict, "DONE_WITHOUT_EXTERNAL_VERIFICATION");
});

test("goal_settle rejects vague next_action", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Vague action test goal",
    tasks: [{ id: "t1", description: "work item", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  await dispatch.handler({ task_id: "t1" });

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await assert.rejects(
    () => settle.handler({ task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, next_action: "continue" }),
    /at least 20 characters|specific/i,
  );
});

test("tool_result hook appends reminder when checkpoint overdue", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await init.handler({
    objective: "Hook test goal for reminder",
    tasks: [{ id: "t1", description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  const hook = pi.hooks.tool_result[0];
  let lastResult;
  for (let i = 0; i < 6; i++) {
    lastResult = hook({ toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "ok" }], isError: false }, { cwd });
  }

  const text = lastResult?.content?.[0]?.text || "";
  assert.match(text, /goal-engine/);
  assert.match(text, /未 settle/);
});
