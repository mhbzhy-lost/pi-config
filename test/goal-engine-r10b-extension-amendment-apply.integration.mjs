import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { appendEvent, appendEventBatch, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { fingerprintSettlementEvidence } from "../scripts/lib/goal-engine/settlement-evidence.mjs";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const rootFor = cwd => join(cwd, ".state/goal-engine");
const projectionFor = cwd => loadProjection(rootFor(cwd), "harden-runtime");
const eventCount = (cwd, type) => (readFileSync(join(rootFor(cwd), "goals/harden-runtime/events.jsonl"), "utf8").match(new RegExp(`"type":"${type}"`, "g")) || []).length;
const eventTotal = cwd => readFileSync(join(rootFor(cwd), "goals/harden-runtime/events.jsonl"), "utf8").trim().split("\n").length;
const hash = value => createHash("sha256").update(value).digest("hex");
const event = (goalId, type, data) => ({ schemaVersion: "goal-runtime.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data });
function appendRuntime(cwd, goalId, type, data) { const root = rootFor(cwd), projection = loadProjection(root, goalId); return appendEvent(root, event(goalId, type, data), projection.version); }

// Drive the actual Store reducer and Git disposition protocol instead of
// substituting a Task status or mutating the projection fixture.
function acceptCanonicalTask(cwd, goalId, taskId, directory) {
  const before = projectionFor(cwd), task = before.tasks.get(taskId), baseCommit = git(cwd, "rev-parse", "HEAD"), workspace = mkdtempSync(join(tmpdir(), `r10-${taskId}-`));
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
}

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "r10b-apply-"));
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init");
  return cwd;
}
function pi(cwd, entries = [], sessionId = "owner") {
  const tools = [], listeners = new Map(); let leaf = entries.at(-1)?.id ?? null, sequence = entries.length;
  const append = entry => { const value = { id: `entry-${++sequence}`, parentId: leaf, timestamp: new Date(Date.now() + sequence).toISOString(), ...entry }; entries.push(value); leaf = value.id; return value; };
  const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => join(cwd, `session-${sessionId}`), getLeafId: () => leaf, getEntries: () => [...entries], getBranch: () => [...entries] };
  return { cwd, entries, tools, sessionManager, registerTool: tool => tools.push(tool), on: (name, handler) => listeners.set(name, handler), appendEntry: (customType, data) => append({ type: "custom", customType, data }), handlers: { get: name => {
    const handler = listeners.get(name); if (name !== "input" || !handler) return handler;
    return async (event, ctx) => { const result = await handler(event, ctx); append({ type: "message", message: { role: "user", content: event.text } }); return result; };
  } } };
}
function host(cwd, { nonceCalls, world = () => ({}) } = {}) {
  const adapter = { ref: "oracle", version: "1", deterministic: true, reset: "clean", resourceClaims: [], artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" }, validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] } };
  let phase = "lease_allocated";
  return { registries: runtimeRegistries, adapterRegistry: createObservationAdapterRegistry([adapter]), nonceFactory: () => { nonceCalls?.push("raw-host-only-nonce"); return "raw-host-only-nonce"; },
    captureCurrentWorld() { return { safe: true, repo: { root: cwd, head: git(cwd, "rev-parse", "HEAD"), trackedDirty: [], untracked: [], sequencer: null }, adapters: [{ ref: "oracle", version: "1" }], environments: [{ ref: "local", fingerprint: "local-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "sample-1", available: true }], resources: [], activeRuns: [], capturedAt: new Date().toISOString(), ...world() }; },
    prepareManagedValidation(input) { const id = `managed-${createHash("sha256").update(input.ownerId).digest("hex").slice(0, 16)}`; return { id, stateRoot: rootFor(cwd), receiptPath: join(rootFor(cwd), `managed-validations/${id}.json`), workspacePath: null, phase, terminal: null, recorded: null, recordCount: 0, cleanupDebt: false }; },
    inspectManagedValidation(value) { return { ...value, phase, terminal: phase === "recorded" ? { status: "passed", code: 0 } : null }; },
    async startManagedValidation(value, { onProcessBound }) { phase = "process_bound"; await onProcessBound({ processIdentityHash: createHash("sha256").update(value.id).digest("hex") }); phase = "recorded"; return { ...value, phase, terminal: { status: "passed", code: 0 } }; },
    async recoverManagedValidation(value) { return { ...value, phase, terminal: { status: "passed", code: 0 } }; }, releaseManagedValidation(value) { return { id: value.id, released: true }; },
    artifactRefForRun() { const path = join(cwd, ".state/artifact.json"); writeFileSync(path, JSON.stringify({ code: "PASS" }), { mode: 0o600 }); return { id: "artifact", path }; },
  };
}
async function invoke(api, name, input = {}) { return (await api.tools.find(tool => tool.name === name).execute("call", input, undefined, undefined, { cwd: api.cwd, sessionManager: api.sessionManager })).details.value; }
async function approved({ sessionId = "owner", entries, extension = {}, choice = "approve", accepted = false, updates = [{ id: "task-1", description: "Amended target task" }], decide = true, expectProposalError = null } = {}) {
  const cwd = repo(), api = pi(cwd, entries, sessionId), nonces = [];
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd, { nonceCalls: nonces, ...extension }), ...extension });
  await invoke(api, "goal_init", runtimeInit()); await invoke(api, "goal_status");
  await api.handlers.get("input")({ type: "input", text: "approve", source: "interactive" }, { cwd, sessionManager: api.sessionManager });
  for (let i = 0; i < 10 && projectionFor(cwd).runtimeState !== "active"; i++) await invoke(api, "goal_status");
  nonces.length = 0; // Activation's capability is not the amendment capability under test.
  if (accepted) acceptCanonicalTask(cwd, "harden-runtime", "task-1", "src");
  await api.handlers.get("input")({ type: "input", text: "amend privately", source: "interactive" }, { cwd, sessionManager: api.sessionManager });
  const beforeProposalEvents = eventTotal(cwd);
  if (expectProposalError) {
    await assert.rejects(invoke(api, "goal_amend", { goal_id: "harden-runtime", operation: "propose_execution_change", reason: "amend task", changes: { update_tasks: updates } }), expectProposalError);
    assert.equal(projectionFor(cwd).pendingHumanDecision, null); assert.equal(eventTotal(cwd), beforeProposalEvents);
    return { cwd, api, nonces };
  }
  await invoke(api, "goal_amend", { goal_id: "harden-runtime", operation: "propose_execution_change", reason: "amend task", changes: { update_tasks: updates } });
  if (decide) {
    await api.handlers.get("input")({ type: "input", text: choice, source: "interactive" }, { cwd, sessionManager: api.sessionManager });
    await invoke(api, "goal_status");
    assert.equal(projectionFor(cwd).pendingHumanDecision.phase, choice === "approve" ? "approved" : "rejected");
  }
  return { cwd, api, nonces };
}

// RED: status must atomically consume the Host capability, apply the target contract, and resume.
test("R10B happy path applies approved amendment through the canonical Store batch", async () => {
  const { cwd, api, nonces } = await approved(); const before = projectionFor(cwd);
  const result = await invoke(api, "goal_status"); const after = projectionFor(cwd);
  assert.match(result, /AMENDMENT_APPLIED/); assert.equal(after.runtimeState, "active"); assert.equal(after.executionRevision, before.executionRevision + 1);
  assert.equal(after.tasks.get("task-1").description, "Amended target task"); assert.equal(after.taskApplicability.get("task-1").state, "applicable");
  assert.equal(nonces.length, 1); assert.equal(eventCount(cwd, "execution.amendment_applied"), 1);
});

test("R10B keeps raw Host nonce out of all public ledgers and repeats no batch", async () => {
  const { cwd, api, nonces } = await approved(); await invoke(api, "goal_status");
  const status = await invoke(api, "goal_status"), publicText = `${readFileSync(join(rootFor(cwd), "goals/harden-runtime/events.jsonl"), "utf8")}${JSON.stringify(api.entries)}${status}`;
  assert.doesNotMatch(publicText, /raw-host-only-nonce/); assert.equal(nonces.length, 1); assert.equal(eventCount(cwd, "execution.amendment_applied"), 1);
});

test("R10B pre-append failure leaves approved suspension retryable", async () => {
  let armed = false, failed = false; const { cwd, api } = await approved({ extension: { appendEventBatch(root, batch, version) { if (armed && !failed && batch.some(entry => entry.type === "execution.amendment_applied")) { failed = true; armed = false; throw Error("pre-append"); } return appendEventBatch(root, batch, version); } } }); armed = true;
  await assert.rejects(invoke(api, "goal_status"), /pre-append/); const pending = projectionFor(cwd);
  assert.equal(pending.pendingHumanDecision.phase, "approved"); assert.equal(pending.runtimeState, "suspended"); const revision = pending.executionRevision;
  await invoke(api, "goal_status"); assert.equal(failed, true); assert.equal(projectionFor(cwd).runtimeState, "active"); assert.equal(projectionFor(cwd).executionRevision, revision + 1);
});

test("R10B durable-then-throw batch recovers exactly once across reload", async () => {
  let armed = false; const { cwd, api } = await approved({ extension: { appendEventBatch(root, batch, version) { const value = appendEventBatch(root, batch, version); if (armed) throw Error("durable-then-throw"); return value; } } }); armed = true;
  await invoke(api, "goal_status"); const revision = projectionFor(cwd).executionRevision, entries = structuredClone(api.entries), reload = pi(cwd, entries);
  createGoalEngineExtension(reload, { goalStateEnv: {}, runtimeHost: host(cwd) }); await invoke(reload, "goal_status");
  assert.equal(projectionFor(cwd).executionRevision, revision); assert.equal(eventCount(cwd, "execution.amendment_capability_consumed"), 1); assert.equal(eventCount(cwd, "goal.runtime_resumed"), 1);
});

test("R10B drift blocks apply before nonce consumption for every durable identity", async () => {
  const { cwd, api, nonces } = await approved(); git(cwd, "commit", "--allow-empty", "-m", "drift"); const before = projectionFor(cwd).version;
  const result = await invoke(api, "goal_status"); assert.match(result, /DRIFT|ATTENTION/); assert.equal(projectionFor(cwd).version, before + 1); assert.equal(nonces.length, 0); assert.equal(eventCount(cwd, "execution.amendment_applied"), 0);
});

test("R10B cross-session status cannot apply and rejection permits a fresh proposal", async () => {
  const { cwd, api } = await approved(); const other = pi(cwd, structuredClone(api.entries), "other"); createGoalEngineExtension(other, { goalStateEnv: {}, runtimeHost: host(cwd) });
  const blocked = await invoke(other, "goal_status"); assert.match(blocked, /NO_ACTIVE_GOAL|DRIFT|ATTENTION/); assert.equal(eventCount(cwd, "execution.amendment_applied"), 0);
  const rejected = await approved({ choice: "reject" }); const oldProposalId = projectionFor(rejected.cwd).pendingHumanDecision.proposalId;
  await assert.doesNotReject(invoke(rejected.api, "goal_amend", { goal_id: "harden-runtime", operation: "propose_execution_change", reason: "fresh proposal", changes: { update_tasks: [{ id: "task-1", description: "Fresh target" }] } }));
  const fresh = projectionFor(rejected.cwd).pendingHumanDecision; assert.equal(fresh.phase, "proposed"); assert.notEqual(fresh.proposalId, oldProposalId);
});

test("R10B accepted task history remains accepted and applicable after supported updates", async () => {
  for (const update of [
    { id: "task-1", description: "Updated accepted description" },
    { id: "task-1", deps: [] },
    { id: "task-1", writePaths: ["src/**"] },
    { id: "task-1", workflow: "existing-tests" },
  ]) {
    const { cwd, api } = await approved({ accepted: true, updates: [update] }); const before = projectionFor(cwd).tasks.get("task-1"); assert.equal(before.status, "accepted", "fixture must establish accepted Task through canonical events");
    await invoke(api, "goal_status"); const task = projectionFor(cwd).tasks.get("task-1"); assert.equal(task.status, "accepted"); assert.equal(projectionFor(cwd).taskApplicability.get("task-1").state, "applicable");
    assert.match(readFileSync(join(rootFor(cwd), "goals/harden-runtime/events.jsonl"), "utf8"), /"action":"keep"/);
  }
});

test("R10B supported pending updates keep applicability and leave dispatch available", async () => {
  for (const update of [
    { id: "task-1", description: "Updated description" },
    { id: "task-1", deps: [] },
    { id: "task-1", writePaths: ["src/**"] },
    { id: "task-1", workflow: "existing-tests" },
  ]) {
    const { cwd, api } = await approved({ updates: [update] });
    await invoke(api, "goal_status");
    const task = projectionFor(cwd).tasks.get("task-1");
    assert.equal(task.status, "pending"); assert.equal(projectionFor(cwd).taskApplicability.get("task-1").state, "applicable");
    assert.match(readFileSync(join(rootFor(cwd), "goals/harden-runtime/events.jsonl"), "utf8"), /"action":"keep"/);
    assert.match(await invoke(api, "goal_status"), /goal_dispatch/);
  }
});

test("R10B rejects accepted Task acceptance changes before proposal append", async () => {
  await approved({ accepted: true, updates: [{ id: "task-1", acceptance: { criteria: [{ id: "contract", statement: "Unverified replacement criterion", evidenceKinds: ["tests"] }] } }], expectProposalError: /accepted Task acceptance/i });
});
