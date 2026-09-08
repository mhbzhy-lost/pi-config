import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, chmodSync, realpathSync, symlinkSync, renameSync, rmSync } from "node:fs";
import { basename, join, dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";
import { appendEvent as appendEventStore, loadProjection } from "../src/goal-engine/store.ts";
import { createGoalEngineExtension as createGoalEngineExtensionFactory } from "../src/goal-engine/extension.ts";
import { classifyGoalEvidence, completionVerdictFor } from "../src/goal-engine/evidence.ts";
import { allocateGoalWorkspaceFixture as allocateExecutorWorkspace, goalWorkspaceService, inspectGoalWorkspaceFixture as inspectExecutorWorkspace, loadGoalWorkspaceFixture as loadExecutorWorkspaceLease, releaseGoalWorkspaceFixture as releaseExecutorWorkspace } from "./helpers/goal-workspace-service-fixture.mjs";
import { ensureGoalStateIdentity, resolveGoalStateScope } from "../src/goal-engine/state-scope.ts";
import { findGoalRunCoordinator } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { inventoryManagedWorkspaces } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { managedWorkspacePaths } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";
import { bindManagedWorkspaceServiceSession, unbindManagedWorkspaceServiceSession } from "../packages/pi-subagents-enhanced/src/workspace/registry.ts";
import { fingerprintSettlementEvidence, serializeSettlementEvidenceYaml } from "../src/goal-engine/settlement-evidence.ts";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const temporaryArena = createTemporaryArenaSync("goal-engine-extension-");
test.after(() => temporaryArena.disposeSync());
function mkdtempSync(prefix) { return temporaryArena.mkdtempSync(basename(prefix)); }

test("Root Goal ABI is exact-eight and goal_finalize rejects planned before side effects", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  assert.deepEqual(pi.tools.map((tool) => tool.name).sort(), ["goal_accept", "goal_amend", "goal_dispatch", "goal_finalize", "goal_init", "goal_integrate", "goal_settle", "goal_status"]);
  const initialized = JSON.parse(await invoke(pi, "goal_init", oneTaskGoal("Finalize remains unsupported")));
  const root = join(cwd, ".state/goal-engine");
  const before = readFileSync(join(root, "goals", initialized.goalId, "events.jsonl"), "utf8");
  await assert.rejects(() => invoke(pi, "goal_finalize", { goal_id: initialized.goalId, action_token: "unused", approval_entry_id: "approval-1" }), (error) => error.code === "FINALIZATION_UNSUPPORTED_GENERATION");
  assert.equal(readFileSync(join(root, "goals", initialized.goalId, "events.jsonl"), "utf8"), before);
});

test("exact-eight Goal tools expose display-only bounded localized renderers", () => {
  const pi = createMockPi(tmpCwd());
  createGoalEngineExtension(pi);
  const tools = Object.fromEntries(pi.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools).sort(), ["goal_accept", "goal_amend", "goal_dispatch", "goal_finalize", "goal_init", "goal_integrate", "goal_settle", "goal_status"]);
  // Ordinary display labels are localized; tool names, operations and typed
  // identifiers keep their English authority values, and nothing raw (JSON,
  // secrets, schema strings) ever reaches the display line.
  const callLine = (name, input) => tools[name].renderCall(input).render(80)[0];
  const expectations = [
    [callLine("goal_init", { objective: "hidden objective", execution: { schema: "goal-runtime.v1", tasks: [{}], conditions: [{}] } }), "goal_init", ["运行时", "任务 1", "条件 1"]],
    [callLine("goal_status", { list_cwd_goals: true }), "goal_status", ["列表"]],
    [callLine("goal_dispatch", { task_id: "t1", action_token: "hidden-token" }), "goal_dispatch", ["任务 t1"]],
    [callLine("goal_settle", { task_id: "t1", outcome: "failed", next_action: "x", action_token: "hidden-token" }), "goal_settle", ["任务 t1", "失败"]],
    [callLine("goal_integrate", { task_id: "t1", action: "discard", action_token: "hidden-token" }), "goal_integrate", ["任务 t1", "丢弃"]],
    [callLine("goal_accept", { task_id: "t1", action_token: "hidden-token" }), "goal_accept", ["任务 t1"]],
    [callLine("goal_amend", { operation: "patch_active", reason: "hidden objective", action_token: "hidden-token", add_tasks: [{}] }), "goal_amend", ["patch_active", "新增 1", "移除 0", "更新 0"]],
    [callLine("goal_finalize", { goal_id: "g1", action_token: "hidden-token", approval_entry_id: "approval" }), "goal_finalize", ["目标 g1"]],
  ];
  for (const [rendered, toolName, fragments] of expectations) {
    assert.equal(rendered.startsWith(`${toolName} | `), true, `${toolName} keeps its English tool-name authority`);
    for (const fragment of fragments) assert.equal(rendered.includes(fragment), true, `${toolName} renders the localized display fragment ${fragment}`);
    for (const forbidden of ["{", "}", "\"", "hidden objective", "hidden-token", "approval", "goal-runtime.v1", "runnable"]) assert.equal(rendered.includes(forbidden), false, `${toolName} display must not leak raw payload material`);
  }
  const statusLine = tools.goal_status.renderResult({ details: { value: { status: "active", runnable: ["t1"] } } }, {}, null, { expanded: false }).render(80)[0];
  assert.equal(statusLine.startsWith("goal_status | "), true, "goal_status keeps its English tool-name authority");
  for (const fragment of ["活跃", "可运行 1"]) assert.equal(statusLine.includes(fragment), true, `status result renders the localized display fragment ${fragment}`);
  for (const forbidden of ["{", "}", "\"", "runnable"]) assert.equal(statusLine.includes(forbidden), false, "status display must not leak raw payload material");
});

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

function createMockPi(cwd, { sessionId = "session-test", autoSettlementEvidence = true } = {}) {
  const tools = [];
  const hooks = { tool_result: [] };
  const entries = [];
  const sentMessages = [];
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionFile: () => join(cwd, "session.jsonl"),
    getLeafId: () => entries.at(-1)?.id || "leaf-test",
    getEntries: () => [...entries],
    getBranch: () => [...entries],
  };
  return {
    tools, hooks, entries, sentMessages, sessionManager,
    executorProofs: new Map(),
    executorBindingSequence: 0,
    autoSettlementEvidence,
    executeContext: { cwd, sessionManager },
    workspaceService: goalWorkspaceService({ stateRoot: join(cwd, ".state/goal-engine") }),
    registerTool(def) { tools.push(def); },
    on(event, handler) { (hooks[event] ||= []).push(handler); },
    appendEntry(customType, data) { entries.push({ id: `custom-${entries.length + 1}`, type: "custom", customType, data }); },
    sendMessage(message, options) { sentMessages.push({ message, options }); },
  };
}

function createGoalEngineExtensionProduction(pi, options = {}) {
  return createGoalEngineExtensionFactory(pi, {
    goalStateEnv: {},
    inspectExecutorProof(runId) { return pi.executorProofs.get(runId) ?? null; },
    workspaceService: pi.workspaceService,
    allowMissingRootBrokerForTests: true,
    ...options,
  });
}

function createGoalEngineExtension(pi, options = {}) {
  return createGoalEngineExtensionProduction(pi, { enforceActionTokens: false, allowMissingRootBrokerForTests: true, ...options });
}

function tmpCwd() {
  const cwd = mkdtempSync(join(tmpdir(), "ge-ext-"));
  initGitRepo(cwd);
  writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n");
  git(cwd, "add", ".gitignore");
  git(cwd, "commit", "-m", "test: ignore goal state");
  return cwd;
}

function objectiveToGoalId(objective) {
  return objective.toLowerCase().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 80);
}

function plannedSettlementEvidence({ goalId, taskId, runId, attempt, contractHash, head, criteria, mainSessionId }) {
  const identity = { goalId, taskId, runId, attempt, contractHash, head };
  const ids = criteria.map((criterion) => criterion.id);
  const evidenceFor = (ref) => ({ identity, criteria: ids.map((id) => ({ id, status: "satisfied", evidence: [ref] })), commandsRun: [], changedFiles: ["src/a.ts"] });
  const subagent = evidenceFor(`sha256:${"1".repeat(64)}`);
  const main = evidenceFor(`sha256:${"2".repeat(64)}`);
  const options = { expectedIdentity: identity, expectedCriteria: ids, outcome: "succeeded" };
  const content = `${JSON.stringify({ main, mainSessionId, schemaVersion: "goal-engine.settlement-evidence.v1", subagent }, null, 2)}\n`;
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { schemaVersion: "goal-engine.settlement-evidence.v1", path: `acceptance-evidence/sha256/${sha256}.yaml`, sha256, subagentFingerprint: fingerprintSettlementEvidence(subagent, options), mainFingerprint: fingerprintSettlementEvidence(main, options), subagent, main, mainSessionId };
}

function plannedAcceptance(statements, { id = "criterion-1", evidenceKinds = ["tests"] } = {}) {
  const values = Array.isArray(statements) ? statements : [statements];
  return {
    criteria: values.map((statement, index) => ({
      id: values.length === 1 ? id : `${id}-${index + 1}`,
      statement,
      evidenceKinds: [...evidenceKinds],
    })),
  };
}

function oneTaskGoal(objective) {
  return {
    objective,
    tasks: [{
      id: "t1",
      description: "exercise Goal state storage",
      deps: [],
      writePaths: ["src/t1.ts"],
      acceptance: plannedAcceptance("state remains recoverable"),
      workflow: "tdd",
    }],
  };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function invoke(pi, name, params = {}) {
  let fixtureWorkspace;
  if (name === "goal_settle" && params.outcome === "succeeded" && pi.autoSettlementEvidence && !params.subagent_evidence) {
    const root = join(pi.executeContext.cwd, ".state/goal-engine");
    const goalsDirectory = join(root, "goals");
    const goalId = params.goal_id || (existsSync(goalsDirectory) ? readdirSync(goalsDirectory).find((entry) => existsSync(join(goalsDirectory, entry, "projection.json"))) : null);
    const projection = goalId ? loadProjection(root, goalId) : null;
    const task = projection?.tasks.get(params.task_id);
    if (projection?.eventSchemaVersion === "planned.v1" && task?.executorBinding) {
      let head;
      try { head = git(task.workspace.path, "rev-parse", "HEAD"); } catch { head = null; }
      if (head) {
      const identity = { goalId: projection.goalId, taskId: params.task_id, runId: task.executorBinding.runId, attempt: task.workspace.owner.attempt, contractHash: task.contractHash, head };
      // Executor evidence is limited to canonical run-evaluated criteria; the
      // coordinator owns its predicates and must not receive duplicate IDs.
      const expectedCriteria = task.acceptance.criteria.filter(({ evaluator }) => evaluator !== "coordinator").map(({ id }) => id);
      assert.equal(new Set(expectedCriteria).size, expectedCriteria.length, "fixture criteria IDs must be unique");
      const criteria = expectedCriteria.map((id) => ({ id, status: "satisfied", evidence: [`sha256:${"1".repeat(64)}`] }));
      const changedFiles = [task.writePaths[0]];
      const child = { identity, criteria, commandsRun: [], changedFiles };
      const main = { identity, criteria: criteria.map((entry) => ({ ...entry, evidence: [`sha256:${"2".repeat(64)}`] })), commandsRun: [], changedFiles };
      const sha256 = fingerprintSettlementEvidence(child, { expectedIdentity: identity, expectedCriteria, outcome: "succeeded" });
      const directory = join(task.executorBinding.asyncDir, "acceptance-evidence");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const excludePath = git(task.workspace.path, "rev-parse", "--git-path", "info/exclude");
      if (isAbsolute(excludePath) || existsSync(resolve(task.workspace.path, excludePath))) {
        writeFileSync(isAbsolute(excludePath) ? excludePath : resolve(task.workspace.path, excludePath), ".pi-subagents/\n", { flag: "a" });
      }
      const artifact = join(directory, `${sha256}.yaml`);
      writeFileSync(artifact, serializeSettlementEvidenceYaml(child, { expectedIdentity: identity, expectedCriteria, outcome: "succeeded" }), { mode: 0o600 });
      chmodSync(artifact, 0o600);
      params = { ...params, subagent_evidence: { sha256, content: child }, main_verification: main };
      }
    }
  }
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
  if (name === "goal_dispatch") {
    const dispatched = typeof result.details.value === "string" ? JSON.parse(result.details.value) : result.details.value;
    if (dispatched?.status === "dispatched") {
      const compiled = dispatched.contract;
      const contractHash = dispatched.contract_hash ?? compiled?.hash;
      const contract = compiled?.hash ? Object.fromEntries(Object.entries(compiled).filter(([key]) => key !== "hash")) : compiled;
      const coordinator = findGoalRunCoordinator(pi);
      const ticket = await coordinator?.prepareSpawn({ contract, contractHash, ctx: pi.executeContext });
      if (ticket) {
        const receipt = pi.workspaceService.ensureAllocated(ticket.workspaceRequest);
        await coordinator.workspaceAllocated(ticket, receipt);
        fixtureWorkspace = receipt;
        await coordinator.confirmSpawn(ticket, receipt);
        const suffix = ++pi.executorBindingSequence;
        const fixtureIdentity = ticket.ticketId.slice(0, 24);
        const runId = `fixture-run-${fixtureIdentity}`;
        const asyncDir = `/tmp/goal-engine-fixture-run-${fixtureIdentity}`;
        pi.workspaceService.bindRun({ workspaceId: receipt.workspaceId, run: { runId, asyncDir } });
        await coordinator.bindSpawn(ticket, { runId, asyncDir, sessionId: pi.sessionManager.getSessionId(), pid: 1, agentProfile: ticket.agentProfile });
        pi.executorProofs.set(runId, {
          runId,
          proofId: createHash("sha256").update(`${runId}\0${asyncDir}`).digest("hex"),
          rootSessionId: pi.sessionManager.getSessionId(),
          observedAt: 1_700_000_000_000 + suffix,
          outcome: "succeeded",
          agentProfile: "executor",
        });
      }
    }
  }
  return fixtureWorkspace ? JSON.stringify({ ...JSON.parse(text), workspace: fixtureWorkspace }) : text;
}

function setOfficialBoundRunProof(pi, cwd, goalId, taskId, outcome) {
  const task = loadProjection(join(cwd, ".state/goal-engine"), goalId).tasks.get(taskId);
  const prior = pi.executorProofs.get(task.executorBinding.runId);
  assert.ok(prior, "dispatch fixture must bind the run before its coordinator proof is recorded");
  pi.executorProofs.set(task.executorBinding.runId, { ...prior, outcome });
}

test("Goal status resolves its managed workspace service from the current Host registry context", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd, { sessionId: "root-registry-status" });
  const stateRoot = join(cwd, ".state/managed-workspaces");
  pi.workspaceService = goalWorkspaceService({ stateRoot });
  bindManagedWorkspaceServiceSession(pi, pi.sessionManager.getSessionId(), pi.workspaceService);
  try {
    createGoalEngineExtensionFactory(pi, {
      goalStateEnv: {},
      enforceActionTokens: false,
      allowMissingRootBrokerForTests: true,
      inspectExecutorProof(runId) { return pi.executorProofs.get(runId) ?? null; },
    });
    const objective = "Host registry workspace service";
    const goalId = objectiveToGoalId(objective);
    await invoke(pi, "goal_init", oneTaskGoal(objective));
    assert.deepEqual(inventoryManagedWorkspaces({ stateRoot }).workspaces, []);
    const goalEvents = join(cwd, ".state/goal-engine/goals", goalId, "events.jsonl");
    const beforeStatus = readFileSync(goalEvents, "utf8");
    const status = JSON.parse(await invoke(pi, "goal_status", {}));
    assert.equal(readFileSync(goalEvents, "utf8"), beforeStatus);
    assert.deepEqual(inventoryManagedWorkspaces({ stateRoot }).workspaces, []);
    assert.equal(status.tasks.t1.blockingReason, null);
    assert.deepEqual(status.runnable, ["t1"]);
  } finally {
    unbindManagedWorkspaceServiceSession(pi, pi.sessionManager.getSessionId(), pi.workspaceService);
  }
});

test("new session cannot recover or mutate another session's active Goal", async () => {
  const cwd = tmpCwd();
  const owner = createMockPi(cwd, { sessionId: "session-owner" });
  createGoalEngineExtensionProduction(owner);
  const objective = "Owner isolated Goal";
  const goalId = objectiveToGoalId(objective);
  await invoke(owner, "goal_init", oneTaskGoal(objective));
  // goal.created/session binding precede dispatch: the unified ledger has no
  // Goal/task/attempt record and status must treat that exact absence as safe.
  const stateRoot = join(cwd, ".state/goal-engine");
  assert.deepEqual(inventoryManagedWorkspaces({ stateRoot }).workspaces, []);
  const ownerStatus = JSON.parse(await invoke(owner, "goal_status", {}));
  assert.deepEqual(inventoryManagedWorkspaces({ stateRoot }).workspaces, []);
  assert.ok(ownerStatus.action_token);

  const other = createMockPi(cwd, { sessionId: "session-other" });
  createGoalEngineExtensionProduction(other);
  assert.equal(await invoke(other, "goal_status", {}), "NO_ACTIVE_GOAL");
  assert.equal((await emitHook(other, "before_agent_start", {})), undefined);
  const before = fullRejectionSnapshot(cwd, goalId);
  await assert.rejects(
    () => invoke(other, "goal_dispatch", { goal_id: goalId, task_id: "t1", action_token: ownerStatus.action_token }),
    /owner|active goal|session/i,
  );
  assert.deepEqual(fullRejectionSnapshot(cwd, goalId), before);

  const ownObjective = "Other isolated Goal";
  await invoke(other, "goal_init", oneTaskGoal(ownObjective));
  assert.equal(JSON.parse(await invoke(other, "goal_status", {})).goalId, objectiveToGoalId(ownObjective));
  assert.equal(JSON.parse(await invoke(owner, "goal_status", {})).goalId, goalId);
});

test("configured Goal state root keeps empty goal_status read-only before initialization", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ge-global-empty-origin-"));
  const goalBase = mkdtempSync(join(tmpdir(), "ge-global-empty-state-"));
  try {
    initGitRepo(cwd);
    const pi = createMockPi(cwd);
    createGoalEngineExtension(pi, { goalStateEnv: { PI_CODING_GOAL_DIR: goalBase } });

    assert.equal(await invoke(pi, "goal_status", {}), "NO_ACTIVE_GOAL");
    assert.deepEqual(readdirSync(goalBase), []);
    assert.equal(existsSync(join(cwd, ".state", "goal-engine")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(goalBase, { recursive: true, force: true });
  }
});

test("configured Goal state root keeps new structured artifacts outside the repository", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ge-global-origin-"));
  const goalBase = mkdtempSync(join(tmpdir(), "ge-global-state-"));
  try {
    initGitRepo(cwd);
    const pi = createMockPi(cwd);
    // Both Goal and workspace state are external to the clean origin before
    // allocation; do not weaken the managed service's dirty-origin preflight.
    pi.workspaceService = goalWorkspaceService({ stateRoot: join(goalBase, "managed-workspaces") });
    createGoalEngineExtension(pi, { goalStateEnv: { PI_CODING_GOAL_DIR: goalBase }, workspaceService: pi.workspaceService });
    const objective = "Global state root";
    const goalId = objectiveToGoalId(objective);

    await invoke(pi, "goal_init", oneTaskGoal(objective));

    const namespaces = readdirSync(goalBase);
    assert.equal(namespaces.length, 1);
    const stateRoot = join(goalBase, namespaces[0]);
    assert.equal(existsSync(join(stateRoot, "identity.json")), true);
    assert.equal(existsSync(join(stateRoot, "registry.json")), true);
    assert.equal(existsSync(join(stateRoot, "goals", goalId, "events.jsonl")), true);
    assert.equal(existsSync(join(cwd, ".state", "goal-engine")), false);

    const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
    const receipt = requireGoalWorkspaceReceipt(cwd, goalId, "t1", 1, join(goalBase, "managed-workspaces"));
    assert.equal(receipt.path.startsWith(join(goalBase, "managed-workspaces") + "/"), true);
    assert.equal(existsSync(receipt.path), true);
    assert.equal(existsSync(join(cwd, ".state", "goal-engine", "worktrees")), false);
    await invoke(pi, "goal_settle", {
      task_id: "t1",
      outcome: "failed",
      reason: "Global state path exercise is complete",
      next_action: "Discard the clean test workspace after verifying its global state path",
    });
    await invoke(pi, "goal_integrate", { task_id: "t1", action: "discard" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(goalBase, { recursive: true, force: true });
  }
});

test("configured Goal state root pins an active legacy Goal in place", async () => {
  const cwd = tmpCwd();
  const goalBase = mkdtempSync(join(tmpdir(), "ge-global-state-"));
  try {
    const legacyPi = createMockPi(cwd);
    createGoalEngineExtension(legacyPi);
    const objective = "Legacy active root";
    const goalId = objectiveToGoalId(objective);
    await invoke(legacyPi, "goal_init", oneTaskGoal(objective));

    const restartedPi = createMockPi(cwd);
    createGoalEngineExtension(restartedPi, { goalStateEnv: { PI_CODING_GOAL_DIR: goalBase } });
    const status = JSON.parse(await invoke(restartedPi, "goal_status", { goal_id: goalId }));

    assert.equal(status.goalId, goalId);
    assert.equal(existsSync(goalEventsPath(cwd, goalId)), true);
    assert.deepEqual(readdirSync(goalBase), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(goalBase, { recursive: true, force: true });
  }
});

test("configured Goal state root cuts new Goals over after a legacy Goal completes", async () => {
  const cwd = tmpCwd();
  const goalBase = mkdtempSync(join(tmpdir(), "ge-global-state-"));
  try {
    const legacyPi = createMockPi(cwd);
    createGoalEngineExtension(legacyPi);
    await invoke(legacyPi, "goal_init", oneTaskGoal("Completed legacy root"));
    await prepareSucceededTask(legacyPi, objectiveToGoalId("Completed legacy root"));
    await invoke(legacyPi, "goal_accept", { task_id: "t1" });

    const globalPi = createMockPi(cwd);
    createGoalEngineExtension(globalPi, { goalStateEnv: { PI_CODING_GOAL_DIR: goalBase } });
    const objective = "First global root";
    const goalId = objectiveToGoalId(objective);
    await invoke(globalPi, "goal_init", oneTaskGoal(objective));

    const scope = resolveGoalStateScope({ cwd, env: { PI_CODING_GOAL_DIR: goalBase } });
    assert.equal(existsSync(join(scope.preferredRoot, "goals", goalId, "events.jsonl")), true);
    assert.equal(existsSync(goalEventsPath(cwd, goalId)), false);
    const oldStatus = JSON.parse(await invoke(globalPi, "goal_status", { goal_id: objectiveToGoalId("Completed legacy root") }));
    assert.equal(oldStatus.lifecycle, "completed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(goalBase, { recursive: true, force: true });
  }
});

test("configured Goal state root rejects simultaneous global and legacy authorities", async () => {
  const cwd = tmpCwd();
  const goalBase = mkdtempSync(join(tmpdir(), "ge-global-state-"));
  try {
    const legacyPi = createMockPi(cwd);
    createGoalEngineExtension(legacyPi);
    const objective = "Conflicting state roots";
    await invoke(legacyPi, "goal_init", oneTaskGoal(objective));

    const scope = resolveGoalStateScope({ cwd, env: { PI_CODING_GOAL_DIR: goalBase } });
    ensureGoalStateIdentity(scope);
    cpSync(scope.legacyRoot, scope.preferredRoot, { recursive: true });

    const conflictedPi = createMockPi(cwd);
    createGoalEngineExtension(conflictedPi, { goalStateEnv: { PI_CODING_GOAL_DIR: goalBase } });
    await assert.rejects(
      () => invoke(conflictedPi, "goal_status", {}),
      (error) => error.code === "GOAL_STATE_ROOT_CONFLICT" && /global.*legacy|legacy.*global/i.test(error.message),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(goalBase, { recursive: true, force: true });
  }
});

function initGitRepo(cwd) {
  const run = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (existsSync(join(cwd, ".git"))) return run;
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

function bindGoalToMockSession(cwd, goalId, sessionId = "session-test") {
  const root = join(cwd, ".state/goal-engine");
  const projection = loadProjection(root, goalId);
  appendEventStore(root, {
    schemaVersion: "planned.v1", eventId: `${goalId}-session-bound-${sessionId}`, goalId,
    occurredAt: new Date().toISOString(), type: "goal.session_bound",
    data: { sessionId, leafId: "leaf-test" },
  }, projection.version);
}

function readGoalEvents(cwd, goalId) {
  const path = goalEventsPath(cwd, goalId);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function writeGoalHistory(cwd, events, { lifecycle = "active" } = {}) {
  const goalId = events[0].goalId;
  const root = join(cwd, ".state/goal-engine");
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(goalEventsPath(cwd, goalId), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  writeFileSync(join(root, "registry.json"), JSON.stringify({
    schema_version: "goal-engine.registry.v1",
    active_goal_ids: lifecycle === "active" ? [goalId] : [],
    goals: {
      [goalId]: {
        lifecycle,
        objective: events[0].data.objective,
        updatedAt: events.at(-1).occurredAt,
      },
    },
  }));
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
  const receipt = loadExecutorWorkspaceLease({
    goalId,
    taskId,
    attempt,
    stateRoot: join(cwd, ".state/goal-engine"),
  });
  const recordPath = receipt
    ? managedWorkspacePaths({ stateRoot: join(cwd, ".state/goal-engine"), originRoot: cwd, workspaceId: receipt.workspaceId }).recordPath
    : null;
  let branchExists = false;
  if (receipt) {
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", receipt.branchRef], { cwd, stdio: "ignore" });
      branchExists = true;
    } catch {}
  }
  return {
    receipt,
    workspacePath: receipt?.path ?? null,
    recordPath,
    branch: receipt?.branchRef ?? null,
    state: receipt?.state ?? "absent",
    identity: receipt?.owner ?? null,
    workspaceExists: receipt !== undefined && existsSync(receipt.path),
    recordExists: recordPath !== null && existsSync(recordPath),
    branchExists,
  };
}

function requireGoalWorkspaceReceipt(cwd, goalId, taskId, attempt = 1, stateRoot = join(cwd, ".state/goal-engine")) {
  const receipt = loadExecutorWorkspaceLease({ goalId, taskId, attempt, stateRoot });
  if (receipt) return receipt;
  const error = new Error(`managed workspace receipt is missing for ${goalId}/${taskId}/${attempt}`);
  error.code = "MANAGED_WORKSPACE_RECEIPT_MISSING";
  throw error;
}

function commitWorkspaceChange(lease, filePath, content, message) {
  const absolute = join(lease.path, filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  execFileSync("git", ["add", filePath], { cwd: lease.path });
  execFileSync("git", ["commit", "-m", message], { cwd: lease.path });
}

function persistedStateBytes(cwd, goalId) {
  const root = join(cwd, ".state/goal-engine");
  const bytes = (path) => existsSync(path) ? readFileSync(path) : null;
  return [
    bytes(goalEventsPath(cwd, goalId)),
    bytes(join(root, "goals", goalId, "projection.json")),
    bytes(join(root, "registry.json")),
  ];
}

function rejectionSnapshot(cwd, goalId) {
  return {
    state: persistedStateBytes(cwd, goalId),
    refs: git(cwd, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"),
    worktrees: git(cwd, "worktree", "list", "--porcelain"),
  };
}

function fullRejectionSnapshot(cwd, goalId, taskId = "t1", attempt = 1) {
  const workspace = workspaceState(cwd, goalId, taskId, attempt);
  const bytes = (path) => existsSync(path) ? readFileSync(path) : null;
  const workspaceGit = (args) => workspace.workspaceExists ? git(workspace.workspacePath, ...args) : null;
  return {
    ...rejectionSnapshot(cwd, goalId),
    origin: { head: git(cwd, "rev-parse", "HEAD"), ref: git(cwd, "symbolic-ref", "--short", "HEAD"), status: git(cwd, "status", "--porcelain=v1") },
    workspace: { ...workspace, head: workspaceGit(["rev-parse", "HEAD"]), ref: workspaceGit(["symbolic-ref", "--short", "HEAD"]), status: workspaceGit(["status", "--porcelain=v1"]), leaseBytes: bytes(workspace.recordPath) },
  };
}

function createGoalEngineWithAppendInjection(pi, options = {}) {
  return createGoalEngineExtension(pi, options);
}

function assertDispatchRequiredNextAction(error, expected) {
  assert.deepEqual(error.requiredNextAction, expected);
  const match = error.message.match(/requiredNextAction=(\{.*\})$/);
  assert.ok(match, "dispatch preflight error must include requiredNextAction JSON");
  assert.deepEqual(JSON.parse(match[1]), expected);
}

function assertOrphanRecoveryContract(error, expected) {
  assert.equal(error.code, expected.code);
  assert.deepEqual(error.observed, expected.observed);
  assert.equal(error.remediation, expected.remediation);
  assert.equal(error.stateChanged, false);
  assert.deepEqual(error.requiredNextAction, expected.requiredNextAction);
  assert.deepEqual(error.blockingReason, expected.blockingReason);
  assert.match(error.message, /observed=.*remediation=.*stateChanged=false/);
  const match = error.message.match(/recoveryContract=(\{.*\})$/);
  assert.ok(match, "orphan dispatch error must end with recoveryContract JSON");
  assert.deepEqual(JSON.parse(match[1]), {
    code: error.code,
    observed: error.observed,
    remediation: error.remediation,
    stateChanged: error.stateChanged,
    requiredNextAction: error.requiredNextAction,
    blockingReason: error.blockingReason,
  });
  assert.deepEqual(JSON.parse(match[1]), expected);
}

function orphanNotSettledRecoveryContract() {
  const resources = { workspaceExists: true, branchExists: true, recordExists: true };
  return {
    code: "ORPHANED_WORKSPACE_NOT_SETTLED",
    observed: { taskId: "t1", candidate: { attempt: 1 }, resources },
    remediation: "inspect the authoritative recovery state with goal_status before any workspace action",
    stateChanged: false,
    requiredNextAction: null,
    blockingReason: {
      code: "ORPHANED_WORKSPACE_NOT_SETTLED", requiresHumanDecision: true,
      choices: [
        { tool: "goal_integrate", params: { task_id: "t1", action: "discard" } },
        { tool: "goal_integrate", params: { task_id: "t1", action: "preserve" } },
      ],
    },
  };
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

function assertStructuredWorkspaceError(error, code, goalId) {
  assert.equal(error.code, code);
  assert.match(error.message, /remediation=.*stateChanged=false.*requiredNextAction/);
  assertDispatchRequiredNextAction(error, { tool: "goal_status", params: { goal_id: goalId } });
}

test("goal_status returns active task from historical v2 JSONL", async () => {
  const cwd = tmpCwd();
  const goalId = "legacy-status-v2";
  const root = join(cwd, ".state/goal-engine");
  const event = { schemaVersion: "goal-engine.event.v2", eventId: "legacy-status-create", goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Restore legacy status", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["cd /tmp && true"] }, workflow: "tdd" } } } };
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${JSON.stringify(event)}\n`);
  writeFileSync(join(root, "registry.json"), JSON.stringify({ schema_version: "goal-engine.registry.v1", active_goal_ids: [goalId], goals: { [goalId]: { lifecycle: "active", objective: event.data.objective, updatedAt: event.occurredAt } } }));
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const status = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(status.goalId, goalId);
  assert.equal(status.lifecycle, "active");
  assert.equal(status.tasks.t1.status, "pending");
  assert.deepEqual(status.runnable, ["t1"]);
});

test("historical workspace-less succeeded settle returns workspace-missing without state changes", async () => {
  const cwd = tmpCwd();
  const goalId = "historical-workspace-less-settle";
  const root = join(cwd, ".state/goal-engine");
  const created = { schemaVersion: "goal-engine.event.v1", eventId: "legacy-workspace-less-created", goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Historical workspace-less settlement", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" } } } };
  const dispatched = { schemaVersion: "goal-engine.event.v1", eventId: "legacy-workspace-less-dispatched", goalId, occurredAt: "2024-01-01T00:00:01.000Z", type: "task.dispatched", data: { taskId: "t1", contractHash: "legacy-contract" } };
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(goalEventsPath(cwd, goalId), `${JSON.stringify(created)}\n${JSON.stringify(dispatched)}\n`);
  writeFileSync(join(root, "registry.json"), JSON.stringify({ schema_version: "goal-engine.registry.v1", active_goal_ids: [goalId], goals: { [goalId]: { lifecycle: "active", objective: created.data.objective, updatedAt: dispatched.occurredAt } } }));
  const before = { events: readFileSync(goalEventsPath(cwd, goalId), "utf8"), projection: existsSync(join(root, "goals", goalId, "projection.json")) ? readFileSync(join(root, "goals", goalId, "projection.json"), "utf8") : null, registry: readFileSync(join(root, "registry.json"), "utf8") };
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  assert.equal(status.tasks.t1.status, "dispatched");
  assert.deepEqual({ events: readFileSync(goalEventsPath(cwd, goalId), "utf8"), projection: existsSync(join(root, "goals", goalId, "projection.json")) ? readFileSync(join(root, "goals", goalId, "projection.json"), "utf8") : null, registry: readFileSync(join(root, "registry.json"), "utf8") }, before);
});

test("goal_settle classifies Git infrastructure workspace inspection without side effects", async () => {
  const cwd = tmpCwd();
  const objective = "Git infrastructure settle fixture";
  const goalId = objectiveToGoalId(objective);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Break Git metadata", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  await invoke(pi, "goal_dispatch", { task_id: "t1" });
  const workspace = requireGoalWorkspaceReceipt(cwd, goalId, "t1");
  const gitFile = join(workspace.path, ".git");
  assert.match(readFileSync(gitFile, "utf8"), /^gitdir: /);
  writeFileSync(gitFile, "gitdir: /nonexistent/goal-engine-broken-gitdir\n");
  const before = rejectionSnapshot(cwd, goalId);
  await assert.rejects(
    () => invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Repair the executor Git metadata and recover through typed goal status before retrying." }),
    (error) => { assertStructuredWorkspaceError(error, "GIT_INFRASTRUCTURE_ERROR", goalId); return true; },
  );
  assert.deepEqual(rejectionSnapshot(cwd, goalId), before);
});

test("goal_settle classifies top-level identity mismatch without side effects", async () => {
  const cwd = tmpCwd();
  const objective = "Top-level identity mismatch settle fixture";
  const goalId = objectiveToGoalId(objective);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Fall back to parent repository", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  await invoke(pi, "goal_dispatch", { task_id: "t1" });
  const workspace = requireGoalWorkspaceReceipt(cwd, goalId, "t1");
  renameSync(join(workspace.path, ".git"), join(workspace.path, ".git-moved"));
  const before = rejectionSnapshot(cwd, goalId);
  await assert.rejects(
    () => invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Recover the executor workspace through typed goal status before retrying." }),
    (error) => {
      assert.equal(error.code, "EXECUTOR_WORKSPACE_IDENTITY_MISMATCH");
      assertStructuredWorkspaceError(error, "EXECUTOR_WORKSPACE_IDENTITY_MISMATCH", goalId);
      return true;
    },
  );
  assert.deepEqual(rejectionSnapshot(cwd, goalId), before);
});

test("goal_settle failed and blocked dirty no-commit recovery characterizes discard and preserve", async () => {
  for (const [outcome, action] of [["failed", "discard"], ["blocked", "preserve"]]) {
    const cwd = tmpCwd();
    const objective = `${outcome} dirty no-commit recovery fixture`;
    const goalId = objectiveToGoalId(objective);
    const pi = createMockPi(cwd);
    createGoalEngineExtension(pi);
    await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Leave ordinary dirty work", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
    await invoke(pi, "goal_dispatch", { task_id: "t1" });
    const workspace = requireGoalWorkspaceReceipt(cwd, goalId, "t1");
    writeFileSync(join(workspace.path, "ordinary-dirty.txt"), "dirty\n");
    setOfficialBoundRunProof(pi, cwd, goalId, "t1", "failed");
    await invoke(pi, "goal_settle", { task_id: "t1", outcome, reason: outcome === "blocked" ? "Waiting for an external dependency before the executor can continue." : undefined, next_action: "Keep the dirty executor workspace available for the selected typed disposition action." });
    const settled = loadProjection(join(cwd, ".state/goal-engine"), goalId).tasks.get("t1");
    assert.equal(settled.lastExecutorProof.outcome, "failed", "fixture uses the coordinator's official verified failed terminal proof");
    assert.equal(settled.lastExecutorProof.runId, settled.executorBinding.runId);
    if (action === "discard") {
      await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action }), (error) => error.code === "GIT_INFRASTRUCTURE_ERROR" && /disposition is not allowed by the terminal and workspace snapshot/.test(error.message));
      assert.equal(existsSync(workspace.path), true);
    } else {
      await invoke(pi, "goal_integrate", { task_id: "t1", action });
      assert.equal(existsSync(workspace.path), true);
    }
    execFileSync("git", ["show-ref", "--verify", "--quiet", workspace.branchRef], { cwd });
    assert.equal(existsSync(join(workspace.path, "ordinary-dirty.txt")), true);
  }
});

test("historical unsafe dispatch is rejected before workspace allocation while status remains readable", async () => {
  const cwd = tmpCwd();
  const goalId = "historical-unsafe-dispatch";
  const root = join(cwd, ".state/goal-engine");
  const event = { schemaVersion: "goal-engine.event.v2", eventId: "historical-unsafe-create", goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Historical unsafe dispatch", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: [`cd ${cwd} && true`] }, workflow: "tdd" } } } };
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${JSON.stringify(event)}\n`);
  writeFileSync(join(root, "registry.json"), JSON.stringify({ schema_version: "goal-engine.registry.v1", active_goal_ids: [goalId], goals: { [goalId]: { lifecycle: "active", objective: event.data.objective, updatedAt: event.occurredAt } } }));
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  assert.equal(JSON.parse(await invoke(pi, "goal_status", {})).tasks.t1.status, "pending");
  await assert.rejects(
    () => invoke(pi, "goal_dispatch", { task_id: "t1" }),
    (error) => {
      assert.equal(error.code, "INVALID_TASK_CONTRACT");
      assert.match(error.message, /observed=.*remediation=.*goal_amend.*stateChanged=false/);
      assertDispatchRequiredNextAction(error, { tool: "goal_status", params: { goal_id: goalId } });
      return true;
    },
  );
  assert.equal(readGoalEvents(cwd, goalId).length, 1);
  assert.deepEqual(workspaceState(cwd, goalId, "t1"), {
    receipt: undefined, workspacePath: null, recordPath: null, branch: null, state: "absent", identity: null,
    workspaceExists: false, recordExists: false, branchExists: false,
  });
});

test("historical tracked state dispatch is rejected before workspace allocation", async () => {
  const cwd = tmpCwd();
  const goalId = "historical-tracked-state-dispatch";
  const root = join(cwd, ".state/goal-engine");
  const event = { schemaVersion: "goal-engine.event.v2", eventId: "historical-tracked-create", goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Historical tracked state dispatch", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy safe task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" } } } };
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${JSON.stringify(event)}\n`);
  writeFileSync(join(root, "registry.json"), JSON.stringify({ schema_version: "goal-engine.registry.v1", active_goal_ids: [goalId], goals: { [goalId]: { lifecycle: "active", objective: event.data.objective, updatedAt: event.occurredAt } } }));
  writeFileSync(join(root, "tracked.json"), "{}\n");
  git(cwd, "add", "-f", ".state/goal-engine/tracked.json");
  git(cwd, "commit", "-m", "test: track legacy goal state");
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  await assert.rejects(
    () => invoke(pi, "goal_dispatch", { task_id: "t1" }),
    (error) => {
      assert.equal(error.code, "STATE_TRACKED");
      assert.match(error.message, /observed=.*remediation=.*goal_dispatch.*stateChanged=false/);
      assertDispatchRequiredNextAction(error, { tool: "goal_dispatch", params: { goal_id: goalId, task_id: "t1" } });
      return true;
    },
  );
  assert.equal(readGoalEvents(cwd, goalId).length, 1);
  assert.deepEqual(workspaceState(cwd, goalId, "t1"), {
    receipt: undefined, workspacePath: null, recordPath: null, branch: null, state: "absent", identity: null,
    workspaceExists: false, recordExists: false, branchExists: false,
  });
});

test("historical dispatch errors offer complete retry and status actions", async () => {
  for (const scenario of [
    { code: "STATE_NOT_IGNORED", setup(cwd) { writeFileSync(join(cwd, ".gitignore"), ""); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: stop ignoring state"); } },
    { code: "GIT_INFRASTRUCTURE_ERROR", setup(cwd) { renameSync(join(cwd, ".git"), join(cwd, ".git-hidden")); } },
  ]) {
    const cwd = tmpCwd();
    const goalId = `historical-${scenario.code.toLowerCase()}`;
    const root = join(cwd, ".state/goal-engine");
    const event = { schemaVersion: "goal-engine.event.v2", eventId: `historical-${scenario.code}`, goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Historical preflight", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy safe task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" } } } };
    mkdirSync(join(root, "goals", goalId), { recursive: true });
    writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${JSON.stringify(event)}\n`);
    writeFileSync(join(root, "registry.json"), JSON.stringify({ schema_version: "goal-engine.registry.v1", active_goal_ids: [goalId], goals: { [goalId]: { lifecycle: "active", objective: event.data.objective, updatedAt: event.occurredAt } } }));
    scenario.setup(cwd);
    const pi = createMockPi(cwd);
    createGoalEngineExtension(pi);
    await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), (error) => {
      assert.equal(error.code, scenario.code);
      assert.match(error.message, /observed=.*remediation=.*stateChanged=false/);
      assertDispatchRequiredNextAction(error, { tool: "goal_dispatch", params: { goal_id: goalId, task_id: "t1" } });
      return true;
    });
  }
});

test("historical safe ignored state remains readable and rejects new dispatch", async () => {
  const cwd = tmpCwd();
  const goalId = "historical-safe-dispatch";
  const root = join(cwd, ".state/goal-engine");
  const event = { schemaVersion: "goal-engine.event.v2", eventId: "historical-safe-create", goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Historical safe dispatch", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy safe task", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["works"], commands: ["true"] }, workflow: "tdd" } } } };
  mkdirSync(join(root, "goals", goalId), { recursive: true });
  writeFileSync(join(root, "goals", goalId, "events.jsonl"), `${JSON.stringify(event)}\n`);
  writeFileSync(join(root, "registry.json"), JSON.stringify({ schema_version: "goal-engine.registry.v1", active_goal_ids: [goalId], goals: { [goalId]: { lifecycle: "active", objective: event.data.objective, updatedAt: event.occurredAt } } }));
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const status = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(status.tasks.t1.status, "pending");
  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), /strict generation|read.?only/i);
  assert.deepEqual(readGoalEvents(cwd, goalId).map((record) => record.schemaVersion), ["goal-engine.event.v2"]);
});

test("goal_amend exposes a strict discriminated twelve-operation schema", () => {
  const pi = createMockPi(tmpCwd());
  createGoalEngineExtension(pi);
  const schema = pi.tools.find((tool) => tool.name === "goal_amend").parameters;
  assert.equal(schema.type, "object");
  assert.equal(schema.anyOf.length, 12);
  assert.deepEqual(schema.anyOf.map((candidate) => candidate.properties.operation.const).sort(), [
    "abandon_runtime", "detach_session", "patch_active", "propose_execution_change", "propose_transfer_session", "propose_update_goal", "reopen_completed", "resolve_blocked", "resume_runtime", "transfer_session", "triage", "update_goal",
  ].sort());
  for (const branch of schema.anyOf) {
    assert.equal(branch.additionalProperties, false);
    assert.ok(branch.properties.operation.const);
    assert.ok(Object.hasOwn(branch.properties, "goal_id"), "goal_id remains optional in every branch");
    assert.equal(branch.required.includes("goal_id"), ["propose_transfer_session", "transfer_session", "propose_execution_change", "abandon_runtime"].includes(branch.properties.operation.const));
  }
  const branch = (operation) => schema.anyOf.find((candidate) => candidate.properties.operation.const === operation);
  const propose = branch("propose_update_goal");
  const update = branch("update_goal");
  const reopen = branch("reopen_completed");
  const triage = branch("triage");
  const detach = branch("detach_session");
  const proposeTransfer = branch("propose_transfer_session");
  const transfer = branch("transfer_session");
  const executionChange = branch("propose_execution_change");
  const resume = branch("resume_runtime");
  assert.deepEqual(resume.required.sort(), ["action_token", "operation"].sort());
  assert.deepEqual(executionChange.required.sort(), ["changes", "goal_id", "operation", "reason"].sort());
  assert.deepEqual(Object.keys(executionChange.properties.changes.properties), ["update_tasks"]);
  assert.equal(executionChange.properties.changes.additionalProperties, false);
  assert.deepEqual(executionChange.properties.changes.properties.update_tasks.items.required, ["id"]);
  assert.deepEqual(propose.required.sort(), ["changes", "operation", "reason"].sort());
  assert.equal(Object.hasOwn(propose.properties, "action_token"), false);
  assert.deepEqual(Object.keys(update.properties).sort(), ["action_token", "challenge_id", "goal_id", "operation"]);
  assert.deepEqual(update.required.sort(), ["action_token", "challenge_id", "operation"].sort());
  assert.equal(detach.required.includes("session_id"), false);
  assert.deepEqual(proposeTransfer.required.sort(), ["goal_id", "operation", "reason"].sort());
  assert.deepEqual(transfer.required.sort(), ["goal_id", "operation", "challenge_id", "reason", "action_token"].sort());

  const basis = reopen.properties.basis;
  assert.equal(basis.additionalProperties, false);
  assert.deepEqual(basis.required, ["epoch"]);
  const discovery = triage.properties.resolve_discoveries.items;
  assert.equal(discovery.additionalProperties, false);
  assert.deepEqual(discovery.required.sort(), ["disposition", "id", "reason"]);
  const task = reopen.properties.add_tasks.items;
  assert.deepEqual(task.required.sort(), ["acceptance", "description", "id", "writePaths"]);
  assert.equal(task.additionalProperties, false);
  assert.equal(task.properties.acceptance.additionalProperties, false);
  assert.deepEqual(task.properties.acceptance.required, ["criteria"]);
  assert.deepEqual(task.properties.acceptance.properties.criteria.items.required.sort(), ["evidenceKinds", "id", "statement"]);
  assert.equal(task.properties.acceptance.properties.criteria.items.additionalProperties, false);
  const updateAcceptance = branch("patch_active").properties.update_tasks.additionalProperties.properties.acceptance;
  assert.equal(updateAcceptance.additionalProperties, false);
  assert.deepEqual(updateAcceptance.required, ["criteria"]);
  assert.equal(Object.hasOwn(updateAcceptance.properties, "commands"), false);

  const initTask = pi.tools.find((tool) => tool.name === "goal_init").parameters.properties.tasks.items;
  for (const plannedCriteria of [task.properties.acceptance.properties.criteria, updateAcceptance.properties.criteria, initTask.properties.acceptance.properties.criteria]) {
    assert.deepEqual(plannedCriteria.items.required.sort(), ["evidenceKinds", "id", "statement"]);
    assert.equal(plannedCriteria.items.additionalProperties, false);
    assert.equal(Object.hasOwn(plannedCriteria.items.properties, "evaluator"), false);
    assert.equal(Object.hasOwn(plannedCriteria.items.properties, "predicate"), false);
  }
  const runtimeCriteria = executionChange.properties.changes.properties.update_tasks.items.properties.acceptance.properties.criteria.items;
  assert.equal(runtimeCriteria.anyOf.length, 3);
  assert.deepEqual(runtimeCriteria.anyOf[2].required.sort(), ["evaluator", "evidenceKinds", "id", "predicate", "statement"]);
});

test("goal_amend prepareArguments fail-closed validates strict operation shapes", () => {
  const pi = createMockPi(tmpCwd());
  createGoalEngineExtension(pi);
  const prepare = pi.tools.find((tool) => tool.name === "goal_amend").prepareArguments;
  const discovery = { id: "d1", disposition: "tasked", reason: "The completed goal needs a follow-up", task_id: "t2" };
  const task = { id: "t2", description: "Follow-up", writePaths: ["src/t2.ts"], acceptance: plannedAcceptance(["works"]) };
  assert.deepEqual(prepare({ reason: "legacy patch", action_token: "token" }), { operation: "patch_active", reason: "legacy patch", action_token: "token" });
  for (const invalid of [
    { operation: "invalid", reason: "x", action_token: "t" },
    { operation: "patch_active", reason: "x" },
    { operation: "patch_active", reason: "x", action_token: "t", changes: {} },
    { operation: "propose_update_goal", reason: "x", changes: {}, action_token: "t" },
    { operation: "update_goal", challenge_id: "c", action_token: "t", changes: {} },
    { operation: "reopen_completed", reason: "x", action_token: "t", basis: {}, resolve_discoveries: [discovery], add_tasks: [task] },
    { operation: "triage", reason: "x", action_token: "t", resolve_discoveries: [{ id: "d1" }] },
    { operation: "patch_active", reason: "x", action_token: "t", update_tasks: { t1: { unknown: true } } },
    { operation: "patch_active", reason: "x", action_token: "t", update_tasks: { t1: { workflow: "unsafe" } } },
  ]) assert.throws(() => prepare(invalid), /valid|mixed|missing|invalid|shape/i);
  for (const valid of [
    { operation: "patch_active", reason: "x", action_token: "t" },
    { operation: "resolve_blocked", reason: "x", action_token: "t", blocked_resolution: "retry", blocked_task_id: "t1" },
    { operation: "triage", reason: "x", action_token: "t", resolve_discoveries: [discovery] },
    { operation: "reopen_completed", reason: "x", action_token: "t", basis: { epoch: 1, discovery_ids: ["d1"] }, resolve_discoveries: [discovery], add_tasks: [task] },
    { operation: "detach_session", reason: "x", action_token: "t" },
    { operation: "propose_update_goal", reason: "x", changes: { objective: "new" } },
    { operation: "update_goal", challenge_id: "c", action_token: "t" },
  ]) assert.deepEqual(prepare(valid), valid);
});

test("registers exact-eight goal engine tools", () => {
  const pi = createMockPi(tmpCwd());
  createGoalEngineExtension(pi);
  const names = pi.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["goal_accept", "goal_amend", "goal_dispatch", "goal_finalize", "goal_init", "goal_integrate", "goal_settle", "goal_status"]);
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
      goal_integrate: "当已 settle 或 status 报告 verified orphan 时使用；正常 workspace 可 integrate/discard/preserve，orphan 仅 discard/preserve。不要 integrate orphan 或手工清资源。",
      goal_accept: "当 task succeeded、机械验收通过且 workspace 已 integrated+released 时，或重试同一验收确认时使用；验收 task 并可完成 goal。不要只凭 executor completed 声明。",
      goal_finalize: "终局工具 ABI 已冻结；R1 中所有现有 generation 均在任何评审、事件或资源副作用前拒绝，R11 才接通 runtime 终审。",
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

test("goal_init writes strict planned.v1 records and rejects commands atomically", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  const objective = "Strict Planned writer";
  const goalId = objectiveToGoalId(objective);

  await invoke(pi, "goal_init", {
    objective,
    tasks: [{
      id: "t1",
      description: "persist a structured criterion",
      writePaths: ["src/planned.ts"],
      acceptance: plannedAcceptance("planned criterion remains bound", {
        id: "planned-bound",
        evidenceKinds: ["changed-files", "tests"],
      }),
      workflow: "tdd",
    }],
  });

  const events = readGoalEvents(cwd, goalId);
  assert.deepEqual(events.map((event) => event.type), ["goal.created"]);
  assert.deepEqual(events.map((event) => event.schemaVersion), ["planned.v1"]);
  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.deepEqual(projection.tasks.get("t1").acceptance, plannedAcceptance("planned criterion remains bound", {
    id: "planned-bound",
    evidenceKinds: ["changed-files", "tests"],
  }));

  const invalidCwd = tmpCwd();
  const invalidPi = createMockPi(invalidCwd);
  createGoalEngineExtension(invalidPi);
  await assert.rejects(
    () => invoke(invalidPi, "goal_init", {
      objective: "Reject Planned commands",
      tasks: [{
        id: "t1",
        description: "reject command transport",
        writePaths: ["src/rejected.ts"],
        acceptance: { ...plannedAcceptance("commands never enter Planned"), commands: ["true"] },
        workflow: "tdd",
      }],
    }),
    (error) => error.code === "INVALID_TASK_CONTRACT" && /commands|unknown field|only criteria/i.test(error.message),
  );
  assert.deepEqual(readGoalEvents(invalidCwd, objectiveToGoalId("Reject Planned commands")), []);
});

test("goal_dispatch persists a criteria-only runtime task without leaking its managed workspace", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  // This unit double intentionally does not install the production Root Broker.
  createGoalEngineExtension(pi, {
    allowMissingRootBrokerForTests: true,
    runtimeHost: {
      registries: runtimeRegistries,
      captureCurrentWorld() {
        return {
          safe: true,
          repo: { root: cwd, head: git(cwd, "rev-parse", "HEAD"), trackedDirty: [], untracked: [], sequencer: null },
          adapters: [], environments: [], fixtures: [], resources: [], activeRuns: [], capturedAt: new Date().toISOString(),
        };
      },
    },
  });

  const initialized = JSON.parse(await invoke(pi, "goal_init", runtimeInit()));
  const beforeDispatch = workspaceState(cwd, initialized.goalId, "task-1");
  assert.equal(beforeDispatch.workspaceExists, false);
  let dispatched;
  try {
    dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "task-1" }));
    assert.equal(dispatched.status, "dispatched");
    assert.equal(Object.hasOwn(dispatched.contract.acceptance, "commands"), false);
    assert.equal(JSON.stringify(dispatched.contract).includes("commands"), false);
    assert.equal(dispatched.workspace.owner.kind, "goal-task");
    const workspace = loadProjection(join(cwd, ".state/goal-engine"), initialized.goalId).tasks.get("task-1").workspace;
    assert.equal(workspace.state, "active");
    assert.equal(existsSync(workspace.path), true);
    assert.ok(readGoalEvents(cwd, initialized.goalId).some((event) => event.type === "task.dispatch_requested"));
  } finally {
    const root = join(cwd, ".state/goal-engine");
    const lease = loadExecutorWorkspaceLease({ goalId: initialized.goalId, taskId: "task-1", attempt: 1, stateRoot: root });
    if (lease) releaseExecutorWorkspace(lease, { disposition: "failed-cleanup", expectedExecutorHead: lease.baseCommit });
  }
  const state = workspaceState(cwd, initialized.goalId, "task-1");
  assert.equal(state.workspaceExists, false);
  assert.equal(state.state, "released");
});

test("planned.v1 production lifecycle keeps every writer record in one generation", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd, { autoSettlementEvidence: false });
  createGoalEngineExtensionProduction(pi);
  const objective = "Planned production writer lifecycle";
  const goalId = objectiveToGoalId(objective);

  await invoke(pi, "goal_init", {
    objective,
    tasks: [{
      id: "t1",
      description: "exercise every production writer phase",
      writePaths: ["src/t1.ts"],
      acceptance: plannedAcceptance("all writer phases retain generation", { id: "writer-generation" }),
      workflow: "tdd",
    }],
  });
  await emitHook(pi, "session_before_compact", {
    reason: "overflow",
    willRetry: true,
    preparation: { fileOps: { read: new Set(), written: new Set(["src/t1.ts"]), edited: new Set() } },
  });

  let status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", {
    task_id: "t1",
    action_token: status.action_token,
  }));
  assert.equal(Object.hasOwn(dispatched.contract.acceptance, "commands"), false);
  assert.deepEqual(dispatched.contract.acceptance.criteria, [
    JSON.stringify({ id: "writer-generation", statement: "all writer phases retain generation", evidenceKinds: ["tests"] }),
  ]);
  commitWorkspaceChange(dispatched.workspace, "src/t1.ts", "export const planned = true;\n", "feat: planned writer lifecycle");

  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  await assert.rejects(() => invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/t1.ts" },
    evidence_source: "self_produced",
    next_action: "Integrate the Planned writer fixture and verify its complete event generation",
    action_token: status.action_token,
  }), /subagent_evidence|main_verification|dual.*evidence/i);
  pi.autoSettlementEvidence = true;
  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  await invoke(pi, "goal_settle", {
    task_id: "t1", outcome: "succeeded",
    next_action: "Integrate the Planned writer fixture and verify its complete event generation",
    action_token: status.action_token,
  });
  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  await invoke(pi, "goal_integrate", {
    task_id: "t1",
    action: "integrate",
    action_token: status.action_token,
  });
  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  const accepted = JSON.parse(await invoke(pi, "goal_accept", { task_id: "t1", action_token: status.action_token }));
  assert.equal(accepted.goal_complete, true);

  const events = readGoalEvents(cwd, goalId);
  assert.ok(events.some((event) => event.type === "goal.session_bound"));
  assert.ok(events.some((event) => event.type === "goal.continuity_checkpointed"));
  assert.ok(events.some((event) => event.type === "goal.action_offered"));
  assert.ok(events.some((event) => event.type === "task.managed_workspace_disposition_intent"));
  assert.ok(events.some((event) => event.type === "task.managed_workspace_disposition_receipt"));
  assert.equal(events.some((event) => /^task\.workspace_disposition_(started|applied|disposed)$/.test(event.type)), false);
  assert.equal(events.filter((event) => event.type === "goal.completed").length, 1);
  assert.deepEqual(new Set(events.map((event) => event.schemaVersion)), new Set(["planned.v1"]));
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
      { id: "t1", description: "Implement token validation logic", deps: [], writePaths: ["src/auth/token.ts"], acceptance: plannedAcceptance(["Handles expiry"]), workflow: "tdd" },
      { id: "t2", description: "Add session management layer", deps: ["t1"], writePaths: ["src/auth/session.ts"], acceptance: plannedAcceptance(["Session persists"]), workflow: "tdd" },
    ],
  }));

  assert.equal(result.goalId, "build-the-authentication-module-with-token-validation");
  assert.equal(result.lifecycle, "active");
  assert.deepEqual(result.runnable, ["t1"]);
  assert.equal(result.total_tasks, 2);
});

test("goal_init rejects unsafe Git preflight before creating state", async () => {
  const cases = [
    { name: "non Git cwd", expectedCode: "GIT_INFRASTRUCTURE_ERROR", setup: () => mkdtempSync(join(tmpdir(), "ge-unsafe-")) },
    { name: "unborn HEAD", expectedCode: "INVALID_GIT_HEAD", setup: () => { const cwd = mkdtempSync(join(tmpdir(), "ge-unborn-")); git(cwd, "init"); return cwd; } },
    { name: "state directory not ignored", expectedCode: "STATE_NOT_IGNORED", setup: () => { const cwd = mkdtempSync(join(tmpdir(), "ge-unignored-")); initGitRepo(cwd); return cwd; } },
    { name: "repository subdirectory", expectedCode: "UNSAFE_GIT_CWD", setup: () => { const cwd = tmpCwd(); mkdirSync(join(cwd, "child")); return join(cwd, "child"); } },
    { name: "detached HEAD", expectedCode: "DETACHED_GIT_HEAD", setup: () => { const cwd = tmpCwd(); git(cwd, "checkout", "--detach"); return cwd; } },
    { name: "tracked state entry", expectedCode: "STATE_TRACKED", setup: () => { const cwd = tmpCwd(); mkdirSync(join(cwd, ".state/goal-engine"), { recursive: true }); writeFileSync(join(cwd, ".state/goal-engine/old.json"), "{}\n"); git(cwd, "add", "-f", ".state/goal-engine/old.json"); git(cwd, "commit", "-m", "test: tracked state"); return cwd; } },
    { name: "corrupt index", expectedCode: "GIT_INFRASTRUCTURE_ERROR", setup: () => { const cwd = tmpCwd(); writeFileSync(join(cwd, ".git/index"), "not a git index"); return cwd; } },
  ];
  for (const fixture of cases) {
    const cwd = fixture.setup();
    const pi = createMockPi(cwd);
    createGoalEngineExtension(pi);
    await assert.rejects(
      () => invoke(pi, "goal_init", { objective: `Unsafe ${fixture.name}`, tasks: [{ id: "t1", description: "task", writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }] }),
      (error) => error.code === fixture.expectedCode
        && /observed=.*remediation=.*stateChanged=false/.test(error.message),
      fixture.name,
    );
    assert.deepEqual(readGoalEvents(cwd, objectiveToGoalId(`Unsafe ${fixture.name}`)), [], `${fixture.name} must not append events`);
    assert.equal(existsSync(join(cwd, ".state/goal-engine/worktrees")), false, `${fixture.name} must not allocate worktrees`);
    if (fixture.name !== "tracked state entry") assert.equal(existsSync(join(cwd, ".state/goal-engine")), false, `${fixture.name} must leave no state`);
  }
});

test("goal_init rejects a nonexistent absolute cwd before creating state", async () => {
  const cwd = join(tmpdir(), `ge-missing-${crypto.randomUUID()}`);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await assert.rejects(
    () => invoke(pi, "goal_init", { objective: "Missing cwd", tasks: [{ id: "t1", description: "task", writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }] }),
    (error) => error.code === "GIT_INFRASTRUCTURE_ERROR"
      && /GIT_INFRASTRUCTURE_ERROR: observed=cwd realpath could not be read: .*; remediation=repair filesystem access and retry goal_init; stateChanged=false/.test(error.message),
  );
  assert.equal(existsSync(join(cwd, ".state/goal-engine")), false);
});

test("goal_status rejects a nonexistent absolute cwd with the stable filesystem contract", async () => {
  const cwd = join(tmpdir(), `ge-missing-status-${crypto.randomUUID()}`);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  await assert.rejects(
    () => invoke(pi, "goal_status", {}),
    (error) => error.code === "GIT_INFRASTRUCTURE_ERROR"
      && /observed=cwd realpath could not be read: .*stateChanged=false/.test(error.message),
  );
  assert.equal(existsSync(join(cwd, ".state", "goal-engine")), false);
});

test("goal_init metadata-derived dispatch gates reject atomically", async () => {
  const base = { id: "t1", description: "task", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["works"]), workflow: "existing-tests" };
  const cases = [
    ["objective fact", { objective: "o".repeat(4097), tasks: [base] }],
    ["scope joined fact", { objective: "scope gate", scope: ["s".repeat(4090)], tasks: [base] }],
    ["non-goals", { objective: "non-goals gate", non_goals: Array.from({ length: 33 }, (_, i) => `non-goal ${i}`), tasks: [base] }],
    ["DoD requirements", { objective: "dod gate", dod: ["goal proof"], tasks: [{ ...base, acceptance: plannedAcceptance(Array.from({ length: 32 }, (_, i) => `criterion ${i}`)) }] }],
    ["composite id", { objective: "g".repeat(80), tasks: [{ ...base, id: "t".repeat(80) }] }],
  ];
  for (const [name, params] of cases) {
    const cwd = tmpCwd();
    const pi = createMockPi(cwd);
    createGoalEngineExtension(pi);
    await assert.rejects(
      () => invoke(pi, "goal_init", params),
      (error) => error.code === "INVALID_GOAL_CONTRACT" && /observed=.*remediation=.*stateChanged=false/i.test(error.message),
      name,
    );
    assert.equal(existsSync(join(cwd, ".state/goal-engine/registry.json")), false, `${name} must not register a goal`);
    assert.equal(existsSync(join(cwd, ".state/goal-engine/worktrees")), false, `${name} must not allocate worktrees`);
    assert.deepEqual(readGoalEvents(cwd, objectiveToGoalId(params.objective)), [], `${name} must not append events`);
  }
});

test("goal_init wraps invalid task contracts before any persistent side effect", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await assert.rejects(
    () => invoke(pi, "goal_init", { objective: "Bad contract", tasks: [{ id: "t1", description: "task", writePaths: ["src/*"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }] }),
    (error) => error.code === "INVALID_TASK_CONTRACT" && /observed=.*unsupported.*remediation=.*stateChanged=false/i.test(error.message),
  );
  assert.equal(existsSync(join(cwd, ".state/goal-engine")), false);
});

test("goal_init rejects bounded task contracts and wrapper escapes before state", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  const base = { id: "t1", description: "task", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" };
  const invalid = [
    [{ ...base, description: "x".repeat(4097) }],
    [{ ...base, acceptance: { ...plannedAcceptance(["works"]), commands: ["sh -c 'cd /tmp'"] } }],
    Array.from({ length: 33 }, (_, i) => ({ ...base, id: `t${i}` })),
  ];
  for (const tasks of invalid) {
    await assert.rejects(() => invoke(pi, "goal_init", { objective: `bounded ${Math.random()}`, tasks }), (error) => error.code === "INVALID_TASK_CONTRACT" && /stateChanged=false/.test(error.message));
    assert.equal(existsSync(join(cwd, ".state/goal-engine")), false);
  }
});

test("goal_init preflights derived dispatch contracts before appending", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  const task = { id: "t1", description: "task", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(Array.from({ length: 32 }, (_, i) => `criterion ${i}`)), workflow: "tdd" };
  await assert.rejects(() => invoke(pi, "goal_init", { objective: "Derived contract failure", tasks: [task] }), (error) => error.code === "INVALID_GOAL_CONTRACT" && /observed=.*requirements.*remediation=.*stateChanged=false/i.test(error.message));
  assert.equal(existsSync(join(cwd, ".state/goal-engine")), false);
  await assert.rejects(() => invoke(pi, "goal_init", { objective: "!!!", tasks: [{ ...task, acceptance: plannedAcceptance(["works"]) }] }), (error) => error.code === "INVALID_GOAL_CONTRACT" && /observed=.*objective.*remediation=.*stateChanged=false/i.test(error.message));
});

test("goal_init active-goal error embeds actionable goal_status next action", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  const params = { objective: "Only active goal", tasks: [{ id: "t1", description: "task", writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }] };
  await invoke(pi, "goal_init", params);
  await assert.rejects(() => invoke(pi, "goal_init", { ...params, objective: "Another goal" }), (error) =>
    error.code === "ACTIVE_GOAL_EXISTS"
      && /observed=.*remediation=.*stateChanged=false/i.test(error.message)
      && /"requiredNextAction":\{"tool":"goal_status","params":\{"goal_id":"only-active-goal"\}\}/.test(error.message),
  );
});

test("goal_status returns full recovery context", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective: "Status recovery test goal",
    tasks: [{ id: "t1", description: "First task work", deps: [], writePaths: ["a.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }],
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
    tasks: [{ id: "t1", description: "Flow task for machine action assertions", deps: [], writePaths: ["src/machine.ts"], acceptance: plannedAcceptance(["flow"]), workflow: "tdd" }],
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
  assert.equal(snapshot.tasks.t1.workspace.state, "active");
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
  assert.equal(snapshot.tasks.t1.workspace.state, "active");
  assertTaskMachineAction(snapshot.tasks.t1, {
    allowedActions: ["goal_integrate"],
    requiredTool: "goal_integrate",
    requiredParams: { task_id: "t1", action: "integrate" },
    blockingReason: null,
  });

  const integrated = JSON.parse(await invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }));
  assert.equal(integrated.action, "integrated");

  snapshot = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(snapshot.tasks.t1.workspace.state, "released");
  assert.deepEqual(snapshot.tasks.t1.workspace.disposition, { action: "integrate", strategy: "cherry-pick" });
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

test("goal_dispatch records a workspace request without creating a worktree", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective: "Dispatch IR test goal",
    tasks: [{ id: "t1", description: "Implement the widget parser module", deps: [], writePaths: ["src/parser.ts"], acceptance: plannedAcceptance(["Parses valid input"]), workflow: "tdd" }],
  });

  const beforeWorktrees = git(cwd, "worktree", "list", "--porcelain");
  const beforeHead = git(cwd, "rev-parse", "HEAD");
  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const raw = await dispatch.execute("dispatch-without-spawn", { task_id: "t1" }, new AbortController().signal, undefined, pi.executeContext);
  const result = JSON.parse(raw.details.value);

  assert.equal(result.status, "dispatched");
  assert.ok(result.contract);
  assert.equal(result.contract.version, "dispatch-ir.v1");
  assert.equal(result.contract.agent, "executor");
  assert.ok(result.contract.hash);
  assert.deepEqual(result.contract.boundaries.writePaths, ["src/parser.ts"]);
  assert.equal(Object.hasOwn(result.contract.acceptance, "commands"), false);
  assert.deepEqual(result.contract.acceptance.criteria, [
    JSON.stringify({ id: "criterion-1", statement: "Parses valid input", evidenceKinds: ["tests"] }),
  ]);
  assert.equal(result.contract.execution.cwd, cwd);
  assert.equal(result.contract.execution.worktree, true);
  assert.equal(Object.hasOwn(result, "workspace"), false);
  assert.equal(git(cwd, "worktree", "list", "--porcelain"), beforeWorktrees);
  assert.equal(git(cwd, "rev-parse", "HEAD"), beforeHead);
  const projection = loadProjection(join(cwd, ".state/goal-engine"), objectiveToGoalId("Dispatch IR test goal"));
  assert.equal(projection.tasks.get("t1").status, "dispatch_requested");
  assert.equal(projection.tasks.get("t1").workspace, null);
  assert.ok(readGoalEvents(cwd, projection.goalId).some((event) => event.type === "task.dispatch_requested"));
});

test("goal_dispatch supports existing-tests tasks with a workflow reason", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  await invoke(pi, "goal_init", {
    objective: "Existing acceptance suite goal",
    tasks: [{ id: "verify", description: "Verify the implementation with the existing acceptance suite", deps: [], writePaths: ["src/verified.ts"], acceptance: plannedAcceptance(["Existing acceptance suite passes"]), workflow: "existing-tests" }],
  });

  const result = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "verify" }));

  assert.equal(result.status, "dispatched");
  assert.equal(result.contract.workflow.mode, "existing-tests");
  assert.ok(result.contract.workflow.reason);
  assert.match(result.contract.workflow.reason, /acceptance|existing test/i);
  assert.equal(result.contract.execution.cwd, cwd);
  assert.equal(result.contract.execution.worktree, true);
});

test("goal_dispatch supports docs-only tasks with a workflow reason", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective: "Independent documentation review goal",
    tasks: [{ id: "review", description: "Review implementation and write the acceptance report", deps: [], writePaths: ["reports/review.md"], acceptance: plannedAcceptance(["Report has verdict"]), workflow: "docs-only" }],
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
  await assert.rejects(() => invoke(pi, "goal_init", {
    objective: "Dispatch cleanup test goal",
    tasks: [{ id: "t1", description: "Compile an invalid path-boundary contract", deps: [], writePaths: ["../../etc/passwd"], acceptance: plannedAcceptance(["Compilation fails"]), workflow: "tdd" }],
  }), /repo-relative/);

  const worktreesRoot = join(cwd, ".state/goal-engine/worktrees");
  assert.equal(existsSync(join(worktreesRoot, "dispatch-cleanup-test-goal-t1-1")), false);
  assert.equal(existsSync(join(worktreesRoot, ".dispatch-cleanup-test-goal-t1-1.lease.json")), false);
  assert.equal(git("branch", "--list", "ge/dispatch-cleanup-test-goal/t1/1"), "");

  assert.equal(await invoke(pi, "goal_status", {}), "NO_ACTIVE_GOAL");
});

test("goal_dispatch durable-then-throw acknowledges committed dispatch and survives restart", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);
  const objective = "Dispatch durable acknowledgement restart";
  const goalId = objectiveToGoalId(objective);
  const injected = createDurableThenThrowAppendEvent("task.workspace_allocated");
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi, { appendEvent: injected.appendEvent });
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "durable dispatch", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }],
  });

  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const task = projection.tasks.get("t1");
  assert.equal(dispatched.status, "dispatched");
  assert.equal(task.status, "dispatched");
  assert.equal(task.attempts, 1);
  assert.equal(task.contractHash, dispatched.contract.hash);
  assert.deepEqual(task.workspace, dispatched.workspace);
  const dispatchedWorkspaceState = workspaceState(cwd, goalId, "t1");
  assert.equal(dispatchedWorkspaceState.workspacePath, dispatched.workspace.path);
  assert.equal(dispatchedWorkspaceState.branch, dispatched.workspace.branchRef);
  assert.equal(dispatchedWorkspaceState.state, "active");
  assert.equal(dispatchedWorkspaceState.workspaceExists, true);
  assert.equal(dispatchedWorkspaceState.recordExists, true);
  assert.equal(dispatchedWorkspaceState.branchExists, true);
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.workspace_allocated").length, 1);

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
  const injected = createFailingAppendEvent("task.dispatch_requested");
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi, { appendEvent: injected.appendEvent });
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "before durable", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }],
  });
  const before = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), /injected appendEvent failure/);
  const after = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(after.version, before.version);
  assert.equal(after.tasks.get("t1").status, "pending");
  assert.equal(after.tasks.get("t1").attempts, 0);
  assert.deepEqual(workspaceState(cwd, goalId, "t1"), {
    receipt: undefined, workspacePath: null, recordPath: null, branch: null, state: "absent", identity: null,
    workspaceExists: false, recordExists: false, branchExists: false,
  });
});

test("ambiguous dispatch recovery failure preserves resources and reports stable code", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);
  const objective = "Ambiguous dispatch recovery";
  const goalId = objectiveToGoalId(objective);
  const injected = createFailingAppendEvent("task.dispatch_requested");
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
    tasks: [{ id: "t1", description: "ambiguous", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }],
  });
  await assert.rejects(
    () => invoke(pi, "goal_dispatch", { task_id: "t1" }),
    (error) => error.code === "AMBIGUOUS_DISPATCH_COMMIT" && /goal .*task t1.*attempt 1/i.test(error.message),
  );
  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.receipt, undefined);
  assert.equal(state.workspaceExists, false);
  assert.equal(state.recordExists, false);
  assert.equal(state.branchExists, false);
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
      if (!conflicted && event.type === "task.dispatch_requested") {
        conflicted = true;
        appendEventStore(root, { ...event, data: { ...event.data, contractHash: "conflicting-contract-hash" } }, version);
        throw new Error("injected durable identity conflict");
      }
      return appendEventStore(root, event, version);
    },
  });
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "identity conflict", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }],
  });

  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), /workspace request contract or base commit is invalid/i);
  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.receipt, undefined);
  assert.equal(state.workspaceExists, false);
  assert.equal(state.recordExists, false);
  assert.equal(state.branchExists, false);
  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.tasks.get("t1").status, "pending");
});

test("ambiguous dispatch wrong goal recovery preserves resources", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);
  const objective = "Dispatch wrong goal recovery";
  const goalId = objectiveToGoalId(objective);
  const injected = createFailingAppendEvent("task.dispatch_requested");
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
    tasks: [{ id: "t1", description: "wrong goal", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }],
  });

  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), (error) => error.code === "AMBIGUOUS_DISPATCH_COMMIT");
  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.receipt, undefined);
  assert.equal(state.workspaceExists, false);
  assert.equal(state.recordExists, false);
  assert.equal(state.branchExists, false);
  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.tasks.get("t1").status, "pending");
  assert.equal(projection.tasks.get("t1").attempts, 0);
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.dispatch_requested").length, 0);
});

test("goal_integrate recovers a persisted workspace lease after extension restart", async () => {
  const cwd = tmpCwd();
  const git = initGitRepo(cwd);

  const firstPi = createMockPi(cwd);
  createGoalEngineExtension(firstPi);
  const init = firstPi.tools.find((t) => t.name === "goal_init");
  await invoke(firstPi, "goal_init", {
    objective: "Restart integration test goal",
    tasks: [{ id: "t1", description: "Create a persisted executor artifact", deps: [], writePaths: ["src/result.ts"], acceptance: plannedAcceptance(["result exists"]), workflow: "tdd" }],
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
  assert.equal(execFileSync("git", ["branch", "--list", dispatched.workspace.branchRef], { cwd, encoding: "utf8" }).trim(), "");
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
    tasks: [{ id: "t1", description: "The only task in this goal", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }],
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
    tasks: [{ id: "t1", description: "Work before settle", deps: [], writePaths: ["src/pre.ts"], acceptance: plannedAcceptance(["pre-settlement"]), workflow: "tdd" }],
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
  assert.equal(state.recordExists, true);
  assert.equal(state.branchExists, true);
  assert.equal(existsSync(join(cwd, "src/pre.ts")), false);
});

test("goal_settle rejects succeeded no-op workspace and failed settle still allows discard", async () => {
  const cwd = tmpCwd();
  const objective = "No-commit integrate test goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "No-op integrate failure path", deps: [], writePaths: ["src/noop.ts"], acceptance: plannedAcceptance(["noop"]), workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  await invoke(pi, "goal_dispatch", { task_id: "t1" });

  const before = persistedStateBytes(cwd, goalId);
  await assert.rejects(
    () => invoke(pi, "goal_settle", {
      task_id: "t1", outcome: "succeeded",
      evidence: { type: "diff", ref: "git diff HEAD --no-index" }, evidence_source: "self_produced",
      next_action: "No-op commit should still integrate cannot be accepted and must be discarded first",
    }),
    (error) => error.code === "EXECUTOR_COMMIT_REQUIRED" && /observed=.*remediation=.*stateChanged=false.*requiredNextAction/.test(error.message),
  );
  assert.deepEqual(persistedStateBytes(cwd, goalId), before);

  await invoke(pi, "goal_settle", {
    task_id: "t1", outcome: "failed",
    next_action: "Discard the no-op executor workspace and retry with a warranted implementation.",
  });
  const preDiscardState = workspaceState(cwd, goalId, "t1");
  assert.equal(preDiscardState.workspaceExists, true);
  assert.equal(preDiscardState.recordExists, true);

  const discard = JSON.parse(await invoke(pi, "goal_integrate", { task_id: "t1", action: "discard" }));
  assert.equal(discard.action, "discarded");
  assert.equal(discard.released, true);

  const postDiscardState = workspaceState(cwd, goalId, "t1");
  assert.equal(postDiscardState.workspaceExists, false);
  assert.equal(postDiscardState.recordExists, true);
  assert.equal(postDiscardState.branchExists, false);
  assert.equal(existsSync(join(cwd, "src/noop.ts")), false);
});

test("goal_settle classifies ancestor, empty, and missing persisted lease before appending", async () => {
  const cases = [
    { name: "ancestor", prepare(workspace) { git(workspace.path, "reset", "--hard", "HEAD~2"); }, code: "EXECUTOR_COMMIT_RANGE_INVALID" },
    { name: "empty", prepare(workspace) { git(workspace.path, "reset", "--hard", workspace.baseCommit); git(workspace.path, "commit", "--allow-empty", "-m", "test: empty"); }, code: "EXECUTOR_COMMIT_RANGE_EMPTY" },
    { name: "missing canonical record", prepare(workspace, state) { renameSync(state.recordPath, `${state.recordPath}.removed`); }, code: "EXECUTOR_WORKSPACE_MISSING" },
  ];
  for (const scenario of cases) {
    const cwd = tmpCwd();
    const objective = `Strict ${scenario.name} settle gate`;
    const goalId = objectiveToGoalId(objective);
    const pi = createMockPi(cwd);
    createGoalEngineExtension(pi);
    await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Write authorized source", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
    const workspace = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" })).workspace;
    commitWorkspaceChange(workspace, "src/x.ts", "export const x = true;\n", "feat: x");
    scenario.prepare(workspace, workspaceState(cwd, goalId, "t1"));
    const resources = workspaceState(cwd, goalId, "t1");
    const before = persistedStateBytes(cwd, goalId);
    await assert.rejects(
      () => invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Inspect the executor workspace and recover through the typed status action." }),
      (error) => { assertStructuredWorkspaceError(error, scenario.code, goalId); return true; },
    );
    assert.deepEqual(persistedStateBytes(cwd, goalId), before);
    assert.deepEqual(workspaceState(cwd, goalId, "t1"), resources);
  }
});

test("goal_settle classifies unrelated, wrong live branch, tampered lease, and physical workspace failures without side effects", async () => {
  const cases = [
    { name: "unrelated", code: "EXECUTOR_WORKSPACE_IDENTITY_MISMATCH", prepare(workspace) { git(workspace.path, "checkout", "--orphan", "impostor"); writeFileSync(join(workspace.path, "rogue.txt"), "x\n"); git(workspace.path, "add", "rogue.txt"); git(workspace.path, "commit", "-m", "test: unrelated"); const head = git(workspace.path, "rev-parse", "HEAD"); git(workspace.path, "branch", "-f", workspace.branchRef, head); git(workspace.path, "checkout", workspace.branchRef); } },
    { name: "wrong live branch", code: "EXECUTOR_WORKSPACE_IDENTITY_MISMATCH", prepare(workspace) { git(workspace.path, "checkout", "-b", "impostor-live-branch"); } },
    { name: "tampered lease", code: "EXECUTOR_WORKSPACE_IDENTITY_MISMATCH", prepare(workspace, state) { const lease = JSON.parse(readFileSync(state.recordPath, "utf8")); lease.branchRef = "refs/heads/pi-managed/tampered-branch-1"; writeFileSync(state.recordPath, `${JSON.stringify(lease)}\n`); } },
    { name: "physical workspace", code: "EXECUTOR_WORKSPACE_IDENTITY_MISMATCH", prepare(workspace) { rmSync(workspace.path, { recursive: true, force: true }); } },
  ];
  for (const scenario of cases) {
    const cwd = tmpCwd();
    const objective = `Settle ${scenario.name} error contract`;
    const goalId = objectiveToGoalId(objective);
    const pi = createMockPi(cwd);
    createGoalEngineExtension(pi);
    await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Write source", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
    const workspace = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" })).workspace;
    commitWorkspaceChange(workspace, "src/x.ts", "export const x = true;\n", "feat: x");
    scenario.prepare(workspace, workspaceState(cwd, goalId, "t1"));
    const before = rejectionSnapshot(cwd, goalId);
    await assert.rejects(() => invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Recover only through the typed goal status action before retrying." }), (error) => { assertStructuredWorkspaceError(error, scenario.code, goalId); return true; });
    assert.deepEqual(rejectionSnapshot(cwd, goalId), before);
  }
});

test("active discard and preserve classify live branch and missing lease without side effects", async () => {
  const cases = [
    { name: "live branch", code: "EXECUTOR_WORKSPACE_IDENTITY_MISMATCH", prepare(workspace) { git(workspace.path, "checkout", "-b", "impostor-disposition-branch"); } },
    { name: "canonical record", code: "EXECUTOR_WORKSPACE_MISSING", prepare(workspace, state) { renameSync(state.recordPath, `${state.recordPath}.removed`); } },
  ];
  for (const action of ["discard", "preserve"]) for (const scenario of cases) {
    const cwd = tmpCwd();
    const objective = `${action} ${scenario.name} mutation contract`;
    const goalId = objectiveToGoalId(objective);
    const pi = createMockPi(cwd);
    createGoalEngineExtension(pi);
    await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Disposition", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
    const workspace = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" })).workspace;
    await invoke(pi, "goal_settle", { task_id: "t1", outcome: "failed", next_action: "Dispose the executor workspace using the selected typed disposition action." });
    scenario.prepare(workspace, workspaceState(cwd, goalId, "t1"));
    const before = rejectionSnapshot(cwd, goalId);
    await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action }), (error) => { assertStructuredWorkspaceError(error, scenario.code, goalId); return true; });
    assert.deepEqual(rejectionSnapshot(cwd, goalId), before);
  }
});

test("goal_settle rejects dirty executor workspace without state changes", async () => {
  const cwd = tmpCwd();
  const objective = "Dirty settle gate test goal";
  const goalId = objectiveToGoalId(objective);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Write allowed source", deps: [], writePaths: ["src/allowed.ts"], acceptance: plannedAcceptance(["allowed"]), workflow: "tdd" }] });
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/allowed.ts", "export const allowed = true;\n", "feat: allowed");
  writeFileSync(join(dispatched.workspace.path, "src", "staged.ts"), "staged\n");
  git(dispatched.workspace.path, "add", "src/staged.ts");
  const before = persistedStateBytes(cwd, goalId);
  await assert.rejects(
    () => invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/allowed.ts" }, next_action: "Clean the executor workspace before retrying the successful settlement." }),
    (error) => error.code === "EXECUTOR_WORKSPACE_DIRTY" && /stateChanged=false.*requiredNextAction/.test(error.message),
  );
  assert.deepEqual(persistedStateBytes(cwd, goalId), before);
});

test("goal_settle persists settlement identity from the inspected executor HEAD", async () => {
  const cwd = tmpCwd();
  const objective = "Settlement identity persistence";
  const goalId = objectiveToGoalId(objective);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Write allowed source", deps: [], writePaths: ["src/allowed.ts"], acceptance: plannedAcceptance(["allowed"]), workflow: "tdd" }] });
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" })).workspace;
  commitWorkspaceChange(dispatched, "src/allowed.ts", "export const allowed = true;\n", "feat: allowed");
  const head = git(dispatched.path, "rev-parse", "HEAD");
  await invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/allowed.ts" }, next_action: "Integrate the inspected executor commit after verifying settlement identity." });
  const settled = readGoalEvents(cwd, goalId).find((event) => event.type === "task.settled");
  assert.deepEqual({ attempt: settled.data.attempt, executorHead: settled.data.executorHead }, { attempt: dispatched.owner.attempt, executorHead: head });
  const task = loadProjection(join(cwd, ".state/goal-engine"), goalId).tasks.get("t1");
  assert.equal(task.settlement.attempt, dispatched.owner.attempt);
  assert.equal(task.settlement.executorHead, head);
  assert.equal(task.settlement.executorRunId, task.executorBinding.runId);
  assert.equal(task.settlement.terminalProofId, task.lastExecutorProof.proofId);
  assert.ok(task.settlement.evidence);
});

test("goal_settle permits clean authorized commits with runtime-only artifacts", async () => {
  const cwd = tmpCwd();
  const objective = "Clean settle gate test goal";
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Write allowed source", deps: [], writePaths: ["src/allowed.ts"], acceptance: plannedAcceptance(["allowed"]), workflow: "tdd" }] });
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/allowed.ts", "export const allowed = true;\n", "feat: allowed");
  mkdirSync(join(dispatched.workspace.path, ".pi-subagents"), { recursive: true });
  writeFileSync(join(dispatched.workspace.path, ".pi-subagents", "runtime.log"), "runtime\n");
  const settled = JSON.parse(await invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/allowed.ts" }, next_action: "Integrate the clean authorized executor commit after confirming its evidence." }));
  assert.equal(settled.status, "succeeded");
});

test("goal_settle rejects changedFiles outside writePaths and keeps workspace for retry", async () => {
  const cwd = tmpCwd();
  const objective = "Write-path gate test goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Write forbidden file", deps: [], writePaths: ["src/allowed.ts"], acceptance: plannedAcceptance(["write gated"]), workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "outside/rogue.txt", "rogue\n", "feat: rogue change");

  const before = persistedStateBytes(cwd, goalId);
  await assert.rejects(
    () => invoke(pi, "goal_settle", {
      task_id: "t1", outcome: "succeeded",
      evidence: { type: "diff", ref: "git diff HEAD~1 -- outside/rogue.txt" }, evidence_source: "self_produced",
      next_action: "Integrate t1 and verify changedFiles are inside declared writePaths",
    }),
    (error) => error.code === "EXECUTOR_WRITE_PATH_VIOLATION" && /stateChanged=false.*requiredNextAction/.test(error.message),
  );
  assert.deepEqual(persistedStateBytes(cwd, goalId), before);

  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.recordExists, true);
  assert.equal(state.branchExists, true);
});

test("goal_settle rejects rename from forbidden source while preserving retry resources", async () => {
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
    tasks: [{ id: "t1", description: "Move protected source", deps: [], writePaths: ["allowed/**"], acceptance: plannedAcceptance(["source is gated"]), workflow: "tdd" }],
  });
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  mkdirSync(join(dispatched.workspace.path, "allowed"), { recursive: true });
  git(dispatched.workspace.path, "mv", "forbidden/secret.txt", "allowed/secret.txt");
  git(dispatched.workspace.path, "commit", "-m", "test: move protected source");
  await assert.rejects(
    () => invoke(pi, "goal_settle", {
      task_id: "t1", outcome: "succeeded",
      evidence: { type: "diff", ref: "git diff HEAD~1" }, evidence_source: "self_produced",
      next_action: "Attempt integration and verify the forbidden rename source is rejected.",
    }),
    (error) => error.code === "EXECUTOR_WRITE_PATH_VIOLATION",
  );
  assert.equal(git(cwd, "rev-parse", "HEAD"), originHeadBefore);
  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.branchExists, true);
  assert.equal(state.recordExists, true);
});

test("goal_integrate rejects rogue commit appended after started event (rogue)", async () => {
  const cwd = tmpCwd();
  const objective = "Started rogue recovery test goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  let dispatched;
  let intentDurable = false;
  let rogueHead;
  const pi = createMockPi(cwd);
  pi.workspaceService = createManagedWorkspaceService({ stateRoot: join(cwd, ".state/goal-engine"), fault(event) {
    if (event.operation === "dispose" && event.phase === "after-intent" && !rogueHead) {
      const intent = readGoalEvents(cwd, goalId).at(-1);
      assert.equal(intent.type, "task.managed_workspace_disposition_intent");
      intentDurable = true;
      commitWorkspaceChange(dispatched.workspace, "outside/rogue.txt", "export const rogue = true;\n", "feat: rogue change");
      rogueHead = git(dispatched.workspace.path, "rev-parse", "HEAD");
    }
  } });
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Write allowed source", deps: [], writePaths: ["src/allowed.ts"], acceptance: plannedAcceptance(["allowed write"]), workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
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

  const originHeadBefore = git(cwd, "rev-parse", "HEAD");
  await assert.rejects(
    () => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }),
    (error) => error.code === "GIT_INFRASTRUCTURE_ERROR" && /workspace is not a clean committed descendant/.test(error.message),
  );

  const afterProjection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(intentDurable, true, "rogue commit is appended only after the current managed disposition intent is durable");
  assert.equal(afterProjection.tasks.get("t1").managedDisposition.phase, "intent");
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.managed_workspace_disposition_intent").length, 1);
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.managed_workspace_disposition_receipt").length, 0, "the mismatch performs no duplicate service/Git completion");
  assert.equal(git(dispatched.workspace.path, "rev-parse", "HEAD"), rogueHead);
  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.recordExists, true);
  assert.equal(state.branchExists, true);
  assert.equal(git(cwd, "rev-parse", "HEAD"), originHeadBefore);
});


test("goal_integrate rejects dirty origin before persisting disposition_started", async () => {
  const cwd = tmpCwd();
  const objective = "Dirty origin preflight before disposition goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Write scoped source", deps: [], writePaths: ["src/preflight.ts"], acceptance: plannedAcceptance(["preflight"]), workflow: "tdd" }],
  });
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/preflight.ts", "export const preflight = true;\n", "feat: preflight write");
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/preflight.ts" },
    evidence_source: "self_produced",
    next_action: "Reject dirty origin before freezing a workspace disposition baseline",
  });

  writeFileSync(join(cwd, "unrelated-dirty.txt"), "dirty\n");
  const before = persistedStateBytes(cwd, goalId);
  await assert.rejects(
    () => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }),
    /origin must be clean/i,
  );

  assert.deepEqual(persistedStateBytes(cwd, goalId), before);
  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.tasks.get("t1").workspace.state, "active");
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.workspace_disposition_started").length, 0);
});

test("disposing integrate retry durably rebinds a clean forward origin before integration", async () => {
  const cwd = tmpCwd();
  const objective = "Forward origin disposition retry goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Write scoped source", deps: [], writePaths: ["src/retry.ts"], acceptance: plannedAcceptance(["retry"]), workflow: "tdd" }],
  });
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/retry.ts", "export const retry = true;\n", "feat: retry write");
  const executorHead = git(dispatched.workspace.path, "rev-parse", "HEAD");
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "succeeded",
    evidence: { type: "diff", ref: "git diff HEAD~1 -- src/retry.ts" },
    evidence_source: "self_produced",
    next_action: "Resume disposing integration after a clean unrelated origin commit",
  });

  const originHeadBefore = git(cwd, "rev-parse", "HEAD");

  writeFileSync(join(cwd, "unrelated.txt"), "unrelated\n");
  const dirtyPi = createMockPi(cwd);
  createGoalEngineExtension(dirtyPi);
  await assert.rejects(
    () => invoke(dirtyPi, "goal_integrate", { task_id: "t1", action: "integrate" }),
    /origin must be clean/i,
  );

  git(cwd, "add", "unrelated.txt");
  git(cwd, "commit", "-m", "chore: commit unrelated origin change");
  const forwardHead = git(cwd, "rev-parse", "HEAD");
  assert.notEqual(forwardHead, originHeadBefore);

  const retryPi = createMockPi(cwd);
  createGoalEngineExtension(retryPi);
  const result = JSON.parse(await invoke(retryPi, "goal_integrate", { task_id: "t1", action: "integrate" }));
  assert.equal(result.action, "integrated");
  assert.equal(result.released, true);
  assert.equal(readFileSync(join(cwd, "src/retry.ts"), "utf8"), "export const retry = true;\n");

  const events = readGoalEvents(cwd, goalId);
  assert.deepEqual(events.filter((event) => event.type.startsWith("task.managed_workspace_disposition_")).slice(-2).map((event) => event.type), ["task.managed_workspace_disposition_intent", "task.managed_workspace_disposition_receipt"]);

  const replayed = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(replayed.tasks.get("t1").workspace.state, "released");
  assert.equal(replayed.tasks.get("t1").workspace.state, "released");
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
    tasks: [{ id: "t1", description: "Write scoped source", deps: [], writePaths: ["src/identity.ts"], acceptance: plannedAcceptance(["identity check"]), workflow: "tdd" }],
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

  const recordPath = workspaceState(cwd, goalId, "t1").recordPath;
  const lease = JSON.parse(readFileSync(recordPath, "utf8"));
  const victimBranch = `refs/heads/pi-managed/${goalId}-victim-identity`;
  execFileSync("git", ["branch", victimBranch], { cwd });
  lease.branchRef = victimBranch;
  writeFileSync(recordPath, JSON.stringify(lease, null, 2) + "\n");

  const projectionBefore = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const originHeadBefore = git(cwd, "rev-parse", "HEAD");
  await assert.rejects(
    () => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }),
    /lease.*branch|branch.*snapshot|workspace.*identity/i,
  );

  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const task = projection.tasks.get("t1");
  assert.equal(task.workspace.state, projectionBefore.tasks.get("t1").workspace.state);
  assert.equal(task.workspace.branchRef, dispatched.workspace.branchRef);

  const currentLease = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.equal(currentLease.branchRef, victimBranch);

  assert.equal(existsSync(dispatched.workspace.path), true);
  assert.equal(existsSync(recordPath), true);
  assert.equal(git(cwd, "rev-parse", "HEAD"), originHeadBefore);
});

test("goal_integrate follows planned.v1 three-phase flow and accepts with workspaceAttempt", async () => {
  const cwd = tmpCwd();
  const objective = "Normal v2 integrate flow goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Commit with allowed path", deps: [], writePaths: ["src/integrate.ts"], acceptance: plannedAcceptance(["integrated"]), workflow: "tdd" }],
  });

  const dispatch = pi.tools.find((t) => t.name === "goal_dispatch");
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));

  const dispatchEvents = readGoalEvents(cwd, goalId);
  const dispatchEvent = dispatchEvents.find((event) => event.type === "task.workspace_allocated");
  const bindingEvent = dispatchEvents.at(-1);
  assert.equal(dispatchEvent.schemaVersion, "planned.v1");
  assert.equal(dispatchEvent.type, "task.workspace_allocated");
  assert.ok(dispatchEvent.data.workspace, "allocation event should include the canonical receipt");
  assert.equal(dispatchEvent.data.workspace.owner.attempt, 1);
  assert.equal(dispatchEvent.data.workspace.path, dispatched.workspace.path);
  assert.equal(dispatchEvent.data.workspace.branchRef, dispatched.workspace.branchRef);
  assert.equal(bindingEvent.schemaVersion, "planned.v1");
  assert.equal(bindingEvent.type, "task.executor_bound");
  assert.match(bindingEvent.data.runId, /^fixture-run-[a-f0-9]{24}$/);

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
  const dispositionEvents = events.filter((event) => ["task.managed_workspace_disposition_intent", "task.managed_workspace_disposition_receipt"].includes(event.type));
  const tail = dispositionEvents.slice(-2).map((event) => event.type);
  assert.deepEqual(tail, [
    "task.managed_workspace_disposition_intent",
    "task.managed_workspace_disposition_receipt",
  ]);

  const projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const task = projection.tasks.get("t1");
  assert.equal(task.workspace.state, "released");
  assert.deepEqual(task.workspace.disposition, { action: "integrate", strategy: "cherry-pick" });
  assert.equal(task.workspace.owner.attempt, 1);

  const status = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(status.tasks.t1.status, "succeeded");
  assert.equal(status.tasks.t1.workspace.state, "released");
  assert.deepEqual(status.tasks.t1.workspace.disposition, { action: "integrate", strategy: "cherry-pick" });

  const accept = pi.tools.find((t) => t.name === "goal_accept");
  const accepted = JSON.parse(await invoke(pi, "goal_accept", { task_id: "t1" }));
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.goal_complete, true);

  const acceptedEvents = readGoalEvents(cwd, goalId).filter((event) => event.type === "task.accepted");
  assert.equal(acceptedEvents.at(-1).schemaVersion, "planned.v1");
  assert.equal(acceptedEvents.at(-1).data.workspaceAttempt, 1);

  const projectionAfterAccept = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projectionAfterAccept.tasks.get("t1").workspace.state, "released");
  assert.deepEqual(projectionAfterAccept.tasks.get("t1").workspace.disposition, { action: "integrate", strategy: "cherry-pick" });
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
    tasks: [{ id: "t1", description: "Work that failed", deps: [], writePaths: ["src/fail.ts"], acceptance: plannedAcceptance(["fails"]), workflow: "tdd" }],
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
  assert.equal(retryDispatched.workspace.owner.attempt, 2);

  const status = pi.tools.find((t) => t.name === "goal_status");
  const projection = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.equal(projection.tasks.t1.attempts, 2);
  const state = workspaceState(cwd, goalId, "t1", 2);
  assert.equal(state.workspaceExists, true);
  assert.equal(state.branchExists, true);
});

test("preserve keeps workspace and rejects discard after a tampered lease", async () => {
  const cwd = tmpCwd();
  const objective = "Preserve gate test goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "Work to preserve", deps: [], writePaths: ["src/preserve.ts"], acceptance: plannedAcceptance(["preserved"]), workflow: "tdd" }],
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
  assert.equal(preserve.released, false);

  const state = workspaceState(cwd, goalId, "t1");
  assert.equal(state.workspaceExists, true);
  assert.equal(state.branchExists, true);

  const persistedLease = JSON.parse(readFileSync(state.recordPath, "utf8"));
  persistedLease.branchRef = `refs/heads/pi-managed/${goalId}-tampered-preserve`;
  writeFileSync(state.recordPath, JSON.stringify(persistedLease, null, 2) + "\n");
  await assert.rejects(
    () => invoke(pi, "goal_integrate", { task_id: "t1", action: "preserve" }),
    (error) => { assertStructuredWorkspaceError(error, "EXECUTOR_WORKSPACE_IDENTITY_MISMATCH", goalId); return true; },
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
      { id: "t1", description: "Base task", deps: [], writePaths: ["src/base.ts"], acceptance: plannedAcceptance(["base done"]), workflow: "tdd" },
      { id: "t2", description: "Dependent task", deps: ["t1"], writePaths: ["src/depend.ts"], acceptance: plannedAcceptance(["depend done"]), workflow: "tdd" },
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
  const fixture = await terminalReceiptGapFixture("discard", createFailingAppendEvent);
  const retry = createMockPi(fixture.cwd); createGoalEngineExtension(retry);
  assert.deepEqual(JSON.parse(await invoke(retry, "goal_integrate", { task_id: "t1", action: "discard" })), { action: "discarded", released: true });
  assert.equal(readGoalEvents(fixture.cwd, fixture.goalId).filter((event) => event.type === "task.managed_workspace_disposition_receipt").length, 1);
});

test("action recovery: disposed append can be repaired from projection snapshot without lease", async () => {
  const fixture = await terminalReceiptGapFixture("discard", createDurableThenThrowAppendEvent);
  const retry = createMockPi(fixture.cwd); createGoalEngineExtension(retry);
  assert.deepEqual(JSON.parse(await invoke(retry, "goal_integrate", { task_id: "t1", action: "discard" })), { action: "discarded", released: true });
  assert.equal(readGoalEvents(fixture.cwd, fixture.goalId).filter((event) => event.type === "task.managed_workspace_disposition_receipt").length, 1);
});

test("event failure: applied preserve retry rejects a different strategy", async () => {
  const fixture = await terminalReceiptGapFixture("preserve", createFailingAppendEvent);
  const retry = createMockPi(fixture.cwd); createGoalEngineExtension(retry);
  assert.deepEqual(JSON.parse(await invoke(retry, "goal_integrate", { task_id: "t1", action: "preserve" })), { action: "preserved", released: false });
  assert.deepEqual(loadProjection(join(fixture.cwd, ".state/goal-engine"), fixture.goalId).tasks.get("t1").workspace.disposition, { action: "preserve", reason: "Goal requested workspace preservation" });
});

test("event failure: disposed append durable-then-throw keeps disposed and rejects different strategy retry", async () => {
  const fixture = await terminalReceiptGapFixture("discard", createDurableThenThrowAppendEvent);
  assert.equal(readGoalEvents(fixture.cwd, fixture.goalId).filter((event) => event.type === "task.managed_workspace_disposition_receipt").length, 1);
});

test("goal_settle rejects vague next_action", async () => {
  const cwd = tmpCwd();
  initGitRepo(cwd);

  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);

  const init = pi.tools.find((t) => t.name === "goal_init");
  await invoke(pi, "goal_init", {
    objective: "Vague action test goal",
    tasks: [{ id: "t1", description: "work item", deps: [], writePaths: ["a.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }],
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
    tasks: [{ id: "t1", description: "work", deps: [], writePaths: ["a.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }],
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
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Protected active task", deps: [], writePaths: ["src/protected.ts"], acceptance: plannedAcceptance(["protected"]), workflow: "tdd" }] });
  bindGoalToMockSession(cwd, goalId);
  await invoke(pi, "goal_dispatch", { task_id: "t1" });
  const beforeEvents = readGoalEvents(cwd, goalId).length;
  await assert.rejects(() => invoke(pi, "goal_amend", { reason: "Do not delete a task that still owns active workspace resources", remove_tasks: ["t1"] }), /pending|workspace|remove/i);
  assert.equal(readGoalEvents(cwd, goalId).length, beforeEvents);
  assert.deepEqual(workspaceState(cwd, goalId, "t1"), {
    ...workspaceState(cwd, goalId, "t1"), workspaceExists: true, recordExists: true, branchExists: true,
  });
});

async function prepareSucceededTask(pi, goalId, taskId = "t1") {
  await invoke(pi, "goal_dispatch", { goal_id: goalId, task_id: taskId });
  commitWorkspaceChange(requireGoalWorkspaceReceipt(pi.executeContext.cwd, goalId, taskId), `src/${taskId}.ts`, `export const ${taskId} = true;\n`, `feat: ${taskId}`);
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
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "final task", deps: [], writePaths: ["src/t1.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  await prepareSucceededTask(pi, goalId);
  await invoke(pi, "goal_accept", { task_id: "t1" });
  let projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.lifecycle, "completed"); assert.equal(projection.tasks.get("t1").status, "accepted");
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
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "durable task", deps: [], writePaths: ["src/t1.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  await prepareSucceededTask(pi, goalId);
  assert.equal(JSON.parse(await invoke(pi, "goal_accept", { task_id: "t1" })).goal_complete, true);
  const events = readGoalEvents(cwd, goalId);
  assert.equal(events.filter((event) => event.type === "task.accepted").length, 1);
  assert.equal(events.filter((event) => event.type === "goal.completed").length, 1);
});

test("goal_accept goal.completed durable-then-throw returns completion retry exactly once", async () => {
  const cwd = tmpCwd(); const objective = "Completion durable retry"; const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd); const injected = createDurableThenThrowAppendEvent("goal.completed");
  const pi = createMockPi(cwd); createGoalEngineExtension(pi, { appendEvent: injected.appendEvent });
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "durable completion", deps: [], writePaths: ["src/t1.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  await prepareSucceededTask(pi, goalId);
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
    { id: "t1", description: "first durable task", deps: [], writePaths: ["src/t1.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" },
    { id: "t2", description: "remaining task", deps: [], writePaths: ["src/t2.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" },
  ] });
  await prepareSucceededTask(pi, goalId, "t1");
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
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "historical evidence", deps: [], writePaths: ["src/t1.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  await prepareSucceededTask(pi, goalId); await invoke(pi, "goal_accept", { task_id: "t1" });
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

test("goal_amend rejects commands on added and updated Planned tasks before append", async (t) => {
  const canonicalCwd = tmpCwd();
  const lexicalCwd = join(mkdtempSync(join(tmpdir(), "ge-amend-link-")), "repo");
  try { symlinkSync(canonicalCwd, lexicalCwd, "dir"); }
  catch (error) { t.skip(`symlink fixture unavailable: ${error.message}`); return; }
  const cwd = lexicalCwd;
  const physicalCwd = realpathSync(lexicalCwd);
  const objective = "Amend origin command validation";
  const goalId = objectiveToGoalId(objective);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "initial task", writePaths: ["src/t1.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }] });
  bindGoalToMockSession(cwd, goalId);
  const before = readGoalEvents(cwd, goalId).length;
  await assert.rejects(
    () => invoke(pi, "goal_amend", { reason: "Reject an added command that hardcodes the lexical symlink origin cwd", add_tasks: [{ id: "t2", description: "unsafe add", writePaths: ["src/t2.ts"], acceptance: { ...plannedAcceptance(["works"]), commands: [`node ${cwd}/scripts/test.mjs`] }, workflow: "tdd" }] }),
    (error) => error.code === "INVALID_GOAL_CONTRACT" && /commands|only criteria|additional property.*stateChanged=false/i.test(error.message),
  );
  await assert.rejects(
    () => invoke(pi, "goal_amend", { reason: "Reject an updated command that hardcodes the canonical physical origin cwd", update_tasks: { t1: { acceptance: { ...plannedAcceptance(["works"]), commands: [`node ${physicalCwd}/scripts/test.mjs`] } } } }),
    (error) => error.code === "INVALID_GOAL_CONTRACT" && /commands|only criteria|additional property.*stateChanged=false/i.test(error.message),
  );
  assert.equal(readGoalEvents(cwd, goalId).length, before);
});

test("goal_amend applies workflow only to safe pending tasks", async () => {
  const cwd = tmpCwd();
  const objective = "Amend pending task workflow";
  const goalId = objectiveToGoalId(objective);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "workflow task", deps: [], writePaths: ["src/t1.ts"], acceptance: plannedAcceptance(["works"]), workflow: "existing-tests" }] });
  bindGoalToMockSession(cwd, goalId);

  const amended = JSON.parse(await invoke(pi, "goal_amend", { reason: "Change the pending task to a test-first implementation workflow", update_tasks: { t1: { workflow: "tdd" } } }));
  assert.equal(amended.tasks.t1.workflow, "tdd");

  await invoke(pi, "goal_dispatch", { task_id: "t1" });
  const beforeEvents = readGoalEvents(cwd, goalId).length;
  await assert.rejects(
    () => invoke(pi, "goal_amend", { reason: "Do not alter workflow while an active workspace remains allocated", update_tasks: { t1: { workflow: "docs-only" } } }),
    (error) => error.code === "INVALID_GOAL_CONTRACT" && /stateChanged=false/.test(error.message),
  );
  assert.equal(readGoalEvents(cwd, goalId).length, beforeEvents);
});

test("goal_amend rejects accepted acceptance rewrite without appending an event", async () => {
  const cwd = tmpCwd();
  const objective = "Amend accepted proof protection goal";
  const goalId = objectiveToGoalId(objective);
  initGitRepo(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [
    { id: "t1", description: "Accepted protected task", deps: [], writePaths: ["src/accepted.ts"], acceptance: plannedAcceptance(["accepted"]), workflow: "tdd" },
    { id: "t2", description: "Keep goal active after t1 acceptance", deps: ["t1"], writePaths: ["src/pending.ts"], acceptance: plannedAcceptance(["pending"]), workflow: "tdd" },
  ] });
  bindGoalToMockSession(cwd, goalId);
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  commitWorkspaceChange(dispatched.workspace, "src/accepted.ts", "export const accepted = true;\n", "feat: accepted proof");
  await invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/accepted.ts" }, evidence_source: "self_produced", next_action: "Integrate this accepted proof task before recording its final acceptance" });
  await invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" });
  await invoke(pi, "goal_accept", { task_id: "t1" });
  const beforeEvents = readGoalEvents(cwd, goalId).length;
  await assert.rejects(() => invoke(pi, "goal_amend", { reason: "Do not rewrite acceptance proof after the task has been accepted", update_tasks: { t1: { acceptance: plannedAcceptance(["rewritten"]) } } }), /pending|accepted|update/i);
  assert.equal(readGoalEvents(cwd, goalId).length, beforeEvents);
});

test("settlement identity missing after a real legacy dispatch reaches the integrate gate with zero side effects", async () => {
  const cwd = tmpCwd();
  const objective = "Historical unbound succeeded with real executor identity";
  const goalId = objectiveToGoalId(objective);
  const created = {
    schemaVersion: "goal-engine.event.v2",
    eventId: "legacy-unbound-created",
    goalId,
    occurredAt: "2024-01-01T00:00:00.000Z",
    type: "goal.created",
    data: {
      objective,
      scope: [],
      nonGoals: [],
      dod: [],
      tasks: ["t1"],
      taskDefs: {
        t1: {
          description: "real executor",
          deps: [],
          writePaths: ["src/x.ts"],
          acceptance: { criteria: ["works"], commands: ["true"] },
          workflow: "tdd",
        },
      },
    },
  };
  writeGoalHistory(cwd, [created]);
  const pi = createMockPi(cwd); createGoalEngineExtension(pi);
  const before = fullRejectionSnapshot(cwd, goalId);
  const status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  assert.equal(status.tasks.t1.status, "pending");
  assert.deepEqual(fullRejectionSnapshot(cwd, goalId), before);
});

test("post-settle HEAD drift rejects every succeeded disposition before started event or Git side effect", async () => {
  for (const action of ["integrate", "discard", "preserve"]) {
    const cwd = tmpCwd();
    const objective = `Post-settle ${action} drift`;
    const goalId = objectiveToGoalId(objective);
    const pi = createMockPi(cwd); createGoalEngineExtension(pi);
    await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "drift", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
    const workspace = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" })).workspace;
    commitWorkspaceChange(workspace, "src/x.ts", "export const x = 1;\n", "feat: settled");
    await invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Use a typed disposition after inspecting the settled executor commit." });
    commitWorkspaceChange(workspace, "rogue.txt", "post-settle unauthorized commit\n", "test: post-settle rogue drift");
    const before = fullRejectionSnapshot(cwd, goalId);
    await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action }), (error) => {
      assert.equal(error.code, "EXECUTOR_SETTLEMENT_HEAD_MISMATCH");
      assert.match(error.message, /observed=.*remediation=.*stateChanged=false.*requiredNextAction/);
      assertDispatchRequiredNextAction(error, { tool: "goal_status", params: { goal_id: goalId } });
      return true;
    });
    assert.deepEqual(fullRejectionSnapshot(cwd, goalId), before);
    assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.workspace_disposition_started").length, 0);
  }
});

test("post-settle allow-empty HEAD drift rejects integrate before started event", async () => {
  const cwd = tmpCwd();
  const objective = "Post-settle allow-empty executor drift";
  const goalId = objectiveToGoalId(objective);
  const pi = createMockPi(cwd); createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "empty drift", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  const workspace = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" })).workspace;
  commitWorkspaceChange(workspace, "src/x.ts", "export const emptyDrift = true;\n", "feat: settle before empty drift");
  await invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Use a typed disposition after inspecting the settled executor commit." });
  git(workspace.path, "commit", "--allow-empty", "-m", "test: empty executor drift");
  const before = fullRejectionSnapshot(cwd, goalId);
  await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }), (error) => {
    assert.equal(error.code, "EXECUTOR_SETTLEMENT_HEAD_MISMATCH");
    assert.match(error.message, /observed=.*remediation=.*stateChanged=false.*requiredNextAction/);
    assertDispatchRequiredNextAction(error, { tool: "goal_status", params: { goal_id: goalId } });
    return true;
  });
  assert.deepEqual(fullRejectionSnapshot(cwd, goalId), before);
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.workspace_disposition_started").length, 0);
});

test("post-settle wrong live branch rejects identity mismatch before started event", async () => {
  const cwd = tmpCwd();
  const objective = "Post-settle wrong live branch";
  const goalId = objectiveToGoalId(objective);
  const pi = createMockPi(cwd); createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "branch identity", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  const workspace = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" })).workspace;
  commitWorkspaceChange(workspace, "src/x.ts", "export const branch = true;\n", "feat: branch identity");
  await invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Use the typed disposition after inspecting the settled executor commit." });
  git(workspace.path, "checkout", "-b", `wrong/${goalId}`);
  const before = fullRejectionSnapshot(cwd, goalId);
  await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action: "integrate" }), (error) => {
    assert.equal(error.code, "EXECUTOR_WORKSPACE_IDENTITY_MISMATCH");
    assert.match(error.message, /observed=.*remediation=.*stateChanged=false.*requiredNextAction/);
    assertDispatchRequiredNextAction(error, { tool: "goal_status", params: { goal_id: goalId } });
    return true;
  });
  assert.deepEqual(fullRejectionSnapshot(cwd, goalId), before);
  assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.workspace_disposition_started").length, 0);
});

test("inspection race: goal_settle rejects HEAD drift after the first real inspection without side effects", async () => {
  const cwd = tmpCwd();
  const objective = "Settlement inspection TOCTOU race";
  const goalId = objectiveToGoalId(objective);
  let rejectionSnapshot;
  let mutated = false;
  let workspace;
  const pi = createMockPi(cwd);
  pi.workspaceService = createManagedWorkspaceService({ stateRoot: join(cwd, ".state/goal-engine"), fault(event) {
    if (event.operation === "status" && event.phase === "after-inspection" && workspace && !mutated) {
      mutated = true;
      commitWorkspaceChange(workspace, "src/race-b.ts", "export const raceB = true;\n", "test: competing clean commit B");
      rejectionSnapshot = fullRejectionSnapshot(cwd, goalId);
    }
  } });
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "race", deps: [], writePaths: ["src/**"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  workspace = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" })).workspace;
  commitWorkspaceChange(workspace, "src/x.ts", "export const x = true;\n", "feat: clean commit A");

  await assert.rejects(() => invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Recover through the typed goal status action after the executor head changed." }), (error) => {
    assert.equal(error.code, "EXECUTOR_SETTLEMENT_HEAD_MISMATCH");
    assert.match(error.message, /observed=.*remediation=.*stateChanged=false.*requiredNextAction/);
    assert.match(error.message, /return to the same Executor worktree, verify the same Executor worktree HEAD and cleanliness, then retry goal_settle/);
    assert.doesNotMatch(error.message, /retry goal_integrate/);
    assertDispatchRequiredNextAction(error, { tool: "goal_status", params: { goal_id: goalId } });
    return true;
  });
  assert.ok(rejectionSnapshot, "the injected inspector must commit B after inspecting A");
  assert.deepEqual(fullRejectionSnapshot(cwd, goalId), rejectionSnapshot);
});

test("inspection race: succeeded dispositions reject HEAD drift before started event or side effects", async () => {
  for (const action of ["integrate", "discard", "preserve"]) {
    const cwd = tmpCwd();
    const objective = `Disposition inspection TOCTOU ${action}`;
    const goalId = objectiveToGoalId(objective);
    let armed = false;
    let mutated = false;
    let rejectionSnapshot;
    let workspace;
    const pi = createMockPi(cwd);
    pi.workspaceService = createManagedWorkspaceService({ stateRoot: join(cwd, ".state/goal-engine"), fault(event) {
      if (event.operation === "status" && event.phase === "after-inspection" && armed && workspace && !mutated) {
        mutated = true;
        commitWorkspaceChange(workspace, "src/race-b.ts", `export const ${action}RaceB = true;\n`, "test: competing clean commit B");
        rejectionSnapshot = fullRejectionSnapshot(cwd, goalId);
      }
    } });
    createGoalEngineExtension(pi);
    await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "race", deps: [], writePaths: ["src/**"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
    workspace = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" })).workspace;
    commitWorkspaceChange(workspace, "src/x.ts", "export const x = true;\n", "feat: clean commit A");
    await invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Use a typed disposition after inspecting the settled executor commit." });
    armed = true;

    await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action }), (error) => {
      assert.equal(error.code, "EXECUTOR_SETTLEMENT_HEAD_MISMATCH");
      assert.match(error.message, /observed=.*remediation=.*stateChanged=false.*requiredNextAction/);
      assertDispatchRequiredNextAction(error, { tool: "goal_status", params: { goal_id: goalId } });
      return true;
    });
    assert.ok(rejectionSnapshot, `${action} must inspect A before competing commit B`);
    assert.deepEqual(fullRejectionSnapshot(cwd, goalId), rejectionSnapshot);
    assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.workspace_disposition_started").length, 0);
    const state = workspaceState(cwd, goalId, "t1");
    assert.equal(state.workspaceExists, true);
    assert.equal(state.recordExists, true);
    assert.equal(state.branchExists, true);
  }
});

test("inspection-internal HEAD drift: goal_settle uses the canonical service barrier between inspections", async () => {
  const cwd = tmpCwd();
  const objective = "Settlement internal inspection drift";
  const goalId = objectiveToGoalId(objective);
  let rejectionSnapshot;
  let workspace;
  const pi = createMockPi(cwd);
  pi.workspaceService = createManagedWorkspaceService({ stateRoot: join(cwd, ".state/goal-engine"), fault(event) {
    if (event.operation === "status" && event.phase === "after-inspection" && workspace && !rejectionSnapshot) {
      commitWorkspaceChange(workspace, "src/race-b.ts", "export const settleRaceB = true;\n", "test: competing clean commit B");
      rejectionSnapshot = fullRejectionSnapshot(cwd, goalId);
    }
  } });
  createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "race", deps: [], writePaths: ["src/**"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  workspace = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" })).workspace;
  commitWorkspaceChange(workspace, "src/x.ts", "export const x = true;\n", "feat: clean commit A");
  await assert.rejects(() => invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Recover through typed status after verifying the executor workspace." }), (error) => {
    assert.equal(error.code, "EXECUTOR_SETTLEMENT_HEAD_MISMATCH");
    assert.match(error.message, /verify the same Executor worktree.*retry goal_settle/i);
    assert.match(error.message, /stateChanged=false/);
    assertDispatchRequiredNextAction(error, { tool: "goal_status", params: { goal_id: goalId } });
    return true;
  });
  assert.ok(rejectionSnapshot, "the canonical barrier commits only between the service's two inspections");
  assert.deepEqual(fullRejectionSnapshot(cwd, goalId), rejectionSnapshot);
});

test("inspection-internal HEAD drift: succeeded dispositions use the canonical service barrier", async () => {
  for (const action of ["integrate", "discard", "preserve"]) {
    const cwd = tmpCwd();
    const objective = `Disposition internal inspection drift ${action}`;
    const goalId = objectiveToGoalId(objective);
    let armed = false;
    let rejectionSnapshot;
    let workspace;
    const pi = createMockPi(cwd);
    pi.workspaceService = createManagedWorkspaceService({ stateRoot: join(cwd, ".state/goal-engine"), fault(event) {
      if (event.operation === "status" && event.phase === "after-inspection" && armed && workspace && !rejectionSnapshot) {
        commitWorkspaceChange(workspace, "src/race-b.ts", `export const ${action}RaceB = true;\n`, "test: competing clean commit B");
        rejectionSnapshot = fullRejectionSnapshot(cwd, goalId);
      }
    } });
    createGoalEngineExtension(pi);
    await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "race", deps: [], writePaths: ["src/**"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
    workspace = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" })).workspace;
    commitWorkspaceChange(workspace, "src/x.ts", "export const x = true;\n", "feat: clean commit A");
    await invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Use typed disposition after inspecting the settled executor commit." });
    armed = true;
    await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action }), (error) => {
      assert.equal(error.code, "EXECUTOR_SETTLEMENT_HEAD_MISMATCH");
      assert.match(error.message, /verify the settled attempt and commit identity.*retry goal_integrate/i);
      assert.match(error.message, /stateChanged=false/);
      assertDispatchRequiredNextAction(error, { tool: "goal_status", params: { goal_id: goalId } });
      return true;
    });
    assert.ok(rejectionSnapshot, `${action} commits through the canonical service barrier between inspections`);
    assert.deepEqual(fullRejectionSnapshot(cwd, goalId), rejectionSnapshot);
    assert.equal(readGoalEvents(cwd, goalId).filter((event) => event.type === "task.workspace_disposition_started").length, 0);
  }
});

test("semantic priority keeps task-state and reducer errors ahead of workspace-missing recovery", async () => {
  const cwd = tmpCwd();
  const root = join(cwd, ".state/goal-engine");
  const writeHistory = (goalId, events) => {
    mkdirSync(join(root, "goals", goalId), { recursive: true });
    writeFileSync(goalEventsPath(cwd, goalId), `${events.map(JSON.stringify).join("\n")}\n`);
    writeFileSync(join(root, "registry.json"), JSON.stringify({ schema_version: "goal-engine.registry.v1", active_goal_ids: [goalId], goals: { [goalId]: { lifecycle: "active", objective: events[0].data.objective, updatedAt: events.at(-1).occurredAt } } }));
  };
  const created = (goalId) => ({ schemaVersion: "goal-engine.event.v1", eventId: `${goalId}-created`, goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: goalId, scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["x"], commands: ["true"] }, workflow: "tdd" } } } });
  const pending = "semantic-priority-pending";
  writeHistory(pending, [created(pending)]);
  let pi = createMockPi(cwd); createGoalEngineExtension(pi);
  await assert.rejects(() => invoke(pi, "goal_settle", { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "Recover through the typed status action after dispatching." }), /task is not dispatched/i);
  const invalid = "semantic-priority-invalid";
  const dispatched = { schemaVersion: "goal-engine.event.v1", eventId: `${invalid}-dispatch`, goalId: invalid, occurredAt: "2024-01-01T00:00:01.000Z", type: "task.dispatched", data: { taskId: "t1", contractHash: "legacy" } };
  writeHistory(invalid, [created(invalid), dispatched]);
  pi = createMockPi(cwd); createGoalEngineExtension(pi);
  for (const params of [
    { task_id: "t1", outcome: "succeeded", evidence: { type: "file", path: "src/x.ts" }, next_action: "bad" },
    { task_id: "t1", outcome: "succeeded", next_action: "Recover through typed status after reviewing the semantic failure." },
  ]) {
    await assert.rejects(() => invoke(pi, "goal_settle", params), (error) => {
      assert.notEqual(error.code, "EXECUTOR_WORKSPACE_MISSING");
      assert.match(error.message, /nextAction|next_action|next action|evidence|semantic/i);
      return true;
    });
  }
});

// Fixture provenance: these cases never rewrite Goal events or projection.  The
// workspace service allocates durably, then the public coordinator's allocation
// receipt append fails before durable.  A fresh extension therefore discovers
// the exact service-owned resource debt as an orphan.
async function dispatchedRollbackFixture(label, { removeLease = false } = {}) {
  const cwd = tmpCwd();
  const objective = `Allocation receipt orphan ${label}`;
  const goalId = objectiveToGoalId(objective);
  const injected = createFailingAppendEvent("task.workspace_allocated");
  const allocating = createMockPi(cwd);
  createGoalEngineExtension(allocating, { appendEvent: injected.appendEvent });
  await invoke(allocating, "goal_init", { objective, tasks: [{ id: "t1", description: "Create a service-owned orphan", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  bindGoalToMockSession(cwd, goalId);
  await assert.rejects(() => invoke(allocating, "goal_dispatch", { task_id: "t1" }), /injected appendEvent failure for task\.workspace_allocated/);
  const workspace = loadExecutorWorkspaceLease({ goalId, taskId: "t1", attempt: 1, stateRoot: join(cwd, ".state/goal-engine") });
  assert.ok(workspace, "service allocation must remain durable after Goal append failure");
  if (removeLease) rmSync(workspaceState(cwd, goalId, "t1").recordPath);
  const restarted = createMockPi(cwd);
  createGoalEngineExtension(restarted);
  return { cwd, goalId, pi: restarted, workspace };
}

test("allocation append failure creates a canonical service orphan without Goal ledger rollback", async () => {
  const fixture = await dispatchedRollbackFixture("canonical status");
  const events = readGoalEvents(fixture.cwd, fixture.goalId);
  assert.deepEqual(events.map((event) => event.type), ["goal.created", "goal.session_bound", "task.dispatch_requested"]);
  const status = JSON.parse(await invoke(fixture.pi, "goal_status", {}));
  assert.equal(status.tasks.t1.blockingReason.code, "ORPHANED_EXECUTOR_WORKSPACE");
  assert.deepEqual(status.tasks.t1.allowedActions, ["goal_integrate"]);
  assert.deepEqual(status.tasks.t1.blockingReason.choices, [
    { tool: "goal_integrate", params: { task_id: "t1", action: "discard" } },
    { tool: "goal_integrate", params: { task_id: "t1", action: "preserve" } },
  ]);
  assert.deepEqual(workspaceState(fixture.cwd, fixture.goalId, "t1").receipt, fixture.workspace);
});

test("canonical orphan inventory drift changes only the service inventory dimension", async () => {
  const fixture = await dispatchedRollbackFixture("single inventory drift");
  const state = workspaceState(fixture.cwd, fixture.goalId, "t1");
  assert.ok(state.recordPath);
  rmSync(state.recordPath);
  const status = JSON.parse(await invoke(fixture.pi, "goal_status", {}));
  assert.equal(status.tasks.t1.blockingReason.code, "ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED");
  assert.deepEqual(status.tasks.t1.blockingReason.resources, { workspaceExists: true, branchExists: true, recordExists: false });
});

async function terminalReceiptGapFixture(action, factory) {
  const cwd = tmpCwd(); const objective = `Terminal receipt gap ${action} ${factory.name}`; const goalId = objectiveToGoalId(objective);
  const pi = createMockPi(cwd); createGoalEngineExtension(pi);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "Terminal receipt recovery", deps: [], writePaths: ["src/x.ts"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] });
  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1" }));
  if (action === "integrate") commitWorkspaceChange(dispatched.workspace, "src/x.ts", "export const receiptGap = true;\n", "test: terminal receipt gap");
  await invoke(pi, "goal_settle", { task_id: "t1", outcome: action === "integrate" ? "succeeded" : "failed", ...(action === "integrate" ? { evidence: { type: "diff", ref: "git diff HEAD~1 -- src/x.ts" }, evidence_source: "self_produced" } : {}), next_action: "Use the typed disposition recovery path." });
  const injected = factory("task.managed_workspace_disposition_receipt");
  const failing = createMockPi(cwd); createGoalEngineWithAppendInjection(failing, { appendEvent: injected.appendEvent });
  if (factory === createDurableThenThrowAppendEvent) {
    await invoke(failing, "goal_integrate", { task_id: "t1", action });
  } else {
    await assert.rejects(() => invoke(failing, "goal_integrate", { task_id: "t1", action }), /injected appendEvent failure/);
  }
  return { cwd, goalId, workspace: dispatched.workspace, injected };
}

test("terminal service receipt recovery appends exactly one missing Goal receipt without repeating discard", async () => {
  for (const factory of [createFailingAppendEvent, createDurableThenThrowAppendEvent]) {
    const fixture = await terminalReceiptGapFixture("discard", factory);
    const service = goalWorkspaceService({ stateRoot: join(fixture.cwd, ".state/goal-engine") });
    const terminal = service.status({ workspaceId: fixture.workspace.workspaceId }).receipt;
    assert.equal(terminal.state, "released");
    const before = readGoalEvents(fixture.cwd, fixture.goalId).filter((event) => event.type === "task.managed_workspace_disposition_receipt");
    assert.equal(before.length, factory === createDurableThenThrowAppendEvent ? 1 : 0);
    const retry = createMockPi(fixture.cwd); createGoalEngineExtension(retry);
    assert.deepEqual(JSON.parse(await invoke(retry, "goal_integrate", { task_id: "t1", action: "discard" })), { action: "discarded", released: true });
    const receipts = readGoalEvents(fixture.cwd, fixture.goalId).filter((event) => event.type === "task.managed_workspace_disposition_receipt");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].data.workspaceId, terminal.workspaceId);
    assert.equal(receipts[0].data.leaseId, terminal.leaseId);
    assert.equal(receipts[0].data.attempt, terminal.owner.attempt);
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    assert.equal(receipts[0].data.serviceReceiptHash, createHash("sha256").update(JSON.stringify(canonical(terminal))).digest("hex"));
  }
});

test("preserve terminal receipt recovery retains preserve semantics until explicit release and redispatch", async () => {
  const fixture = await terminalReceiptGapFixture("preserve", createFailingAppendEvent);
  const retry = createMockPi(fixture.cwd); createGoalEngineExtension(retry);
  assert.deepEqual(JSON.parse(await invoke(retry, "goal_integrate", { task_id: "t1", action: "preserve" })), { action: "preserved", released: false });
  let task = loadProjection(join(fixture.cwd, ".state/goal-engine"), fixture.goalId).tasks.get("t1");
  assert.deepEqual(task.workspace.disposition, { action: "preserve", reason: "Goal requested workspace preservation" });
  assert.equal(Object.hasOwn(task.workspace, "released"), false);
  assert.deepEqual(JSON.parse(await invoke(retry, "goal_integrate", { task_id: "t1", action: "discard" })), { action: "discarded", released: true });
  const redispatched = JSON.parse(await invoke(retry, "goal_dispatch", { task_id: "t1" }));
  assert.equal(redispatched.workspace.owner.attempt, 2);
});

test("invalid historical contract takes priority over an exact orphan on dispatch", async () => {
  const cwd = tmpCwd(); const goalId = "unsafe-contract-orphan-priority"; const root = join(cwd, ".state/goal-engine");
  const created = { schemaVersion: "goal-engine.event.v2", eventId: "unsafe-priority-create", goalId, occurredAt: "2024-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Unsafe contract orphan priority", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy", deps: [], writePaths: ["src/x.ts"], acceptance: { criteria: ["x"], commands: [`cd ${cwd} && true`] }, workflow: "tdd" } } } };
  mkdirSync(join(root, "goals", goalId), { recursive: true }); writeFileSync(goalEventsPath(cwd, goalId), `${JSON.stringify(created)}\n`);
  writeFileSync(join(root, "registry.json"), JSON.stringify({ schema_version: "goal-engine.registry.v1", active_goal_ids: [goalId], goals: { [goalId]: { lifecycle: "active", objective: created.data.objective, updatedAt: created.occurredAt } } }));
  allocateExecutorWorkspace({ goalId, taskId: "t1", attempt: 1, originRoot: cwd, stateRoot: root, baseCommit: git(cwd, "rev-parse", "HEAD") });
  const pi = createMockPi(cwd); createGoalEngineExtension(pi);
  const status = JSON.parse(await invoke(pi, "goal_status", {})); assert.equal(status.tasks.t1.blockingReason.code, "ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED");
  const before = fullRejectionSnapshot(cwd, goalId);
  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), (error) => { assert.equal(error.code, "INVALID_TASK_CONTRACT"); assertDispatchRequiredNextAction(error, { tool: "goal_status", params: { goal_id: goalId } }); return true; });
  assert.deepEqual(fullRejectionSnapshot(cwd, goalId), before);
});

async function emitHook(pi, name, event, ctx = pi.executeContext) {
  let result;
  for (const handler of pi.hooks[name] || []) {
    const next = await handler(event, ctx);
    if (next !== undefined) result = next;
  }
  return result;
}

async function seedCompletedWatchingGoal(cwd, goalId = "completed-watching") {
  initGitRepo(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  const initialized = JSON.parse(await invoke(pi, "goal_init", {
    objective: goalId.replaceAll("-", " "),
    tasks: [{ id: "t1", description: "original", deps: [], writePaths: ["src/t1.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }],
  }));
  bindGoalToMockSession(cwd, initialized.goalId);
  await prepareSucceededTask(pi, initialized.goalId);
  await invoke(pi, "goal_accept", { task_id: "t1" });
  return initialized.goalId;
}

test("production status issues one-shot action tokens and dispatch returns an exact subagent contract envelope", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtensionProduction(pi);
  const objective = "Enforce one shot dispatch action";
  const goalId = objectiveToGoalId(objective);
  await invoke(pi, "goal_init", { objective, tasks: [{ id: "t1", description: "implement", deps: [], writePaths: ["src/a.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }] });

  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), /action_token|status/i);
  const status = JSON.parse(await invoke(pi, "goal_status", {}));
  assert.match(status.action_token, /^goal-action\.v1:/);
  assert.deepEqual(status.machineAction, { tool: "goal_dispatch", params: { goal_id: goalId, task_id: "t1" } });
  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1", action_token: `${status.action_token}bad` }), /token/i);

  const dispatched = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "t1", action_token: status.action_token }));
  assert.equal(Object.hasOwn(dispatched.contract, "hash"), false);
  assert.match(dispatched.contract_hash, /^[a-f0-9]{64}$/);
  assert.equal(dispatched.contract.taskId, `${goalId}.t1`);
  assert.equal(loadProjection(join(cwd, ".state/goal-engine"), goalId).tasks.get("t1").contractHash, dispatched.contract_hash);
  assert.deepEqual(readGoalEvents(cwd, goalId).slice(-4).map((event) => event.type), [
    "goal.action_consumed", "task.dispatch_requested", "task.workspace_allocated", "task.executor_bound",
  ]);
  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1", action_token: status.action_token }), /consumed|status|offer/i);
});

test("production status dispatches every runnable task before offering settlement for an earlier dispatched task", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtensionProduction(pi);
  const objective = "Parallel runnable dispatch status";
  const goalId = objectiveToGoalId(objective);
  await invoke(pi, "goal_init", {
    objective,
    tasks: [
      { id: "t1", description: "first independent task", deps: [], writePaths: ["src/first.ts"], acceptance: plannedAcceptance(["first works"]), workflow: "tdd" },
      { id: "t2", description: "second independent task", deps: [], writePaths: ["src/second.ts"], acceptance: plannedAcceptance(["second works"]), workflow: "tdd" },
    ],
  });

  let status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  assert.deepEqual(status.machineAction, { tool: "goal_dispatch", params: { goal_id: goalId, task_id: "t1" } });
  await invoke(pi, "goal_dispatch", { task_id: "t1", action_token: status.action_token });

  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  assert.deepEqual(status.runnable, ["t2"]);
  assert.deepEqual(status.machineAction, { tool: "goal_dispatch", params: { goal_id: goalId, task_id: "t2" } });
  await invoke(pi, "goal_dispatch", { task_id: "t2", action_token: status.action_token });

  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  assert.deepEqual(status.runnable, []);
  assert.deepEqual(status.machineAction, { tool: "goal_settle", params: { goal_id: goalId, task_id: "t1" } });
});

test("production status offers a bound DAG amendment for a superseded dependency", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtensionProduction(pi);
  const objective = "Repair superseded dependency debt";
  const goalId = objectiveToGoalId(objective);
  const task = (id, deps = []) => ({ id, description: `implement ${id}`, deps, writePaths: [`src/${id}.ts`], acceptance: plannedAcceptance([`${id} works`]), workflow: "tdd" });
  await invoke(pi, "goal_init", { objective, tasks: [task("source"), task("dependent", ["source"])] });

  let status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  assert.deepEqual(status.machineAction, { tool: "goal_dispatch", params: { goal_id: goalId, task_id: "source" } }, "ordinary pending dependencies must not receive an amendment offer");
  await invoke(pi, "goal_dispatch", { task_id: "source", action_token: status.action_token });
  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  assert.deepEqual(status.machineAction, { tool: "goal_settle", params: { goal_id: goalId, task_id: "source" } }, "ordinary running dependencies must not receive an amendment offer");
  await invoke(pi, "goal_settle", {
    task_id: "source", outcome: "blocked", reason: "The source task needs an approved replacement", next_action: "Discard the clean workspace before explicitly superseding the blocked task", action_token: status.action_token,
  });
  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  await invoke(pi, "goal_integrate", { task_id: "source", action: "discard", action_token: status.action_token });
  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  assert.deepEqual(status.machineAction, { tool: "goal_amend", params: { goal_id: goalId, task_id: "source" } }, "a released blocked task must retain its bound amendment offer ahead of generic dispatch");
  await invoke(pi, "goal_amend", {
    goal_id: goalId, operation: "resolve_blocked", reason: "Explicitly replace the blocked source task", blocked_resolution: "supersede", blocked_task_id: "source", replacement_task_id: "replacement", add_tasks: [task("replacement")], action_token: status.action_token,
  });

  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  const replacementDispatch = JSON.parse(await invoke(pi, "goal_dispatch", { task_id: "replacement", action_token: status.action_token }));
  commitWorkspaceChange(replacementDispatch.workspace, "src/replacement.ts", "export const replacement = true;\n", "test: accept replacement task");
  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  await invoke(pi, "goal_settle", { task_id: "replacement", outcome: "succeeded", next_action: "Integrate the replacement task", action_token: status.action_token });
  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  await invoke(pi, "goal_integrate", { task_id: "replacement", action: "integrate", action_token: status.action_token });
  status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  await invoke(pi, "goal_accept", { task_id: "replacement", action_token: status.action_token });

  const offer = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  assert.deepEqual(offer.runnable, []);
  assert.deepEqual(offer.machineAction, { tool: "goal_amend", params: { goal_id: goalId, operation: "patch_active", task_id: "dependent" } });
  assert.match(offer.action_token, /^goal-action\.v1:/);
  for (const invalid of [
    { operation: "patch_active", update_tasks: { source: { deps: ["replacement"] } } },
    { operation: "patch_active", update_tasks: { dependent: { deps: ["replacement"], description: "unauthorized" } } },
    { operation: "patch_active", update_tasks: { dependent: { deps: ["replacement"] }, replacement: { deps: [] } } },
    { operation: "resolve_blocked", blocked_resolution: "retry", blocked_task_id: "dependent", update_tasks: { dependent: { deps: ["replacement"] } } },
  ]) {
    const before = persistedStateBytes(cwd, goalId);
    await assert.rejects(() => invoke(pi, "goal_amend", { goal_id: goalId, reason: "Attempt an unauthorized dependency amendment", action_token: offer.action_token, ...invalid }), /offer|task|deps|operation|amend/i);
    assert.deepEqual(persistedStateBytes(cwd, goalId), before);
  }

  const amendment = { goal_id: goalId, operation: "patch_active", reason: "Replace the superseded source dependency explicitly", update_tasks: { dependent: { deps: ["replacement"] } }, action_token: offer.action_token };
  const amended = JSON.parse(await invoke(pi, "goal_amend", amendment));
  assert.deepEqual(amended.tasks.dependent.deps, ["replacement"]);
  assert.deepEqual(amended.runnable, ["dependent"]);
  const beforeReplay = persistedStateBytes(cwd, goalId);
  await assert.rejects(() => invoke(pi, "goal_amend", amendment), /consumed|offer|status|token/i);
  assert.deepEqual(persistedStateBytes(cwd, goalId), beforeReplay);
});

test("production resolve_blocked consumes the task offer and atomically updates a retried contract", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtensionProduction(pi);
  const objective = "Recover blocked task contract";
  const goalId = objectiveToGoalId(objective);
  await invoke(pi, "goal_init", {
    objective,
    tasks: [{ id: "t1", description: "implement", deps: [], writePaths: ["src/a.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }],
  });

  let offer = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  await invoke(pi, "goal_dispatch", { task_id: "t1", action_token: offer.action_token });
  offer = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  await invoke(pi, "goal_settle", {
    task_id: "t1",
    outcome: "blocked",
    reason: "The task contract omitted its required bug document write path",
    next_action: "Discard the empty workspace and amend the blocked task contract before retrying",
    action_token: offer.action_token,
  });
  offer = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  await invoke(pi, "goal_integrate", { task_id: "t1", action: "discard", action_token: offer.action_token });
  offer = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  assert.equal(offer.tasks.t1.status, "blocked", "discarding a blocked managed workspace must retain explicit amendment authority");
  assert.equal(loadProjection(join(cwd, ".state/goal-engine"), goalId).tasks.get("t1").blockedReason, "The task contract omitted its required bug document write path");
  assert.deepEqual(offer.machineAction, { tool: "goal_amend", params: { goal_id: goalId, task_id: "t1" } });

  const amendment = {
    goal_id: goalId,
    operation: "resolve_blocked",
    reason: "Retry after adding the mandatory bug root-cause document to the task boundary",
    blocked_resolution: "retry",
    blocked_task_id: "t1",
    update_tasks: { t1: { writePaths: ["src/a.ts", "docs/bugs/bug-required.md"] } },
    action_token: offer.action_token,
  };
  const recovered = JSON.parse(await invoke(pi, "goal_amend", amendment));
  assert.equal(recovered.coordinationState, "ready");
  assert.equal(recovered.tasks.t1.status, "pending");
  assert.deepEqual(recovered.tasks.t1.writePaths, ["src/a.ts", "docs/bugs/bug-required.md"]);
  assert.deepEqual(readGoalEvents(cwd, goalId).slice(-3).map((event) => event.type), [
    "goal.action_consumed", "task.block_resolved", "goal.amended",
  ]);
  await assert.rejects(() => invoke(pi, "goal_amend", amendment), /consumed|offer|status|token/i);
});

test("legacy blocked supersede replacement inherits hidden commands through the criteria-only schema", async () => {
  const cwd = tmpCwd();
  const goalId = "legacy-supersede-hidden-commands";
  const root = join(cwd, ".state/goal-engine");
  const workspace = {
    attempt: 1,
    path: join(root, "worktrees", `${goalId}-t1-1`),
    branch: `ge/${goalId}/t1/1`,
    baseCommit: "a".repeat(40),
    originRef: "refs/heads/main",
  };
  const events = [
    { schemaVersion: "goal-engine.event.v3", eventId: "legacy-created", goalId, occurredAt: "2026-01-01T00:00:00.000Z", type: "goal.created", data: { objective: "Replace blocked legacy task", scope: [], nonGoals: [], dod: [], tasks: ["t1"], taskDefs: { t1: { description: "legacy blocked task", deps: [], writePaths: ["src/legacy.ts"], acceptance: { criteria: ["legacy behavior"], commands: ["node --test test/legacy.test.mjs"] }, workflow: "tdd" } } } },
    { schemaVersion: "goal-engine.event.v3", eventId: "legacy-dispatched", goalId, occurredAt: "2026-01-01T00:00:01.000Z", type: "task.dispatched", data: { taskId: "t1", contractHash: "b".repeat(64), workspace } },
    { schemaVersion: "goal-engine.event.v3", eventId: "legacy-blocked", goalId, occurredAt: "2026-01-01T00:00:02.000Z", type: "task.settled", data: { taskId: "t1", outcome: "blocked", reason: "The legacy task needs an approved replacement", nextAction: "Discard the released workspace before superseding", attempt: 1 } },
    { schemaVersion: "goal-engine.event.v3", eventId: "legacy-disposition-started", goalId, occurredAt: "2026-01-01T00:00:03.000Z", type: "task.workspace_disposition_started", data: { taskId: "t1", attempt: 1, requestedAction: "discard", strategy: "merge", executorHead: "c".repeat(40), originHeadBefore: "a".repeat(40), originRef: "refs/heads/main" } },
    { schemaVersion: "goal-engine.event.v3", eventId: "legacy-disposition-applied", goalId, occurredAt: "2026-01-01T00:00:04.000Z", type: "task.workspace_disposition_applied", data: { taskId: "t1", attempt: 1, action: "discard", strategy: "merge", executorHead: "c".repeat(40), originHead: "a".repeat(40) } },
    { schemaVersion: "goal-engine.event.v3", eventId: "legacy-disposed", goalId, occurredAt: "2026-01-01T00:00:05.000Z", type: "task.workspace_disposed", data: { taskId: "t1", attempt: 1, action: "discard", released: true } },
    { schemaVersion: "goal-engine.event.v3", eventId: "legacy-bound", goalId, occurredAt: "2026-01-01T00:00:06.000Z", type: "goal.session_bound", data: { sessionId: "session-test", leafId: "legacy-fixture" } },
  ];
  writeGoalHistory(cwd, events);
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi);
  const replacement = { id: "t2", description: "approved replacement", deps: [], writePaths: ["src/replacement.ts"], acceptance: plannedAcceptance("replacement criteria"), workflow: "tdd" };
  const prepare = pi.tools.find((tool) => tool.name === "goal_amend").prepareArguments;
  assert.throws(() => prepare({ operation: "resolve_blocked", reason: "x", action_token: "token", blocked_resolution: "supersede", blocked_task_id: "t1", replacement_task_id: "t2", add_tasks: [{ ...replacement, acceptance: { ...replacement.acceptance, commands: ["false"] } }] }), /additional property|schema/i);

  const amended = JSON.parse(await invoke(pi, "goal_amend", {
    goal_id: goalId, operation: "resolve_blocked", reason: "Human approved a criteria-only replacement", action_token: "unused", blocked_resolution: "supersede", blocked_task_id: "t1", replacement_task_id: "t2", add_tasks: [replacement],
  }));
  assert.equal(amended.tasks.t1.status, "superseded");
  assert.deepEqual(amended.tasks.t2.acceptance.criteria, replacement.acceptance.criteria.map((criterion) => JSON.stringify(criterion)));
  assert.deepEqual(amended.tasks.t2.acceptance.commands, ["node --test test/legacy.test.mjs"]);
  assert.deepEqual(readGoalEvents(cwd, goalId).at(-1).data.addTasks.t2.acceptance.commands, ["node --test test/legacy.test.mjs"]);
});

test("failed production mutation consumes its status token before business preflight", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtensionProduction(pi);
  await invoke(pi, "goal_init", { objective: "Consume failed mutation capability", tasks: [{ id: "t1", description: "implement", deps: [], writePaths: ["src/a.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }] });
  const status = JSON.parse(await invoke(pi, "goal_status", {}));

  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1", timeout_ms: -1, action_token: status.action_token }), /timeout|positive/i);
  const events = readGoalEvents(cwd, status.goalId);
  assert.equal(events.at(-1).type, "goal.action_consumed");
  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1", action_token: status.action_token }), /consumed|status|offer/i);
});

test("completed watching session records discovery blocks writes and atomically reopens with a new task", async () => {
  const cwd = tmpCwd();
  const goalId = await seedCompletedWatchingGoal(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtensionProduction(pi);
  pi.entries.push({ id: "entry-follow-up", type: "message", message: { role: "user" } });

  await emitHook(pi, "input", { text: "Add the related follow-up implementation", source: "interactive" });
  const injection = await emitHook(pi, "before_agent_start", { prompt: "Add the related follow-up implementation", systemPrompt: "base" });
  assert.match(injection.message.content, /goal_status|completed-watching/);
  let projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  const observation = Object.values(projection.continuity.observations)[0];
  assert.equal(observation.status, "untriaged");
  assert.equal(observation.userEntryId, "entry-follow-up");

  const blocked = await emitHook(pi, "tool_call", { toolName: "edit", input: { path: "src/b.ts" }, toolCallId: "edit-1" });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /goal_status.*goal_amend/);

  const status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  const amended = JSON.parse(await invoke(pi, "goal_amend", {
    goal_id: goalId,
    operation: "reopen_completed",
    reason: "Turn the related follow-up into an explicit second epoch task",
    basis: { epoch: 1, discovery_ids: [observation.id] },
    add_tasks: [{ id: "t2", description: "follow-up", deps: ["t1"], writePaths: ["src/b.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }],
    resolve_discoveries: [{ id: observation.id, disposition: "tasked", task_id: "t2", reason: "This follow-up belongs to the completed goal" }],
    action_token: status.action_token,
  }));
  assert.equal(amended.epoch, 2);
  assert.equal(amended.lifecycle, "active");
  assert.equal(amended.tasks.t1.status, "accepted");
  assert.equal(amended.tasks.t2.status, "pending");
  projection = loadProjection(join(cwd, ".state/goal-engine"), goalId);
  assert.equal(projection.completionHistory.length, 1);
  assert.equal(projection.continuity.observations[observation.id].taskId, "t2");
});

test("triage new_goal and detach_session resolve completed-watch debt without reopening", async () => {
  const cwd = tmpCwd();
  const goalId = await seedCompletedWatchingGoal(cwd);
  const pi = createMockPi(cwd);
  createGoalEngineExtensionProduction(pi);
  pi.entries.push({ id: "entry-unrelated", type: "message", message: { role: "user" } });
  await emitHook(pi, "input", { text: "Start a separate documentation project", source: "interactive" });
  await emitHook(pi, "before_agent_start", { prompt: "Start a separate documentation project", systemPrompt: "base" });
  const observation = Object.values(loadProjection(join(cwd, ".state/goal-engine"), goalId).continuity.observations)[0];
  const status = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  const triaged = JSON.parse(await invoke(pi, "goal_amend", {
    goal_id: goalId, operation: "triage", reason: "This request belongs to a separate new Goal instead",
    resolve_discoveries: [{ id: observation.id, disposition: "new_goal", reason: "User requested independent work" }],
    action_token: status.action_token,
  }));
  assert.equal(triaged.lifecycle, "completed");
  assert.equal(triaged.epoch, 1);
  assert.equal(triaged.continuity.observations[observation.id].status, "new_goal");
  assert.equal(await emitHook(pi, "tool_call", { toolName: "edit", input: { path: "docs/new-project.md" } }), undefined);

  const detachStatus = JSON.parse(await invoke(pi, "goal_status", { goal_id: goalId }));
  const detached = JSON.parse(await invoke(pi, "goal_amend", {
    goal_id: goalId, operation: "detach_session", reason: "Move this session to unrelated work after triage", action_token: detachStatus.action_token,
  }));
  assert.equal(detached.lifecycle, "completed");
  assert.equal(detached.epoch, 1);
  assert.equal(loadProjection(join(cwd, ".state/goal-engine"), goalId).sessionBindings[0].state, "detached");
});

test("compaction checkpoints survive extension reload and checkpoint failure cancels compaction", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtensionProduction(pi);
  await invoke(pi, "goal_init", { objective: "Persist compaction recovery context", tasks: [{ id: "t1", description: "implement", deps: [], writePaths: ["src/a.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }] });

  for (const [reason, files] of [
    ["overflow", ["src/a.ts", "src/b.ts"]],
    ["manual", ["src/c.ts"]],
  ]) {
    const before = await emitHook(pi, "session_before_compact", {
      reason, willRetry: true,
      preparation: { fileOps: { read: new Set(["docs/read-only.md"]), written: new Set(files), edited: new Set() } },
    });
    assert.equal(before, undefined);
    await emitHook(pi, "session_compact", { reason, willRetry: true });
  }
  const compacted = loadProjection(join(cwd, ".state/goal-engine"), objectiveToGoalId("Persist compaction recovery context"));
  assert.equal(compacted.continuity.lastCheckpoint.reason, "manual");
  assert.deepEqual(compacted.continuity.lastCheckpoint.modifiedFiles, ["src/c.ts"]);
  assert.deepEqual(pi.sentMessages.filter(({ options }) => options.deliverAs === "nextTurn"), []);

  const reloadedPi = createMockPi(cwd);
  createGoalEngineExtensionProduction(reloadedPi);
  await emitHook(reloadedPi, "session_start", { reason: "reload" });
  const recovery = await emitHook(reloadedPi, "before_agent_start", { prompt: "resume", systemPrompt: "base" });
  assert.match(recovery.message.content, /goal_status|overflow/);

  const failingPi = createMockPi(cwd);
  const failing = createFailingAppendEvent("goal.continuity_checkpointed");
  createGoalEngineExtensionProduction(failingPi, { appendEvent: failing.appendEvent.bind(failing) });
  const cancelled = await emitHook(failingPi, "session_before_compact", {
    reason: "manual", willRetry: false, preparation: { fileOps: { read: new Set(), written: new Set(["src/b.ts"]), edited: new Set() } },
  });
  assert.deepEqual(cancelled, { cancel: true });
  assert.equal(failingPi.entries.some((entry) => entry.customType === "goal-engine-recovery-latch"), true);
});

test("metadata terminal state restores ordinary machineAction after consumed and rejected decisions", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtensionProduction(pi);
  const initialized = JSON.parse(await invoke(pi, "goal_init", { objective: "Metadata terminal progress", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] }));
  const root = join(cwd, ".state/goal-engine");
  const initialProjection = loadProjection(root, initialized.goalId);
  appendEventStore(root, { schemaVersion: "planned.v1", eventId: "metadata-terminal-discovery", goalId: initialized.goalId, occurredAt: new Date().toISOString(), type: "goal.discovery_recorded", data: { id: "metadata-terminal-discovery", summary: "Terminal metadata must restore the ordinary action", paths: [], source: "user_intent", sessionId: "session-test" } }, initialProjection.version);
  const ordinary = JSON.parse(await invoke(pi, "goal_status", { goal_id: initialized.goalId }));
  assert.equal(ordinary.machineAction.tool, "goal_amend");
  const proposed = JSON.parse(await invoke(pi, "goal_amend", { goal_id: initialized.goalId, operation: "propose_update_goal", reason: "Show terminal audit does not block", changes: { objective: "Updated metadata" } }));
  await emitHook(pi, "input", { source: "interactive", text: "approve" });
  const approval = JSON.parse(await invoke(pi, "goal_status", { goal_id: initialized.goalId }));
  await invoke(pi, "goal_amend", { goal_id: initialized.goalId, operation: "update_goal", challenge_id: proposed.challenge_id, action_token: approval.action_token });
  const assertTerminalOffer = (status) => {
    const actionOffer = loadProjection(root, initialized.goalId).actionOffer;
    assert.ok(actionOffer);
    assert.equal(status.machineAction.tool, ordinary.machineAction.tool);
    assert.deepEqual(status.machineAction.params, ordinary.machineAction.params);
    assert.equal(status.machineAction.tool, actionOffer.tool);
    assert.deepEqual(status.machineAction.params, actionOffer.params);
    assert.equal(status.action_token, actionOffer.token);
  };
  const consumed = JSON.parse(await invoke(pi, "goal_status", { goal_id: initialized.goalId }));
  assert.equal(consumed.metadataDecision.status, "CONSUMED");
  assertTerminalOffer(consumed);

  const rejectedProposal = JSON.parse(await invoke(pi, "goal_amend", { goal_id: initialized.goalId, operation: "propose_update_goal", reason: "Reject without blocking dispatch", changes: { objective: "Rejected metadata" } }));
  await emitHook(pi, "input", { source: "interactive", text: "reject" });
  const rejected = JSON.parse(await invoke(pi, "goal_status", { goal_id: initialized.goalId }));
  assert.equal(rejected.metadataDecision.status, "REJECTED");
  assertTerminalOffer(rejected);
  await emitHook(pi, "input", { source: "interactive", text: "approve" });
  const afterApprove = JSON.parse(await invoke(pi, "goal_status", { goal_id: initialized.goalId }));
  assert.equal(afterApprove.metadataDecision.status, "REJECTED");
  assertTerminalOffer(afterApprove);
  assert.notEqual(afterApprove.machineAction?.params?.challenge_id, rejectedProposal.challenge_id);
});

test("metadata latch status appends cleared tombstone before every metadata response", async () => {
  const cwd = tmpCwd(); const pi = createMockPi(cwd); createGoalEngineExtensionProduction(pi);
  const initialized = JSON.parse(await invoke(pi, "goal_init", { objective: "Metadata latch", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] }));
  const proposal = JSON.parse(await invoke(pi, "goal_amend", { goal_id: initialized.goalId, operation: "propose_update_goal", reason: "Pending proposal", changes: { objective: "Changed" } }));
  const assertCleared = async (expected) => {
    pi.appendEntry("goal-engine-recovery-latch", { state: "active", goalId: initialized.goalId, reason: "injected" });
    await emitHook(pi, "session_start", { reason: "reload" });
    const status = JSON.parse(await invoke(pi, "goal_status", { goal_id: initialized.goalId }));
    assert.equal(status.metadataDecision.status, expected);
    assert.equal(pi.entries.at(-1).customType, "goal-engine-recovery-latch");
    assert.equal(pi.entries.at(-1).data.state, "cleared");
    return status;
  };
  await assertCleared("AWAITING_USER_DECISION");
  await emitHook(pi, "input", { source: "interactive", text: "approve" });
  const approved = await assertCleared("APPROVED");
  await invoke(pi, "goal_amend", { goal_id: initialized.goalId, operation: "update_goal", challenge_id: proposal.challenge_id, action_token: approved.action_token });
  await assertCleared("CONSUMED");
});

test("metadata persistence fails closed when appendEntry is absent", async () => {
  const cwd = tmpCwd(); const missing = createMockPi(cwd); delete missing.appendEntry; createGoalEngineExtensionProduction(missing);
  const initialized = JSON.parse(await invoke(missing, "goal_init", { objective: "Metadata persistence", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] }));
  await assert.rejects(() => invoke(missing, "goal_amend", { goal_id: initialized.goalId, operation: "propose_update_goal", reason: "must persist", changes: { objective: "Never pending" } }), /appendEntry|persist/i);
  const ordinary = JSON.parse(await invoke(missing, "goal_status", { goal_id: initialized.goalId }));
  assert.equal(ordinary.metadataDecision, undefined);
});

test("metadata persistence keeps reject terminal when tombstone append fails without raw input", async () => {
  const pi = createMockPi(tmpCwd()); const durableAppend = pi.appendEntry.bind(pi);
  pi.appendEntry = (type, data) => {
    if (type === "goal-engine-metadata-rejected") throw new Error("reject tombstone append failed");
    durableAppend(type, data);
  };
  createGoalEngineExtensionProduction(pi);
  const rejectedGoal = JSON.parse(await invoke(pi, "goal_init", { objective: "Metadata reject persistence", tasks: [{ id: "t1", description: "Task", writePaths: ["a"], acceptance: plannedAcceptance(["x"]), workflow: "tdd" }] }));
  await invoke(pi, "goal_amend", { goal_id: rejectedGoal.goalId, operation: "propose_update_goal", reason: "No raw user input", changes: { objective: "Never revive" } });
  await emitHook(pi, "input", { source: "interactive", text: "reject" });
  const terminal = JSON.parse(await invoke(pi, "goal_status", { goal_id: rejectedGoal.goalId }));
  assert.equal(terminal.metadataDecision.status, "REJECTED");
  assert.equal(terminal.machineAction.tool, "goal_dispatch");
  assert.ok(terminal.action_token);
  for (const entry of pi.entries.filter((entry) => entry.type === "custom" && entry.customType.startsWith("goal-engine-metadata-"))) {
    assert.equal(Object.hasOwn(entry.data, "text"), false);
    assert.equal(Object.hasOwn(entry.data, "inputText"), false);
    assert.equal(Object.hasOwn(entry.data, "rawInput"), false);
  }

  await emitHook(pi, "session_start", { reason: "reload" });
  const restored = JSON.parse(await invoke(pi, "goal_status", { goal_id: rejectedGoal.goalId }));
  assert.equal(restored.metadataDecision.status, "REJECTED");
  assert.equal(restored.machineAction.tool, "goal_dispatch");
  assert.ok(restored.action_token);
});

test("lifecycle ambiguity is durably fail-closed and compaction never clears its latch", async () => {
  const cwd = tmpCwd();
  const projections = ["a", "b"].map((goalId) => ({
    goalId, lifecycle: "active", epoch: 1, scope: [], tasks: new Map(),
    continuity: { observations: {} }, sessionBindings: [{ sessionId: "session-test", state: "watching" }], nextAction: "goal_status",
  }));
  const pi = createMockPi(cwd);
  createGoalEngineExtension(pi, {
    store: {
      listGoalIds: () => projections.map((projection) => projection.goalId),
      loadProjection: (_root, goalId) => projections.find((projection) => projection.goalId === goalId),
    },
  });

  const recovery = await emitHook(pi, "before_agent_start", { prompt: "resume", systemPrompt: "base" });
  assert.match(recovery.message.content, /ambiguous/i);
  assert.equal(pi.entries.at(-1).data.state, "active");

  const blocked = await emitHook(pi, "tool_call", { toolName: "edit", input: { path: "src/a.ts" } });
  assert.deepEqual(blocked, { block: true, reason: "Goal candidates are ambiguous; call goal_status with an explicit goal_id before mutation" });
  assert.equal(pi.entries.at(-1).data.state, "active");

  const cancelled = await emitHook(pi, "session_before_compact", { reason: "manual", preparation: { fileOps: { written: new Set(), edited: new Set() } } });
  assert.deepEqual(cancelled, { cancel: true });
  assert.equal(pi.entries.at(-1).data.state, "active");
});

test("orphan human challenge production authorization is sanitized and idempotent", async () => {
  const fixture = await dispatchedRollbackFixture("human challenge authorization");
  const pi = createMockPi(fixture.cwd); createGoalEngineExtensionProduction(pi);
  const first = JSON.parse(await invoke(pi, "goal_status", { goal_id: fixture.goalId }));
  assert.deepEqual(first.orphanDecision, { status: "AWAITING_USER_DECISION", goalId: fixture.goalId, taskId: "t1", attempt: 1, challenge_id: first.orphanDecision.challenge_id, inventory: first.orphanDecision.inventory, inventory_hash: first.orphanDecision.inventory_hash, choices: ["discard", "preserve"] });
  assert.match(first.orphanDecision.inventory_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(first.orphanDecision.inventory).sort(), ["baseCommit", "branch", "executorHead", "originRef", "resources"]);
  for (const forbidden of ["ownerToken", "recordPath", "originRoot", "stateRoot", "path", "command", "toolOutput"]) assert.equal(JSON.stringify(first.orphanDecision.inventory).includes(forbidden), false);
  const challenges = pi.entries.filter((entry) => entry.customType === "goal-engine-orphan-disposition-challenge"); assert.equal(challenges.length, 1);
  const second = JSON.parse(await invoke(pi, "goal_status", { goal_id: fixture.goalId }));
  assert.equal(second.orphanDecision.challenge_id, first.orphanDecision.challenge_id); assert.equal(pi.entries.filter((entry) => entry.customType === "goal-engine-orphan-disposition-challenge").length, challenges.length);
  const proposal = JSON.parse(await invoke(pi, "goal_amend", { goal_id: fixture.goalId, operation: "propose_update_goal", reason: "Metadata alongside orphan", changes: { objective: "Metadata approved first" } }));
  await emitHook(pi, "input", { source: "interactive", text: "approve" });
  const metadataOnly = JSON.parse(await invoke(pi, "goal_status", { goal_id: fixture.goalId }));
  assert.equal(metadataOnly.metadataDecision.status, "APPROVED");
  assert.equal(metadataOnly.orphanDecision.status, "AWAITING_USER_DECISION");
  const before = fullRejectionSnapshot(fixture.cwd, fixture.goalId);
  await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action: "discard", challenge_id: first.orphanDecision.challenge_id, action_token: "fake-token" }), /decision|authorization|token|offer/i);
  assert.deepEqual(fullRejectionSnapshot(fixture.cwd, fixture.goalId), before);
  await emitHook(pi, "input", { source: "extension", text: "discard" }); await emitHook(pi, "input", { source: "interactive", text: "discard later" });
  assert.equal(JSON.parse(await invoke(pi, "goal_status", { goal_id: fixture.goalId })).orphanDecision.status, "AWAITING_USER_DECISION");
  await emitHook(pi, "input", { source: "interactive", text: "discard" });
  const composed = JSON.parse(await invoke(pi, "goal_status", { goal_id: fixture.goalId }));
  assert.equal(composed.metadataDecision.status, "APPROVED");
  assert.equal(composed.orphanDecision.status, "DECIDED");
  assert.deepEqual(composed.machineAction, { tool: "goal_amend", params: { goal_id: fixture.goalId, operation: "update_goal", challenge_id: proposal.challenge_id } });
  const composedOffer = loadProjection(join(fixture.cwd, ".state/goal-engine"), fixture.goalId).actionOffer;
  assert.deepEqual({ tool: composedOffer.tool, params: composedOffer.params }, composed.machineAction);
  await invoke(pi, "goal_amend", { ...composed.machineAction.params, action_token: composed.action_token });
  const offer = JSON.parse(await invoke(pi, "goal_status", { goal_id: fixture.goalId }));
  assert.deepEqual(offer.machineAction, { tool: "goal_integrate", params: { goal_id: fixture.goalId, task_id: "t1", action: "discard" } });
  const actionOffer = loadProjection(join(fixture.cwd, ".state/goal-engine"), fixture.goalId).actionOffer;
  assert.equal(actionOffer.tool, offer.machineAction.tool);
  assert.deepEqual(actionOffer.params, offer.machineAction.params);
  const wrongBefore = fullRejectionSnapshot(fixture.cwd, fixture.goalId);
  await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action: "preserve", challenge_id: first.orphanDecision.challenge_id, action_token: offer.action_token }), /action|token|offer/i);
  assert.deepEqual(fullRejectionSnapshot(fixture.cwd, fixture.goalId), wrongBefore);
  await invoke(pi, "goal_integrate", { ...offer.machineAction.params, action_token: offer.action_token });
  const consumed = pi.entries.find((entry) => entry.customType === "goal-engine-orphan-disposition-consumed"); assert.ok(consumed);
  assert.deepEqual(Object.keys(consumed.data).sort(), ["action", "challenge_id", "receipt_id"]);
  await assert.rejects(() => invoke(pi, "goal_integrate", { ...offer.machineAction.params, action_token: offer.action_token }), /consumed|token|offer/i);
});

test("orphan cross-session production decision and action token authorization are isolated", async () => {
  const fixture = await dispatchedRollbackFixture("cross-session authorization"); const pi = createMockPi(fixture.cwd); createGoalEngineExtensionProduction(pi);
  const sessionA = JSON.parse(await invoke(pi, "goal_status", { goal_id: fixture.goalId }));
  await emitHook(pi, "input", { source: "rpc", text: "preserve" }); const offerA = JSON.parse(await invoke(pi, "goal_status", { goal_id: fixture.goalId }));
  pi.sessionManager.getSessionId = () => "session-other";
  assert.equal(await invoke(pi, "goal_status", { goal_id: fixture.goalId }), "NO_ACTIVE_GOAL");
  const before = fullRejectionSnapshot(fixture.cwd, fixture.goalId);
  await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action: "preserve", challenge_id: sessionA.orphanDecision.challenge_id, action_token: offerA.action_token }), /No active goal|session|challenge|token|offer/i);
  assert.deepEqual(fullRejectionSnapshot(fixture.cwd, fixture.goalId), before);
});

test("orphan challenge authorization fails closed for unverified and stale inventory", async () => {
  const unverified = await dispatchedRollbackFixture("challenge unverified", { removeLease: true }); const unverifiedPi = createMockPi(unverified.cwd); createGoalEngineExtensionProduction(unverifiedPi);
  const status = JSON.parse(await invoke(unverifiedPi, "goal_status", { goal_id: unverified.goalId }));
  assert.equal(status.orphanDecision.status, "REINSPECTION_REQUIRED");
  assert.equal(status.action_token, null);
  assert.equal(Object.hasOwn(status.orphanDecision, "choices"), false);
  assert.equal(unverifiedPi.entries.some((entry) => entry.customType === "goal-engine-orphan-disposition-challenge"), false);

  const stale = await dispatchedRollbackFixture("challenge stale inventory"); const stalePi = createMockPi(stale.cwd); createGoalEngineExtensionProduction(stalePi);
  const offered = JSON.parse(await invoke(stalePi, "goal_status", { goal_id: stale.goalId }));
  const staleLeasePath = workspaceState(stale.cwd, stale.goalId, "t1").recordPath;
  const originalLease = JSON.parse(readFileSync(staleLeasePath, "utf8"));
  const writeOwnerToken = (ownerToken) => writeFileSync(staleLeasePath, `${JSON.stringify({ ...originalLease, ownerToken })}\n`);
  writeOwnerToken("second-lease-identity");
  await emitHook(stalePi, "input", { source: "interactive", text: "preserve" });
  const reinspected = JSON.parse(await invoke(stalePi, "goal_status", { goal_id: stale.goalId }));
  // A changed service owner is a single inventory identity dimension.  It is
  // deliberately not a replacement challenge: canonical recovery fails closed
  // until the original service receipt is restored.
  assert.equal(reinspected.orphanDecision.status, "REINSPECTION_REQUIRED");
  assert.equal(reinspected.action_token, null);
  writeFileSync(staleLeasePath, `${JSON.stringify(originalLease)}\n`);
  const restored = JSON.parse(await invoke(stalePi, "goal_status", { goal_id: stale.goalId }));
  assert.equal(restored.orphanDecision.status, "DECIDED");
  assert.equal(restored.orphanDecision.challenge_id, offered.orphanDecision.challenge_id);
  assert.equal(restored.orphanDecision.inventory_hash, offered.orphanDecision.inventory_hash);
  assert.match(restored.action_token, /^goal-action\.v1:/);
});

test("orphan decision survives a failed production disposition and re-signs its token", async () => {
  const fixture = await dispatchedRollbackFixture("decision retry"); const pi = createMockPi(fixture.cwd); createGoalEngineExtensionProduction(pi);
  const challenge = JSON.parse(await invoke(pi, "goal_status", { goal_id: fixture.goalId }));
  await emitHook(pi, "input", { source: "interactive", text: "preserve" }); const offer = JSON.parse(await invoke(pi, "goal_status", { goal_id: fixture.goalId }));
  const originRef = git(fixture.cwd, "symbolic-ref", "--quiet", "HEAD");
  try {
    git(fixture.cwd, "checkout", "-b", "orphan-retry-wrong-origin");
    await assert.rejects(() => invoke(pi, "goal_integrate", { task_id: "t1", action: "preserve", challenge_id: challenge.orphanDecision.challenge_id, action_token: offer.action_token }), /origin|ref|mismatch|failed/i);
  } finally { git(fixture.cwd, "checkout", originRef.replace("refs/heads/", "")); }
  const retried = JSON.parse(await invoke(pi, "goal_status", { goal_id: fixture.goalId }));
  assert.equal(retried.orphanDecision.challenge_id, challenge.orphanDecision.challenge_id);
  assert.equal(retried.orphanDecision.status, "DECIDED"); assert.notEqual(retried.action_token, offer.action_token);
});

test("production status throws replay failures and repeated completed slugs receive unique suffixes", async () => {
  const cwd = tmpCwd();
  const existingGoalId = await seedCompletedWatchingGoal(cwd, "repeat-objective");
  assert.equal(existingGoalId, "repeat-objective");
  const pi = createMockPi(cwd);
  createGoalEngineExtensionProduction(pi);
  const created = JSON.parse(await invoke(pi, "goal_init", {
    objective: "Repeat objective",
    tasks: [{ id: "t1", description: "new work", deps: [], writePaths: ["src/new.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }],
  }));
  assert.match(created.goalId, /^repeat-objective-[a-f0-9]{8}$/);

  const brokenPi = createMockPi(cwd);
  createGoalEngineExtensionProduction(brokenPi, { store: { listGoals: () => [created.goalId], loadProjection: () => { throw new Error("replay failed"); } } });
  await assert.rejects(() => invoke(brokenPi, "goal_status", {}), /replay failed/);
});

test("detached active session cannot reacquire a runnable offer while another session can", async () => {
  const cwd = tmpCwd();
  const pi = createMockPi(cwd);
  createGoalEngineExtensionProduction(pi);
  const initialized = JSON.parse(await invoke(pi, "goal_init", {
    objective: "Detach runnable offer", tasks: [{ id: "t1", description: "implement", deps: [], writePaths: ["src/a.ts"], acceptance: plannedAcceptance(["works"]), workflow: "tdd" }],
  }));
  const status = JSON.parse(await invoke(pi, "goal_status", { goal_id: initialized.goalId }));
  assert.deepEqual(status.machineAction, { tool: "goal_dispatch", params: { goal_id: initialized.goalId, task_id: "t1" } });
  const rejectionBefore = () => ({ persistent: fullRejectionSnapshot(cwd, initialized.goalId), entries: structuredClone(pi.entries) });

  for (const params of [
    { session_id: "session-other", action_token: status.action_token },
    { action_token: "wrong-token" },
  ]) {
    const before = rejectionBefore();
    await assert.rejects(() => invoke(pi, "goal_amend", {
      goal_id: initialized.goalId, operation: "detach_session", reason: "Only the current session may detach", ...params,
    }), /detach_session|token|offer/i);
    assert.deepEqual(rejectionBefore(), before);
  }
  const refreshed = JSON.parse(await invoke(pi, "goal_status", { goal_id: initialized.goalId }));
  const staleBefore = rejectionBefore();
  await assert.rejects(() => invoke(pi, "goal_amend", {
    goal_id: initialized.goalId, operation: "detach_session", reason: "A replaced token is stale", action_token: status.action_token,
  }), /consumed|token|offer/i);
  assert.deepEqual(rejectionBefore(), staleBefore);

  const beforeEvents = readGoalEvents(cwd, initialized.goalId).length;
  const detached = JSON.parse(await invoke(pi, "goal_amend", {
    goal_id: initialized.goalId, operation: "detach_session", reason: "Leave runnable work for another session", action_token: refreshed.action_token,
  }));
  assert.equal(detached.lifecycle, "active");
  const events = readGoalEvents(cwd, initialized.goalId);
  assert.equal(events.length, beforeEvents + 2);
  assert.deepEqual(events.slice(-2).map((event) => event.type), ["goal.action_consumed", "goal.session_detached"]);
  assert.equal(loadProjection(join(cwd, ".state/goal-engine"), initialized.goalId).sessionBindings[0].state, "detached");
  assert.equal(existsSync(join(cwd, ".state/goal-engine/worktrees", `${initialized.goalId}-t1-1`)), false);

  const detachedBefore = rejectionBefore();
  for (const params of [{}, { goal_id: initialized.goalId }]) {
    const detachedStatus = JSON.parse(await invoke(pi, "goal_status", params));
    assert.equal(detachedStatus.machineAction, null);
    assert.equal(detachedStatus.action_token, null);
    assert.deepEqual(rejectionBefore(), detachedBefore);
  }
  await assert.rejects(() => invoke(pi, "goal_dispatch", { task_id: "t1" }), /action_token|offer|status/i);
  assert.deepEqual(rejectionBefore(), detachedBefore);
  assert.equal(await emitHook(pi, "before_agent_start", { prompt: "unrelated", systemPrompt: "base" }), undefined);
  assert.equal(await emitHook(pi, "tool_call", { toolName: "edit", input: { path: "src/a.ts" } }), undefined);
  assert.equal(await emitHook(pi, "session_before_compact", { reason: "overflow", preparation: { fileOps: { written: new Set(), edited: new Set() } } }), undefined);
  await emitHook(pi, "session_compact", { reason: "overflow", willRetry: true });
  assert.equal(pi.sentMessages.length, 0);
  let reminder;
  for (let i = 0; i < 5; i++) reminder = await emitHook(pi, "tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false });
  assert.match(reminder.content[0].text, /goal-engine/);

  pi.sessionManager.getSessionId = () => "session-other";
  assert.equal(await invoke(pi, "goal_status", { goal_id: initialized.goalId }), "NO_ACTIVE_GOAL");
});
