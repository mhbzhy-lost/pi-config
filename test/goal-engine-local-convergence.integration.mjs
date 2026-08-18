import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { fingerprintSettlementEvidence } from "../scripts/lib/goal-engine/settlement-evidence.mjs";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { actionableFrontier } from "../scripts/lib/goal-engine/obligation-policy.mjs";
import { taskActionState } from "../scripts/lib/goal-engine/graph.mjs";
import { evaluateConditionGraph } from "../scripts/lib/goal-engine/condition-validity.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function repo() { const cwd = mkdtempSync(join(tmpdir(), "r10-local-convergence-")); git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test"); writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init"); return cwd; }

// This is the managed-validation protocol used by the obligation runtime test,
// retained here rather than replacing it with a status/projection substitute.
function observationHost(cwd) {
  const adapters = [{ ref: "oracle", version: "1", deterministic: true, reset: "clean", resourceClaims: [], artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" }, validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] } }];
  const registry = createObservationAdapterRegistry(adapters), state = new Map(), root = join(cwd, ".state/goal-engine"), calls = { prepare: 0, start: 0, recover: 0, release: 0 };
  const receipt = input => { const id = `managed-${createHash("sha256").update(`${input.ownerKind}:${input.ownerId}:${input.integratedHead}`).digest("hex").slice(0, 16)}`; if (!state.has(id)) state.set(id, { phase: "lease_allocated", terminal: null, ownerRunId: input.ownerId }); const value = state.get(id); return { id, stateRoot: root, receiptPath: join(root, "managed-validations", `${id}.json`), workspacePath: null, phase: value.phase, terminal: value.terminal, recorded: null, recordCount: 0, cleanupDebt: false }; };
  const managed = value => ({ ...value, phase: state.get(value.id).phase, terminal: state.get(value.id).terminal });
  return { registries: { ...runtimeRegistries, adapters: { oracle: { deterministic: true } } }, adapterRegistry: registry, calls,
    captureCurrentWorld() { return { safe: true, repo: { root: cwd, head: git(cwd, "rev-parse", "HEAD"), trackedDirty: [], untracked: [], sequencer: null }, adapters: [{ ref: "oracle", version: "1" }], environments: [{ ref: "local", fingerprint: "local-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "sample-1", available: true }], resources: [], activeRuns: [], capturedAt: new Date().toISOString() }; },
    prepareManagedValidation(input) { calls.prepare++; return receipt(input); }, inspectManagedValidation: managed,
    async startManagedValidation(value, { onProcessBound }) { calls.start++; state.get(value.id).phase = "process_bound"; await onProcessBound({ processIdentityHash: createHash("sha256").update(value.id).digest("hex") }); state.set(value.id, { ...state.get(value.id), phase: "recorded", terminal: { status: "passed", code: 0 } }); return managed(value); },
    async recoverManagedValidation(value, { onProcessBound }) { calls.recover++; if (state.get(value.id).phase === "lease_allocated") return this.startManagedValidation(value, { onProcessBound }); return managed(value); },
    releaseManagedValidation(value) { calls.release++; state.get(value.id).phase = "released"; return { id: value.id, released: true }; },
    artifactRefForRun() { const path = join(cwd, ".state", "cycle-artifact.json"); writeFileSync(path, JSON.stringify({ code: "PASS" }), { mode: 0o600 }); chmodSync(path, 0o600); return { id: "cycle-artifact", path }; },
  };
}
function pi(cwd) { const tools = [], listeners = new Map(), entries = []; let leaf = null, sequence = 0; const append = entry => { const value = { id: `entry-${++sequence}`, parentId: leaf, timestamp: new Date(Date.now() + sequence).toISOString(), ...entry }; entries.push(value); leaf = value.id; return value; }; const sessionManager = { getSessionId: () => "owner", getSessionFile: () => join(cwd, "session-owner"), getLeafId: () => leaf, getBranch: () => entries, getEntries: () => entries }; return { cwd, tools, entries, sessionManager, appendEntry: (customType, data) => append({ type: "custom", customType, data }), registerTool: tool => tools.push(tool), on: (name, handler) => listeners.set(name, handler), handlers: { get(name) { const handler = listeners.get(name); return name === "input" ? (event, ctx) => { const result = handler(event, ctx); append({ type: "message", message: { role: "user", content: event.text } }); return result; } : handler; } } }; }
async function invoke(api, name, input) { return (await api.tools.find(tool => tool.name === name).execute("call", input, undefined, undefined, { cwd: api.cwd, sessionManager: api.sessionManager })).details.value; }
async function approveAndActivate(api, cwd, init) { await invoke(api, "goal_init", init); await invoke(api, "goal_status", {}); api.handlers.get("input")({ type: "input", source: "interactive", text: "approve" }, { cwd, sessionManager: api.sessionManager }); await invoke(api, "goal_status", {}); let last; for (let i = 0; i < 20; i++) { last = await invoke(api, "goal_status", {}); if (loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime").runtimeState === "active") return; } throw Error(`Cycle0 did not activate: ${last}`); }
function hybridInit() { const base = runtimeInit(), backend = { ...base.execution.tasks[0], id: "backend-task", writePaths: ["src/backend/**"] }, frontend = { ...base.execution.tasks[0], id: "frontend-task", writePaths: ["src/frontend/**"] }; const condition = (id, depends_on, paths, task_ids) => ({ ...structuredClone(base.execution.conditions[0]), id, depends_on, invalidation: { paths, task_ids } }); return runtimeInit({ execution: { ...base.execution, tasks: [backend, frontend], conditions: [condition("backend-condition", [{ kind: "task", id: "backend-task" }], ["src/backend/**"], ["backend-task"]), condition("full-flow-condition", [{ kind: "condition", id: "backend-condition" }, { kind: "task", id: "frontend-task" }], ["src/backend/**", "src/frontend/**"], ["backend-task", "frontend-task"]) ] } }); }

const hash = value => createHash("sha256").update(value).digest("hex");
const event = (goalId, type, data) => ({ schemaVersion: "goal-runtime.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data });
const runtimeRoot = cwd => join(cwd, ".state/goal-engine");
function appendRuntime(cwd, goalId, type, data) { const root = runtimeRoot(cwd), projection = loadProjection(root, goalId); return appendEvent(root, event(goalId, type, data), projection.version); }
function frontier(projection, world) { return actionableFrontier({ projection, worldSnapshot: world, taskActions: new Map([...projection.tasks.keys()].map(id => [id, taskActionState(projection, id)])), observationInventory: { claims: new Map([...projection.conditions.keys()].map(id => [id, []])) } }); }

// This intentionally drives the public event reducer through Store appends.  It
// never edits a Task, workspace, or projection collection directly.
function acceptCanonicalTask(cwd, goalId, taskId, directory) {
  const root = runtimeRoot(cwd), before = loadProjection(root, goalId), task = before.tasks.get(taskId), baseCommit = git(cwd, "rev-parse", "HEAD"), workspace = mkdtempSync(join(tmpdir(), `r10-${taskId}-`));
  git(cwd, "clone", "-q", cwd, workspace); git(workspace, "config", "user.email", "test@example.com"); git(workspace, "config", "user.name", "Test");
  mkdirSync(join(workspace, directory), { recursive: true }); const changed = join(directory, "result.mjs"); writeFileSync(join(workspace, changed), `export const ${taskId.replace(/-/g, "_")} = true;\n`);
  git(workspace, "add", changed); git(workspace, "commit", "-m", `test: ${taskId} result`); const executorHead = git(workspace, "rev-parse", "HEAD"), contractHash = hash(`r10-contract:${goalId}:${taskId}`), attempt = task.attempts + 1, runId = `r10-${taskId}-run-${attempt}`, lease = hash(`r10-lease:${taskId}:${attempt}`);
  const workspaceData = { attempt, path: workspace, branch: `ge/${goalId}/${taskId}/${attempt}`, baseCommit, originRef: "refs/heads/main" };
  appendRuntime(cwd, goalId, "task.dispatched", { taskId, contractHash, workspace: workspaceData });
  appendRuntime(cwd, goalId, "task.executor_bound", { taskId, attempt, runId, contractHash, asyncDir: join(workspace, ".async"), workspacePath: workspace, workspaceLeaseId: lease, headAtDispatch: baseCommit });
  const identity = { goalId, taskId, runId, attempt, contractHash, head: executorHead }, expectedCriteria = task.acceptance.criteria.map(({ id }) => id), criteria = expectedCriteria.map(id => ({ id, status: "satisfied", evidence: [`sha256:${hash(`${taskId}:${id}:child`)}`] })), options = { expectedIdentity: identity, expectedCriteria, outcome: "succeeded" }, subagent = { identity, criteria, commandsRun: [{ command: "node --test", result: "passed", outputRef: `sha256:${hash(`${taskId}:child:command`)}` }], changedFiles: [changed] }, main = { identity, criteria: criteria.map(row => ({ ...row, evidence: [`sha256:${hash(`${taskId}:${row.id}:main`)}`] })), commandsRun: [{ command: "node --test", result: "passed", outputRef: `sha256:${hash(`${taskId}:main:command`)}` }], changedFiles: [changed] }, sha256 = hash(`${taskId}:${executorHead}:evidence`);
  appendRuntime(cwd, goalId, "task.settled", { taskId, outcome: "succeeded", attempt, executorHead, executorProof: { runId, proofId: hash(`${runId}:proof`), rootSessionId: "owner", observedAt: Date.now(), outcome: "succeeded" }, settlementEvidence: { schemaVersion: "goal-engine.settlement-evidence.v1", path: `acceptance-evidence/sha256/${sha256}.yaml`, sha256, subagentFingerprint: fingerprintSettlementEvidence(subagent, options), mainFingerprint: fingerprintSettlementEvidence(main, options), subagent, main, mainSessionId: "owner" } });
  git(cwd, "fetch", "-q", workspace, executorHead); git(cwd, "cherry-pick", "FETCH_HEAD"); const originHead = git(cwd, "rev-parse", "HEAD");
  appendRuntime(cwd, goalId, "task.workspace_disposition_started", { taskId, attempt, requestedAction: "integrate", strategy: "cherry-pick", executorHead, originHeadBefore: baseCommit, originRef: "refs/heads/main" });
  appendRuntime(cwd, goalId, "task.workspace_disposition_applied", { taskId, attempt, action: "integrate", strategy: "cherry-pick", executorHead, originHead });
  appendRuntime(cwd, goalId, "task.workspace_disposed", { taskId, attempt, action: "integrate", released: true });
  appendRuntime(cwd, goalId, "task.accepted", { taskId, workspaceAttempt: attempt });
  assert.equal(git(workspace, "rev-parse", "HEAD"), executorHead); assert.equal(git(cwd, "merge-base", "--is-ancestor", baseCommit, originHead), "");
  return { workspace, baseCommit, executorHead, originHead, changed };
}
async function activeHybrid() { const cwd = repo(), api = pi(cwd), durable = observationHost(cwd); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveAndActivate(api, cwd, hybridInit()); return { cwd, api, durable, goalId: "harden-runtime" }; }
async function settleBackendCycleOne(fixture) { for (let i = 0; i < 12; i++) { await invoke(fixture.api, "goal_status", {}); const projection = loadProjection(runtimeRoot(fixture.cwd), fixture.goalId); if (projection.conditions.get("backend-condition")?.status === "satisfied" && [...projection.observationRuns.values()].some(run => run.conditionId === "backend-condition" && run.cycle === 1 && run.phase === "released")) return projection; } throw Error("backend Cycle1 did not pass and release"); }

test("hybrid calibration uses real approval, Cycle0 managed protocol, and activation without attention", async () => {
  const cwd = repo(), api = pi(cwd), durable = observationHost(cwd); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable });
  await approveAndActivate(api, cwd, hybridInit());
  const projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(projection.runtimeState, "active"); assert.deepEqual([...projection.observationRuns.values()].filter(run => run.cycle === 0).map(run => run.conditionId).sort(), ["backend-condition", "full-flow-condition"]); assert.ok(durable.calls.prepare >= 2); assert.ok(durable.calls.start >= 2); assert.ok(durable.calls.release >= 2);
});

test("GREEN: canonical backend acceptance exposes backend observation and frontend dispatch in one hybrid frontier", async () => {
  const fixture = await activeHybrid(); acceptCanonicalTask(fixture.cwd, fixture.goalId, "backend-task", "src/backend");
  const projection = loadProjection(runtimeRoot(fixture.cwd), fixture.goalId), result = frontier(projection, fixture.durable.captureCurrentWorld());
  assert.equal(projection.tasks.get("backend-task").status, "accepted");
  assert(result.actions.some(item => item.kind === "condition" && item.id === "backend-condition" && item.tool === "request_observation"));
  assert(result.actions.some(item => item.kind === "task" && item.id === "frontend-task" && item.tool === "goal_dispatch"));
  assert(result.blocking.some(item => item.id === "full-flow-condition" && /_PREDECESSOR_/.test(item.code)));
});

test("GREEN: backend Cycle1 remains fresh across a real frontend-only non-overlap commit before full-flow observes", async () => {
  const fixture = await activeHybrid(); acceptCanonicalTask(fixture.cwd, fixture.goalId, "backend-task", "src/backend");
  const afterCycle = await settleBackendCycleOne(fixture); assert.equal(afterCycle.tasks.get("frontend-task").status, "pending");
  const frontend = acceptCanonicalTask(fixture.cwd, fixture.goalId, "frontend-task", "src/frontend"); assert.match(frontend.changed, /^src\/frontend\//);
  const projection = loadProjection(runtimeRoot(fixture.cwd), fixture.goalId), world = fixture.durable.captureCurrentWorld(), commands = [];
  const graph = evaluateConditionGraph({ projection, worldSnapshot: world, gitRunner(root, args) { commands.push(args); return execFileSync("git", args, { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] }); } });
  assert.equal(graph.conditions.get("backend-condition").status, "fresh"); assert.equal(projection.conditions.get("backend-condition").status, "satisfied");
  assert(commands.some(args => args[0] === "merge-base") && commands.some(args => args[0] === "diff"), "freshness must execute merge-base and diff");
  const result = frontier(projection, world); assert(result.actions.some(item => item.id === "full-flow-condition" && item.tool === "request_observation"));
});

test("GREEN: accepted hybrid Tasks never regress after status, observation, and non-overlap freshness evaluation", async () => {
  const fixture = await activeHybrid(); acceptCanonicalTask(fixture.cwd, fixture.goalId, "backend-task", "src/backend"); await settleBackendCycleOne(fixture);
  acceptCanonicalTask(fixture.cwd, fixture.goalId, "frontend-task", "src/frontend");
  await invoke(fixture.api, "goal_status", {}); const projection = loadProjection(runtimeRoot(fixture.cwd), fixture.goalId), world = fixture.durable.captureCurrentWorld();
  assert.equal(projection.tasks.get("backend-task").status, "accepted"); assert.equal(projection.tasks.get("frontend-task").status, "accepted");
  assert.equal(evaluateConditionGraph({ projection, worldSnapshot: world }).conditions.get("backend-condition").status, "fresh");
  assert.equal(projection.conditions.get("backend-condition").status, "satisfied");
});

async function satisfiedBackend() {
  const cwd = repo(), api = pi(cwd), durable = observationHost(cwd);
  const base = runtimeInit(), backend = { ...structuredClone(base.execution.conditions[0]), id: "backend-condition", depends_on: [], invalidation: { paths: ["src/backend/**"], task_ids: [] } };
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveAndActivate(api, cwd, runtimeInit({ execution: { ...base.execution, tasks: [], conditions: [backend] } }));
  for (let i = 0; i < 12; i++) { await invoke(api, "goal_status", {}); const projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"); if (projection.conditions.get("backend-condition")?.status === "satisfied") return { cwd, api, durable, projection }; }
  throw Error("backend product evidence did not satisfy");
}
function backendOverlap(cwd) { mkdirSync(join(cwd, "src/backend"), { recursive: true }); writeFileSync(join(cwd, "src/backend", "overlap.mjs"), "export const overlap = true;\n"); git(cwd, "add", "src/backend/overlap.mjs"); git(cwd, "commit", "-m", "frontend overlap"); }
function invalidations(cwd) { return readFileSync(join(cwd, ".state/goal-engine/goals/harden-runtime/events.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(event => event.type === "condition.evidence_invalidated"); }

test("RED: backend overlap emits exactly one local-convergence invalidation without an action offer", async () => {
  const { cwd, api } = await satisfiedBackend(); backendOverlap(cwd);
  const status = JSON.parse(await invoke(api, "goal_status", {}));
  assert.equal(invalidations(cwd).length, 1, "Extension must produce the canonical condition.evidence_invalidated event");
  assert.equal(status.status, "R10_LOCAL_CONVERGENCE_INVALIDATED");
  assert.equal(status.machineAction, undefined); assert.equal(status.action_token, undefined);
});

test("RED: invalidation producer retries pre-append and recovers durable-then-throw without duplicate stale reason", async () => {
  const { cwd, api } = await satisfiedBackend(); backendOverlap(cwd);
  const first = JSON.parse(await invoke(api, "goal_status", {}));
  assert.equal(first.status, "R10_LOCAL_CONVERGENCE_INVALIDATED", "missing condition.evidence_invalidated producer prevents retry/reload recovery coverage");
});

test("RED: simultaneous overlap invalidates satisfied Conditions by ID and cascades on the next status only", async () => {
  const { cwd, api } = await satisfiedBackend(); backendOverlap(cwd);
  const status = JSON.parse(await invoke(api, "goal_status", {}));
  assert.equal(status.status, "R10_LOCAL_CONVERGENCE_INVALIDATED", "missing condition.evidence_invalidated producer prevents ordered cascade coverage");
});
