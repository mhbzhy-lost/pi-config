import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { appendEvent, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function host(cwd) { return { registries: runtimeRegistries, captureCurrentWorld() { return { safe: true, repo: { head: git(cwd, "rev-parse", "HEAD") }, resources: [], activeRuns: [], capturedAt: new Date().toISOString() }; } }; }
function observationHost(cwd, { code = "PASS", receiptRoot = join(cwd, ".state/goal-engine"), receiptPath = join(receiptRoot, "validation-runtime"), allocation = "normal", artifactMode = 0o600, artifactSymlink = false, holdProcess = false, holdTerminal = false } = {}) {
  const registry = createObservationAdapterRegistry([{ ref: "oracle", version: "1", deterministic: true, reset: "clean", resourceClaims: [], artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" }, validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] } }]);
  const calls = { prepare: 0, start: 0, recover: 0, release: 0, artifact: 0 }; const state = new Map();
  const receipt = input => { const id = allocation === "mismatch" ? `managed-${calls.prepare}` : `managed-${createHash("sha256").update(`${input.ownerKind}:${input.ownerId}:${input.integratedHead}`).digest("hex").slice(0, 16)}`; const prior = state.get(id) || { phase: "lease_allocated", terminal: null }; return { id, stateRoot: receiptRoot, receiptPath: join(receiptPath, `${id}.json`), workspacePath: null, phase: prior.phase, terminal: prior.terminal, recorded: null, recordCount: 0, cleanupDebt: false }; };
  const terminal = { status: "passed", code: 0 }; const managed = value => ({ ...value, phase: state.get(value.id)?.phase || value.phase, terminal: state.get(value.id)?.terminal || null });
  return { registries: runtimeRegistries, adapterRegistry: registry, calls, captureCurrentWorld() { return { safe: true, repo: { head: git(cwd, "rev-parse", "HEAD") }, environments: [{ ref: "local", fingerprint: "local-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "sample-1", available: true }], resources: [], activeRuns: [], capturedAt: new Date().toISOString() }; }, prepareManagedValidation(input) { calls.prepare++; return receipt(input); }, inspectManagedValidation(value) { return managed(value); }, async startManagedValidation(value, { onProcessBound }) { calls.start++; state.set(value.id, { phase: "process_bound", terminal: null }); await onProcessBound({ processIdentityHash: createHash("sha256").update(value.id).digest("hex") }); if (holdProcess) throw Error("interrupt after durable process"); state.set(value.id, { phase: "recorded", terminal }); if (holdTerminal) throw Error("interrupt after durable managed terminal"); return managed(value); }, async recoverManagedValidation(value) { calls.recover++; return managed(value); }, releaseManagedValidation(value) { calls.release++; state.set(value.id, { phase: "released", terminal }); return { id: value.id, released: true }; }, artifactRefForRun() { calls.artifact++; const path = join(cwd, ".state", "cycle0-artifact.json"), target = join(cwd, ".state", "cycle0-artifact-target.json"); writeFileSync(artifactSymlink ? target : path, JSON.stringify({ code }), { mode: artifactMode }); chmodSync(artifactSymlink ? target : path, artifactMode); if (artifactSymlink) symlinkSync(target, path); return { id: "cycle0-artifact", path }; } };
}
function observationEvents(cwd) { return readFileSync(join(cwd, ".state/goal-engine/goals/harden-runtime/events.jsonl"), "utf8").trim().split("\n").map(JSON.parse).map(event => event.type); }
async function approveCalibration(api, cwd, init = runtimeInit()) { await invoke(api, "goal_init", init); await invoke(api, "goal_status", {}); api.handlers.get("input")({ source: "interactive", text: "approve", entryId: "cycle0-approve" }, { cwd, sessionManager: api.sessionManager }); await invoke(api, "goal_status", {}); }
async function statusUntil(api, phase, limit = 8) { for (let i = 0; i < limit; i++) { await invoke(api, "goal_status", {}); const projection = loadProjection(join(api.cwd, ".state/goal-engine"), "harden-runtime"); if ([...projection.observationRuns.values()].some(run => run.phase === phase)) return projection; } throw Error(`phase not reached: ${phase}`); }
function pi(cwd, entries = [], { sessionId = "owner", appendEntry } = {}) { const tools = [], handlers = new Map(), manager = { getSessionId: () => sessionId, getSessionFile: () => join(cwd, `session-${sessionId}`), getLeafId: () => "leaf", getEntries: () => entries }; const api = { tools, entries, handlers, sessionManager: manager, registerTool: tool => tools.push(tool), on: (name, handler) => handlers.set(name, handler) }; api.appendEntry = (customType, data) => { if (appendEntry) return appendEntry(customType, data, entries); entries.push({ type: "custom", customType, data }); }; return api; }
function repo() { const cwd = mkdtempSync(join(tmpdir(), "r10a1-")); git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test"); writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init"); return cwd; }
function runtimeEntries(api, suffix) { return api.entries.filter((entry) => entry.customType?.endsWith(suffix)); }
async function invoke(api, name, input) { const result = await api.tools.find(tool => tool.name === name).execute("call", input, undefined, undefined, { cwd: api.cwd, sessionManager: api.sessionManager }); return result.details.value; }

test("runtime init is draft-only, records readiness, and retains progress checkpoints", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "r10a1-")); git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test"); writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init");
  const api = pi(cwd); api.cwd = cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd) });
  assert.deepEqual(api.tools.map(tool => tool.name).sort(), ["goal_accept", "goal_amend", "goal_dispatch", "goal_finalize", "goal_init", "goal_integrate", "goal_settle", "goal_status"]);
  const initialized = JSON.parse(await invoke(api, "goal_init", runtimeInit())); assert.equal(initialized.runtimeState, "awaiting_user_approval");
  const first = JSON.parse(await invoke(api, "goal_status", {})); assert.deepEqual(first.choices, ["approve", "reject"]); assert.equal(api.entries.filter(entry => entry.customType === "goal-engine-runtime-approval-challenge").length, 1);
  const second = JSON.parse(await invoke(api, "goal_status", {})); assert.equal(second.proposalId, first.proposalId); assert.equal(api.entries.filter(entry => entry.customType === "goal-engine-runtime-approval-challenge").length, 1);
});


test("runtime init fails closed with a stable blocker before any append when HEAD is absent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "r10a1-")); git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test"); writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init");
  const api = pi(cwd); api.cwd = cwd;
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: { registries: runtimeRegistries, captureCurrentWorld() { return { safe: false, repo: {}, resources: [], activeRuns: [] }; } } });
  await assert.rejects(invoke(api, "goal_init", runtimeInit()), /RUNTIME_READINESS_BLOCKER/);
  assert.equal(api.entries.length, 0);
});

test("unconsumed runtime input creates a durable fail-closed gate", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "r10a1-")); git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test"); writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init");
  const api = pi(cwd); api.cwd = cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd) }); await invoke(api, "goal_init", runtimeInit());
  api.handlers.get("input")({ source: "interactive", text: "new work", entryId: "entry-intent" }, { cwd, sessionManager: api.sessionManager });
  assert.deepEqual(JSON.parse(await invoke(api, "goal_status", {})), { status: "R10B_SUSPENSION_REQUIRED" }); assert.equal(api.entries.some(entry => entry.customType === "goal-engine-runtime-intent-pending" && entry.data.userEntryId === "entry-intent" && !JSON.stringify(entry.data).includes("new work")), true);
});

test("runtime approval consumes only exact real input and restores challenge identity", async () => {
  const cwd = repo(); const api = pi(cwd); api.cwd = cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd) }); await invoke(api, "goal_init", runtimeInit());
  const pending = JSON.parse(await invoke(api, "goal_status", {})); api.handlers.get("input")({ source: "interactive", text: "approve", entryId: "entry-1" }, { sessionManager: api.sessionManager });
  const challenge = api.entries.find(entry => entry.customType === "goal-engine-runtime-approval-challenge").data, decision = api.entries.find(entry => entry.customType === "goal-engine-runtime-approval-decision").data; assert.equal(decision.id, challenge.id); assert.ok(decision.receiptId); assert.equal(decision.proposalHash, pending.proposalHash);
  const reloaded = pi(cwd, api.entries); reloaded.cwd = cwd; createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: host(cwd) }); reloaded.handlers.get("session_start")({}, { sessionManager: reloaded.sessionManager });
  const status = JSON.parse(await invoke(reloaded, "goal_status", {})); assert.equal(status.runtimeState, "calibrating"); assert.equal(status.pendingHumanDecision, undefined);
});

test("runtime authority is session-scoped: another session cannot discover or consume it", async () => {
  const cwd = repo(), owner = pi(cwd); owner.cwd = cwd; createGoalEngineExtension(owner, { goalStateEnv: {}, runtimeHost: host(cwd) });
  const initialized = JSON.parse(await invoke(owner, "goal_init", runtimeInit())); const offered = JSON.parse(await invoke(owner, "goal_status", {}));
  const other = pi(cwd, [], { sessionId: "other" }); other.cwd = cwd; createGoalEngineExtension(other, { goalStateEnv: {}, runtimeHost: host(cwd) }); other.handlers.get("session_start")({}, { sessionManager: other.sessionManager });
  assert.equal(await invoke(other, "goal_status", { goal_id: initialized.goalId }), "NO_ACTIVE_GOAL");
  other.handlers.get("input")({ source: "interactive", text: "approve", entryId: "other-input" }, { cwd, sessionManager: other.sessionManager });
  assert.equal(runtimeEntries(other, "decision").length, 0); assert.equal(runtimeEntries(owner, "decision").length, 0); assert.ok(offered.proposalId);
});

test("challenge, approved decision, and consumed approval survive reload without duplicate nonce or event", async () => {
  const cwd = repo(); let nonceCalls = 0; const options = { goalStateEnv: {}, runtimeHost: { ...host(cwd), nonceFactory: () => { nonceCalls++; return "nonce-for-reload"; } } };
  const first = pi(cwd); first.cwd = cwd; createGoalEngineExtension(first, options); await invoke(first, "goal_init", runtimeInit()); const offered = JSON.parse(await invoke(first, "goal_status", {}));
  const challengeReload = pi(cwd, first.entries); challengeReload.cwd = cwd; createGoalEngineExtension(challengeReload, options); challengeReload.handlers.get("session_start")({}, { sessionManager: challengeReload.sessionManager }); assert.equal(JSON.parse(await invoke(challengeReload, "goal_status", {})).proposalId, offered.proposalId);
  challengeReload.handlers.get("input")({ source: "interactive", text: "approve", entryId: "reload-approve" }, { cwd, sessionManager: challengeReload.sessionManager });
  const consumedReload = pi(cwd, first.entries); consumedReload.cwd = cwd; createGoalEngineExtension(consumedReload, options); consumedReload.handlers.get("session_start")({}, { sessionManager: consumedReload.sessionManager }); assert.equal(JSON.parse(await invoke(consumedReload, "goal_status", {})).runtimeState, "calibrating");
  assert.equal(runtimeEntries(challengeReload, "decision").length, 1); assert.equal(runtimeEntries(consumedReload, "consumed").length, 1); assert.equal(nonceCalls, 1);
});

test("durable approval append throw is recovered from the real projection without replay", async () => {
  const cwd = repo(); let threw = false, nonceCalls = 0;
  const options = { goalStateEnv: {}, runtimeHost: { ...host(cwd), nonceFactory: () => { nonceCalls++; return "durable-nonce"; } }, appendEvent(root, event, version) { const projection = appendEvent(root, event, version); if (event.type === "goal.runtime_approval_recorded" && !threw) { threw = true; throw new Error("after durable append"); } return projection; } };
  const api = pi(cwd); api.cwd = cwd; createGoalEngineExtension(api, options); await invoke(api, "goal_init", runtimeInit()); await invoke(api, "goal_status", {}); api.handlers.get("input")({ source: "interactive", text: "approve", entryId: "durable-entry" }, { cwd, sessionManager: api.sessionManager });
  assert.equal(JSON.parse(await invoke(api, "goal_status", {})).runtimeState, "calibrating"); const reloaded = pi(cwd, api.entries); reloaded.cwd = cwd; createGoalEngineExtension(reloaded, options); reloaded.handlers.get("session_start")({}, { sessionManager: reloaded.sessionManager }); await invoke(reloaded, "goal_status", {});
  assert.equal(loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime").runtimeState, "calibrating"); assert.equal(nonceCalls, 1); assert.equal(runtimeEntries(reloaded, "consumed").length, 1);
});

test("runtime nonce is represented only by its digest in JSONL, Pi entries, and status", async () => {
  const cwd = repo(), raw = "raw-nonce-must-never-escape", digest = createHash("sha256").update(raw).digest("hex"); const api = pi(cwd); api.cwd = cwd;
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: { ...host(cwd), nonceFactory: () => raw } }); await invoke(api, "goal_init", runtimeInit()); await invoke(api, "goal_status", {}); api.handlers.get("input")({ source: "interactive", text: "approve", entryId: "raw-entry" }, { cwd, sessionManager: api.sessionManager }); const status = await invoke(api, "goal_status", {});
  const jsonl = readFileSync(join(cwd, ".state/goal-engine/goals/harden-runtime/events.jsonl"), "utf8"); const visible = `${jsonl}\n${JSON.stringify(api.entries)}\n${status}`; assert.equal(visible.includes(raw), false); assert.equal(jsonl.includes(digest), true);
});

test("restored runtime approval metadata is strict authority, not a permissive object merge", async () => {
  const cwd = repo(), first = pi(cwd); first.cwd = cwd; createGoalEngineExtension(first, { goalStateEnv: {}, runtimeHost: host(cwd) }); await invoke(first, "goal_init", runtimeInit()); await invoke(first, "goal_status", {});
  const malformed = structuredClone(first.entries); malformed.find((entry) => entry.customType === "goal-engine-runtime-approval-challenge").data.extra = "forged";
  const restored = pi(cwd, malformed); restored.cwd = cwd; createGoalEngineExtension(restored, { goalStateEnv: {}, runtimeHost: host(cwd) }); restored.handlers.get("session_start")({}, { sessionManager: restored.sessionManager }); const status = JSON.parse(await invoke(restored, "goal_status", {}));
  assert.notEqual(status.proposalId, malformed.find((entry) => entry.customType === "goal-engine-runtime-approval-challenge").data.proposalId); assert.equal(runtimeEntries(restored, "challenge").length, 2);
});

test("malformed runtime decision, tombstone, and intent metadata cannot restore authority", async () => {
  const cwd = repo(), first = pi(cwd); first.cwd = cwd; createGoalEngineExtension(first, { goalStateEnv: {}, runtimeHost: host(cwd) }); await invoke(first, "goal_init", runtimeInit());
  const offered = JSON.parse(await invoke(first, "goal_status", {})); first.handlers.get("input")({ source: "interactive", text: "approve", entryId: "decision-entry" }, { sessionManager: first.sessionManager });
  const malformedDecision = structuredClone(first.entries); malformedDecision.find((entry) => entry.customType === "goal-engine-runtime-approval-decision").data.extra = "forged";
  const decisionReload = pi(cwd, malformedDecision); decisionReload.cwd = cwd; createGoalEngineExtension(decisionReload, { goalStateEnv: {}, runtimeHost: host(cwd) }); decisionReload.handlers.get("session_start")({}, { sessionManager: decisionReload.sessionManager });
  assert.equal(loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime").runtimeState, "awaiting_user_approval"); assert.notEqual(JSON.parse(await invoke(decisionReload, "goal_status", {})).proposalId, offered.proposalId);

  const malformedTombstone = structuredClone(first.entries.filter((entry) => entry.customType !== "goal-engine-runtime-approval-decision")); malformedTombstone.push({ type: "custom", customType: "goal-engine-runtime-approval-consumed", data: { id: first.entries.find((entry) => entry.customType === "goal-engine-runtime-approval-challenge").data.id, extra: "forged" } });
  const tombstoneReload = pi(cwd, malformedTombstone); tombstoneReload.cwd = cwd; createGoalEngineExtension(tombstoneReload, { goalStateEnv: {}, runtimeHost: host(cwd) }); tombstoneReload.handlers.get("session_start")({}, { sessionManager: tombstoneReload.sessionManager });
  assert.notEqual(JSON.parse(await invoke(tombstoneReload, "goal_status", {})).proposalId, offered.proposalId);

  const malformedIntent = structuredClone(first.entries.filter((entry) => entry.customType !== "goal-engine-runtime-approval-decision")); malformedIntent.push({ type: "custom", customType: "goal-engine-runtime-intent-pending", data: { goalId: "harden-runtime", sessionId: "owner", userEntryId: "intent-entry", source: "interactive", occurredAt: new Date().toISOString(), extra: "forged" } });
  const intentReload = pi(cwd, malformedIntent); intentReload.cwd = cwd; createGoalEngineExtension(intentReload, { goalStateEnv: {}, runtimeHost: host(cwd) }); intentReload.handlers.get("session_start")({}, { sessionManager: intentReload.sessionManager });
  assert.notEqual(JSON.parse(await invoke(intentReload, "goal_status", {})).status, "R10B_SUSPENSION_REQUIRED");
});

test("goal_status drives one-condition Cycle0 through request, terminal, record, release, and activation", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd;
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: observationHost(cwd) });
  await invoke(api, "goal_init", runtimeInit()); await invoke(api, "goal_status", {});
  api.handlers.get("input")({ source: "interactive", text: "approve", entryId: "approve-observation" }, { cwd, sessionManager: api.sessionManager });
  await invoke(api, "goal_status", {}); // consume approval only
  for (let i = 0; i < 5; i++) await invoke(api, "goal_status", {});
  const projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(projection.runtimeState, "active");
  assert.deepEqual([...projection.observationRuns.values()].map(run => run.phase), ["released"]);
  assert.equal(projection.findings.size, 0);
  assert.deepEqual(projection.conditions.get("condition-1").supportingEvidenceIds, []);
});

test("calibrating runtime without Host observation wiring fails closed without observation events", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd;
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd) });
  await invoke(api, "goal_init", runtimeInit());
  await invoke(api, "goal_status", {});
  api.handlers.get("input")({ source: "interactive", text: "approve", entryId: "approve-no-observation-host" }, { cwd, sessionManager: api.sessionManager });
  await invoke(api, "goal_status", {}); // approval consumption is not a calibration step
  const status = JSON.parse(await invoke(api, "goal_status", {}));
  assert.equal(status.status, "RUNTIME_OBSERVATION_HOST_UNAVAILABLE");
  const projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(projection.observationRuns.size, 0);
});

test("Cycle0 JSONL authority sequence is single-step and exactly once", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd);
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(api, cwd);
  const afterApproval = observationEvents(cwd).filter(name => name === "condition.observation_requested"); await invoke(api, "goal_status", {}); assert.equal(observationEvents(cwd).filter(name => name === "condition.observation_requested").length, afterApproval.length + 1); // request only
  for (let i = 0; i < 4; i++) await invoke(api, "goal_status", {});
  const names = observationEvents(cwd).filter(name => name.startsWith("condition.observation") || name === "goal.runtime_activated");
  assert.deepEqual(names, ["condition.observation_requested", "condition.observation_lease_allocated", "condition.observation_process_bound", "condition.observation_terminal", "condition.observation_recorded", "condition.observation_released", "goal.runtime_activated"]);
  for (const name of names) assert.equal(names.filter(value => value === name).length, 1);
  assert.equal(durable.calls.start, 1); assert.equal(durable.calls.release, 1);
});

test("Cycle0 Conditions run in definition order and never overlap", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; const second = structuredClone(runtimeInit().execution.conditions[0]); second.id = "condition-2";
  const durable = observationHost(cwd); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(api, cwd, runtimeInit({ execution: { ...runtimeInit().execution, conditions: [runtimeInit().execution.conditions[0], second] } }));
  await statusUntil(api, "recorded"); let projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"); assert.equal([...projection.observationRuns.values()].filter(run => run.conditionId === "condition-2").length, 0);
  await invoke(api, "goal_status", {}); await invoke(api, "goal_status", {}); await statusUntil(api, "released"); await invoke(api, "goal_status", {});
  projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"); assert.deepEqual([...projection.observationRuns.values()].map(run => run.conditionId), ["condition-1", "condition-2"]);
});

test("Cycle0 reload retains allocation identity through each durable phase", async () => {
  for (const phase of ["requested", "process_bound", "terminal", "recorded", "released"]) {
    const cwd = repo(), first = pi(cwd); first.cwd = cwd; const durable = observationHost(cwd, phase === "process_bound" ? { holdProcess: true } : phase === "terminal" ? { holdTerminal: true } : {});
    createGoalEngineExtension(first, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(first, cwd); await statusUntil(first, phase === "terminal" ? "process_bound" : phase);
    const before = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"); const run = [...before.observationRuns.values()][0], allocationId = run.allocationId;
    const reloaded = pi(cwd, first.entries); reloaded.cwd = cwd; createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: durable }); reloaded.handlers.get("session_start")({}, { sessionManager: reloaded.sessionManager }); await invoke(reloaded, "goal_status", {});
    const after = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"); assert.equal(phase === "requested" ? Boolean([...after.observationRuns.values()][0].allocationId) : [...after.observationRuns.values()][0].allocationId === allocationId, true, phase);
    assert.equal(new Set(observationEvents(cwd).filter(name => name === "condition.observation_requested")).size, 1, phase);
  }
});

test("Cycle0 rejects allocation and receipt-root identity mismatch without mutation", async () => {
  for (const options of [{ allocation: "mismatch" }, { receiptRoot: "/tmp/outside-goal-root" }]) {
    const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd, options); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(api, cwd); await invoke(api, "goal_status", {}); const before = observationEvents(cwd); const status = JSON.parse(await invoke(api, "goal_status", {}));
    assert.equal(status.status, "RUNTIME_CALIBRATION_MANAGED_ATTENTION"); assert.deepEqual(observationEvents(cwd), before); assert.equal(durable.calls.start, 0);
  }
});

test("Cycle0 HEAD drift blocks inherited run and artifact safety rejects unsafe files", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(api, cwd); await invoke(api, "goal_status", {}); writeFileSync(join(cwd, "drift"), "x"); git(cwd, "add", "drift"); git(cwd, "commit", "-m", "drift"); const before = observationEvents(cwd); const status = JSON.parse(await invoke(api, "goal_status", {})); assert.equal(status.status, "RUNTIME_CALIBRATION_MANAGED_ATTENTION"); assert.deepEqual(observationEvents(cwd), before);
  const bad = repo(), badApi = pi(bad); badApi.cwd = bad; const unsafe = observationHost(bad, { artifactMode: 0o644 }); createGoalEngineExtension(badApi, { goalStateEnv: {}, runtimeHost: unsafe }); await approveCalibration(badApi, bad); await statusUntil(badApi, "terminal"); const prior = observationEvents(bad); const unsafeStatus = JSON.parse(await invoke(badApi, "goal_status", {})); assert.equal(unsafeStatus.status, "RUNTIME_CALIBRATION_MANAGED_ATTENTION"); assert.equal(observationEvents(bad).filter(name => name === "condition.observation_recorded").length, prior.filter(name => name === "condition.observation_recorded").length); assert.equal(JSON.stringify(unsafeStatus).includes("cycle0-artifact"), false);
});

test("Cycle0 verdict matrix activates only PASS and FAIL", async () => {
  for (const [code, active] of [["PASS", true], ["FAIL", true], ["UNKNOWN", false], ["INFRA", false]]) {
    const cwd = repo(), api = pi(cwd); api.cwd = cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: observationHost(cwd, { code }) }); await approveCalibration(api, cwd); for (let i = 0; i < 5; i++) await invoke(api, "goal_status", {});
    const projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"); assert.equal(projection.runtimeState === "active", active, code); assert.equal(projection.findings.size, 0, code); assert.deepEqual(projection.conditions.get("condition-1").supportingEvidenceIds, [], code);
  }
});

test("artifact symlink rejects recording without exposing its path", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: observationHost(cwd, { artifactSymlink: true }) }); await approveCalibration(api, cwd); await statusUntil(api, "terminal"); const before = observationEvents(cwd); const status = JSON.parse(await invoke(api, "goal_status", {})); assert.equal(status.status, "RUNTIME_CALIBRATION_MANAGED_ATTENTION"); assert.equal(observationEvents(cwd).filter(name => name === "condition.observation_recorded").length, before.filter(name => name === "condition.observation_recorded").length); assert.equal(JSON.stringify(status).includes("cycle0-artifact"), false);
});

test("runtime Host cannot override Extension-owned Store authority", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; let poisoned = 0; const durable = observationHost(cwd); Object.assign(durable, { loadProjection() { poisoned++; }, persistEvent() { poisoned++; }, originRoot: "/evil", stateRoot: "/evil", integratedHead: "evil" }); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(api, cwd); await invoke(api, "goal_status", {}); assert.equal(poisoned, 0); assert.equal(observationEvents(cwd).includes("condition.observation_requested"), true);
});

test("runtime status checkpoints are exact, monotonic, and fingerprint-stable without semantic progress", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd) }); const initialized = JSON.parse(await invoke(api, "goal_init", runtimeInit())); await invoke(api, "goal_status", {}); await invoke(api, "goal_status", {});
  const ledger = loadProjection(join(cwd, ".state/goal-engine"), initialized.goalId).progressLedger; assert.deepEqual(ledger.map(({ sequence, advanced }) => ({ sequence, advanced })), [{ sequence: 1, advanced: true }, { sequence: 2, advanced: false }]); assert.equal(ledger[0].canonicalFingerprint, ledger[1].canonicalFingerprint);
});
