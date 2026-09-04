import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { applyEvent, createProjection, PLANNED_SCHEMA_VERSION } from "../src/goal-engine/events.ts";
import { assertExecutorSettlementProof } from "../src/goal-engine/executor-binding.ts";
import { createGoalEngineExtension } from "../src/goal-engine/extension.ts";
import { appendEvent as appendGoalEvent, loadProjection } from "../src/goal-engine/store.ts";
import { createTypedSubagentExtension } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { bindRootBroker, findGoalExecutorCoordinator, stopRootBrokerGoalOwnedRun, unbindRootBroker } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { fingerprintSettlementEvidence, serializeSettlementEvidenceYaml } from "../src/goal-engine/settlement-evidence.ts";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";
import { buildObligationFinalizationManifest } from "../src/goal-engine/finalization.ts";
import { createProductionGoalRuntimeHost } from "../src/goal-engine/production-runtime-host.ts";
import { deriveOwnedExecutorStopRequest } from "../src/goal-engine/suspension.ts";
import { inspectExecutorWorkspace, loadExecutorWorkspaceLease, releaseExecutorWorkspace } from "../src/goal-engine/workspace.mjs";

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
  const branch = [];
  const handlers = new Map();
  const sessionManager = {
    getSessionId: () => "root-session-1",
    getSessionFile: () => join(cwd, "session.jsonl"),
    getLeafId: () => "leaf-1",
    getEntries: () => branch,
    getBranch: () => branch,
  };
  const pi = {
    events: eventIdentity,
    registerTool(tool) { tools.push(tool); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(customType, data) { branch.push({ id: `entry-${branch.length + 1}`, timestamp: new Date(Date.now() + branch.length + 1).toISOString(), type: "custom", customType, data }); },
  };
  const context = { cwd, sessionManager };
  const invoke = async (name, params) => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `missing tool ${name}`);
    const result = await tool.execute(`call-${name}`, params, new AbortController().signal, undefined, context);
    return result.details.value;
  };
  const workspaceService = createManagedWorkspaceService({ stateRoot: arena.mkdtempSync("managed-workspaces-") });
  return { cwd, pi, tools, context, invoke, branch, handlers, workspaceService };
}

function runtimeHost(cwd, calls = null) {
  return {
    registries: runtimeRegistries,
    adapterRegistry: {},
    async stopOwnedRun() { if (calls) calls.stopOwnedRun++; return null; },
    async quarantineWorkspace() { if (calls) calls.quarantineWorkspace++; return null; },
    async quarantineResource() { if (calls) calls.quarantineResource++; return null; },
    artifactRefForRun() { throw new Error("runtime fixture has no observations"); },
    captureCurrentWorld() {
      return { safe: true, repo: { root: cwd, head: git(cwd, "rev-parse", "HEAD"), trackedDirty: [], untracked: [], sequencer: null }, adapters: [], environments: [], fixtures: [], resources: [], activeRuns: [], capturedAt: new Date().toISOString() };
    },
  };
}

async function initializeActiveRuntimeDispatch(fixture, { coordinatorCriteria = false, runtimeCalls = null } = {}) {
  // This lightweight Host deliberately has no Root Broker; production tests
  // bind one and therefore exercise the default fail-closed behavior.
  createGoalEngineExtension(fixture.pi, { allowMissingRootBrokerForTests: true, goalStateEnv: {}, runtimeHost: runtimeHost(fixture.cwd, runtimeCalls), inspectExecutorProof(runId) { return officialProof(runId, `/tmp/${runId}`); } });
  const base = runtimeInit();
  const task = structuredClone(base.execution.tasks[0]);
  if (coordinatorCriteria) task.acceptance.criteria.push(
    { id: "executor-bound", statement: "The official executor is bound", evidenceKinds: ["manual-review"], evaluator: "coordinator", predicate: "executor-bound" },
    { id: "terminal-proof", statement: "The official executor terminal proof exists", evidenceKinds: ["manual-review"], evaluator: "coordinator", predicate: "executor-terminal-proof" },
    { id: "workspace-released", statement: "The workspace is integrated and released", evidenceKinds: ["manual-review"], evaluator: "coordinator", predicate: "workspace-integrated-released" },
    { id: "task-accepted", statement: "The task is accepted", evidenceKinds: ["manual-review"], evaluator: "coordinator", predicate: "task-accepted" },
  );
  const init = runtimeInit({ execution: { ...base.execution, tasks: [task], conditions: [], budgets: { ...base.execution.budgets, max_no_progress: 99 } } });
  await fixture.invoke("goal_init", init);
  await fixture.invoke("goal_status", {});
  fixture.handlers.get("input")({ type: "input", source: "interactive", text: "approve" }, fixture.context);
  const intent = fixture.branch.at(-1);
  fixture.branch.push({ id: "runtime-approval", parentId: intent.id, timestamp: new Date(Date.now() + 1_000).toISOString(), type: "message", message: { role: "user", content: "approve" } });
  await fixture.invoke("goal_status", {});
  for (let i = 0; i < 3 && loadProjection(join(fixture.cwd, ".state/goal-engine"), "harden-runtime").runtimeState !== "active"; i++) await fixture.invoke("goal_status", {});
  const status = JSON.parse(await fixture.invoke("goal_status", {}));
  assert.ok(status.machineAction, JSON.stringify(status));
  assert.equal(status.machineAction.tool, "goal_dispatch");
  const dispatched = JSON.parse(await fixture.invoke("goal_dispatch", { goal_id: "harden-runtime", task_id: "task-1", action_token: status.action_token }));
  return { goalId: "harden-runtime", dispatched };
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

test("Subagent confirms the allocated Goal receipt before spawn and rejects projection drift", async () => {
  const tools = [];
  const pi = { events: {}, registerTool(tool) { tools.push(tool); }, on() {} };
  let spawnCalls = 0;
  let prepareCalls = 0;
  let confirmCalls = 0;
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "s", sessionFile: "/tmp/s", cwd: "/repo" } }; },
    async spawn() { spawnCalls += 1; return { details: { runId: "run-1", asyncDir: "/tmp/run-1" } }; },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  const workspaceRequest = {
    workspaceId: "goal-workspace-confirm",
    owner: { kind: "goal-task", rootSessionId: "root-1", goalId: "goal", taskId: "task", attempt: 1, executionRevision: 1 },
    originRoot: "/repo", requestedCwd: "/repo", originRef: "refs/heads/main", baseCommit: "b".repeat(40),
    contractHash: "unused", mode: "coding", writePaths: ["src/task.mjs"],
  };
  const receiptFor = (request) => ({
    schemaVersion: "managed-workspace.v1", workspaceId: request.workspaceId, leaseId: "c".repeat(64), owner: request.owner,
    originRoot: request.originRoot, requestedCwd: request.requestedCwd, originRef: request.originRef, baseCommit: request.baseCommit,
    path: "/managed/goal-workspace-confirm", dispatchCwd: "/managed/goal-workspace-confirm", branchRef: "refs/heads/pi-managed/goal-workspace-confirm",
    state: "active", run: null, disposition: null, cleanupDebt: null,
  });
  const goalExecutorCoordinator = {
    prepareSpawn({ contractHash }) {
      prepareCalls += 1;
      const request = { ...workspaceRequest, contractHash };
      return { ticketId: "ticket-1", spawnIdentity: { requestId: "request-1", spawnKey: "request-1" }, workspaceRequest: request };
    },
    async workspaceAllocated() {},
    async confirmSpawn() { confirmCalls += 1; throw Object.assign(new Error("Goal projection changed before spawn"), { code: "EXECUTOR_BINDING_MISMATCH" }); },
    async bindSpawn() {},
  };
  const workspaceService = { ensureAllocated(request) { return receiptFor(request); } };
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    goalExecutorCoordinator,
    workspaceService,
    async prepareCodingSpawn() {},
  });
  const result = await tools[0].execute("replace-at-execute", { ...STRICT_CODING_CONTRACT, execution: { ...STRICT_CODING_CONTRACT.execution, worktree: true } }, undefined, undefined, { cwd: "/repo" });

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "EXECUTOR_BINDING_MISMATCH");
  assert.equal(prepareCalls, 1);
  assert.equal(confirmCalls, 1);
  assert.equal(spawnCalls, 0);
});

async function initializeIntegratedDispatch(fixture, objective = "Integrated executor binding", extensionOptions = {}) {
  createGoalEngineExtension(fixture.pi, { goalStateEnv: {}, allowMissingRootBrokerForTests: true, ...extensionOptions });
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

async function allocateGoalWorkspace(fixture, dispatched) {
  const coordinator = findGoalExecutorCoordinator(fixture.pi);
  const ticket = await coordinator.prepareSpawn({ contract: dispatched.contract, contractHash: dispatched.contract_hash, ctx: fixture.context });
  const receipt = fixture.workspaceService.ensureAllocated(ticket.workspaceRequest);
  return { coordinator, ticket, receipt };
}

async function bindIntegratedRun(fixture, dispatched, { runId = "run-bound-1", asyncDir = "/tmp/run-bound-1" } = {}) {
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session-1", sessionFile: "/tmp/s", cwd: fixture.cwd } }; },
    async spawn(params) { return workflowSpawnReply(fixture.pi, params, { runId, asyncDir }); },
    async status() { return {}; }, async steer() { return {}; }, async interrupt() { return {}; }, async stop() { return {}; }, dispose() {},
  };
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {}, workspaceService: fixture.workspaceService });
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

function settlementEvidence(fixture, goalId, taskId) {
  const projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  const task = projection.tasks.get(taskId);
  const head = git(task.workspace.path, "rev-parse", "HEAD");
  const identity = { goalId, taskId, runId: task.executorBinding.runId, attempt: task.workspace.owner.attempt, contractHash: task.contractHash, head };
  const expectedCriteria = task.acceptance.criteria.filter(({ evaluator }) => evaluator !== "coordinator").map(({ id }) => id);
  const criteria = expectedCriteria.map((id) => ({ id, status: "satisfied", evidence: [`sha256:${"1".repeat(64)}`] }));
  const child = { identity, criteria, commandsRun: [], changedFiles: [task.writePaths[0]] };
  const main = { identity, criteria: criteria.map((item) => ({ ...item, evidence: [`sha256:${"2".repeat(64)}`] })), commandsRun: [], changedFiles: [task.writePaths[0]] };
  const sha256 = fingerprintSettlementEvidence(child, { expectedIdentity: identity, expectedCriteria, outcome: "succeeded" });
  const directory = join(task.executorBinding.asyncDir, "acceptance-evidence");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(git(task.workspace.path, "rev-parse", "--git-path", "info/exclude"), ".pi-subagents/\n", { flag: "a" });
  const artifact = join(directory, `${sha256}.yaml`);
  writeFileSync(artifact, serializeSettlementEvidenceYaml(child, { expectedIdentity: identity, expectedCriteria, outcome: "succeeded" }), { mode: 0o600 });
  chmodSync(artifact, 0o600);
  return { subagent_evidence: { sha256, content: child }, main_verification: main };
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
  const workspace = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one").workspace;
  const head = commitExecutorResult(workspace.path);
  const status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));
  const result = JSON.parse(await fixture.invoke("goal_settle", {
    goal_id: goalId,
    task_id: "task-one",
    outcome: "succeeded",
    evidence: { type: "diff", ref: head },
    evidence_source: "self_produced",
    next_action: "集成当前提交并在主分支独立复核全部验收标准",
    action_token: status.action_token,
    ...settlementEvidence(fixture, goalId, "task-one"),
  }));

  assert.equal(result.status, "succeeded");
  const task = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one");
  const { evidence, ...settlementIdentity } = task.settlement;
  assert.deepEqual(settlementIdentity, {
    attempt: 1,
    executorHead: head,
    executorRunId: runId,
    terminalProofId: "f".repeat(64),
  });
  assert.equal(evidence.schemaVersion, "goal-engine.settlement-evidence.v1");
});

test("real Goal Host settlement reads the bound proof from the Root Broker registry", async (t) => {
  const fixture = integratedFixture(t);
  const runId = "run-registry-proof";
  const asyncDir = "/tmp/run-registry-proof";
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Settle registered broker proof");
  const broker = new RootBrokerServer({
    rootSessionId: "root-session-1",
    lifecycleSessionId: "/tmp/s",
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
  const workspace = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one").workspace;
  const head = commitExecutorResult(workspace.path);
  const status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));
  const result = JSON.parse(await fixture.invoke("goal_settle", {
    goal_id: goalId, task_id: "task-one", outcome: "succeeded",
    evidence: { type: "diff", ref: head }, evidence_source: "self_produced",
    next_action: "集成当前提交并在主分支独立复核全部验收标准", action_token: status.action_token,
    ...settlementEvidence(fixture, goalId, "task-one"),
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
  const workspace = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one").workspace;
  const head = commitExecutorResult(workspace.path);
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

test("workspace allocation rejects a receipt with a replaced base commit before spawn", async (t) => {
  const fixture = integratedFixture(t);
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Reject pre-spawn workspace commit");
  const { coordinator, ticket, receipt } = await allocateGoalWorkspace(fixture, dispatched);
  assert.throws(() => coordinator.workspaceAllocated(ticket, { ...receipt, baseCommit: "f".repeat(40) }), /receipt|binding/i);
  const task = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one");
  assert.equal(task.status, "dispatch_requested");
  assert.equal(task.workspace, null);
});

test("confirmSpawn reloads projection and rejects a receipt changed after allocation", async (t) => {
  const fixture = integratedFixture(t);
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Reject dirty pre-spawn workspace");
  const { coordinator, ticket, receipt } = await allocateGoalWorkspace(fixture, dispatched);
  await coordinator.workspaceAllocated(ticket, receipt);
  assert.throws(() => coordinator.confirmSpawn(ticket, { ...receipt, path: `${receipt.path}-replacement`, dispatchCwd: `${receipt.path}-replacement` }), /receipt|binding/i);
  assert.equal(loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one").executorBinding, null);
});

test("repeated workspace allocation accepts the exact receipt and rejects owner replacement", async (t) => {
  const fixture = integratedFixture(t);
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Reject replaced workspace owner");
  const { coordinator, ticket, receipt } = await allocateGoalWorkspace(fixture, dispatched);
  await coordinator.workspaceAllocated(ticket, receipt);
  assert.deepEqual(await coordinator.workspaceAllocated(ticket, receipt), receipt);
  assert.throws(() => coordinator.workspaceAllocated(ticket, { ...receipt, owner: { ...receipt.owner, rootSessionId: "replacement-root" } }), /conflicting|binding/i);
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
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {}, workspaceService: fixture.workspaceService });
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
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {}, workspaceService: fixture.workspaceService });
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
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {}, workspaceService: fixture.workspaceService });
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

test("goal_status recovers one unbound official active-branch executor handle without settling", async (t) => {
  const fixture = integratedFixture(t);
  const runId = "run-recovered-1";
  const asyncDir = "/tmp/run-recovered-1";
  const { goalId, dispatched } = await initializeIntegratedDispatch(fixture, "Recover unbound active branch", {
    inspectExecutorProof(observedRunId, rootSessionId) {
      assert.equal(observedRunId, runId);
      assert.equal(rootSessionId, "root-session-1");
      return officialProof(runId, asyncDir);
    },
  });
  const { coordinator, ticket, receipt } = await allocateGoalWorkspace(fixture, dispatched);
  await coordinator.workspaceAllocated(ticket, receipt);
  await coordinator.confirmSpawn(ticket, receipt);
  const timestamp = new Date(Date.now() + 1_000).toISOString();
  fixture.branch.push(
    { id: "assistant-spawn", timestamp, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "spawn-call", name: "subagent", arguments: dispatched.contract }] } },
    { id: "result-spawn", timestamp: new Date(Date.now() + 2_000).toISOString(), type: "message", message: { role: "toolResult", toolCallId: "spawn-call", toolName: "subagent", details: { version: "coding-dispatch-handle.v1", dispatchId: "goal-dispatch", taskId: dispatched.contract.taskId, agent: "executor", title: dispatched.contract.title, contractHash: dispatched.contract_hash, runId, asyncDir, workspace_id: receipt.workspaceId, lease_id: receipt.leaseId } } },
  );
  const status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));
  assert.equal(status.status, "RECOVERED_EXECUTOR_BINDING");
  const task = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-one");
  assert.equal(task.executorBinding.runId, runId);
  assert.equal(task.status, "dispatched", "recovery binds only; a later status may settle");
});

test("runtime goal_status recovers an unbound official executor handle before issuing another action", async (t) => {
  const fixture = integratedFixture(t);
  const runId = "run-runtime-recovered-1";
  const asyncDir = "/tmp/run-runtime-recovered-1";
  const { goalId, dispatched } = await initializeActiveRuntimeDispatch(fixture);
  const { coordinator, ticket, receipt } = await allocateGoalWorkspace(fixture, dispatched);
  await coordinator.workspaceAllocated(ticket, receipt);
  await coordinator.confirmSpawn(ticket, receipt);
  fixture.branch.push(
    { id: "runtime-spawn", timestamp: new Date(Date.now() + 2_000).toISOString(), type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "runtime-spawn-call", name: "subagent", arguments: dispatched.contract }] } },
    { id: "runtime-spawn-result", timestamp: new Date(Date.now() + 3_000).toISOString(), type: "message", message: { role: "toolResult", toolCallId: "runtime-spawn-call", toolName: "subagent", details: { version: "coding-dispatch-handle.v1", dispatchId: "goal-dispatch", taskId: dispatched.contract.taskId, agent: "executor", title: dispatched.contract.title, contractHash: dispatched.contract_hash, runId, asyncDir, workspace_id: receipt.workspaceId, lease_id: receipt.leaseId } } },
  );
  const status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));
  assert.equal(status.status, "RECOVERED_EXECUTOR_BINDING");
  assert.equal(status.machineAction, null, "recovery is this status call's only action");
  const task = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-1");
  assert.equal(task.executorBinding.runId, runId);
  assert.equal(task.status, "dispatched");
});

test("public runtime dispatch→binding→settle→integrate→accept rejects accepted acceptance amendment before suspension", async (t) => {
  const fixture = integratedFixture(t), runtimeCalls = { stopOwnedRun: 0, quarantineWorkspace: 0, quarantineResource: 0 };
  const runId = "run-runtime-settlement";
  const asyncDir = "/tmp/run-runtime-settlement";
  const { goalId, dispatched } = await initializeActiveRuntimeDispatch(fixture, { coordinatorCriteria: true, runtimeCalls });
  await bindIntegratedRun(fixture, dispatched, { runId, asyncDir });
  const workspace = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId).tasks.get("task-1").workspace;
  const resultHead = commitExecutorResult(workspace.path);
  let status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));

  const result = JSON.parse(await fixture.invoke("goal_settle", {
    goal_id: goalId, task_id: "task-1", outcome: "succeeded",
    evidence: { type: "diff", ref: resultHead }, evidence_source: "self_produced",
    next_action: "集成当前提交并在主分支独立复核全部验收标准", action_token: status.action_token,
    ...settlementEvidence(fixture, goalId, "task-1"),
  }));
  assert.equal(result.status, "succeeded");
  let projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  let task = projection.tasks.get("task-1");
  assert.deepEqual(task.settlement.evidence.subagent.criteria.map(({ id }) => id), ["contract"], "dual evidence covers only the executor-owned criterion");
  assert.deepEqual(task.acceptance.criteria.map(({ id }) => id), ["contract", "executor-bound", "terminal-proof", "workspace-released", "task-accepted"]);

  status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));
  await fixture.invoke("goal_integrate", { goal_id: goalId, task_id: "task-1", action: "integrate", action_token: status.action_token });
  status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));
  const accepted = JSON.parse(await fixture.invoke("goal_accept", { goal_id: goalId, task_id: "task-1", action_token: status.action_token }));
  assert.equal(accepted.status, "accepted");

  projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  task = projection.tasks.get("task-1");
  assert.equal(task.status, "accepted");
  assert.equal(task.workspace.released, true, "typed integration releases the real workspace");

  // Public RED/GREEN boundary: this accepted task was reached exclusively via
  // typed runtime tools above, not a Store fixture. An immutable acceptance
  // amendment must reject without touching ledger bytes or owned resources.
  const ledgerPath = join(fixture.cwd, ".state/goal-engine/goals", goalId, "events.jsonl");
  const ledgerBefore = readFileSync(ledgerPath);
  const versionBefore = projection.version;
  await assert.rejects(
    fixture.invoke("goal_amend", { goal_id: goalId, operation: "propose_execution_change", reason: "replace accepted acceptance", changes: { update_tasks: [{ id: "task-1", acceptance: { criteria: [{ id: "replacement", statement: "must not replace accepted contract", evidenceKinds: ["tests"] }] } }] } }),
    /accepted Task acceptance/i,
  );
  projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  assert.deepEqual(readFileSync(ledgerPath), ledgerBefore, "rejection preserves exact ledger bytes");
  assert.equal(projection.version, versionBefore);
  assert.equal(projection.runtimeState, "active"); assert.equal(projection.suspension, null); assert.equal(projection.pendingHumanDecision, null);
  const ledger = readFileSync(ledgerPath, "utf8");
  assert.equal((ledger.match(/"type":"goal.runtime_suspended"/g) || []).length, 0);
  assert.equal((ledger.match(/"type":"execution.amendment_proposed"/g) || []).length, 0);
  assert.deepEqual(runtimeCalls, { stopOwnedRun: 0, quarantineWorkspace: 0, quarantineResource: 0 });

  const manifest = buildObligationFinalizationManifest({
    projection,
    worldSnapshot: runtimeHost(fixture.cwd).captureCurrentWorld(),
    conditionValidity: new Map(),
    resourceInventory: [],
  });
  assert.deepEqual(manifest.tasks[0].coordinatorCriteria, [
    { id: "executor-bound", predicate: "executor-bound", satisfied: true },
    { id: "terminal-proof", predicate: "executor-terminal-proof", satisfied: true },
    { id: "workspace-released", predicate: "workspace-integrated-released", satisfied: true },
    { id: "task-accepted", predicate: "task-accepted", satisfied: true },
  ], "finalization mechanically retains all coordinator lifecycle predicates");
  assert.equal(manifest.blockers.some(({ code }) => code === "TASK_COORDINATOR_PREDICATE_UNSATISFIED"), false);
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
  createTypedSubagentExtension(fixture.pi, { rpc, cleanupStore: {}, workspaceService: fixture.workspaceService });
  const subagent = fixture.tools.find((tool) => tool.name === "subagent");
  const result = await subagent.execute("spawn-goal-task", dispatched.contract, undefined, undefined, fixture.context);
  assert.equal(result.isError, false, result.content[0].text);

  const projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  const workspace = projection.tasks.get("task-one").workspace;
  const expectedBinding = {
    attempt: 1,
    runId: "run-returned-1",
    contractHash: dispatched.contract_hash,
    asyncDir: "/tmp/run-returned-1",
    workspacePath: workspace.path,
    workspaceLeaseId: workspace.leaseId,
    headAtDispatch: workspace.baseCommit,
  };
  assert.equal(Object.hasOwn(workspace, "ownerToken"), false);
  assert.deepEqual(projection.tasks.get("task-one").executorBinding, expectedBinding);
  const status = JSON.parse(await fixture.invoke("goal_status", { goal_id: goalId }));
  assert.deepEqual(status.tasks["task-one"].executorBinding, expectedBinding);
});

test("lower-level fixture: fresh Broker recovery reads a hand-authored failed terminal artifact", async (t) => {
  const fixture = integratedFixture(t);
  const asyncDir = join(fixture.cwd, ".executor-failed-terminal");
  const runId = "run-public-failed-recovery";
  const { goalId, dispatched } = await initializeActiveRuntimeDispatch(fixture);

  // This fixture covers only recovery parsing. Real runtime artifact ownership
  // is covered by the top-level RPC canary rather than this hand-authored data.
  await bindIntegratedRun(fixture, dispatched, { runId, asyncDir });
  let projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  const authority = deriveOwnedExecutorStopRequest({ projection, taskId: "task-1" });
  assert.equal(projection.tasks.get("task-1").executorBinding.runId, runId);
  const terminal = {
    version: 1, runId, sessionId: authority.sessionId, asyncDir, agent: "executor",
    runnerProcessInstanceId: `${runId}-runner`, state: "observed", observedAt: 1_700_000_000_000,
    instances: [{ processInstanceId: `${runId}-runner`, kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 1, signal: null }],
  };
  mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ ...authority, state: "failed", steps: [{ agent: "executor" }], processTerminal: terminal }), { mode: 0o600 });
  writeFileSync(join(asyncDir, "process-terminal.json"), JSON.stringify(terminal), { mode: 0o600 });

  // Broker A observed the official failed terminal, then its in-memory owner
  // state is discarded. Broker B below is deliberately fresh.
  const upstreamStops = [];
  const brokerA = new RootBrokerServer({
    rootSessionId: authority.sessionId, lifecycleSessionId: authority.sessionId,
    captureProcessBirthIdentity: async () => "public-recovery-birth",
    writeGrant: async () => join(asyncDir, "grant"),
    upstream: { async ping() { return {}; }, async stop(request) { upstreamStops.push(request); }, async dispose() {} },
  });
  await brokerA.observeStarted({ runId, id: runId, agent: "executor", pid: 43210, asyncDir, sessionId: authority.sessionId });
  brokerA.observeTerminal(terminal);
  assert.equal(brokerA.inspectExecutorProof(runId).terminal.outcome, "failed");
  await brokerA.closeRootSession();

  // Public followUp creates the durable suspension while the initial fixture
  // Host intentionally cannot close it. This proves the later closure is not
  // a hand-written suspension projection.
  await fixture.handlers.get("input")({ type: "input", source: "interactive", text: "follow up", streamingBehavior: "followUp" }, fixture.context);
  projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.runtimeState, "suspended");
  assert.equal(projection.suspension.resourcesQuarantined, false);

  const brokerB = new RootBrokerServer({
    rootSessionId: authority.sessionId, lifecycleSessionId: authority.sessionId,
    writeGrant: async () => join(asyncDir, "grant-fresh"),
    upstream: { async ping() { return {}; }, async stop(request) { upstreamStops.push(request); }, async dispose() {} },
  });
  bindRootBroker(fixture.pi, brokerB);
  t.after(async () => { unbindRootBroker(fixture.pi, brokerB); await brokerB.closeRootSession(); });
  const seenAuthorities = [];
  let quarantineFailure = null;
  const freshHost = createProductionGoalRuntimeHost(fixture.pi, {
    registries: runtimeRegistries,
    adapterRegistry: {},
    loadExecutorWorkspaceLease,
    inspectExecutorWorkspace,
    releaseExecutorWorkspace(...args) { try { return releaseExecutorWorkspace(...args); } catch (error) { quarantineFailure = error; throw error; } },
    stopRootBrokerGoalOwnedRun(pi, binding) {
      seenAuthorities.push(binding);
      return stopRootBrokerGoalOwnedRun(pi, binding);
    },
  });
  const quarantineCalls = [];
  const observedFreshHost = { ...freshHost, captureCurrentWorld: runtimeHost(fixture.cwd).captureCurrentWorld, quarantineWorkspace: async (request) => { try { const result = await freshHost.quarantineWorkspace(request); quarantineCalls.push({ request, result }); return result; } catch (error) { quarantineCalls.push({ request, error: error.message }); throw error; } } };
  // Reconstructing the Extension keeps the same Store and durable root session.
  createGoalEngineExtension(fixture.pi, { goalStateEnv: {}, runtimeHost: observedFreshHost });
  const freshStatusTool = fixture.tools.filter((tool) => tool.name === "goal_status").at(-1);
  const statusResult = await freshStatusTool.execute("fresh-recovery-status", { goal_id: goalId }, new AbortController().signal, undefined, fixture.context);
  projection = loadProjection(join(fixture.cwd, ".state/goal-engine"), goalId);
  const resumeResult = await freshStatusTool.execute("fresh-recovery-resume-offer", { goal_id: goalId }, new AbortController().signal, undefined, fixture.context);
  const status = JSON.parse(resumeResult.details.value);

  assert.ok(seenAuthorities.length >= 1, "fresh status invokes Store-derived authority");
  assert.ok(seenAuthorities.every((value) => JSON.stringify(value) === JSON.stringify(authority)), "Extension forwards complete Store-derived authority unchanged");
  assert.equal(brokerB.ownedRuns.has(runId), false, "fresh recovery must not recreate an owner");
  assert.deepEqual(upstreamStops, [], "failed terminal recovery never stops a process");
  assert.equal(projection.suspension.resourcesQuarantined, false, `${JSON.stringify(projection.suspension)}; quarantine=${quarantineFailure?.message}; calls=${JSON.stringify(quarantineCalls)}`);
  assert.deepEqual(projection.suspension.terminalProofRefs ?? [], [], "a hand-authored runtime artifact without a durable sidecar remains attention");
  assert.notEqual(status.machineAction?.params?.operation, "resume_runtime", JSON.stringify(status));
});
