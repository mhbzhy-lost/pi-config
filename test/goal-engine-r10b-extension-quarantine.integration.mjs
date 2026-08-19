import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { appendEvent, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { issueActionOffer } from "../scripts/lib/goal-engine/action-offer.mjs";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const canonicalHash = (value) => hash(JSON.stringify(canonical(value)));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const rootFor = (cwd) => join(cwd, ".state/goal-engine");
const projectionFor = (cwd) => loadProjection(rootFor(cwd), "harden-runtime");
const runtimeEvent = (cwd, type, data) => { const p = projectionFor(cwd); return appendEvent(rootFor(cwd), { schemaVersion: "goal-runtime.v1", eventId: crypto.randomUUID(), goalId: p.goalId, type, occurredAt: new Date().toISOString(), data }, p.version); };
const officialProof = (runId = "executor-run-1") => ({ runId, version: 1, runnerProcessInstanceId: "runner-1", state: "observed", observedAt: 1724371201000, instances: [{ processInstanceId: "runner-1", kind: "runner", closeObservedAt: 1724371201000, exitCode: 0, signal: null }] });

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "r10b-quarantine-"));
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.invalid"); git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init");
  return cwd;
}

function pi(cwd, entries = []) {
  const tools = [], listeners = new Map(), sessionId = "owner"; let leaf = entries.at(-1)?.id || null, n = entries.length;
  const append = (entry) => { const value = { id: `entry-${++n}`, parentId: leaf, timestamp: new Date(Date.now() + n).toISOString(), ...entry }; entries.push(value); leaf = value.id; };
  const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => join(cwd, "session-owner"), getLeafId: () => leaf, getEntries: () => entries, getBranch: () => [...entries] };
  return { cwd, entries, tools, sessionId, sessionManager, registerTool: (tool) => tools.push(tool), on: (name, handler) => listeners.set(name, handler), appendEntry: (customType, data) => append({ type: "custom", customType, data }), handlers: { get: (name) => {
    const handler = listeners.get(name); if (name !== "input" || !handler) return handler;
    return async (event, ctx) => { const result = await handler(event, ctx); append({ type: "message", message: { role: "user", content: event.text } }); return result; };
  } } };
}

function host(cwd, calls, { stop = "observed", managed = "observed" } = {}) {
  const proof = officialProof();
  const adapter = { ref: "oracle", version: "1", deterministic: true, reset: "clean", resourceClaims: [], artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" }, validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] } };
  let phase = "lease_allocated";
  const managedReceipt = { id: "managed-cycle", stateRoot: rootFor(cwd), receiptPath: join(rootFor(cwd), "managed-validations/managed-cycle.json"), workspacePath: null, terminal: null, recorded: null, recordCount: 0, cleanupDebt: false };
  const observe = (name, request) => { const p = projectionFor(cwd); calls.push({ name, request, runtimeState: p.runtimeState, suspension: structuredClone(p.suspension) }); assert.equal(p.runtimeState, "suspended", `${name} must reload durable suspension first`); };
  return {
    registries: runtimeRegistries, adapterRegistry: createObservationAdapterRegistry([adapter]),
    captureCurrentWorld() { return { safe: true, repo: { root: cwd, head: git(cwd, "rev-parse", "HEAD"), trackedDirty: [], untracked: [], sequencer: null }, adapters: [{ ref: "oracle", version: "1" }], environments: [{ ref: "local", fingerprint: "local-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "sample-1", available: true }], resources: [], activeRuns: [], capturedAt: new Date().toISOString() }; },
    prepareManagedValidation(input) { const id = `managed-${hash(`${input.ownerKind}:${input.ownerId}:${input.integratedHead}`).slice(0, 16)}`; return { ...managedReceipt, id, receiptPath: join(rootFor(cwd), `managed-validations/${id}.json`), phase }; },
    inspectManagedValidation(value) { return { ...value, phase, terminal: phase === "recorded" ? { status: "passed", code: 0 } : null }; },
    async startManagedValidation(value, { onProcessBound }) { phase = "process_bound"; await onProcessBound({ processIdentityHash: hash(value.id) }); phase = "recorded"; return { ...value, phase, terminal: { status: "passed", code: 0 } }; },
    async recoverManagedValidation(value) { return { ...value, phase, terminal: { status: "passed", code: 0 } }; },
    releaseManagedValidation(value) { return { id: value.id, released: true }; },
    artifactRefForRun() { const path = join(cwd, ".state/cycle-artifact.json"); writeFileSync(path, JSON.stringify({ code: "PASS" }), { mode: 0o600 }); return { id: "cycle-artifact", path }; },
    async stopOwnedRun(request) { observe("stop", request); return stop === "observed" ? { state: "observed", proof } : { state: "attention", code: "OWNED_STOP_TIMEOUT" }; },
    async quarantineWorkspace(request) { observe("workspace", request); return { taskId: request.taskId, attempt: request.attempt, proofHash: hash("workspace"), state: "quarantined", disposition: "preserved" }; },
    async quarantineResource(request) { observe("resource", request); return { ownerId: request.ownerId, proofHash: hash("resource"), state: "quarantined", debt: true }; },
    async stopManagedValidation(request) { observe("managed-stop", request); return managed === "observed" ? { state: "observed", terminalProofHash: hash("managed-terminal"), resourceProofHash: hash("managed-resource"), resourceState: "quarantined", debt: true } : { state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" }; },
  };
}

async function invoke(api, name, input) { return (await api.tools.find((tool) => tool.name === name).execute("call", input, undefined, undefined, { cwd: api.cwd, sessionManager: api.sessionManager })).details.value; }
async function ready(options) {
  const cwd = repo(), calls = [], api = pi(cwd), runtimeHost = host(cwd, calls, options); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost });
  await invoke(api, "goal_init", runtimeInit()); await invoke(api, "goal_status", {}); await api.handlers.get("input")({ type: "input", text: "approve", source: "interactive" }, { cwd, sessionManager: api.sessionManager });
  for (let i = 0; i < 10 && projectionFor(cwd).runtimeState !== "active"; i++) await invoke(api, "goal_status", {});
  assert.equal(projectionFor(cwd).runtimeState, "active");
  const p = projectionFor(cwd), task = p.tasks.get("task-1"), attempt = task.attempts + 1, runId = "executor-run-1", head = git(cwd, "rev-parse", "HEAD"), contractHash = hash("executor-contract"), leaseId = hash("executor-lease"), workspacePath = join(tmpdir(), "r10b-quarantine-workspace");
  runtimeEvent(cwd, "task.dispatched", { taskId: "task-1", contractHash, workspace: { attempt, path: workspacePath, branch: `ge/harden-runtime/task-1/${attempt}`, baseCommit: head, originRef: "refs/heads/main" } });
  runtimeEvent(cwd, "task.executor_bound", { taskId: "task-1", attempt, runId, contractHash, asyncDir: join(tmpdir(), "executor-async"), workspacePath, workspaceLeaseId: leaseId, headAtDispatch: head });
  const current = projectionFor(cwd), offer = issueActionOffer(current, { tool: "goal_dispatch", params: { goal_id: current.goalId, task_id: "task-1" } }, api.sessionId); runtimeEvent(cwd, "goal.action_offered", offer);
  return { cwd, api, calls, runtimeHost, runId, attempt, leaseId, workspacePath, head, contractHash };
}

async function steer(api) { await api.handlers.get("input")({ type: "input", text: "private steer", source: "interactive", streamingBehavior: "steer" }, { cwd: api.cwd, sessionManager: api.sessionManager }); }
async function reload(f) {
  const api = pi(f.cwd, structuredClone(f.api.entries));
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: f.runtimeHost });
  await api.handlers.get("session_start")({}, { cwd: api.cwd, sessionManager: api.sessionManager });
  await invoke(api, "goal_status", {});
  return api;
}

test("steer durably closes an executor in stop-proof, preserved-workspace, resource-debt order", { concurrency: false }, async () => {
  const f = await ready(); await steer(f.api);
  const p = projectionFor(f.cwd), proof = officialProof(f.runId);
  assert.deepEqual(f.calls.map(({ name }) => name), ["stop", "workspace", "resource"]);
  assert.deepEqual(f.calls[0].request, { runId: f.runId, asyncDir: join(tmpdir(), "executor-async"), sessionId: f.api.sessionId });
  assert.deepEqual(f.calls[1].request, { goalId: p.goalId, taskId: "task-1", attempt: f.attempt, runId: f.runId, leaseId: f.leaseId, workspacePath: f.workspacePath, headAtDispatch: f.head, baseHead: f.head, executionRevision: 1, contractHash: p.executionContractHash, sessionId: f.api.sessionId });
  assert.deepEqual(f.calls[2].request, { goalId: p.goalId, ownerKind: "executor", ownerId: f.runId, taskId: "task-1", attempt: f.attempt, leaseId: f.leaseId, executionRevision: 1, contractHash: p.executionContractHash, sessionId: f.api.sessionId });
  assert.equal(p.suspension.resourcesQuarantined, true);
  assert.deepEqual(p.suspension.terminalProofRefs, [{ runId: f.runId, proofHash: canonicalHash(proof), state: "observed" }]);
  assert.deepEqual(p.suspension.workspaceClosureProofRefs, [{ taskId: "task-1", attempt: f.attempt, proofHash: hash("workspace"), state: "quarantined", disposition: "preserved" }]);
  assert.deepEqual(p.suspension.resourceClosureProofRefs, [{ ownerId: f.runId, proofHash: hash("resource"), state: "quarantined", debt: true }]);
  await reload(f); assert.equal(f.calls.length, 3, "fresh Host reload must not duplicate closed facades");
});

test("wrong or malformed observed proof leaves the executor suspended for attention", { concurrency: false }, async () => {
  const f = await ready(), proofs = [officialProof("executor-run-other"), { ...officialProof(), observedAt: "not-a-finite-number" }];
  f.runtimeHost.stopOwnedRun = async (request) => { const p = projectionFor(f.cwd); f.calls.push({ name: "stop", request, runtimeState: p.runtimeState }); assert.equal(p.runtimeState, "suspended"); return { state: "observed", proof: proofs.shift() }; };
  await steer(f.api);
  let p = projectionFor(f.cwd);
  assert.deepEqual(f.calls.map(({ name }) => name), ["stop"]);
  assert.equal(p.runtimeState, "suspended"); assert.equal(p.suspension.resourcesQuarantined, false);
  await reload(f);
  p = projectionFor(f.cwd);
  assert.deepEqual(f.calls.map(({ name }) => name), ["stop", "stop"]);
  assert.equal(p.runtimeState, "suspended"); assert.equal(p.suspension.resourcesQuarantined, false);
});

test("attention stop leaves the affected executor suspended without quarantine or resume", { concurrency: false }, async () => {
  const f = await ready(); f.runtimeHost.stopOwnedRun = async (request) => { const p = projectionFor(f.cwd); f.calls.push({ name: "stop", request, runtimeState: p.runtimeState }); assert.equal(p.runtimeState, "suspended"); return { state: "attention", code: "OWNED_STOP_TIMEOUT" }; };
  await steer(f.api); const p = projectionFor(f.cwd);
  assert.deepEqual(f.calls.map(({ name }) => name), ["stop"]); assert.equal(p.runtimeState, "suspended"); assert.equal(p.suspension.resourcesQuarantined, false); assert.equal(p.suspension.terminalProofRefs, undefined);
});

test("steer includes a process-bound managed Observation and stops it through the typed facade", { concurrency: false }, async () => {
  const f = await ready(); const p = projectionFor(f.cwd), condition = p.conditions.get("condition-1"), observationRunId = "observation-run-1", allocationId = "allocation-1";
  runtimeEvent(f.cwd, "condition.observation_requested", { runId: observationRunId, conditionId: "condition-1", cycle: 1, head: f.head, executionRevision: p.executionRevision, executionContractHash: p.executionContractHash, conditionHash: condition.conditionHash, adapter: { ref: "oracle", version: "1" }, worldSnapshotHash: hash("world"), resourceClaimsHash: hash("resources") });
  runtimeEvent(f.cwd, "condition.observation_lease_allocated", { runId: observationRunId, conditionId: "condition-1", allocationId, leaseReceiptHash: hash("lease") });
  runtimeEvent(f.cwd, "condition.observation_process_bound", { runId: observationRunId, conditionId: "condition-1", processIdentityHash: hash("process") });
  await steer(f.api); const suspended = projectionFor(f.cwd);
  assert.deepEqual(suspended.suspension.affectedRunIds, [f.runId, observationRunId].sort());
  assert.deepEqual(f.calls.map(({ name }) => name), ["stop", "workspace", "resource", "managed-stop"]);
  assert.deepEqual(f.calls.at(-1).request, { goalId: suspended.goalId, runId: observationRunId, conditionId: "condition-1", allocationId, processIdentityHash: hash("process"), executionRevision: 1, executionContractHash: suspended.executionContractHash, baseHead: f.head });
});

test("lease-only managed Observation is retained for attention and is never killed", { concurrency: false }, async () => {
  const f = await ready(); const p = projectionFor(f.cwd), condition = p.conditions.get("condition-1"), observationRunId = "observation-run-unknown";
  runtimeEvent(f.cwd, "condition.observation_requested", { runId: observationRunId, conditionId: "condition-1", cycle: 1, head: f.head, executionRevision: p.executionRevision, executionContractHash: p.executionContractHash, conditionHash: condition.conditionHash, adapter: { ref: "oracle", version: "1" }, worldSnapshotHash: hash("world-unknown"), resourceClaimsHash: hash("resources-unknown") });
  runtimeEvent(f.cwd, "condition.observation_lease_allocated", { runId: observationRunId, conditionId: "condition-1", allocationId: "allocation-unknown", leaseReceiptHash: hash("lease-unknown") });
  await steer(f.api); const suspended = projectionFor(f.cwd);
  assert.ok(suspended.suspension.affectedRunIds.includes(observationRunId)); assert.equal(f.calls.some(({ name }) => name === "managed-stop"), false); assert.equal(suspended.suspension.resourcesQuarantined, false);
});
