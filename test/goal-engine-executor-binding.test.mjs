import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { applyEvent, createProjection, PLANNED_SCHEMA_VERSION } from "../scripts/lib/goal-engine/events.mjs";
import { assertExecutorSettlementProof } from "../scripts/lib/goal-engine/executor-binding.mjs";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { appendEvent as appendGoalEvent, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { createTypedSubagentExtension } from "../scripts/lib/subagent-dispatch/extension.ts";
import { bindRootBroker, unbindRootBroker } from "../scripts/lib/subagent-dispatch/root-broker-registry.ts";
import { RootBrokerServer } from "../scripts/lib/subagent-dispatch/root-broker-server.ts";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";

const GOAL_ID = "binding-goal";
const CONTRACT_HASH = "a".repeat(64);
const BASE_COMMIT = "b".repeat(40);
const WORKSPACE = "/tmp/binding-goal-task-one-1";

function event(type, data, sequence) {
  return {
    schemaVersion: PLANNED_SCHEMA_VERSION,
    eventId: `event-${sequence}`,
    goalId: GOAL_ID,
    type,
    occurredAt: `2026-08-08T00:00:0${sequence}.000Z`,
    data,
  };
}

function dispatchedProjection() {
  let projection = applyEvent(createProjection(), event("goal.created", {
    objective: "Bind one Planned executor",
    scope: [],
    nonGoals: [],
    dod: [],
    tasks: ["task-one"],
    taskDefs: {
      "task-one": {
        description: "Bind the official executor run",
        deps: [],
        writePaths: ["src/task-one.mjs"],
        acceptance: {
          criteria: [{ id: "binding", statement: "The run is durably bound", evidenceKinds: ["tests"] }],
        },
        workflow: "tdd",
      },
    },
  }, 1));
  projection = applyEvent(projection, event("task.dispatched", {
    taskId: "task-one",
    contractHash: CONTRACT_HASH,
    workspace: {
      attempt: 1,
      path: WORKSPACE,
      branch: "ge/binding-goal/task-one/1",
      baseCommit: BASE_COMMIT,
      originRef: "refs/heads/main",
    },
  }, 2));
  return projection;
}

const EXACT_BINDING = Object.freeze({
  taskId: "task-one",
  attempt: 1,
  runId: "run-official-1",
  contractHash: CONTRACT_HASH,
  asyncDir: "/tmp/async-run-official-1",
  workspacePath: WORKSPACE,
  workspaceLeaseId: "1".repeat(64),
  headAtDispatch: BASE_COMMIT,
});

test("Planned reducer durably binds one exact executor run to the dispatched attempt", () => {
  const projection = applyEvent(dispatchedProjection(), event("task.executor_bound", EXACT_BINDING, 3));

  assert.deepEqual(projection.tasks.get("task-one").executorBinding, {
    attempt: 1,
    runId: "run-official-1",
    contractHash: CONTRACT_HASH,
    asyncDir: "/tmp/async-run-official-1",
    workspacePath: WORKSPACE,
    workspaceLeaseId: "1".repeat(64),
    headAtDispatch: BASE_COMMIT,
  });
});

test("executor binding rejects missing, additional, stale, or replaced identity fields", () => {
  const cases = [
    { name: "missing runId", value: Object.fromEntries(Object.entries(EXACT_BINDING).filter(([key]) => key !== "runId")) },
    { name: "additional field", value: { ...EXACT_BINDING, ownerClaim: "self-reported" } },
    { name: "wrong attempt", value: { ...EXACT_BINDING, attempt: 2 } },
    { name: "wrong contract", value: { ...EXACT_BINDING, contractHash: "c".repeat(64) } },
    { name: "wrong workspace", value: { ...EXACT_BINDING, workspacePath: "/tmp/replacement" } },
    { name: "wrong head", value: { ...EXACT_BINDING, headAtDispatch: "d".repeat(40) } },
    { name: "wrong lease", value: { ...EXACT_BINDING, workspaceLeaseId: "not-a-lease-identity" } },
    { name: "relative async directory", value: { ...EXACT_BINDING, asyncDir: "relative/run" } },
  ];

  for (const scenario of cases) {
    assert.throws(
      () => applyEvent(dispatchedProjection(), event("task.executor_bound", scenario.value, 3)),
      undefined,
      scenario.name,
    );
  }
});

test("one Root Broker runId cannot be bound to two Goal task attempts", () => {
  const secondHash = "2".repeat(64);
  const secondHead = "3".repeat(40);
  const secondWorkspace = "/tmp/binding-goal-task-two-1";
  let projection = applyEvent(createProjection(), event("goal.created", {
    objective: "Reject duplicate run ownership",
    scope: [], nonGoals: [], dod: [],
    tasks: ["task-one", "task-two"],
    taskDefs: {
      "task-one": { description: "first", deps: [], writePaths: ["src/one.mjs"], acceptance: { criteria: [{ id: "one", statement: "first works", evidenceKinds: ["tests"] }] }, workflow: "tdd" },
      "task-two": { description: "second", deps: [], writePaths: ["src/two.mjs"], acceptance: { criteria: [{ id: "two", statement: "second works", evidenceKinds: ["tests"] }] }, workflow: "tdd" },
    },
  }, 1));
  projection = applyEvent(projection, event("task.dispatched", {
    taskId: "task-one", contractHash: CONTRACT_HASH,
    workspace: { attempt: 1, path: WORKSPACE, branch: "ge/binding-goal/task-one/1", baseCommit: BASE_COMMIT, originRef: "refs/heads/main" },
  }, 2));
  projection = applyEvent(projection, event("task.dispatched", {
    taskId: "task-two", contractHash: secondHash,
    workspace: { attempt: 1, path: secondWorkspace, branch: "ge/binding-goal/task-two/1", baseCommit: secondHead, originRef: "refs/heads/main" },
  }, 3));
  projection = applyEvent(projection, event("task.executor_bound", EXACT_BINDING, 4));

  assert.throws(() => applyEvent(projection, event("task.executor_bound", {
    taskId: "task-two",
    attempt: 1,
    runId: EXACT_BINDING.runId,
    contractHash: secondHash,
    asyncDir: "/tmp/async-shared-run",
    workspacePath: secondWorkspace,
    workspaceLeaseId: "2".repeat(64),
    headAtDispatch: secondHead,
  }, 5)), /runId.*already bound|already bound.*runId/i);
});

test("retry dispatch clears the old attempt binding so its terminal proof cannot be reused", () => {
  let projection = applyEvent(dispatchedProjection(), event("task.executor_bound", EXACT_BINDING, 3));
  projection = applyEvent(projection, event("task.settled", {
    taskId: "task-one",
    outcome: "failed",
    evidence: null,
    evidenceSource: "self_produced",
    nextAction: "Discard the failed attempt workspace before creating a new executor run",
    reason: null,
    executorProof: {
      runId: "run-official-1",
      proofId: "6".repeat(64),
      rootSessionId: "root-session-1",
      observedAt: 1_700_000_000_000,
      outcome: "succeeded",
    },
  }, 4));
  projection = applyEvent(projection, event("task.workspace_disposition_started", {
    taskId: "task-one", attempt: 1, requestedAction: "discard", strategy: "cherry-pick",
    executorHead: BASE_COMMIT, originHeadBefore: BASE_COMMIT, originRef: "refs/heads/main",
  }, 5));
  projection = applyEvent(projection, event("task.workspace_disposition_applied", {
    taskId: "task-one", attempt: 1, action: "discard", strategy: "cherry-pick",
    executorHead: BASE_COMMIT, originHead: BASE_COMMIT,
  }, 6));
  projection = applyEvent(projection, event("task.workspace_disposed", {
    taskId: "task-one", attempt: 1, action: "discard", released: true,
  }, 7));
  projection = applyEvent(projection, event("task.dispatched", {
    taskId: "task-one",
    contractHash: "9".repeat(64),
    workspace: {
      attempt: 2,
      path: "/tmp/binding-goal-task-one-2",
      branch: "ge/binding-goal/task-one/2",
      baseCommit: "8".repeat(40),
      originRef: "refs/heads/main",
    },
  }, 8));

  assert.equal(projection.tasks.get("task-one").attempts, 2);
  assert.equal(projection.tasks.get("task-one").executorBinding, null);
  assert.throws(() => applyEvent(projection, event("task.executor_bound", {
    taskId: "task-one",
    attempt: 2,
    runId: EXACT_BINDING.runId,
    contractHash: "9".repeat(64),
    asyncDir: EXACT_BINDING.asyncDir,
    workspacePath: "/tmp/binding-goal-task-one-2",
    workspaceLeaseId: "3".repeat(64),
    headAtDispatch: "8".repeat(40),
  }, 9)), /runId.*already bound|already bound.*runId|runId.*reused/i);
});

test("one dispatched attempt accepts exactly one immutable executor binding", () => {
  const bound = applyEvent(dispatchedProjection(), event("task.executor_bound", EXACT_BINDING, 3));
  assert.throws(
    () => applyEvent(bound, event("task.executor_bound", { ...EXACT_BINDING, runId: "run-replacement" }, 4)),
    /already bound|immutable/i,
  );
});

test("official terminal proof validator rejects conflicting, unsuccessful, or wrongly owned runs", () => {
  const task = { executorBinding: { runId: "run-official-1", asyncDir: "/tmp/run-official-1" } };
  const valid = {
    schemaVersion: "root-broker.executor-proof.v1",
    ownership: {
      rootSessionId: "root-session-1",
      runId: "run-official-1",
      role: "executor",
      asyncDir: "/tmp/run-official-1",
      sessionId: "session-1",
      identityState: "verified",
    },
    terminal: { proofId: "e".repeat(64), observedAt: 1_700_000_000_000, outcome: "succeeded" },
    terminalConflict: false,
  };
  const scenarios = [
    ["EXECUTOR_TERMINAL_PROOF_INVALID", { ...valid, schemaVersion: "unknown" }],
    ["EXECUTOR_TERMINAL_PROOF_CONFLICT", { ...valid, terminalConflict: true }],
    ["EXECUTOR_OWNERSHIP_MISMATCH", { ...valid, ownership: { ...valid.ownership, runId: "run-foreign" } }],
    ["EXECUTOR_OWNERSHIP_MISMATCH", { ...valid, ownership: { ...valid.ownership, asyncDir: "/tmp/run-foreign" } }],
    ["EXECUTOR_OWNERSHIP_MISMATCH", { ...valid, ownership: { ...valid.ownership, identityState: "conflict" } }],
    ["EXECUTOR_TERMINAL_PROOF_MISSING", { ...valid, terminal: null }],
    ["EXECUTOR_TERMINAL_PROOF_INVALID", { ...valid, terminal: { ...valid.terminal, proofId: "not-a-proof" } }],
    ["EXECUTOR_TERMINAL_NOT_SUCCESSFUL", { ...valid, terminal: { ...valid.terminal, outcome: "failed" } }],
  ];
  for (const [code, proof] of scenarios) {
    assert.throws(() => assertExecutorSettlementProof({ task, proof }), (error) => error.code === code, code);
  }
  assert.deepEqual(assertExecutorSettlementProof({ task, proof: valid }), {
    runId: "run-official-1",
    proofId: "e".repeat(64),
    rootSessionId: "root-session-1",
    observedAt: 1_700_000_000_000,
    outcome: "succeeded",
  });
});

test("Planned failed or blocked settlement also requires and records the bound official terminal proof", () => {
  const bound = applyEvent(dispatchedProjection(), event("task.executor_bound", EXACT_BINDING, 3));
  const blocked = {
    taskId: "task-one",
    outcome: "blocked",
    evidence: null,
    evidenceSource: "self_produced",
    nextAction: "Amend the task contract before retrying this blocked executor attempt",
    reason: "The required write path is missing",
  };
  assert.throws(() => applyEvent(bound, event("task.settled", blocked, 4)), /executor.*proof|terminal.*proof/i);

  const projection = applyEvent(bound, event("task.settled", {
    ...blocked,
    executorProof: {
      runId: "run-official-1",
      proofId: "7".repeat(64),
      rootSessionId: "root-session-1",
      observedAt: 1_700_000_000_000,
      outcome: "succeeded",
    },
  }, 5));
  assert.equal(projection.tasks.get("task-one").status, "blocked");
  assert.deepEqual(projection.tasks.get("task-one").lastExecutorProof, {
    runId: "run-official-1",
    proofId: "7".repeat(64),
    rootSessionId: "root-session-1",
    observedAt: 1_700_000_000_000,
    outcome: "succeeded",
  });
});

test("Planned settlement cannot succeed without the exact bound official terminal proof", () => {
  const bound = applyEvent(dispatchedProjection(), event("task.executor_bound", EXACT_BINDING, 3));
  const settlement = {
    taskId: "task-one",
    outcome: "succeeded",
    evidence: { type: "diff", ref: BASE_COMMIT },
    evidenceSource: "self_produced",
    nextAction: "集成当前提交并在主分支独立复核全部验收标准",
    attempt: 1,
    executorHead: BASE_COMMIT,
  };
  assert.throws(
    () => applyEvent(bound, event("task.settled", settlement, 4)),
    /executor.*proof|terminal.*proof/i,
  );

  const settled = applyEvent(bound, event("task.settled", {
    ...settlement,
    executorProof: {
      runId: "run-official-1",
      proofId: "e".repeat(64),
      rootSessionId: "root-session-1",
      observedAt: 1_700_000_000_000,
      outcome: "succeeded",
    },
  }, 5));
  assert.deepEqual(settled.tasks.get("task-one").settlement, {
    attempt: 1,
    executorHead: BASE_COMMIT,
    executorRunId: "run-official-1",
    terminalProofId: "e".repeat(64),
  });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createEventBus() {
  const listeners = new Map();
  return {
    on(type, listener) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
      return () => current.delete(listener);
    },
    emit(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
}

function workflowSpawnReply(pi, params, { runId, asyncDir, agent, sessionId = "/tmp/s" }) {
  const workflowKey = params?.workflowScript?.match(/runs\.run\("([^"\\]+)"/)?.[1];
  const workflowAgent = agent ?? params?.workflowScript?.match(/"agent":"([^"\\]+)"/)?.[1];
  assert.ok(workflowKey, "workflow spawn must use a JSON-encoded runs.run key");
  assert.ok(workflowAgent, "workflow spawn must use a JSON-encoded child agent");
  const workflowRunId = `workflow-${runId}`;
  pi.events.emit("subagent:async-started", {
    id: runId,
    runId,
    asyncDir,
    sessionId,
    pid: 1,
    agent: workflowAgent,
    workflowKey,
    parentWorkflowRunId: workflowRunId,
  });
  return { details: { runId: workflowRunId, asyncDir: `/tmp/${workflowRunId}` } };
}

function integratedFixture(t) {
  const arena = createTemporaryArenaSync("executor-binding-");
  t.after(() => arena.disposeSync());
  const cwd = arena.mkdtempSync("repo-");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test User");
  writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n");
  writeFileSync(join(cwd, "README.md"), "fixture\n");
  git(cwd, "add", ".gitignore", "README.md");
  git(cwd, "commit", "-q", "-m", "test: initialize fixture");

  const tools = [];
  const eventIdentity = createEventBus();
  const sessionManager = {
    getSessionId: () => "root-session-1",
    getSessionFile: () => join(cwd, "session.jsonl"),
    getLeafId: () => "leaf-1",
    getEntries: () => [],
    getBranch: () => [],
  };
  const pi = {
    events: eventIdentity,
    registerTool(tool) { tools.push(tool); },
    on() {},
    appendEntry() {},
  };
  const context = { cwd, sessionManager };
  const invoke = async (name, params) => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `missing tool ${name}`);
    const result = await tool.execute(`call-${name}`, params, new AbortController().signal, undefined, context);
    return result.details.value;
  };
  return { cwd, pi, tools, context, invoke };
}

const STRICT_CODING_CONTRACT = Object.freeze({
  version: "dispatch-ir.v1",
  taskId: "goal.task",
  title: "Execute the exact Goal task",
  agent: "executor",
  risk: "normal",
  objective: "Execute without replacing the ticket.",
  requirements: ["Keep the exact contract."],
  workflow: { mode: "tdd" },
  context: { knownFacts: [], decisions: [], relevantFiles: [] },
  boundaries: { writePaths: ["src/task.mjs"], excludedWork: [], forbiddenActions: [] },
  acceptance: { criteria: ["The ticket remains exact."] },
  execution: { cwd: "/repo", timeoutMs: 1_000 },
});

test("Subagent recomputes the Goal ticket after prepare and prevents execute-time replacement", async () => {
  const tools = [];
  const pi = { events: {}, registerTool(tool) { tools.push(tool); }, on() {} };
  let spawnCalls = 0;
  let prepareCalls = 0;
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: "/tmp/s", cwd: "/repo" } }; },
    async spawn() { spawnCalls += 1; return { details: { runId: "run-1", asyncDir: "/tmp/run-1" } }; },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  const goalExecutorCoordinator = {
    prepareSpawn() {
      prepareCalls += 1;
      const suffix = String(prepareCalls);
      return { ticketId: `ticket-${suffix}`, spawnIdentity: { requestId: `request-${suffix}`, spawnKey: `request-${suffix}` } };
    },
    async bindSpawn() {},
  };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    goalExecutorCoordinator,
    async prepareCodingSpawn() {},
  });
  const result = await tools[0].execute("replace-at-execute", STRICT_CODING_CONTRACT, undefined, undefined, { cwd: "/repo" });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "EXECUTOR_BINDING_MISMATCH");
  assert.equal(prepareCalls, 2);
  assert.equal(spawnCalls, 0);
});

async function initializeIntegratedDispatch(fixture, objective = "Integrated executor binding", extensionOptions = {}) {
  createGoalEngineExtension(fixture.pi, { goalStateEnv: {}, ...extensionOptions });
  await fixture.invoke("goal_init", {
    objective,
    tasks: [{
      id: "task-one",
      description: "Bind the spawned executor",
      deps: [],
      writePaths: ["src/task-one.mjs"],
      acceptance: { criteria: [{ id: "binding", statement: "Spawn is bound", evidenceKinds: ["tests"] }] },
      workflow: "tdd",
    }],
  });
  const goalId = objective.toLowerCase().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 80);
  const status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));
  const dispatched = JSON.parse(await fixture.invoke("goal_dispatch", {
    goal_id: goalId,
    task_id: "task-one",
    action_token: status.action_token,
  }));
  return { goalId, dispatched };
}

async function bindIntegratedRun(fixture, dispatched, { runId = "run-bound-1", asyncDir = "/tmp/run-bound-1" } = {}) {
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session-1", sessionFile: "/tmp/s", cwd: fixture.cwd } }; },
    async spawn(params) { return workflowSpawnReply(fixture.pi, params, { runId, asyncDir }); },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {} });
  const result = await fixture.tools.find((tool) => tool.name === "subagent")
    .execute(`spawn-${runId}`, dispatched.contract, undefined, undefined, fixture.context);
  assert.equal(result.isError, false, result.content[0].text);
  return { runId, asyncDir };
}

function commitExecutorResult(workspacePath) {
  mkdirSync(join(workspacePath, "src"), { recursive: true });
  writeFileSync(join(workspacePath, "src/task-one.mjs"), "export const completed = true;\n");
  git(workspacePath, "add", "src/task-one.mjs");
  git(workspacePath, "commit", "-q", "-m", "test: create executor result");
  return git(workspacePath, "rev-parse", "HEAD");
}

function officialProof(runId, asyncDir) {
  return {
    schemaVersion: "root-broker.executor-proof.v1",
    ownership: {
      rootSessionId: "root-session-1",
      runId,
      role: "executor",
      asyncDir,
      sessionId: "root-session-1",
      identityState: "verified",
    },
    terminal: { proofId: "f".repeat(64), observedAt: 1_700_000_000_000, outcome: "succeeded" },
    terminalConflict: false,
  };
}

test("Planned goal_settle persists the exact successful Root Broker proof with the clean commit", async (t) => {
  const fixture = integratedFixture(t);
  const runId = "run-success-proof";
  const asyncDir = "/tmp/run-success-proof";
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Settle official executor", {
    inspectExecutorProof(observedRunId) {
      assert.equal(observedRunId, runId);
      return officialProof(runId, asyncDir);
    },
  });
  await bindIntegratedRun(fixture, dispatched, { runId, asyncDir });
  const head = commitExecutorResult(dispatched.workspace.path);
  const status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));
  const result = JSON.parse(await fixture.invoke("goal_settle", {
    goal_id: goalId,
    task_id: "task-one",
    outcome: "succeeded",
    evidence: { type: "diff", ref: head },
    evidence_source: "self_produced",
    next_action: "集成当前提交并在主分支独立复核全部验收标准",
    action_token: status.action_token,
  }));

  assert.equal(result.status, "succeeded");
  const task = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one");
  assert.deepEqual(task.settlement, {
    attempt: 1,
    executorHead: head,
    executorRunId: runId,
    terminalProofId: "f".repeat(64),
  });
});

test("real Goal Host settlement reads the bound proof from the Root Broker registry", async (t) => {
  const fixture = integratedFixture(t);
  const runId = "run-registry-proof";
  const asyncDir = "/tmp/run-registry-proof";
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Settle registered broker proof");
  const broker = new RootBrokerServer({
    rootSessionId: "root-session-1",
    lifecycleSessionId: "root-session-1",
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
    captureProcessBirthIdentity: async () => "birth-registry-proof",
    writeGrant: async () => "/tmp/nonexistent-registry-proof-grant",
  });
  bindRootBroker(fixture.pi, broker);
  t.after(() => unbindRootBroker(fixture.pi, broker));

  await bindIntegratedRun(fixture, dispatched, { runId, asyncDir });
  await broker.observeStarted({ runId, id: runId, agent: "executor", pid: 43210, asyncDir, sessionId: "root-session-1" });
  broker.observeTerminal({
    version: 1, runId, runnerProcessInstanceId: `${runId}-runner`, state: "observed", observedAt: 1_700_000_000_000,
    instances: [{ processInstanceId: `${runId}-runner`, kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 0, signal: null }],
  });
  const head = commitExecutorResult(dispatched.workspace.path);
  const status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));
  const result = JSON.parse(await fixture.invoke("goal_settle", {
    goal_id: goalId, task_id: "task-one", outcome: "succeeded",
    evidence: { type: "diff", ref: head }, evidence_source: "self_produced",
    next_action: "集成当前提交并在主分支独立复核全部验收标准", action_token: status.action_token,
  }));

  assert.equal(result.status, "succeeded");
  const task = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one");
  assert.equal(task.lastExecutorProof.runId, runId);
  assert.equal(task.lastExecutorProof.proofId, broker.inspectExecutorProof(runId).terminal.proofId);
});

test("Planned goal_settle rejects a bound clean commit when official terminal proof is missing", async (t) => {
  const fixture = integratedFixture(t);
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Reject missing terminal proof");
  await bindIntegratedRun(fixture, dispatched, { runId: "run-missing-proof", asyncDir: "/tmp/run-missing-proof" });
  const head = commitExecutorResult(dispatched.workspace.path);
  const status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));

  await assert.rejects(
    () => fixture.invoke("goal_settle", {
      goal_id: goalId,
      task_id: "task-one",
      outcome: "succeeded",
      evidence: { type: "diff", ref: head },
      evidence_source: "self_produced",
      next_action: "集成当前提交并在主分支独立复核全部验收标准",
      action_token: status.action_token,
    }),
    (error) => error.code === "EXECUTOR_TERMINAL_PROOF_MISSING",
  );
  assert.equal(loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one").status, "dispatched");
});

test("workspace commit created before spawn cannot be attributed to the returned Executor run", async (t) => {
  const fixture = integratedFixture(t);
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Reject pre-spawn workspace commit");
  commitExecutorResult(dispatched.workspace.path);
  let spawnCalls = 0;
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session-1", sessionFile: "/tmp/s", cwd: fixture.cwd } }; },
    async spawn() { spawnCalls += 1; return { details: { runId: "run-too-late", asyncDir: "/tmp/run-too-late" } }; },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {} });
  const result = await fixture.tools.find((tool) => tool.name === "subagent")
    .execute("spawn-after-commit", dispatched.contract, undefined, undefined, fixture.context);

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "EXECUTOR_BINDING_MISMATCH");
  assert.equal(spawnCalls, 0);
  assert.equal(loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one").executorBinding, null);
});

test("dirty workspace present before spawn cannot be attributed to the returned Executor run", async (t) => {
  const fixture = integratedFixture(t);
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Reject dirty pre-spawn workspace");
  writeFileSync(join(dispatched.workspace.path, "result.txt"), "unowned change\n");
  let spawnCalls = 0;
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session-1", sessionFile: "/tmp/s", cwd: fixture.cwd } }; },
    async spawn() { spawnCalls += 1; return { details: { runId: "run-too-late", asyncDir: "/tmp/run-too-late" } }; },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {} });
  const result = await fixture.tools.find((tool) => tool.name === "subagent")
    .execute("spawn-after-dirty", dispatched.contract, undefined, undefined, fixture.context);

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "EXECUTOR_BINDING_MISMATCH");
  assert.equal(spawnCalls, 0);
  assert.equal(loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one").executorBinding, null);
});

test("workspace owner replacement after spawn prevents binding the returned run", async (t) => {
  const fixture = integratedFixture(t);
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Reject replaced workspace owner");
  const leasePath = join(fixture.cwd, ".state/goal-engine/worktrees", `.${goalId}-task-one-1.lease.json`);
  let spawnCalls = 0;
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session-1", sessionFile: "/tmp/s", cwd: fixture.cwd } }; },
    async spawn(params) {
      spawnCalls += 1;
      const reply = workflowSpawnReply(fixture.pi, params, { runId: "run-replaced-owner", asyncDir: "/tmp/run-replaced-owner" });
      const lease = JSON.parse(readFileSync(leasePath, "utf8"));
      writeFileSync(leasePath, `${JSON.stringify({ ...lease, ownerToken: "replacement-owner-token" })}\n`);
      return reply;
    },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {} });
  const result = await fixture.tools.find((tool) => tool.name === "subagent")
    .execute("spawn-replaced-owner", dispatched.contract, undefined, undefined, fixture.context);

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "EXECUTOR_BINDING_MISMATCH");
  assert.equal(spawnCalls, 1);
  assert.equal(loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one").executorBinding, null);
});

test("durable-then-throw executor binding append is acknowledged without spawning a replacement run", async (t) => {
  const fixture = integratedFixture(t);
  let injected = false;
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Recover durable executor binding", {
    appendEvent(root, nextEvent, version) {
      const projection = appendGoalEvent(root, nextEvent, version);
      if (!injected && nextEvent.type === "task.executor_bound") {
        injected = true;
        throw new Error("binding append acknowledgement lost");
      }
      return projection;
    },
  });
  let spawnCalls = 0;
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session-1", sessionFile: "/tmp/s", cwd: fixture.cwd } }; },
    async spawn(params) {
      spawnCalls += 1;
      return workflowSpawnReply(fixture.pi, params, { runId: "run-durable-binding", asyncDir: "/tmp/run-durable-binding" });
    },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {} });
  const result = await fixture.tools.find((tool) => tool.name === "subagent")
    .execute("spawn-durable-binding", dispatched.contract, undefined, undefined, fixture.context);

  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(injected, true);
  assert.equal(spawnCalls, 1);
  const projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.tasks.get("task-one").executorBinding.runId, "run-durable-binding");
});

test("changing any Goal contract value after dispatch prevents spawn and leaves the attempt unbound", async (t) => {
  const fixture = integratedFixture(t);
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Reject replaced contract");
  let spawnCalls = 0;
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session-1", sessionFile: "/tmp/s", cwd: fixture.cwd } }; },
    async spawn() { spawnCalls += 1; return { details: { runId: "run-must-not-start", asyncDir: "/tmp/run-must-not-start" } }; },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {} });
  const changed = { ...dispatched.contract, objective: `${dispatched.contract.objective} replaced` };
  const result = await fixture.tools.find((tool) => tool.name === "subagent")
    .execute("spawn-replaced-contract", changed, undefined, undefined, fixture.context);

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "EXECUTOR_CONTRACT_MISMATCH");
  assert.equal(spawnCalls, 0);
  const projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.tasks.get("task-one").executorBinding, null);
});

test("non-Goal coding runs and generic reviewers remain spawnable without claiming the Goal ticket", async (t) => {
  const fixture = integratedFixture(t);
  const { goalId } = await initializeIntegratedDispatch(fixture, "Leave unrelated runs alone");
  const calls = [];
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session-1", sessionFile: "/tmp/s", cwd: fixture.cwd } }; },
    async spawn(params, options) {
      calls.push({ params, options });
      return workflowSpawnReply(fixture.pi, params, {
        runId: `unrelated-${calls.length}`,
        asyncDir: `/tmp/unrelated-${calls.length}`,
      });
    },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {} });
  const subagent = fixture.tools.find((tool) => tool.name === "subagent");
  const coding = await subagent.execute("non-goal-coding", {
    ...STRICT_CODING_CONTRACT,
    taskId: "standalone-task",
    execution: { ...STRICT_CODING_CONTRACT.execution, cwd: fixture.cwd },
  }, undefined, undefined, fixture.context);
  const review = await subagent.execute("generic-review", {
    agent: "reviewer",
    title: "Review an unrelated change",
    task: "Read the supplied diff without modifying the Goal task.",
  }, undefined, undefined, fixture.context);

  assert.equal(coding.isError, false, coding.content[0].text);
  assert.equal(review.isError, false, review.content[0].text);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options, undefined);
  assert.equal(calls[1].options, undefined);
  const projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.tasks.get("task-one").executorBinding, null);
});

test("Goal dispatch followed by the exact coding spawn persists the returned runId and asyncDir", async (t) => {
  const fixture = integratedFixture(t);
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture);
  const rpc = {
    async ping() {
      return { version: 1, methods: ["spawn"], session: { sessionId: "root-session-1", sessionFile: join(fixture.cwd, "session.jsonl"), cwd: fixture.cwd } };
    },
    async spawn(params, options) {
      assert.match(options.requestId, /^goal-executor-/);
      assert.equal(options.requestId, options.spawnKey);
      return workflowSpawnReply(fixture.pi, params, { runId: "run-returned-1", asyncDir: "/tmp/run-returned-1", sessionId: join(fixture.cwd, "session.jsonl") });
    },
    async status() { return {}; },
    async steer() { return {}; },
    async interrupt() { return {}; },
    async stop() { return {}; },
    dispose() {},
  };
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {} });
  const subagent = fixture.tools.find((tool) => tool.name === "subagent");
  const result = await subagent.execute("spawn-goal-task", dispatched.contract, undefined, undefined, fixture.context);
  assert.equal(result.isError, false, result.content[0].text);

  const projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  const leasePath = join(fixture.cwd, ".state/goal-engine/worktrees", ".integrated-executor-binding-task-one-1.lease.json");
  const lease = JSON.parse(readFileSync(leasePath, "utf8"));
  const expectedBinding = {
    attempt: 1,
    runId: "run-returned-1",
    contractHash: dispatched.contract_hash,
    asyncDir: "/tmp/run-returned-1",
    workspacePath: dispatched.workspace.path,
    workspaceLeaseId: createHash("sha256").update(lease.ownerToken).digest("hex"),
    headAtDispatch: dispatched.workspace.baseCommit,
  };
  assert.deepEqual(projection.tasks.get("task-one").executorBinding, expectedBinding);
  const status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));
  assert.deepEqual(status.tasks["task-one"].executorBinding, expectedBinding);
});
