import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent as appendEventStore, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { classifyGoalEvidence, completionVerdictFor } from "../scripts/lib/goal-engine/evidence.mjs";

test("external evidence classification matrix only promotes external_review from external", () => {
  const projectionFor = (evidence) => ({ tasks: new Map([["t1", { evidence }]]) });
  for (const evidence of [
    [{ source: "self_produced", type: "file" }],
    [{ source: "pre_existing", type: "file" }],
    [{ source: "self_produced", type: "file" }, { source: "pre_existing", type: "file" }],
    [{ source: "self_produced", type: "external_review" }],
    [{ source: "pre_existing", type: "external_review" }],
    [{ source: "external", type: "file" }],
  ]) {
    assert.equal(completionVerdictFor(projectionFor(evidence)), "DONE_WITHOUT_EXTERNAL_VERIFICATION");
    assert.equal(classifyGoalEvidence(projectionFor(evidence)).hasExternalReview, false);
  }
  const externalReview = projectionFor([{ source: "external", type: "external_review" }]);
  assert.equal(completionVerdictFor(externalReview), "COMPLETE");
  assert.equal(classifyGoalEvidence(externalReview).hasExternalReview, true);
});

function createMockPi(cwd) {
  const tools = [];
  const hooks = { tool_result: [] };
  return {
    tools, hooks, executeContext: { cwd },
    registerTool(def) { tools.push(def); },
    on(event, handler) { if (hooks[event]) hooks[event].push(handler); },
  };
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), "ge-ext-"));
}

function objectiveToGoalId(objective) {
  return objective.toLowerCase().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 80);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function invoke(pi, name, params = {}) {
  const definition = pi.tools.find((tool) => tool.name === name);
  assert.ok(definition, `missing tool: ${name}`);
  const result = await definition.execute(
    `test-${name}`,
    params,
    new AbortController().signal,
    undefined,
    pi.executeContext,
  );
  assert.deepEqual(result.content.map((part) => part.type), ["text"]);
  assert.ok(result.details && Object.hasOwn(result.details, "value"), `${name} must return details.value`);
  const text = result.content[0].text;
  if (typeof result.details.value === "string") {
    assert.equal(result.details.value, text);
  } else {
    assert.deepEqual(result.details.value, JSON.parse(text));
  }
  return text;
}

function initGitRepo(cwd) {
  const run = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  run("init");
  run("config", "user.email", "t@t.com");
  run("config", "user.name", "T");
  writeFileSync(join(cwd, "README.md"), "x\n");
  run("add", ".");
  run("commit", "-m", "init");
  return run;
}

function goalEventsPath(cwd, goalId) {
  return join(cwd, ".state/goal-engine/goals", goalId, "events.jsonl");
}

function readGoalEvents(cwd, goalId) {
  const path = goalEventsPath(cwd, goalId);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function createFailingAppendEvent(targetType) {
  let failureTriggered = false;
  let callCount = 0;
  return {
    appendEvent(stateRoot, event, expectedVersion) {
      callCount += 1;
      if (!failureTriggered && event.type === targetType) {
        failureTriggered = true;
        throw new Error(`injected appendEvent failure for ${targetType}`);
      }
      return appendEventStore(stateRoot, event, expectedVersion);
    },
    get called() { return callCount; },
    get failed() { return failureTriggered; },
  };
}

function createDurableThenThrowAppendEvent(targetType) {
  let failureTriggered = false;
  let callCount = 0;
  return {
    appendEvent(stateRoot, event, expectedVersion) {
      callCount += 1;
      const result = appendEventStore(stateRoot, event, expectedVersion);
      if (!failureTriggered && event.type === targetType) {
        failureTriggered = true;
        throw new Error(`injected appendEvent failure after persisting ${targetType}`);
      }
      return result;
    },
    get called() { return callCount; },
    get failed() { return failureTriggered; },
  };
}

function workspaceState(cwd, goalId, taskId, attempt = 1) {
  const worktreesRoot = join(cwd, ".state/goal-engine/worktrees");
  const workspacePath = join(worktreesRoot, `${goalId}-${taskId}-${attempt}`);
  const leasePath = join(worktreesRoot, `.${goalId}-${taskId}-${attempt}.lease.json`);
  const branch = `ge/${goalId}/${taskId}/${attempt}`;
  return {
    workspacePath,
    leasePath,
    branch,
    workspaceExists: existsSync(workspacePath),
    leaseExists: existsSync(leasePath),
    branchExists: git(cwd, "branch", "--list", branch) !== "",
  };
}

function commitWorkspaceChange(lease, filePath, content, message) {
  const absolute = join(lease.path, filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  execFileSync("git", ["add", filePath], { cwd: lease.path });
  execFileSync("git", ["commit", "-m", message], { cwd: lease.path });
}

function createGoalEngineWithAppendInjection(pi, options = {}) {
  return createGoalEngineExtension(pi, options);
}

function assertTaskMachineAction(task, expected) {
  assert.deepEqual(task.allowedActions, expected.allowedActions);
  const required = task.requiredNextAction;
  assert.ok(required && typeof required === "object", "requiredNextAction must be an object");
  assert.equal(required.tool, expected.requiredTool);
  assert.deepEqual(required.params, expected.requiredParams);
  assert.equal(typeof required.reason, "string");
  assert.ok(required.reason.trim().length > 0, "requiredNextAction.reason must be a non-empty string");
  assert.deepEqual(task.blockingReason, expected.blockingReason);
}

test("registers seven goal engine tools", () => {
  const pi = createMockPi(tmpCwd());
  createGoalEngineExtension(pi);
  const names = pi.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["goal_accept", "goal_amend", "goal_dispatch", "goal_init", "goal_integrate", "goal_settle", "goal_status"]);
  for (const definition of pi.tools) {
    assert.equal(typeof definition.execute, "function", `${definition.name} must expose execute`);
    assert.equal(Object.hasOwn(definition, "handler"), false, `${definition.name} must not expose handler`);
  }
});

test("tool descriptions state when to use them and when not to", () => {
  const pi = createMockPi(tmpCwd());
  createGoalEngineExtension(pi);
  assert.deepEqual(
    Object.fromEntries(pi.tools.map(({ name, description }) => [name, description])),
    {
      goal_init: "当跨多轮、compaction 或多个独立验收 task 时使用；创建并持久化 task DAG。不要用于单步短任务或已有 active goal 时重复创建。",
      goal_status: "当存在或可能存在 active goal 时，在每个协调轮次开始及 compact/reload 后首先使用；返回恢复权威的 projection 和 machine action。不要凭对话历史猜进度。",
      goal_dispatch: "当 goal_status 显示 task 的 requiredNextAction 为 goal_dispatch/runnable 且无未释放 workspace 时使用；原样交付 typed subagent contract。不要自行拼 prompt 或重复派 active task。",
      goal_settle: "当 executor 已终止且有真实结果或工件时使用；记录结果，succeeded 必须有 evidence。不要在运行中 settle、编造证据或把命令字符串当 artifact。",
      goal_integrate: "当 task 已 settle 且 accept 前需处置 workspace 时使用；选择 integrate、discard 或 preserve，integrate 后释放 workspace。不要未 settle 调用；preserve 仅人类明确保留现场。",
      goal_accept: "当 task succeeded、机械验收通过且 workspace 已 integrated+released 时，或重试同一验收确认时使用；验收 task 并可完成 goal。不要只凭 executor completed 声明。",
      goal_amend: "当人类明确改范围/DAG，或 blocked/preserved 需调整计划时使用；只改安全 pending task。不要用于正常推进或绕过门禁。",
    },
  );
});

test("tool execution rejects a missing cwd context", async () => {
  const pi = createMockPi(tmpCwd());
  createGoalEngineExtension(pi);
  const init = pi.tools.find((tool) => tool.name === "goal_init");
  await assert.rejects(
    init.execute("missing-context", { objective: "Missing context", tasks: [] }, new AbortController().signal, undefined, undefined),
    /ExtensionContext\.cwd/,
  );
});

test("goal_init creates goal and returns runnable frontier", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  const result = JSON.parse(await invoke(pi, "goal_init", {
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
  await invoke(pi, "goal_init", {
    objective: "Status recovery test goal",
    tasks: [{ id: "t1", description: "First task work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  const status = pi.tools.find((t) => t.name === "goal_status");
  const result = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(result.goalId, "status-recovery-test-goal");
  assert.equal(result.lifecycle, "active");
  assert.ok(result.objective);
  assert.ok(Array.isArray(result.runnable));
  assert.ok(result.progress);
  assert.ok(result.tasks.t1);
  assert.equal(result.tasks.t1.status, "pending");
  assert.deepEqual(result.tasks.t1.writePaths, ["a.ts"]);
});

test("goal_status exposes machine action state across lifecycle (machine action)", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective: "Machine action state goal",
    tasks: [{ id: "t1", description: "Flow task for machine action assertions", deps: [], writePaths: ["src/machine.ts"], acceptance: { criteria: ["flow"], commands: ["true"] }, workflow: "tdd" }],
  });

  let snapshot = JSON.parse(await invoke(pi, "goal_status", {}));
  assertTaskMachineAction(snapshot.tasks.t1, {
    allowedActions: ["goal_dispatch"],
    requiredTool: "goal_dispatch",
    requiredParams: { task_id: "t1" },
    blockingReason: null,
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  assert.equal(dispatched.status, "dispatched");

  snapshot = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(snapshot.tasks.t1.status, "dispatched");
  assert.equal(snapshot.tasks.t1.workspace.phase, "active");
  assertTaskMachineAction(snapshot.tasks.t1, {
    allowedActions: ["goal_settle"],
    requiredTool: "goal_settle",
    requiredParams: { task_id: "t1" },
    blockingReason: null,
  });

  commitWorkspaceChange(dispatched.workspace, "src/machine.ts", "export const machine = true;\n", "feat: machine action state");
  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/machine.ts" },
    evidence_source: "self_produced",
    next_action: "Integrate t1, verify the resulting disposition, and prepare task acceptance.",
  });

  snapshot = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(snapshot.tasks.t1.status, "succeeded");
  assert.equal(snapshot.tasks.t1.workspace.phase, "active");
  assertTaskMachineAction(snapshot.tasks.t1, {
    allowedActions: ["goal_integrate"],
    requiredTool: "goal_integrate",
    requiredParams: { task_id: "t1", action: "integrate" },
    blockingReason: null,
  });

  const integrated = JSON.parse(await invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }));
  assert.equal(integrated.action, "integrated");

  snapshot = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(snapshot.tasks.t1.workspace.phase, "disposed");
  assert.equal(snapshot.tasks.t1.workspace.disposition, "integrated");
  assert.equal(snapshot.tasks.t1.workspace.released, true);
  assertTaskMachineAction(snapshot.tasks.t1, {
    allowedActions: ["goal_accept"],
    requiredTool: "goal_accept",
    requiredParams: { task_id: "t1" },
    blockingReason: null,
  });
});
test("goal_status returns NO_ACTIVE_GOAL when none", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const status = pi.tools.find((t) => t.name === "goal_status");
  assert.equal(await invoke(pi, "goal_status", {}), "NO_ACTIVE_GOAL");
});

test("goal_dispatch allocates worktree and returns dispatch-ir.v1 contract", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective: "Dispatch IR test goal",
    tasks: [{ id: "t1", description: "Implement the widget parser module", deps: [], writePaths: ["src/parser.ts"], acceptance: { criteria: ["Parses valid input"], commands: ["node --test test/parser.test.mjs"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const result = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));

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
  await invoke(pi, "goal_init", {
    objective: "Independent documentation review goal",
    tasks: [{ id: "review", description: "Review implementation and write the acceptance report", deps: [], writePaths: ["reports/review.md"], acceptance: { criteria: ["Report has verdict"], commands: ["test -f reports/review.md"] }, workflow: "docs-only" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const result = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "review" }));

  assert.equal(result.contract.workflow.mode, "docs-only");
  assert.match(result.contract.workflow.reason, /documentation|review|report/i);
});

test("goal_dispatch cleans the workspace when contract compilation fails", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective: "Dispatch cleanup test goal",
    tasks: [{ id: "t1", description: "Compile an invalid path-boundary contract", deps: [], writePaths: ["../../etc/passwd"], acceptance: { criteria: ["Compilation fails"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), /repo-relative/);

  const worktreesRoot = join(cwd, ".state/goal-engine/worktrees");
  assert.equal(existsSync(join(worktreesRoot, "dispatch-cleanup-test-goal-t1-1")), false);
  assert.equal(existsSync(join(worktreesRoot, ".dispatch-cleanup-test-goal-t1-1.lease.json")), false);
  assert.equal(git("branch", "--list", "ge/dispatch-cleanup-test-goal/t1/1"), "");

  const status = pi.tools.find((t) => t.name === "goal_status");
  const projection = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(projection.tasks.t1.status, "pending");
  assert.equal(projection.tasks.t1.attempts, 0);
});

test("goal_dispatch durable-then-throw acknowledges committed dispatch and survives restart", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);
  const objective = "Dispatch durable acknowledgement restart";
  const goalId = objectiveToGoalId(objective);
  const injected = createDurableThenThrowAppendEvent("task.dispatched");
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi, { appendEvent: injected.appendEvent });
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "durable dispatch", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const task = projection.tasks.get("t1");
  assert.equal(dispatched.status, "dispatched");
  assert.equal(task.status, "dispatched");
  assert.equal(task.attempts, 1);
  assert.equal(task.contractHash, dispatched.contract.hash);
  assert.deepEqual(task.workspace, { ...dispatched.workspace, phase: "active" });
  assert.deepEqual(workspaceState(cwd, goalId, "t1"), {
    workspacePath: dispatched.workspace.path, leasePath: join(cwd, ".state/goal-engine/worktrees", `.${goalId}-t1-1.lease.json`), branch: dispatched.workspace.branch,
    workspaceExists: true, leaseExists: true, branchExists: true,
  });
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.dispatched").length, 1);

  const dispatchedStatus = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(dispatchedStatus.tasks.t1.status, "dispatched");
  commitWorkspaceChange(dispatched.workspace, "src/x.ts", "export const x = true;\n", "feat: durable dispatch");
  await invoke(pi, "goal_settle", {
    task_id: "t1", outcome: "succeeded", evidence: { type: "diff", ref: "git diff HEAD~1 -- src/x.ts" },
    evidence_source: "self_produced", next_action: "Recover the durable lease and integrate it",
  });
  const restartedPi = createMockPi(cwd);
  createGoalEngineExtension(restartedPi);
  const status = JSON.parse(await invoke(restartedPi, "goal_status", {}));
  assert.equal(status.tasks.t1.status, "succeeded");
  assert.equal(status.tasks.t1.contractHash, dispatched.contract.hash);
  const integrated = JSON.parse(await invoke(restartedPi, "goal_integrate", { task_id: "t1", action: "integrate" }));
  assert.equal(integrated.action, "integrated");
  assert.ok(existsSync(join(cwd, "src/x.ts")));
});

test("goal_dispatch before-durable append failure cleans resources and rethrows", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);
  const objective = "Dispatch before durable failure";
  const goalId = objectiveToGoalId(objective);
  const injected = createFailingAppendEvent("task.dispatched");
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi, { appendEvent: injected.appendEvent });
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "before durable", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });
  const before = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), /injected appendEvent failure/);
  const after = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(after.version, before.version);
  assert.equal(after.tasks.get("t1").status, "pending");
  assert.equal(after.tasks.get("t1").attempts, 0);
  assert.deepEqual(workspaceState(cwd, goalId, "t1"), {
    workspacePath: join(cwd, ".state/goal-engine/worktrees", `${goalId}-t1-1`), leasePath: join(cwd, ".state/goal-engine/worktrees", `.${goalId}-t1-1.lease.json`), branch: `ge/${goalId}/t1/1`,
    workspaceExists: false, leaseExists: false, branchExists: false,
  });
});

test("ambiguous dispatch recovery failure preserves resources and reports stable code", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);
  const objective = "Ambiguous dispatch recovery";
  const goalId = objectiveToGoalId(objective);
  const injected = createFailingAppendEvent("task.dispatched");
  let failRecovery = false;
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi, {
    appendEvent(root, event, version) {
      try { return injected.appendEvent(root, event, version); } catch (error) { failRecovery = true; throw error; }
    },
    store: { loadProjection(root, id) { if (failRecovery) throw new Error("injected recovery failure"); return loadProjection(root, id); } },
  });
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "ambiguous", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });
  await assert.rejects(
    () => invoke(pi, "goal_dispatch", { task_id: "t1" }),
    (error) => error.code === "AMBIGUOUS_DISPATCH_COMMIT" && /goal .*task t1.*attempt 1/i.test(error.message),
  );
  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.leaseExists, true);
  assert.equal(state.branchExists, true);
});

test("ambiguous dispatch durable identity conflict preserves resources and event", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);
  const objective = "Dispatch durable identity conflict";
  const goalId = objectiveToGoalId(objective);
  let conflicted = false;
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi, {
    appendEvent(root, event, version) {
      if (!conflicted && event.type === "task.dispatched") {
        conflicted = true;
        appendEventStore(root, { ...event, data: { ...event.data, contractHash: "conflicting-contract-hash" } }, version);
        throw new Error("injected durable identity conflict");
      }
      return appendEventStore(root, event, version);
    },
  });
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "identity conflict", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), (error) => error.code === "AMBIGUOUS_DISPATCH_COMMIT");
  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.leaseExists, true);
  assert.equal(state.branchExists, true);
  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.tasks.get("t1").contractHash, "conflicting-contract-hash");
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.dispatched").length, 1);
});

test("ambiguous dispatch wrong goal recovery preserves resources", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);
  const objective = "Dispatch wrong goal recovery";
  const goalId = objectiveToGoalId(objective);
  const injected = createFailingAppendEvent("task.dispatched");
  let failRecovery = false;
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi, {
    appendEvent(root, event, version) {
      try { return injected.appendEvent(root, event, version); } catch (error) { failRecovery = true; throw error; }
    },
    store: {
      loadProjection(root, id) {
        const projection = loadProjection(root, id);
        return failRecovery ? { ...projection, goalId: "another-goal" } : projection;
      },
    },
  });
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "wrong goal", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), (error) => error.code === "AMBIGUOUS_DISPATCH_COMMIT");
  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.leaseExists, true);
  assert.equal(state.branchExists, true);
  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.tasks.get("t1").status, "pending");
  assert.equal(projection.tasks.get("t1").attempts, 0);
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.dispatched").length, 0);
});

test("goal_integrate recovers a persisted workspace lease after extension restart", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);

  const firstPi = createMockPi(cwd);
  createGoalEngineExtension(firstPi);
  const init = firstPi.tools.find((t) => t.name === "goal_init");
  await invoke(firstPi, "goal_init", {
    objective: "Restart integration test goal",
    tasks: [{ id: "t1", description: "Create a persisted executor artifact", deps: [], writePaths: ["src/result.ts"], acceptance: { criteria: ["result exists"], commands: ["test -f src/result.ts"] }, workflow: "tdd" }],
  });

  const dispatch = firstPi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(firstPi, "goal_dispatch", { task_id: "t1" }));
  mkdirSync(join(dispatched.workspace.path, "src"), { recursive: true });
  writeFileSync(join(dispatched.workspace.path, "src/result.ts"), "export const result = true;\n");
  execFileSync("git", ["add", "."], { cwd: dispatched.workspace.path });
  execFileSync("git", ["commit", "-m", "feat: add persisted result"], { cwd: dispatched.workspace.path });

  const settle = firstPi.tools.find((t) => t.name === "goal_settle");
  await invoke(firstPi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/result.ts" },
    evidence_source: "self_produced",
    next_action: "Recover the persisted lease and integrate the executor result",
  });

  const restartedPi = createMockPi(cwd);
  createGoalEngineExtension(restartedPi);
  const integrate = restartedPi.tools.find((t) => t.name === "goal_integrate");
  const result = JSON.parse(await invoke(restartedPi, "goal_integrate", { task_id: "t1", action: "integrate" }));

  assert.equal(result.action, "integrated");
  assert.equal(result.released, true);
  assert.ok(existsSync(join(cwd, "src/result.ts")));
  assert.equal(git("branch", "--list", dispatched.workspace.branch), "");
});

test("goal_accept requires integrated workspace before acceptance", async () => {
  const cwd = tmpCwd();
  const objective = "Full cycle test goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "The only task in this goal", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/x.ts", "export const x = true;\n", "feat: add x result");

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/x.ts" },
    evidence_source: "self_produced",
    next_action: "Accept t1 and verify all acceptance criteria are satisfied for completion",
  });

  await assert.rejects(
    () => invoke(pi, "goal_accept", { task_id: "t1" }),
    /workspace|integrated|disposed|workspaceAttempt|attempt/i,
  );

  const status = pi.tools.find((t) => t.name === "goal_status");
  const projection = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(projection.tasks.t1.status, "succeeded");
  assert.equal(workspaceState(cwd, goalId, "t1").workspaceExists, true);
});

test("goal_integrate requires a settled task and keeps active workspace for pre-settlement retry", async () => {
  const cwd = tmpCwd();
  const objective = "Integrate precondition test goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Work before settle", deps: [], writePaths: ["src/pre.ts"], acceptance: { criteria: ["pre-settlement"], commands: ["node --test test/pre.test.mjs"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/pre.ts", "export const pre = true;\n", "feat: pre work");

  await assert.rejects(
    () => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }),
    /settled|succeeded|status/i,
  );

  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.leaseExists, true);
  assert.equal(state.branchExists, true);
  assert.equal(existsSync(join(cwd, "src/pre.ts")), false);
});

test("goal_integrate rejects succeeded no-op workspace and still allows discard", async () => {
  const cwd = tmpCwd();
  const objective = "No-commit integrate test goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "No-op integrate failure path", deps: [], writePaths: ["src/noop.ts"], acceptance: { criteria: ["noop"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  await invoke(pi, "goal_dispatch", { task_id: "t1" });

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD --no-index" },
    evidence_source: "self_produced",
    next_action: "No-op commit should still integrate cannot be accepted and must be discarded first",
  });

  await assert.rejects(
    () => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }),
    /no commits|nothing to commit|cherry-pick|merge/i,
  );

  const preDiscardState = workspaceState(cwd, goalId, "t1");
  assert.equal(preDiscardState.workspaceExists, true);
  assert.equal(preDiscardState.leaseExists, true);

  const discard = JSON.parse(await invoke(pi, "goal_integrate", { task_id: "t1", action: "discard" }));
  assert.equal(discard.action, "discarded");
  assert.equal(discard.released, true);

  const postDiscardState = workspaceState(cwd, goalId, "t1");
  assert.equal(postDiscardState.workspaceExists, false);
  assert.equal(postDiscardState.leaseExists, false);
  assert.equal(postDiscardState.branchExists, false);
  assert.equal(existsSync(join(cwd, "src/noop.ts")), false);
});

test("goal_integrate rejects changedFiles outside writePaths and keeps workspace for retry", async () => {
  const cwd = tmpCwd();
  const objective = "Write-path gate test goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Write forbidden file", deps: [], writePaths: ["src/allowed.ts"], acceptance: { criteria: ["write gated"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "outside/rogue.txt", "rogue\n", "feat: rogue change");

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- outside/rogue.txt" },
    evidence_source: "self_produced",
    next_action: "Integrate t1 and verify changedFiles are inside declared writePaths",
  });

  await assert.rejects(
    () => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }),
    /writePaths|outside|mismatch|forbidden/i,
  );

  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.leaseExists, true);
  assert.equal(state.branchExists, true);
});

test("goal_integrate rejects rename from forbidden source while preserving retry resources", async () => {
  const cwd = tmpCwd();
  const objective = "Rename source write-path gate goal";
  const goalId = objectiveToGoalId(objective);
  const run = initGitRepo(cwd);
  mkdirSync(join(cwd, "forbidden"), { recursive: true });
  writeFileSync(join(cwd, "forbidden/secret.txt"), "secret\n");
  run("add", ".");
  run("commit", "-m", "test: add protected source");
  const originHeadBefore = git(cwd, "rev-parse", "HEAD");

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Move protected source", deps: [], writePaths: ["allowed/**"], acceptance: { criteria: ["source is gated"], commands: ["true"] }, workflow: "tdd" }],
  });
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  mkdirSync(join(dispatched.workspace.path, "allowed"), { recursive: true });
  git(dispatched.workspace.path, "mv", "forbidden/secret.txt", "allowed/secret.txt");
  git(dispatched.workspace.path, "commit", "-m", "test: move protected source");
  await invoke(pi, "goal_settle", {
    task_id: "t1", outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1" }, evidence_source: "self_produced",
    next_action: "Attempt integration and verify the forbidden rename source is rejected.",
  });

  await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }), /writePaths|forbidden|mismatch/i);
  assert.equal(git(cwd, "rev-parse", "HEAD"), originHeadBefore);
  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.branchExists, true);
  assert.equal(state.leaseExists, true);
});

test("goal_integrate rejects rogue commit appended after started event (rogue)", async () => {
  const cwd = tmpCwd();
  const objective = "Started rogue recovery test goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Write allowed source", deps: [], writePaths: ["src/allowed.ts"], acceptance: { criteria: ["allowed write"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/allowed.ts", "export const allowed = true;\n", "feat: allowed change");
  const expectedExecutorHead = git(dispatched.workspace.path, "rev-parse", "HEAD");

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/allowed.ts" },
    evidence_source: "self_produced",
    next_action: "Simulate started append then rogue commit to the workspace before retrying integrate",
  });

  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const originHeadBefore = git(cwd, "rev-parse", "HEAD");
  appendEventStore(join(cwd, ".state/goal-engine"), {
    schemaVersion: "goal-engine.event.v2",
    eventId: "rogue-started-event",
    goalId,
    type: "task.workspace_disposition_started",
    occurredAt: new Date().toISOString(),
    data: {
      taskId: "t1",
      attempt: 1,
      requestedAction: "integrate",
      strategy: "cherry-pick",
      executorHead: expectedExecutorHead,
      originHeadBefore,
      originRef: git(cwd, "symbolic-ref", "--quiet", "HEAD"),
    },
  }, projection.version);

  commitWorkspaceChange(dispatched.workspace, "outside/rogue.txt", "export const rogue = true;\n", "feat: rogue change");
  await assert.rejects(
    () => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }),
    /executor.*HEAD|HEAD.*expected|HEAD.*changed/i,
  );

  const afterProjection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(afterProjection.tasks.get("t1").workspace.phase, "disposing");
  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.leaseExists, true);
  assert.equal(state.branchExists, true);
  assert.equal(git(cwd, "rev-parse", "HEAD"), originHeadBefore);
});


test("goal_integrate rejects identity-mismatched lease branch before side effects (identity)", async () => {
  const cwd = tmpCwd();
  const objective = "Identity mismatch branch recovery goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Write scoped source", deps: [], writePaths: ["src/identity.ts"], acceptance: { criteria: ["identity check"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/identity.ts", "export const identity = true;\n", "feat: identity write");

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/identity.ts" },
    evidence_source: "self_produced",
    next_action: "Keep the real branch and detect lease branch tampering before applying workspace changes",
  });

  const leasePath = workspaceState(cwd, goalId, "t1").leasePath;
  const lease = JSON.parse(readFileSync(leasePath, "utf8"));
  const victimBranch = `ge/${goalId}-victim-identity`;
  execFileSync("git", ["branch", victimBranch], { cwd });
  lease.branch = victimBranch;
  writeFileSync(leasePath, JSON.stringify(lease, null, 2) + "\n");

  const projectionBefore = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const originHeadBefore = git(cwd, "rev-parse", "HEAD");
  await assert.rejects(
    () => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }),
    /lease.*branch|branch.*snapshot|workspace.*identity/i,
  );

  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const task = projection.tasks.get("t1");
  assert.equal(task.workspace.phase, projectionBefore.tasks.get("t1").workspace.phase);
  assert.equal(task.workspace.branch, dispatched.workspace.branch);

  const currentLease = JSON.parse(readFileSync(leasePath, "utf8"));
  assert.equal(currentLease.branch, victimBranch);

  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.leaseExists, true);
  assert.equal(state.branchExists, true);
  assert.notEqual(git(cwd, "branch", "--list", victimBranch), "");
  assert.equal(git(cwd, "rev-parse", "HEAD"), originHeadBefore);
});

test("goal_integrate follows v2 three-phase flow and accepts with workspaceAttempt", async () => {
  const cwd = tmpCwd();
  const objective = "Normal v2 integrate flow goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Commit with allowed path", deps: [], writePaths: ["src/integrate.ts"], acceptance: { criteria: ["integrated"], commands: ["node --test test/integrate.test.mjs"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));

  const dispatchEvents = readGoalEvents(cwd, goalId);
  const dispatchEvent = dispatchEvents.at(-1);
  assert.equal(dispatchEvent.schemaVersion, "goal-engine.event.v2");
  assert.equal(dispatchEvent.type, "task.dispatched");
  assert.ok(dispatchEvent.data.workspace, "dispatch event should include workspace snapshot");
  assert.equal(dispatchEvent.data.workspace.attempt, 1);
  assert.equal(dispatchEvent.data.workspace.path, dispatched.workspace.path);
  assert.equal(dispatchEvent.data.workspace.branch, dispatched.workspace.branch);

  commitWorkspaceChange(dispatched.workspace, "src/integrate.ts", "export const integrate = true;\n", "feat: v2 integrate");
  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/integrate.ts" },
    evidence_source: "self_produced",
    next_action: "Integrate t1 and then accept this task using workspaceAttempt",
  });

  const integrate = pi.tools.find((t) => t.name === "goal_integrate");
  const integrated = JSON.parse(await invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }));
  assert.equal(integrated.action, "integrated");
  assert.equal(integrated.released, true);
  assert.equal(integrated.strategy, "cherry-pick");
  assert.equal(integrated.newHead, git(cwd, "rev-parse", "HEAD"));

  const events = readGoalEvents(cwd, goalId);
  const dispositionEvents = events.filter((event) => ["task.workspace_disposition_started", "task.workspace_disposition_applied", "task.workspace_disposed"].includes(event.type));
  const tail = dispositionEvents.slice(-3).map((event) => event.type);
  assert.deepEqual(tail, [
    "task.workspace_disposition_started",
    "task.workspace_disposition_applied",
    "task.workspace_disposed",
  ]);

  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const task = projection.tasks.get("t1");
  assert.equal(task.workspace.phase, "disposed");
  assert.equal(task.workspace.disposition, "integrated");
  assert.equal(task.workspace.released, true);
  assert.equal(task.workspace.attempt, 1);

  const status = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(status.tasks.t1.status, "succeeded");
  assert.equal(status.tasks.t1.workspace.phase, "disposed");
  assert.equal(status.tasks.t1.workspace.disposition, "integrated");
  assert.equal(status.tasks.t1.workspace.released, true);

  const accept = pi.tools.find((t) => t.name === "goal_accept");
  const accepted = JSON.parse(await invoke(pi, "goal_accept", { task_id: "t1" }));
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.goal_complete, true);

  const acceptedEvents = readGoalEvents(cwd, goalId).filter((event) => event.type === "task.accepted");
  assert.equal(acceptedEvents.at(-1).schemaVersion, "goal-engine.event.v2");
  assert.equal(acceptedEvents.at(-1).data.workspaceAttempt, 1);

  const projectionAfterAccept = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projectionAfterAccept.tasks.get("t1").workspace.phase, "disposed");
  assert.equal(projectionAfterAccept.tasks.get("t1").workspace.disposition, "integrated");
  assert.equal(projectionAfterAccept.tasks.get("t1").workspace.released, true);
});

test("failed settle keeps active workspace and blocks redispatch until discard", async () => {
  const cwd = tmpCwd();
  const objective = "Failed settle dispatch gate goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Work that failed", deps: [], writePaths: ["src/fail.ts"], acceptance: { criteria: ["fails"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/fail.ts", "export const fail = true;\n", "feat: failed path");

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "failed",
    next_action: "Investigate failure and retry t1 with an alternative strategy after fixing the bug",
  });

  await assert.rejects(
    () => invoke(pi, "goal_dispatch", { task_id: "t1" }),
    /workspace|dispatched|pending|retry/i,
  );

  const discard = JSON.parse(await invoke(pi, "goal_integrate", { task_id: "t1", action: "discard" }));
  assert.equal(discard.action, "discarded");
  assert.equal(discard.released, true);

  const retryDispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  assert.ok(retryDispatched.workspace.branch.endsWith("/2"));

  const status = pi.tools.find((t) => t.name === "goal_status");
  const projection = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(projection.tasks.t1.attempts, 2);
  const state = workspaceState(cwd, goalId, "t1", 2);
  assert.equal(state.workspaceExists, true);
  assert.equal(state.branchExists, true);
});

test("preserve keeps workspace and rejects accept/dispatch/discard afterwards", async () => {
  const cwd = tmpCwd();
  const objective = "Preserve gate test goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Work to preserve", deps: [], writePaths: ["src/preserve.ts"], acceptance: { criteria: ["preserved"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/preserve.ts", "export const preserve = true;\n", "feat: preserve path");

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/preserve.ts" },
    evidence_source: "self_produced",
    next_action: "Preserve the workspace and block further attempts until explicit action is taken",
  });

  const preserve = JSON.parse(await invoke(pi, "goal_integrate", { task_id: "t1", action: "preserve" }));
  assert.equal(preserve.action, "preserved");
  assert.equal(preserve.path, dispatched.workspace.path);
  assert.equal(preserve.branch, dispatched.workspace.branch);

  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.branchExists, true);

  const persistedLease = JSON.parse(readFileSync(state.leasePath, "utf8"));
  persistedLease.branch = `ge/${goalId}-tampered-preserve`;
  writeFileSync(state.leasePath, JSON.stringify(persistedLease, null, 2) + "\n");
  await assert.rejects(
    () => invoke(pi, "goal_integrate", { task_id: "t1", action: "preserve" }),
    /persisted.*lease.*branch.*mismatch/i,
  );

  await assert.rejects(() => invoke(pi, "goal_accept", { task_id: "t1" }), /workspace|integrated|attempt/i);
  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), /pending|dispatched|workspace|attempt|redispatch/i);
  await assert.rejects(
    () => invoke(pi, "goal_integrate", { task_id: "t1", action: "discard" }),
    /workspace|preserved|attempt|state|disposed|discard/i,
  );
});

test("dependent pending task cannot be dispatched when dependency is not accepted", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective: "Dependent dispatch guard test goal",
    tasks: [
      { id: "t1", description: "Base task", deps: [], writePaths: ["src/base.ts"], acceptance: { criteria: ["base done"], commands: ["true"] }, workflow: "tdd" },
      { id: "t2", description: "Dependent task", deps: ["t1"], writePaths: ["src/depend.ts"], acceptance: { criteria: ["depend done"], commands: ["true"] }, workflow: "tdd" },
    ],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  await invoke(pi, "goal_dispatch", { task_id: "t1" });

  await assert.rejects(
    () => invoke(pi, "goal_dispatch", { task_id: "t2" }),
    /dependency|depends|accepted|not pending|pending/i,
  );
});

test("action recovery: applied append retry should skip duplicate Git integration and only complete disposal", async () => {
  const cwd = tmpCwd();
  const objective = "Event failure applied append goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const injectedAppendEvent = createFailingAppendEvent("task.workspace_disposition_applied");

  const initPi = createMockPi(cwd);
  createGoalEngineWithAppendInjection(initPi, { appendEvent: injectedAppendEvent.appendEvent });

  const init = initPi.tools.find((t) => t.name === "goal_init");
  await invoke(initPi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Simulate applied append failure recovery", deps: [], writePaths: ["src/event.ts"], acceptance: { criteria: ["recover"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = initPi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(initPi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/event.ts", "export const event = true;\n", "feat: event recovery");

  const settle = initPi.tools.find((t) => t.name === "goal_settle");
  await invoke(initPi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/event.ts" },
    evidenceSource: "self_produced",
    next_action: "Integrate t1 and retry from projection without re-applying duplicate changes",
  });

  const originHeadBeforeIntegration = git(cwd, "rev-parse", "HEAD");
  await assert.rejects(
    () => invoke(initPi, "goal_integrate", { task_id: "t1", action: "integrate" }),
    /injected appendEvent failure for task\.workspace_disposition_applied/i,
  );

  const originHeadAfterFailure = git(cwd, "rev-parse", "HEAD");
  assert.notEqual(originHeadAfterFailure, originHeadBeforeIntegration);
  assert.equal(Number(git(cwd, "rev-list", "--count", `${originHeadBeforeIntegration}..HEAD`)), 1);

  const stateBeforeRetry = workspaceState(cwd, goalId, "t1");
  assert.equal(stateBeforeRetry.workspaceExists, true);
  assert.equal(stateBeforeRetry.branchExists, true);
  assert.equal(stateBeforeRetry.leaseExists, true);

  const projectionAfterFailure = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const taskAfterFailure = projectionAfterFailure.tasks.get("t1");
  assert.equal(taskAfterFailure.workspace.phase, "disposing");
  assert.equal(taskAfterFailure.workspace.disposition, undefined);
  assert.equal(taskAfterFailure.workspace.released, undefined);

  const statusFromFailureA = JSON.parse(await invoke(initPi, "goal_status", {}));
  assertTaskMachineAction(statusFromFailureA.tasks.t1, {
    allowedActions: ["goal_integrate"],
    requiredTool: "goal_integrate",
    requiredParams: { task_id: "t1", action: "integrate", strategy: "cherry-pick" },
    blockingReason: null,
  });

  const otherStatusBeforeRetry = git(cwd, "status", "--porcelain=v1");
  git(cwd, "branch", "other");
  git(cwd, "switch", "other");
  const otherBeforeRetry = git(cwd, "rev-parse", "HEAD");
  const retryPi = createMockPi(cwd);
  createGoalEngineExtension(retryPi);
  await assert.rejects(() => invoke(retryPi, "goal_integrate", { task_id: "t1", action: "integrate" }), /origin ref mismatch/i);
  assert.equal(git(cwd, "rev-parse", "HEAD"), otherBeforeRetry);
  assert.equal(git(cwd, "status", "--porcelain=v1"), otherStatusBeforeRetry);
  assert.deepEqual(workspaceState(cwd, goalId, "t1"), stateBeforeRetry);
  git(cwd, "switch", "main");
  const statusFromFailureB = JSON.parse(await invoke(retryPi, "goal_status", {}));
  assert.deepEqual(statusFromFailureA.tasks.t1.allowedActions, statusFromFailureB.tasks.t1.allowedActions);
  assert.deepEqual(statusFromFailureA.tasks.t1.requiredNextAction, statusFromFailureB.tasks.t1.requiredNextAction);
  assert.deepEqual(statusFromFailureA.tasks.t1.blockingReason, statusFromFailureB.tasks.t1.blockingReason);

  const retryIntegrate = JSON.parse(await invoke(retryPi, "goal_integrate", { task_id: "t1", action: "integrate" }));
  assert.equal(retryIntegrate.action, "integrated");
  assert.equal(retryIntegrate.released, true);

  const originHeadAfterRetry = git(cwd, "rev-parse", "HEAD");
  assert.equal(originHeadAfterRetry, originHeadAfterFailure);

  const events = readGoalEvents(cwd, goalId);
  const dispositionEvents = events.filter((event) => ["task.workspace_disposition_started", "task.workspace_disposition_applied", "task.workspace_disposed"].includes(event.type));
  assert.deepEqual(dispositionEvents.slice(-3).map((event) => event.type), [
    "task.workspace_disposition_started",
    "task.workspace_disposition_applied",
    "task.workspace_disposed",
  ]);
  assert.equal(dispositionEvents.filter((event) => event.type === "task.workspace_disposition_started").length, 1);
  assert.equal(dispositionEvents.filter((event) => event.type === "task.workspace_disposition_applied").length, 1);
  assert.equal(dispositionEvents.filter((event) => event.type === "task.workspace_disposed").length, 1);

  const projectionAfterRetry = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projectionAfterRetry.tasks.get("t1").workspace.phase, "disposed");
});

test("action recovery: disposed append can be repaired from projection snapshot without lease", async () => {
  const cwd = tmpCwd();
  const objective = "Event failure disposed append goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const injectedAppendEvent = createFailingAppendEvent("task.workspace_disposed");

  const initPi = createMockPi(cwd);
  createGoalEngineWithAppendInjection(initPi, { appendEvent: injectedAppendEvent.appendEvent });

  const init = initPi.tools.find((t) => t.name === "goal_init");
  await invoke(initPi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Simulate disposed append recovery", deps: [], writePaths: ["src/dispose.ts"], acceptance: { criteria: ["recover"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = initPi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(initPi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/dispose.ts", "export const dispose = true;\n", "feat: dispose recovery");

  const settle = initPi.tools.find((t) => t.name === "goal_settle");
  await invoke(initPi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/dispose.ts" },
    evidenceSource: "self_produced",
    next_action: "Integrate t1 first, then recover from projection snapshot without lease",
  });

  const originHeadBeforeIntegration = git(cwd, "rev-parse", "HEAD");
  await assert.rejects(
    () => invoke(initPi, "goal_integrate", { task_id: "t1", action: "integrate" }),
    /injected appendEvent failure for task\.workspace_disposed/i,
  );

  const originHeadAfterFailure = git(cwd, "rev-parse", "HEAD");
  assert.notEqual(originHeadAfterFailure, originHeadBeforeIntegration);

  const stateAfterFailure = workspaceState(cwd, goalId, "t1");
  assert.equal(stateAfterFailure.workspaceExists, false);
  assert.equal(stateAfterFailure.leaseExists, false);
  assert.equal(stateAfterFailure.branchExists, false);

  const projectionAfterFailure = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const taskAfterFailure = projectionAfterFailure.tasks.get("t1");
  assert.equal(taskAfterFailure.workspace.phase, "applied");
  assert.equal(taskAfterFailure.workspace.disposition, "integrated");
  assert.equal(taskAfterFailure.workspace.released, undefined);

  const statusFromFailureA = JSON.parse(await invoke(initPi, "goal_status", {}));
  assertTaskMachineAction(statusFromFailureA.tasks.t1, {
    allowedActions: ["goal_integrate"],
    requiredTool: "goal_integrate",
    requiredParams: { task_id: "t1", action: "integrate", strategy: "cherry-pick" },
    blockingReason: null,
  });

  const retryPi = createMockPi(cwd);
  createGoalEngineExtension(retryPi);
  const statusFromFailureB = JSON.parse(await invoke(retryPi, "goal_status", {}));
  assert.deepEqual(statusFromFailureA.tasks.t1.allowedActions, statusFromFailureB.tasks.t1.allowedActions);
  assert.deepEqual(statusFromFailureA.tasks.t1.requiredNextAction, statusFromFailureB.tasks.t1.requiredNextAction);
  assert.deepEqual(statusFromFailureA.tasks.t1.blockingReason, statusFromFailureB.tasks.t1.blockingReason);

  const otherStatusBeforeRetry = git(cwd, "status", "--porcelain=v1");
  git(cwd, "branch", "other");
  git(cwd, "switch", "other");
  const otherBeforeRetry = git(cwd, "rev-parse", "HEAD");
  await assert.rejects(() => invoke(retryPi, "goal_integrate", { task_id: "t1", action: "integrate" }), /origin ref mismatch/i);
  assert.equal(git(cwd, "rev-parse", "HEAD"), otherBeforeRetry);
  assert.equal(git(cwd, "status", "--porcelain=v1"), otherStatusBeforeRetry);
  assert.deepEqual(workspaceState(cwd, goalId, "t1"), stateAfterFailure);
  git(cwd, "switch", "main");

  const result = JSON.parse(await invoke(retryPi, "goal_integrate", { task_id: "t1", action: "integrate" }));
  assert.equal(result.action, "integrated");
  assert.equal(result.released, true);

  const events = readGoalEvents(cwd, goalId);
  const dispositionEvents = events.filter((event) => ["task.workspace_disposition_started", "task.workspace_disposition_applied", "task.workspace_disposed"].includes(event.type));
  assert.deepEqual(dispositionEvents.slice(-3).map((event) => event.type), [
    "task.workspace_disposition_started",
    "task.workspace_disposition_applied",
    "task.workspace_disposed",
  ]);
  assert.equal(dispositionEvents.filter((event) => event.type === "task.workspace_disposition_started").length, 1);
  assert.equal(dispositionEvents.filter((event) => event.type === "task.workspace_disposition_applied").length, 1);
  assert.equal(dispositionEvents.filter((event) => event.type === "task.workspace_disposed").length, 1);

  const finalState = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(finalState.tasks.get("t1").workspace.phase, "disposed");
  assert.equal(finalState.tasks.get("t1").workspace.released, true);
});

test("event failure: applied preserve retry rejects a different strategy", async () => {
  const cwd = tmpCwd();
  const objective = "Applied preserve strategy identity goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const injectedAppendEvent = createFailingAppendEvent("task.workspace_disposed");
  const initPi = createMockPi(cwd);
  createGoalEngineWithAppendInjection(initPi, { appendEvent: injectedAppendEvent.appendEvent });

  const init = initPi.tools.find((t) => t.name === "goal_init");
  await invoke(initPi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Preserve strategy identity", deps: [], writePaths: ["src/preserve-strategy.ts"], acceptance: { criteria: ["preserve"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatched = JSON.parse(await invoke(initPi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/preserve-strategy.ts", "export const preserveStrategy = true;\n", "feat: preserve strategy");
  await invoke(initPi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/preserve-strategy.ts" },
    evidence_source: "self_produced",
    next_action: "Preserve t1 with its original strategy and reject identity changes during retry",
  });

  await assert.rejects(
    () => invoke(initPi, "goal_integrate", { task_id: "t1", action: "preserve", strategy: "merge" }),
    /injected appendEvent failure for task\.workspace_disposed/i,
  );

  const projectionAfterFailure = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projectionAfterFailure.tasks.get("t1").workspace.phase, "applied");
  assert.equal(projectionAfterFailure.tasks.get("t1").workspace.strategy, "merge");

  const retryPi = createMockPi(cwd);
  createGoalEngineExtension(retryPi);
  await assert.rejects(
    () => invoke(retryPi, "goal_integrate", { task_id: "t1", action: "preserve", strategy: "cherry-pick" }),
    /strategy mismatch/i,
  );

  const preserved = JSON.parse(await invoke(retryPi, "goal_integrate", { task_id: "t1", action: "preserve", strategy: "merge" }));
  assert.equal(preserved.action, "preserved");
  assert.equal(preserved.released, false);
  assert.equal(preserved.path, dispatched.workspace.path);
  assert.equal(preserved.branch, dispatched.workspace.branch);
});

test("event failure: disposed append durable-then-throw keeps disposed and rejects different strategy retry", async () => {
  const cwd = tmpCwd();
  const objective = "Event failure disposed durable then throw goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const injectedAppendEvent = createDurableThenThrowAppendEvent("task.workspace_disposed");

  const initPi = createMockPi(cwd);
  createGoalEngineWithAppendInjection(initPi, { appendEvent: injectedAppendEvent.appendEvent });

  const init = initPi.tools.find((t) => t.name === "goal_init");
  await invoke(initPi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Simulate durable-then-throw recovery", deps: [], writePaths: ["src/durable.ts"], acceptance: { criteria: ["recover"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = initPi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(initPi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/durable.ts", "export const durable = true;\n", "feat: durable recovery");

  const settle = initPi.tools.find((t) => t.name === "goal_settle");
  await invoke(initPi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/durable.ts" },
    evidenceSource: "self_produced",
    next_action: "Integrate t1 once, and ensure same strategy retry is idempotent after durable dispose",
  });

  await assert.rejects(
    () => invoke(initPi, "goal_integrate", { task_id: "t1", action: "integrate", strategy: "merge" }),
    /injected appendEvent failure after persisting task\.workspace_disposed/i,
  );

  const projectionAfterFailure = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const taskAfterFailure = projectionAfterFailure.tasks.get("t1");
  assert.equal(taskAfterFailure.workspace.phase, "disposed");
  assert.equal(taskAfterFailure.workspace.disposition, "integrated");
  assert.equal(taskAfterFailure.workspace.released, true);

  const stateAfterFailure = workspaceState(cwd, goalId, "t1");
  assert.equal(stateAfterFailure.workspaceExists, false);
  assert.equal(stateAfterFailure.leaseExists, false);
  assert.equal(stateAfterFailure.branchExists, false);

  const eventsAfterFailure = readGoalEvents(cwd, goalId).filter((event) => ["task.workspace_disposition_started", "task.workspace_disposition_applied", "task.workspace_disposed"].includes(event.type));
  assert.equal(eventsAfterFailure.filter((event) => event.type === "task.workspace_disposition_started").length, 1);
  assert.equal(eventsAfterFailure.filter((event) => event.type === "task.workspace_disposition_applied").length, 1);
  assert.equal(eventsAfterFailure.filter((event) => event.type === "task.workspace_disposed").length, 1);

  const retryPi = createMockPi(cwd);
  createGoalEngineExtension(retryPi);
  await assert.rejects(
    () => invoke(retryPi, "goal_integrate", { task_id: "t1", action: "integrate", strategy: "cherry-pick" }),
    /strategy mismatch|already disposed|action mismatch|phase/i,
  );

  const retryResult = JSON.parse(await invoke(retryPi, "goal_integrate", { task_id: "t1", action: "integrate", strategy: "merge" }));
  assert.equal(retryResult.action, "integrated");
  assert.equal(retryResult.released, true);
  assert.equal(retryResult.strategy, "merge");

  const eventsAfterRetry = readGoalEvents(cwd, goalId).filter((event) => ["task.workspace_disposition_started", "task.workspace_disposition_applied", "task.workspace_disposed"].includes(event.type));
  assert.equal(eventsAfterRetry.filter((event) => event.type === "task.workspace_disposition_started").length, 1);
  assert.equal(eventsAfterRetry.filter((event) => event.type === "task.workspace_disposition_applied").length, 1);
  assert.equal(eventsAfterRetry.filter((event) => event.type === "task.workspace_disposed").length, 1);
});

test("goal_settle rejects vague next_action", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective: "Vague action test goal",
    tasks: [{ id: "t1", description: "work item", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  await invoke(pi, "goal_dispatch", { task_id: "t1" });

  const settle = pi.tools.find((t) => t.name === "goal_settle");
  await assert.rejects(
    () => invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "a.ts" }, next_action: "continue" }),
    /at least 20 characters|specific/i,
  );
});

test("tool_result hook appends reminder when checkpoint overdue", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective: "Hook test goal for reminder",
    tasks: [{ id: "t1", description: "work", deps: [], writePaths: ["a.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }],
  });

  const hook = pi.hooks.tool_result[0];
  assert.equal(hook({ toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false }), undefined);
  let lastResult;
  for (let i = 0; i < 6; i++) {
    lastResult = hook({ toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "ok" }], isError: false }, { cwd });
  }

  const text = lastResult?.content?.[0]?.text || "";
  assert.match(text, /goal-engine/);
  assert.match(text, /未 settle/);
});


test("goal_amend rejects an active workspace remove without releasing resources", async () => {
  const cwd = tmpCwd();
  const objective = "Amend active workspace protection goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Protected active task", deps: [], writePaths: ["src/protected.ts"], acceptance: { criteria: ["protected"], commands: ["true"] }, workflow: "tdd" }] });
  await invoke(pi, "goal_dispatch", { task_id: "t1" });
  const beforeEvents = readGoalEvents(cwd, goalId).length;
  await assert.rejects(() => invoke(pi, "goal_amend", { reason: "Do not delete a task that still owns active workspace resources", remove_tasks: ["t1"] }), /pending|workspace|remove/i);
  assert.equal(readGoalEvents(cwd, goalId).length, beforeEvents);
  assert.deepEqual(workspaceState(cwd, goalId, "t1"), {
    ...workspaceState(cwd, goalId, "t1"), workspaceExists: true, leaseExists: true, branchExists: true,
  });
});

async function prepareSucceededTask(pi, taskId = "t1") {
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: taskId }));
  commitWorkspaceChange(dispatched.workspace, `src/${taskId}.ts`, `export const ${taskId} = true;\n`, `feat: ${taskId}`);
  await invoke(pi, "goal_settle", {
    task_id: taskId, outcome: "succeeded", evidence: { type: "file", path: `src/${taskId}.ts` },
    evidence_source: "self_produced", next_action: `Integrate ${taskId} before recording final acceptance for recovery testing`,
  });
  await invoke(pi, "goal_integrate", { task_id: taskId, action: "integrate" });
}

test("goal_accept retries final accepted after goal.completed pre-durable failure exactly once", async () => {
  const cwd = tmpCwd(); const objective = "Final accepted retry"; const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);
  const injected = createFailingAppendEvent("goal.completed");
  const pi = createMockPi(cwd); createGoalEngineExtension(pi, { appendEvent: injected.appendEvent });
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "final task", deps: [], writePaths: ["src/t1.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }] });
  await prepareSucceededTask(pi);
  await assert.rejects(() => invoke(pi, "goal_accept", { task_id: "t1" }), /injected appendEvent failure/);
  let projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.lifecycle, "active"); assert.equal(projection.tasks.get("t1").status, "accepted");
  const recoveringPi = createMockPi(cwd); createGoalEngineExtension(recoveringPi);
  const recovered = JSON.parse(await invoke(recoveringPi, "goal_accept", { goal_id: goalId, task_id: "t1" }));
  assert.equal(recovered.goal_complete, true);
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "goal.completed").length, 1);
  const before = readGoalEvents(cwd, goalId).length;
  await invoke(recoveringPi, "goal_accept", { goal_id: goalId, task_id: "t1" });
  assert.equal(readGoalEvents(cwd, goalId).length, before);
});

test("goal_accept task.accepted durable-then-throw recovers and completes exactly once", async () => {
  const cwd = tmpCwd(); const objective = "Accepted durable retry"; const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd); const injected = createDurableThenThrowAppendEvent("task.accepted");
  const pi = createMockPi(cwd); createGoalEngineExtension(pi, { appendEvent: injected.appendEvent });
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "durable task", deps: [], writePaths: ["src/t1.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }] });
  await prepareSucceededTask(pi);
  assert.equal(JSON.parse(await invoke(pi, "goal_accept", { task_id: "t1" })).goal_complete, true);
  const events = readGoalEvents(cwd, goalId);
  assert.equal(events.filter((event) => event.type === "task.accepted").length, 1);
  assert.equal(events.filter((event) => event.type === "goal.completed").length, 1);
});

test("goal_accept goal.completed durable-then-throw returns completion retry exactly once", async () => {
  const cwd = tmpCwd(); const objective = "Completion durable retry"; const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd); const injected = createDurableThenThrowAppendEvent("goal.completed");
  const pi = createMockPi(cwd); createGoalEngineExtension(pi, { appendEvent: injected.appendEvent });
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "durable completion", deps: [], writePaths: ["src/t1.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }] });
  await prepareSucceededTask(pi);
  assert.equal(JSON.parse(await invoke(pi, "goal_accept", { task_id: "t1" })).goal_complete, true);
  const before = readGoalEvents(cwd, goalId).length;
  await invoke(pi, "goal_accept", { goal_id: goalId, task_id: "t1" });
  assert.equal(readGoalEvents(cwd, goalId).length, before);
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "goal.completed").length, 1);
});

test("goal_accept non-final accepted durable retry does not append and remains incomplete", async () => {
  const cwd = tmpCwd(); const objective = "Non final accepted retry"; const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd); const injected = createDurableThenThrowAppendEvent("task.accepted");
  const pi = createMockPi(cwd); createGoalEngineExtension(pi, { appendEvent: injected.appendEvent });
  await invoke(pi, "goal_init", { objective, tasks: [
    { id: "t1", description: "first durable task", deps: [], writePaths: ["src/t1.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" },
    { id: "t2", description: "remaining task", deps: [], writePaths: ["src/t2.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" },
  ] });
  await prepareSucceededTask(pi, "t1");
  const result = JSON.parse(await invoke(pi, "goal_accept", { task_id: "t1" }));
  assert.equal(result.status, "accepted"); assert.equal(result.goal_complete, false);
  const before = readGoalEvents(cwd, goalId).length;
  await invoke(pi, "goal_accept", { task_id: "t1" });
  assert.equal(readGoalEvents(cwd, goalId).length, before);
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.accepted").length, 1);
});

test("goal_accept completed historical verdict is durable authority without append", async () => {
  const cwd = tmpCwd(); const objective = "Historical verdict retry"; const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd); const pi = createMockPi(cwd); createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "historical evidence", deps: [], writePaths: ["src/t1.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" }] });
  await prepareSucceededTask(pi); await invoke(pi, "goal_accept", { task_id: "t1" });
  const before = readGoalEvents(cwd, goalId).length;
  const retryPi = createMockPi(cwd);
  createGoalEngineExtension(retryPi, { store: { loadProjection(root, id) {
    const projection = loadProjection(root, id);
    projection.tasks.get("t1").evidence.push({ source: "external" });
    return projection;
  } } });
  const result = JSON.parse(await invoke(retryPi, "goal_accept", { goal_id: goalId, task_id: "t1" }));
  assert.equal(result.completion_verdict, "DONE_WITHOUT_EXTERNAL_VERIFICATION");
  assert.equal(readGoalEvents(cwd, goalId).length, before);
});

test("goal_amend rejects accepted acceptance rewrite without appending an event", async () => {
  const cwd = tmpCwd();
  const objective = "Amend accepted proof protection goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [
    { id: "t1", description: "Accepted protected task", deps: [], writePaths: ["src/accepted.ts"], acceptance: { criteria: ["accepted"], commands: ["true"] }, workflow: "tdd" },
    { id: "t2", description: "Keep goal active after t1 acceptance", deps: ["t1"], writePaths: ["src/pending.ts"], acceptance: { criteria: ["pending"], commands: ["true"] }, workflow: "tdd" },
  ] });
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/accepted.ts", "export const accepted = true;\n", "feat: accepted proof");
  await invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/accepted.ts" }, evidence_source: "self_produced", next_action: "Integrate this accepted proof task before recording its final acceptance" });
  await invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" });
  await invoke(pi, "goal_accept", { task_id: "t1" });
  const beforeEvents = readGoalEvents(cwd, goalId).length;
  await assert.rejects(() => invoke(pi, "goal_amend", { reason: "Do not rewrite acceptance proof after the task has been accepted", update_tasks: { t1: { acceptance: { criteria: ["rewritten"], commands: ["false"] } } } }), /pending|accepted|update/i);
  assert.equal(readGoalEvents(cwd, goalId).length, beforeEvents);
});
