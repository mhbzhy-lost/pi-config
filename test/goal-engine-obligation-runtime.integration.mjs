import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { appendEvent, appendEventBatch, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { compileTaskContract } from "../scripts/lib/goal-engine/dispatch.mjs";
import { splitDispatchEnvelope } from "../scripts/lib/goal-engine/dispatch-ir.mjs";
import { applyEvent } from "../scripts/lib/goal-engine/events.mjs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function host(cwd) { return { registries: runtimeRegistries, captureCurrentWorld() { return { safe: true, repo: { root: cwd, head: git(cwd, "rev-parse", "HEAD"), trackedDirty: [], untracked: [], sequencer: null }, adapters: [], environments: [], fixtures: [], resources: [], activeRuns: [], capturedAt: new Date().toISOString() }; } }; }
function observationHost(cwd, { code = "PASS", codes = null, environments = null, holdAfterStart = 0, receiptRoot = join(cwd, ".state/goal-engine"), receiptPath = join(receiptRoot, "managed-validations"), receiptId = null, workspacePath = null, allocation = "normal", prepareError = null, artifactMode = 0o600, artifactSymlink = false, holdBeforeProcess = false, holdProcess = false, holdTerminal = false, adapters = [{ ref: "oracle", resourceClaims: [] }] } = {}) {
  const adapterRows = adapters.map(({ ref, resourceClaims = [] }) => ({ ref, version: "1", deterministic: true, reset: "clean", resourceClaims, artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" }, validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] } }));
  const registry = createObservationAdapterRegistry(adapterRows), claims = new Map(adapterRows.map(adapter => [adapter.ref, adapter.resourceClaims]));
  const calls = { prepare: 0, start: 0, recover: 0, release: 0, artifact: 0, startsByRun: new Map() }, state = new Map();
  const receipt = input => { const id = receiptId ?? (allocation === "mismatch" ? `managed-${calls.prepare}` : `managed-${createHash("sha256").update(`${input.ownerKind}:${input.ownerId}:${input.integratedHead}`).digest("hex").slice(0, 16)}`); const prior = state.get(id) || { phase: "lease_allocated", terminal: null, ownerRunId: input.ownerId, resourceClaims: input.resourceClaims }; if (!state.has(id)) state.set(id, prior); return { id, stateRoot: receiptRoot, receiptPath: join(receiptPath, `${id}.json`), workspacePath, phase: prior.phase, terminal: prior.terminal, recorded: null, recordCount: 0, cleanupDebt: false }; };
  const terminal = { status: "passed", code: 0 }, forArtifact = values => Array.isArray(values) ? values[Math.min(Math.max(0, calls.artifact - 1), values.length - 1)] : values, shouldHold = () => calls.start > holdAfterStart;
  const managed = value => ({ ...value, phase: state.get(value.id)?.phase || value.phase, terminal: state.get(value.id)?.terminal || null });
  const setPhase = (value, phase, terminalValue = null) => { const prior = state.get(value.id); state.set(value.id, { ...prior, phase, terminal: terminalValue }); };
  const resources = () => [...new Map([...claims.values()].flat().map(claim => [claim.key, claim])).values()].map(claim => ({ key: claim.key, capacity: claim.capacity, holders: [...state.values()].filter(value => value.phase !== "released" && value.resourceClaims.some(other => other.key === claim.key)).map(value => value.ownerRunId).sort() }));
  return { registries: { ...runtimeRegistries, adapters: Object.fromEntries(adapterRows.map(adapter => [adapter.ref, { deterministic: true }])) }, adapterRegistry: registry, calls, captureCurrentWorld() { return { safe: true, repo: { root: cwd, head: git(cwd, "rev-parse", "HEAD"), trackedDirty: [], untracked: [], sequencer: null }, adapters: adapterRows.map(({ ref, version }) => ({ ref, version })), environments: [{ ref: "local", fingerprint: forArtifact(environments) || "local-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "sample-1", available: true }], resources: resources(), activeRuns: [...state.values()].filter(value => value.phase === "process_bound").map(value => ({ runId: value.ownerRunId, kind: "observation", state: "running" })), capturedAt: new Date().toISOString() }; }, prepareManagedValidation(input) { calls.prepare++; if (prepareError) throw Error(prepareError); const conflict = [...state.values()].some(value => value.ownerRunId !== input.ownerId && value.phase !== "released" && value.resourceClaims.some(left => input.resourceClaims.some(right => left.key === right.key && (left.mode === "exclusive" || right.mode === "exclusive" || left.reset !== right.reset || left.capacity <= 1 || right.capacity <= 1)))); if (conflict) throw Error("Validation resource conflict"); return receipt(input); }, inspectManagedValidation(value) { return managed(value); }, async startManagedValidation(value, { onProcessBound }) { calls.start++; const ownerRunId = state.get(value.id).ownerRunId; calls.startsByRun.set(ownerRunId, (calls.startsByRun.get(ownerRunId) || 0) + 1); if (holdBeforeProcess && shouldHold() && calls.start > 1) throw Error("interrupt before durable process"); setPhase(value, "process_bound"); await onProcessBound({ processIdentityHash: createHash("sha256").update(value.id).digest("hex") }); if (holdProcess && shouldHold()) throw Error("interrupt after durable process"); setPhase(value, "recorded", terminal); if (holdTerminal && shouldHold()) throw Error("interrupt after durable managed terminal"); return managed(value); }, async recoverManagedValidation(value, { onProcessBound }) { calls.recover++; if ((state.get(value.id)?.phase || "lease_allocated") === "process_bound") { setPhase(value, "recorded", terminal); return managed(value); } if ((state.get(value.id)?.phase || "lease_allocated") !== "lease_allocated") return managed(value); setPhase(value, "process_bound"); await onProcessBound({ processIdentityHash: createHash("sha256").update(value.id).digest("hex") }); setPhase(value, "recorded", terminal); return managed(value); }, releaseManagedValidation(value) { calls.release++; setPhase(value, "released", terminal); return { id: value.id, released: true }; }, completeManagedValidation(runId) { const entry = [...state.entries()].find(([, value]) => value.ownerRunId === runId); if (!entry || entry[1].phase !== "process_bound") throw Error("managed run is not process bound"); state.set(entry[0], { ...entry[1], phase: "recorded", terminal }); }, artifactRefForRun() { calls.artifact++; const path = join(cwd, ".state", "cycle0-artifact.json"), target = join(cwd, ".state", "cycle0-artifact-target.json"); writeFileSync(artifactSymlink ? target : path, JSON.stringify({ code: forArtifact(codes) || code }), { mode: artifactMode }); chmodSync(artifactSymlink ? target : path, artifactMode); if (artifactSymlink) symlinkSync(target, path); return { id: "cycle0-artifact", path }; } };
}
function observationEventRows(cwd) { return readFileSync(join(cwd, ".state/goal-engine/goals/harden-runtime/events.jsonl"), "utf8").trim().split("\n").map(JSON.parse); }
function observationEvents(cwd) { return observationEventRows(cwd).map(event => event.type); }
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

test("active status drives the R9-selected product observation and excludes Cycle0 evidence", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd;
  const condition = structuredClone(runtimeInit().execution.conditions[0]); condition.depends_on = []; condition.invalidation.task_ids = [];
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: observationHost(cwd) });
  await approveCalibration(api, cwd, runtimeInit({ execution: { ...runtimeInit().execution, tasks: [], conditions: [condition] } }));
  for (let i = 0; i < 5; i++) await invoke(api, "goal_status", {});
  let projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(projection.runtimeState, "active");
  assert.deepEqual(projection.conditions.get("condition-1").supportingEvidenceIds, []);
  for (let i = 0; i < 4; i++) await invoke(api, "goal_status", {});
  projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  const runs = [...projection.observationRuns.values()];
  assert.deepEqual(runs.map(run => run.cycle), [0, 1]);
  assert.deepEqual(runs.map(run => run.phase), ["released", "released"]);
  assert.equal(projection.conditions.get("condition-1").status, "satisfied");
  assert.equal(projection.conditions.get("condition-1").supportingEvidenceIds.length, 1);
  assert.equal(observationEvents(cwd).filter(name => name === "condition.observation_requested").length, 2);
});

test("active lease allocation reload recovers its durable allocation without another start", async () => {
  const cwd = repo(), first = pi(cwd); first.cwd = cwd;
  const condition = structuredClone(runtimeInit().execution.conditions[0]); condition.depends_on = []; condition.invalidation.task_ids = [];
  const durable = observationHost(cwd, { holdBeforeProcess: true });
  createGoalEngineExtension(first, { goalStateEnv: {}, runtimeHost: durable });
  await approveCalibration(first, cwd, runtimeInit({ execution: { ...runtimeInit().execution, tasks: [], conditions: [condition] } }));
  await statusUntil(first, "released"); await invoke(first, "goal_status", {}); // activate
  await invoke(first, "goal_status", {}); // request cycle 1
  await invoke(first, "goal_status", {}); // durable lease allocation, interrupted before process
  let projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  const run = [...projection.observationRuns.values()].find(value => value.cycle === 1);
  assert.equal(run.phase, "lease_allocated"); const allocationId = run.allocationId;
  const startsBeforeReload = durable.calls.start, recoversBeforeReload = durable.calls.recover;
  assert.equal(startsBeforeReload, 2);

  const reloaded = pi(cwd, first.entries); reloaded.cwd = cwd;
  createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: durable }); reloaded.handlers.get("session_start")({}, { sessionManager: reloaded.sessionManager });
  const status = JSON.parse(await invoke(reloaded, "goal_status", {}));
  projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal([...projection.observationRuns.values()].find(value => value.cycle === 1).phase, "terminal", JSON.stringify({ status, calls: durable.calls }));
  assert.equal([...projection.observationRuns.values()].find(value => value.cycle === 1).allocationId, allocationId);
  assert.equal(durable.calls.start, startsBeforeReload); assert.equal(durable.calls.recover, recoversBeforeReload + 1);
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

test("Cycle0 persists one requested intent before managed allocation", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd);
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(api, cwd);
  await invoke(api, "goal_status", {});
  assert.deepEqual(observationEvents(cwd).filter(name => name.startsWith("condition.observation")), ["condition.observation_requested"]);
  assert.equal(durable.calls.prepare, 0); assert.equal(durable.calls.start, 0);
  await invoke(api, "goal_status", {});
  assert.equal(durable.calls.prepare, 1); assert.equal(durable.calls.start, 1);
  for (let i = 0; i < 3; i++) await invoke(api, "goal_status", {});
  const names = observationEvents(cwd).filter(name => name.startsWith("condition.observation") || name === "goal.runtime_activated");
  assert.deepEqual(names, ["condition.observation_requested", "condition.observation_lease_allocated", "condition.observation_process_bound", "condition.observation_terminal", "condition.observation_recorded", "condition.observation_released", "goal.runtime_activated"]);
  for (const name of names) assert.equal(names.filter(value => value === name).length, 1);
  assert.equal(durable.calls.release, 1);
});

test("Cycle0 request identity rejects Host adapter version and claims drift before managed actions", async () => {
  for (const [version, resourceClaims] of [["2", []], ["1", [{ key: "fixture:changed", mode: "exclusive", capacity: 1, reset: "clean" }]]]) {
    const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd);
    createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(api, cwd); await invoke(api, "goal_status", {});
    const before = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime").observationRuns.values().next().value;
    durable.adapterRegistry = createObservationAdapterRegistry([{ ref: "oracle", version, deterministic: true, reset: "clean", resourceClaims, artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" }, validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] } }]);
    const status = JSON.parse(await invoke(api, "goal_status", {})); const after = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime").observationRuns.values().next().value;
    assert.equal(status.status, "RUNTIME_CALIBRATION_MANAGED_ATTENTION"); assert.equal(durable.calls.prepare, 0); assert.equal(durable.calls.start, 0); assert.equal(after.phase, "requested"); assert.deepEqual(after.adapter, before.adapter);
  }
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
    const after = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"), restored = [...after.observationRuns.values()][0]; assert.equal(phase === "requested" ? Boolean(restored.allocationId) : restored.allocationId === allocationId, true, phase);
    assert.deepEqual(Object.fromEntries(["head", "executionRevision", "executionContractHash", "conditionHash", "adapter", "worldSnapshotHash", "resourceClaimsHash"].map(key => [key, restored[key]])), Object.fromEntries(["head", "executionRevision", "executionContractHash", "conditionHash", "adapter", "worldSnapshotHash", "resourceClaimsHash"].map(key => [key, run[key]])), phase);
    assert.equal(new Set(observationEvents(cwd).filter(name => name === "condition.observation_requested")).size, 1, phase);
  }
});

test("Cycle0 rejects rebuilt allocation and receipt-root identity mismatch without mutation", async () => {
  const cwd = repo(), first = pi(cwd); first.cwd = cwd; const durable = observationHost(cwd, { allocation: "mismatch", holdProcess: true }); createGoalEngineExtension(first, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(first, cwd); await invoke(first, "goal_status", {}); await invoke(first, "goal_status", {});
  const before = observationEvents(cwd), starts = durable.calls.start, recovers = durable.calls.recover;
  const reloaded = pi(cwd, first.entries); reloaded.cwd = cwd; createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: durable }); reloaded.handlers.get("session_start")({}, { sessionManager: reloaded.sessionManager }); const status = JSON.parse(await invoke(reloaded, "goal_status", {}));
  assert.equal(status.status, "RUNTIME_CALIBRATION_MANAGED_ATTENTION"); assert.deepEqual(observationEvents(cwd).filter(name => name !== "goal.checkpoint"), before.filter(name => name !== "goal.checkpoint")); assert.equal(durable.calls.start, starts); assert.equal(durable.calls.recover, recovers);

  const outside = repo(), outsideApi = pi(outside); outsideApi.cwd = outside; const invalid = observationHost(outside, { receiptRoot: "/tmp/outside-goal-root" }); createGoalEngineExtension(outsideApi, { goalStateEnv: {}, runtimeHost: invalid }); await approveCalibration(outsideApi, outside); await invoke(outsideApi, "goal_status", {}); const outsideBefore = observationEvents(outside); const outsideStatus = JSON.parse(await invoke(outsideApi, "goal_status", {}));
  assert.equal(outsideStatus.status, "RUNTIME_CALIBRATION_MANAGED_ATTENTION"); assert.deepEqual(observationEvents(outside).filter(name => name !== "goal.checkpoint"), outsideBefore.filter(name => name !== "goal.checkpoint")); assert.equal(invalid.calls.start, 0);
});

test("Cycle0 rejects unsafe managed receipts after durable requested intent", async () => {
  const cases = [
    { name: "path traversal id", receiptId: "../escape" }, { name: "slash id", receiptId: "managed/receipt" },
    { name: "whitespace id", receiptId: "managed receipt" }, { name: "NUL id", receiptId: "managed\0receipt" },
    { name: "relative state root", receiptRoot: "relative-root" }, { name: "relative receipt path", receiptPath: "relative-receipts" },
    { name: "outside receipt ledger", receiptPath: "/tmp/outside-managed-validations" }, { name: "relative workspace", workspacePath: "relative-workspace" }, { name: "outside workspace", workspacePath: "/tmp/outside-workspace" },
  ];
  for (const options of cases) {
    const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd, options);
    createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(api, cwd);
    await invoke(api, "goal_status", {});
    assert.deepEqual(observationEvents(cwd).filter(name => name.startsWith("condition.observation")), ["condition.observation_requested"], options.name);
    assert.equal(durable.calls.prepare, 0, options.name); assert.equal(durable.calls.start, 0, options.name);
    const status = JSON.parse(await invoke(api, "goal_status", {}));
    assert.equal(status.status, "RUNTIME_CALIBRATION_MANAGED_ATTENTION", options.name);
    assert.deepEqual(observationEvents(cwd).filter(name => name.startsWith("condition.observation")), ["condition.observation_requested"], options.name);
    assert.equal(durable.calls.prepare, 1, options.name); assert.equal(durable.calls.start, 0, options.name); assert.equal(durable.calls.artifact, 0, options.name);
  }
});

test("Cycle0 preserves requested recovery authority when prepare throws", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd, { prepareError: "prepare crash" });
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(api, cwd); await invoke(api, "goal_status", {});
  const before = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"); const runId = [...before.observationRuns.keys()][0];
  const status = JSON.parse(await invoke(api, "goal_status", {})); assert.equal(status.status, "RUNTIME_CALIBRATION_MANAGED_ATTENTION"); assert.equal(durable.calls.prepare, 1); assert.equal(durable.calls.start, 0);
  const reloaded = pi(cwd, api.entries); reloaded.cwd = cwd; createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: durable }); reloaded.handlers.get("session_start")({}, { sessionManager: reloaded.sessionManager }); await invoke(reloaded, "goal_status", {});
  const after = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"); assert.equal(after.observationRuns.size, 1); assert.equal([...after.observationRuns.keys()][0], runId); assert.equal([...after.observationRuns.values()][0].phase, "requested");
});

test("Cycle0 HEAD drift blocks inherited run and artifact safety rejects unsafe files", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await approveCalibration(api, cwd); await invoke(api, "goal_status", {}); writeFileSync(join(cwd, "drift"), "x"); git(cwd, "add", "drift"); git(cwd, "commit", "-m", "drift"); const before = observationEvents(cwd); const status = JSON.parse(await invoke(api, "goal_status", {})); assert.equal(status.status, "RUNTIME_CALIBRATION_MANAGED_ATTENTION"); assert.deepEqual(observationEvents(cwd).filter(name => name !== "goal.checkpoint"), before.filter(name => name !== "goal.checkpoint"));
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

function activeCondition(stability = { mode: "single", require_fresh_environment: true }) {
  const condition = structuredClone(runtimeInit().execution.conditions[0]);
  condition.depends_on = []; condition.invalidation.task_ids = []; condition.stability = stability;
  return condition;
}
async function activateProduct(api, cwd, condition) {
  await approveCalibration(api, cwd, runtimeInit({ execution: { ...runtimeInit().execution, tasks: [], conditions: [condition] } }));
  await statusUntil(api, "released"); await invoke(api, "goal_status", {});
}
function activeConditions(resourceB) {
  const a = activeCondition(), b = activeCondition();
  a.id = "condition-a"; a.oracle_ref = "oracle-a";
  b.id = "condition-b"; b.oracle_ref = "oracle-b";
  return { conditions: [a, b], adapters: [{ ref: "oracle-a", resourceClaims: [{ key: "resource-a", mode: "exclusive", capacity: 1, reset: "clean" }] }, { ref: "oracle-b", resourceClaims: [{ key: resourceB, mode: "exclusive", capacity: 1, reset: "clean" }] }] };
}
async function activateConditions(api, cwd, conditions) {
  await approveCalibration(api, cwd, runtimeInit({ execution: { ...runtimeInit().execution, tasks: [], conditions } }));
  for (let i = 0; i < 12; i++) { if (loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime").runtimeState === "active") return; await invoke(api, "goal_status", {}); }
  throw Error("two-condition runtime did not activate");
}
async function cycleUntil(api, cycle, phase, limit = 10) {
  for (let i = 0; i < limit; i++) {
    await invoke(api, "goal_status", {});
    const projection = loadProjection(join(api.cwd, ".state/goal-engine"), "harden-runtime");
    const run = [...projection.observationRuns.values()].find(value => value.cycle === cycle);
    if (run?.phase === phase) return { projection, run };
  }
  throw Error(`cycle ${cycle} phase not reached: ${phase}`);
}
async function firstProductProcessBound(api, limit = 10) {
  for (let i = 0; i < limit; i++) { await invoke(api, "goal_status", {}); const projection = loadProjection(join(api.cwd, ".state/goal-engine"), "harden-runtime"); const run = [...projection.observationRuns.values()].find(value => value.cycle === 1 && value.phase === "process_bound"); if (run) return { projection, run }; }
  throw Error("product process_bound not reached");
}
function runEvents(cwd, runId, type) { return observationEventRows(cwd).filter(event => event.type === type && event.data.runId === runId); }

function injectedStore(seed, failure = () => null) {
  let current = structuredClone(seed); const batches = [], events = [];
  const apply = (entries, version) => {
    assert.equal(version, current.version); for (const entry of entries) current = applyEvent(current, entry);
    events.push(...entries); batches.push(entries); return current;
  };
  return {
    store: {
      listGoals: () => [current.goalId], listGoalIds: () => [current.goalId], loadProjection: (_root, goalId) => goalId === current.goalId ? current : null,
      appendEvent(_root, entry, version) { const mode = failure([entry]); if (mode === "pre") throw Error("injected pre-append failure"); const result = apply([entry], version); if (mode === "durable") throw Error("injected durable failure"); return result; },
      appendEventBatch(_root, entries, version) { const mode = failure(entries); if (mode === "pre") throw Error("injected pre-append failure"); const result = apply(entries, version); if (mode === "durable") throw Error("injected durable failure"); return result; },
    },
    latest: () => current, batches, events,
  };
}

async function makeReverifyingRuntimeFixture() {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd, { codes: ["PASS", "FAIL", "PASS"] });
  const condition = activeCondition(); condition.remediation.policy = "autonomous";
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable });
  await activateProduct(api, cwd, condition); await cycleUntil(api, 1, "terminal"); await invoke(api, "goal_status", {}); await cycleUntil(api, 1, "released"); await invoke(api, "goal_status", {});
  const initial = structuredClone(loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"));
  const [taskId, task] = [...initial.tasks.entries()][0]; task.status = "succeeded"; task.workspace = { attempt: 1, phase: "disposed", disposition: "integrated", released: true };
  const injected = injectedStore(initial); const accepting = pi(cwd); accepting.cwd = cwd;
  createGoalEngineExtension(accepting, { goalStateEnv: {}, enforceActionTokens: false, store: injected.store });
  await invoke(accepting, "goal_accept", { goal_id: initial.goalId, task_id: taskId, action_token: "schema-required" });
  const projection = injected.latest(), episode = [...projection.repairEpisodes.values()][0];
  assert.equal(episode.status, "reverifying"); assert.deepEqual(injected.batches.at(-1).map(event => event.type), ["task.accepted", "repair.reverification_requested"]);
  return { cwd, durable, taskId, episodeId: episode.episodeId, injected };
}

test("Repair re-observation request/link pre-append failure leaves no run, while durable failure reloads one owned run", async () => {
  { const fixture = await makeReverifyingRuntimeFixture(); const before = { prepare: fixture.durable.calls.prepare, start: fixture.durable.calls.start }; const injected = injectedStore(fixture.injected.latest(), entries => entries.map(event => event.type).join(",") === "condition.observation_requested,repair.observation_linked" ? "pre" : null); const api = pi(fixture.cwd); api.cwd = fixture.cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: fixture.durable, store: injected.store }); await assert.rejects(invoke(api, "goal_status", {}), /injected pre-append failure/); const projection = injected.latest(); assert.equal(projection.observationRuns.size, 2); assert.equal(projection.repairEpisodes.get(fixture.episodeId).ownedRunIds.length, 0); assert.equal(fixture.durable.calls.prepare - before.prepare, 0); assert.equal(fixture.durable.calls.start - before.start, 0); assert.equal(injected.events.filter(event => ["condition.observation_requested", "repair.observation_linked"].includes(event.type)).length, 0); }
  { const fixture = await makeReverifyingRuntimeFixture(); const before = { prepare: fixture.durable.calls.prepare, start: fixture.durable.calls.start }; let threw = false; const injected = injectedStore(fixture.injected.latest(), entries => !threw && entries.map(event => event.type).join(",") === "condition.observation_requested,repair.observation_linked" ? (threw = true, "durable") : null); const api = pi(fixture.cwd); api.cwd = fixture.cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: fixture.durable, store: injected.store }); await invoke(api, "goal_status", {}); let projection = injected.latest(), episode = projection.repairEpisodes.get(fixture.episodeId); assert.equal(episode.ownedRunIds.length, 1); const runId = episode.ownedRunIds[0]; assert.equal(projection.observationRuns.get(runId).phase, "requested"); assert.equal(fixture.durable.calls.prepare - before.prepare, 0); assert.equal(fixture.durable.calls.start - before.start, 0); const reload = pi(fixture.cwd); reload.cwd = fixture.cwd; createGoalEngineExtension(reload, { goalStateEnv: {}, runtimeHost: fixture.durable, store: injected.store }); await invoke(reload, "goal_status", {}); projection = injected.latest(); assert.equal(projection.observationRuns.size, 3); assert.equal(projection.repairEpisodes.get(fixture.episodeId).ownedRunIds[0], runId); assert.equal(fixture.durable.calls.startsByRun.get(runId), 1); assert.equal(injected.events.filter(event => event.type === "condition.observation_requested").length, 1); assert.equal(injected.events.filter(event => event.type === "repair.observation_linked").length, 1); }
});

test("Repair re-observation record/resolve batches are atomic before and after durable failure", async () => {
  for (const mode of ["pre", "durable"]) {
    const fixture = await makeReverifyingRuntimeFixture(); let enabled = false, threw = false;
    const injected = injectedStore(fixture.injected.latest(), entries => enabled && !threw && entries.map(event => event.type).join(",") === "condition.observation_recorded,repair.episode_resolved" ? (threw = true, mode) : null);
    const api = pi(fixture.cwd); api.cwd = fixture.cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: fixture.durable, store: injected.store }); await invoke(api, "goal_status", {}); await invoke(api, "goal_status", {}); enabled = true; await invoke(api, "goal_status", {});
    let projection = injected.latest(), episode = projection.repairEpisodes.get(fixture.episodeId), runId = episode.ownedRunIds[0];
    if (mode === "pre") { assert.equal(projection.observationRuns.get(runId).phase, "terminal"); assert.equal(episode.status, "reverifying"); assert.equal(injected.events.filter(event => ["condition.observation_recorded", "repair.episode_resolved"].includes(event.type)).length, 0); enabled = false; await invoke(api, "goal_status", {}); projection = injected.latest(); episode = projection.repairEpisodes.get(fixture.episodeId); assert.equal(episode.status, "resolved"); }
    else { assert.equal(projection.observationRuns.get(runId).phase, "recorded"); assert.equal(episode.status, "resolved"); const reload = pi(fixture.cwd); reload.cwd = fixture.cwd; createGoalEngineExtension(reload, { goalStateEnv: {}, runtimeHost: fixture.durable, store: injected.store }); await invoke(reload, "goal_status", {}); projection = injected.latest(); assert.equal(projection.observationRuns.get(runId).phase, "released"); }
    assert.equal(injected.events.filter(event => event.type === "condition.observation_recorded").length, 1); assert.equal(injected.events.filter(event => event.type === "repair.episode_resolved").length, 1); assert.equal(injected.events.some(event => event.type === "goal.completed"), false); if (mode === "pre") { await invoke(api, "goal_status", {}); projection = injected.latest(); assert.equal(projection.observationRuns.get(runId).phase, "released"); }
  }
});

test("active reload matrix preserves each product run through requested, process-bound, terminal, and recorded", async () => {
  for (const phase of ["requested", "process_bound", "terminal", "recorded"]) {
    const cwd = repo(), first = pi(cwd); first.cwd = cwd;
    const durable = observationHost(cwd, { holdAfterStart: 1, ...(phase === "process_bound" ? { holdProcess: true } : phase === "terminal" ? { holdTerminal: true } : {}) });
    createGoalEngineExtension(first, { goalStateEnv: {}, runtimeHost: durable }); await activateProduct(first, cwd, activeCondition());
    if (phase === "requested") await cycleUntil(first, 1, "requested");
    else if (phase === "process_bound") await cycleUntil(first, 1, "process_bound");
    else if (phase === "terminal") await cycleUntil(first, 1, "terminal");
    else await cycleUntil(first, 1, "recorded");
    const before = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
    const prior = [...before.observationRuns.values()].find(run => run.cycle === 1), starts = durable.calls.start;
    const reloaded = pi(cwd, first.entries); reloaded.cwd = cwd;
    createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: durable }); reloaded.handlers.get("session_start")({}, { sessionManager: reloaded.sessionManager });
    if (phase === "process_bound") durable.completeManagedValidation(prior.runId);
    await cycleUntil(reloaded, 1, "released");
    const restored = [...loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime").observationRuns.values()].find(run => run.cycle === 1);
    assert.equal(restored.runId, prior.runId, phase); assert.equal(restored.allocationId, prior.allocationId || restored.allocationId, phase);
    assert.equal(durable.calls.start - starts, phase === "requested" ? 1 : 0, phase);
    for (const type of ["condition.observation_terminal", "condition.observation_recorded", "condition.observation_released"]) assert.equal(runEvents(cwd, restored.runId, type).length, 1, `${phase}:${type}`);
  }
});

test("active future-wake starts an independently resourced requested Condition without another supervisor", async () => {
  const cwd = repo(), api = pi(cwd), fixture = activeConditions("resource-b"); api.cwd = cwd;
  const durable = observationHost(cwd, { adapters: fixture.adapters, holdAfterStart: 2, holdProcess: true });
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await activateConditions(api, cwd, fixture.conditions);
  const { projection: activeProjection, run: a } = await firstProductProcessBound(api); let projection = activeProjection;
  const b = [...projection.observationRuns.values()].find(run => run.cycle === 1 && run.runId !== a.runId);
  assert.equal(b.phase, "requested"); assert.equal(durable.calls.startsByRun.get(a.runId), 1);
  const status = JSON.parse(await invoke(api, "goal_status", {})); // R9 starts the other requested Condition despite A future-wake
  projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(projection.observationRuns.get(b.runId).phase, "process_bound"); assert.equal(durable.calls.startsByRun.get(a.runId), 1); assert.equal(durable.calls.startsByRun.get(b.runId), 1);
  assert.equal(status.blocking.some(item => item.id === a.runId && item.code === "OBSERVATION_FUTURE_WAKE"), true);
  for (const run of [a, b]) assert.equal(runEvents(cwd, run.runId, "condition.observation_requested").length, 1);
});

test("shared exclusive resource keeps the second requested run lease-free until typed managed release", async () => {
  const cwd = repo(), api = pi(cwd), fixture = activeConditions("resource-a"); api.cwd = cwd;
  const durable = observationHost(cwd, { adapters: fixture.adapters, holdAfterStart: 2, holdProcess: true });
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await activateConditions(api, cwd, fixture.conditions);
  const { projection: activeProjection, run: a } = await firstProductProcessBound(api); let projection = activeProjection;
  const b = [...projection.observationRuns.values()].find(run => run.cycle === 1 && run.runId !== a.runId);
  const blocked = JSON.parse(await invoke(api, "goal_status", {})); // B start reaches managed allocation conflict
  projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(blocked.status, "R10A3_OBSERVATION_MANAGED_ATTENTION"); assert.equal(projection.observationRuns.get(b.runId).phase, "requested"); assert.equal(projection.observationRuns.get(b.runId).allocationId, null); assert.equal(durable.calls.startsByRun.get(b.runId) || 0, 0);
  durable.completeManagedValidation(a.runId); // supervisor-owned completion only; no Goal event
  await invoke(api, "goal_status", {}); await invoke(api, "goal_status", {}); await invoke(api, "goal_status", {}); // recover terminal, record, typed release
  projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"); assert.equal(projection.observationRuns.get(a.runId).phase, "released"); assert.equal(projection.observationRuns.get(b.runId).phase, "requested");
  await invoke(api, "goal_status", {}); // releaseManagedValidation removed A's holder, so B may lease and start
  projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(projection.observationRuns.get(b.runId).phase, "process_bound"); assert.equal(durable.calls.startsByRun.get(a.runId), 1); assert.equal(durable.calls.startsByRun.get(b.runId), 1);
  const runs = [...projection.observationRuns.values()]; assert.equal(new Set(runs.map(run => run.runId)).size, runs.length); assert.equal(new Set(runs.map(run => run.allocationId).filter(Boolean)).size, runs.filter(run => run.allocationId).length);
  for (const run of [a, b]) assert.equal(runEvents(cwd, run.runId, "condition.observation_requested").length, 1);
  assert.equal(runEvents(cwd, b.runId, "condition.observation_lease_allocated").length, 1);
  for (const run of runs.filter(run => run.conditionId === a.conditionId)) for (const type of ["condition.observation_terminal", "condition.observation_recorded", "condition.observation_released"]) assert.equal(runEvents(cwd, run.runId, type).length, 1, `${run.runId}:${type}`);
});

test("active FAIL atomically records evidence, its unique Finding, and active Repair Episode", async () => {
  const cwd = repo(), api = pi(cwd), batches = []; api.cwd = cwd;
  const durable = observationHost(cwd, { codes: ["PASS", "FAIL"] });
  const condition = activeCondition(); condition.remediation.policy = "autonomous";
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable, appendEventBatch(root, events, version) { batches.push(events); return appendEventBatch(root, events, version); } });
  await activateProduct(api, cwd, condition); await cycleUntil(api, 1, "terminal");
  const result = JSON.parse(await invoke(api, "goal_status", {})); assert.equal(result.status, "R10A3_REPAIR_REQUIRED");
  const projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(projection.findings.size, 1); assert.equal(projection.repairEpisodes.size, 1);
  assert.equal([...projection.repairEpisodes.values()][0].status, "active");
  const batch = batches.find(events => events.map(event => event.type).join(",") === "condition.observation_recorded,finding.recorded,repair.episode_opened");
  assert.ok(batch); assert.equal(batch.length, 3); assert.equal(new Set(batch.map(event => event.schemaVersion)).size, 1); assert.equal(batch[0].schemaVersion, "goal-runtime.v1");
  const { run } = await cycleUntil(api, 1, "released");
  const materialized = JSON.parse(await invoke(api, "goal_status", {}));
  assert.equal(materialized.status, "R10A3_REPAIR_MATERIALIZED");
  assert.equal(materialized.machineAction, undefined); assert.equal(materialized.action_token, undefined);
  const afterMaterialization = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(afterMaterialization.tasks.size, 1);
  const [taskId, task] = [...afterMaterialization.tasks.entries()][0];
  assert.equal(task.metadata.kind, "remediation"); assert.equal(task.metadata.episodeId, [...afterMaterialization.repairEpisodes.keys()][0]);
  const compiled = compileTaskContract(afterMaterialization, taskId, cwd), transport = splitDispatchEnvelope(compiled);
  assert.deepEqual(transport.contract.acceptance, { criteria: compiled.acceptance.criteria });
  const wire = JSON.stringify(transport.contract);
  for (const forbidden of ["metadata", "finding", "episode", "commands"]) assert.equal(wire.includes(forbidden), false, forbidden);
  const offer = JSON.parse(await invoke(api, "goal_status", {}));
  assert.equal(offer.machineAction?.tool, "goal_dispatch");
  for (const type of ["condition.observation_terminal", "condition.observation_recorded", "condition.observation_released"]) assert.equal(runEvents(cwd, run.runId, type).length, 1, type);
});

test("selected autonomous repair pre-append failure leaves its Episode active with no Task", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd;
  const durable = observationHost(cwd, { codes: ["PASS", "FAIL"] }); const condition = activeCondition(); condition.remediation.policy = "autonomous";
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable, appendEventBatch(_root, events) { if (events[0]?.type === "goal.amended") throw Error("before repair write"); return appendEventBatch(...arguments); } });
  await activateProduct(api, cwd, condition); await cycleUntil(api, 1, "terminal"); await invoke(api, "goal_status", {}); await cycleUntil(api, 1, "released");
  await assert.rejects(() => invoke(api, "goal_status", {}), /before repair write/);
  const projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(projection.tasks.size, 0); assert.equal([...projection.repairEpisodes.values()][0].status, "active");
  assert.equal(observationEvents(cwd).filter(type => type === "goal.action_offered").length, 0);
});

test("durable autonomous materialization reloads one Task and offers dispatch only on the next status", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; let threw = false;
  const durable = observationHost(cwd, { codes: ["PASS", "FAIL"] }); const condition = activeCondition(); condition.remediation.policy = "autonomous";
  const options = { goalStateEnv: {}, runtimeHost: durable, appendEventBatch(root, events, version) {
    const projection = appendEventBatch(root, events, version);
    if (events.map(event => event.type).join(",") === "goal.amended,repair.task_linked" && !threw) { threw = true; throw Error("after durable materialization"); }
    return projection;
  } };
  createGoalEngineExtension(api, options); await activateProduct(api, cwd, condition); await cycleUntil(api, 1, "terminal"); await invoke(api, "goal_status", {}); await cycleUntil(api, 1, "released");
  const materialized = JSON.parse(await invoke(api, "goal_status", {}));
  assert.equal(materialized.status, "R10A3_REPAIR_MATERIALIZED"); assert.equal(materialized.machineAction, undefined);
  let projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(projection.tasks.size, 1); assert.equal([...projection.repairEpisodes.values()][0].remediationTaskIds.length, 1);
  for (const type of ["goal.amended", "repair.task_linked"]) assert.equal(observationEvents(cwd).filter(value => value === type).length, 1, type);
  const reloaded = pi(cwd, api.entries); reloaded.cwd = cwd; createGoalEngineExtension(reloaded, options); reloaded.handlers.get("session_start")({}, { sessionManager: reloaded.sessionManager });
  const offer = JSON.parse(await invoke(reloaded, "goal_status", {})); projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(offer.machineAction?.tool, "goal_dispatch"); assert.equal(projection.tasks.size, 1);
  for (const type of ["goal.amended", "repair.task_linked"]) assert.equal(observationEvents(cwd).filter(value => value === type).length, 1, type);
});

test("typed runtime goal_accept recovers a non-final remediation Task before atomically reverifying the final Task", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd, { codes: ["PASS", "FAIL", "PASS"] }); const condition = activeCondition(); condition.remediation.policy = "autonomous";
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await activateProduct(api, cwd, condition); await cycleUntil(api, 1, "terminal"); await invoke(api, "goal_status", {}); await cycleUntil(api, 1, "released"); await invoke(api, "goal_status", {});
  let fixture = structuredClone(loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime")); const [taskId, task] = [...fixture.tasks.entries()][0], secondTaskId = `${taskId}-second`;
  const secondTask = structuredClone(task); secondTask.status = "pending"; secondTask.workspace = null; fixture.tasks.set(secondTaskId, secondTask);
  const episode = [...fixture.repairEpisodes.values()][0]; episode.remediationTaskIds.push(secondTaskId);
  task.status = "succeeded"; task.workspace = { attempt: 1, phase: "disposed", disposition: "integrated", released: true };
  const events = [], batches = []; let threw = false;
  const store = {
    listGoals: () => [fixture.goalId], listGoalIds: () => [fixture.goalId], loadProjection: (_root, goalId) => goalId === fixture.goalId ? fixture : null,
    appendEvent(_root, entry, version) { assert.equal(version, fixture.version); fixture = applyEvent(fixture, entry); events.push(entry); return fixture; },
    appendEventBatch(_root, entries, version) { assert.equal(version, fixture.version); for (const entry of entries) fixture = applyEvent(fixture, entry); events.push(...entries); batches.push(entries); if (!threw) { threw = true; throw Error("after durable accept"); } return fixture; },
  };
  const accepting = pi(cwd); accepting.cwd = cwd; createGoalEngineExtension(accepting, { goalStateEnv: {}, enforceActionTokens: false, store });
  const firstAccepted = JSON.parse(await invoke(accepting, "goal_accept", { goal_id: fixture.goalId, task_id: taskId, action_token: "schema-required" }));
  assert.equal(firstAccepted.goal_complete, false); assert.equal(fixture.tasks.get(taskId).status, "accepted"); assert.equal(fixture.repairEpisodes.get(episode.episodeId).status, "waiting_for_tasks"); assert.equal(fixture.findings.get(episode.findingIds[0]).status, "repairing");
  assert.deepEqual(events.map(entry => entry.type), ["task.accepted"]); assert.deepEqual(batches[0].map(entry => entry.type), ["task.accepted"]);

  const finalTask = fixture.tasks.get(secondTaskId); finalTask.status = "succeeded"; finalTask.workspace = { attempt: 1, phase: "disposed", disposition: "integrated", released: true };
  const finalAccepted = JSON.parse(await invoke(accepting, "goal_accept", { goal_id: fixture.goalId, task_id: secondTaskId, action_token: "schema-required" }));
  assert.equal(finalAccepted.goal_complete, false); assert.equal(fixture.lifecycle, "active"); assert.equal(fixture.tasks.get(secondTaskId).status, "accepted");
  assert.equal(fixture.repairEpisodes.get(episode.episodeId).status, "reverifying"); assert.equal(fixture.findings.get(episode.findingIds[0]).status, "reverification");
  assert.deepEqual(batches[1].map(entry => entry.type), ["task.accepted", "repair.reverification_requested"]); assert.equal(events.some(entry => entry.type === "goal.completed"), false);

  fixture.tasks.get(taskId).status = "accepted";
  fixture.tasks.get(secondTaskId).status = "accepted";
  const reobserving = pi(cwd); reobserving.cwd = cwd;
  createGoalEngineExtension(reobserving, { goalStateEnv: {}, enforceActionTokens: false, runtimeHost: durable, store });
  const reobserveStatus = JSON.parse(await invoke(reobserving, "goal_status", {}));
  const ownedRunId = fixture.repairEpisodes.get(episode.episodeId).ownedRunIds.at(-1);
  assert.equal(fixture.observationRuns.get(ownedRunId)?.phase, "requested", JSON.stringify({ reobserveStatus, episode: fixture.repairEpisodes.get(episode.episodeId) }));
  assert.deepEqual(batches.at(-1).map(entry => entry.type), ["condition.observation_requested", "repair.observation_linked"]);
  await invoke(reobserving, "goal_status", {});
  await invoke(reobserving, "goal_status", {});
  assert.equal(fixture.repairEpisodes.get(episode.episodeId).status, "resolved", JSON.stringify({ runs: [...fixture.observationRuns.values()], episode: fixture.repairEpisodes.get(episode.episodeId) }));
  assert.equal(fixture.findings.get(episode.findingIds[0]).status, "resolved");
  assert.deepEqual(batches.at(-1).map(entry => entry.type), ["condition.observation_recorded", "repair.episode_resolved"]);
});

test("selected user-approved repair requires approval without creating a Task or action offer", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd;
  const durable = observationHost(cwd, { codes: ["PASS", "FAIL"] });
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable });
  await activateProduct(api, cwd, activeCondition()); await cycleUntil(api, 1, "terminal");
  assert.equal(JSON.parse(await invoke(api, "goal_status", {})).status, "R10A3_REPAIR_REQUIRED");
  await cycleUntil(api, 1, "released");
  const result = JSON.parse(await invoke(api, "goal_status", {}));
  assert.equal(result.status, "R10A3_REPAIR_APPROVAL_REQUIRED");
  assert.equal(result.machineAction, undefined); assert.equal(result.action_token, undefined);
  assert.equal(loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime").tasks.size, 0);
});

test("active UNKNOWN and INFRA record without Finding or Repair Episode", async () => {
  for (const [code, status] of [["UNKNOWN", "R10A3_OBSERVATION_BLOCKED"], ["INFRA", "R10A3_OBSERVATION_BLOCKED"]]) {
    const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd, { codes: ["PASS", code] });
    createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await activateProduct(api, cwd, activeCondition());
    await cycleUntil(api, 1, "terminal"); const result = JSON.parse(await invoke(api, "goal_status", {})); assert.equal(result.status, status, code);
    const { projection, run } = await cycleUntil(api, 1, "released");
    assert.equal(projection.findings.size, 0, code); assert.equal(projection.repairEpisodes.size, 0, code);
    for (const type of ["condition.observation_terminal", "condition.observation_recorded", "condition.observation_released"]) assert.equal(runEvents(cwd, run.runId, type).length, 1, `${code}:${type}`);
  }
});

test("failed observation batch pre-append throw leaves the terminal run without partial Goal state", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd, { codes: ["PASS", "FAIL"] });
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable, appendEventBatch(_root, events) { if (events[0]?.type === "condition.observation_recorded") throw Error("before write"); return appendEventBatch(...arguments); } });
  await activateProduct(api, cwd, activeCondition()); await cycleUntil(api, 1, "terminal");
  const status = JSON.parse(await invoke(api, "goal_status", {})); assert.equal(status.status, "R10A3_OBSERVATION_MANAGED_ATTENTION");
  const projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime"), run = [...projection.observationRuns.values()].find(value => value.cycle === 1);
  assert.equal(run.phase, "terminal"); assert.equal(projection.findings.size, 0); assert.equal(projection.repairEpisodes.size, 0); assert.equal(runEvents(cwd, run.runId, "condition.observation_recorded").length, 0);
});

test("durable failed observation batch throw reloads without duplicate evidence, Finding, or Episode", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; let threw = false; const durable = observationHost(cwd, { codes: ["PASS", "FAIL"] });
  const options = { goalStateEnv: {}, runtimeHost: durable, appendEventBatch(root, events, version) { const projection = appendEventBatch(root, events, version); if (events[0]?.type === "condition.observation_recorded" && !threw) { threw = true; throw Error("after write"); } return projection; } };
  createGoalEngineExtension(api, options); await activateProduct(api, cwd, activeCondition()); await cycleUntil(api, 1, "terminal");
  const first = JSON.parse(await invoke(api, "goal_status", {})); assert.equal(first.status, "R10A3_OBSERVATION_MANAGED_ATTENTION");
  const reloaded = pi(cwd, api.entries); reloaded.cwd = cwd; createGoalEngineExtension(reloaded, options); reloaded.handlers.get("session_start")({}, { sessionManager: reloaded.sessionManager });
  await cycleUntil(reloaded, 1, "released");
  const projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(projection.findings.size, 1); assert.equal(projection.repairEpisodes.size, 1);
  const failedRun = [...projection.observationRuns.values()].find(run => run.cycle === 1);
  assert.equal(runEvents(cwd, failedRun.runId, "condition.observation_recorded").length, 1);
  for (const type of ["finding.recorded", "repair.episode_opened"]) assert.equal(observationEvents(cwd).filter(value => value === type).length, 1, type);
});

test("active consecutive stability requires two distinct product environments after Cycle0", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd, { codes: ["PASS", "PASS", "PASS"], environments: ["cycle0", "product-1", "product-2"] });
  const stability = { mode: "consecutive", count: 2, require_distinct_environment: true };
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await activateProduct(api, cwd, activeCondition(stability));
  let result = await cycleUntil(api, 1, "released"); assert.equal(result.projection.conditions.get("condition-1").status, "observing"); assert.equal(result.projection.conditions.get("condition-1").supportingEvidenceIds.length, 1);
  result = await cycleUntil(api, 2, "released"); assert.equal(result.projection.conditions.get("condition-1").status, "satisfied"); assert.equal(result.projection.conditions.get("condition-1").supportingEvidenceIds.length, 2);
  assert.deepEqual([...result.projection.tasks.values()], []);
});

test("active PASS then FAIL clears product support while retaining complete evidence and verdict history", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd, { codes: ["PASS", "PASS", "FAIL"], environments: ["cycle0", "product-1", "product-2"] });
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await activateProduct(api, cwd, activeCondition({ mode: "consecutive", count: 2, require_distinct_environment: true }));
  let result = await cycleUntil(api, 1, "released"); assert.equal(result.projection.conditions.get("condition-1").supportingEvidenceIds.length, 1);
  result = await cycleUntil(api, 2, "released");
  assert.equal(result.projection.conditions.get("condition-1").status, "blocked"); assert.deepEqual(result.projection.conditions.get("condition-1").supportingEvidenceIds, []);
  assert.deepEqual(result.projection.evidenceHistory.map(value => value.verdict.kind), ["passed", "passed", "failed"]);
});

test("active requested identity drift blocks HEAD, adapter, and claims changes before Host actions", async () => {
  for (const drift of ["head", "adapter", "claims"]) {
    const cwd = repo(), api = pi(cwd); api.cwd = cwd; const durable = observationHost(cwd);
    createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable }); await activateProduct(api, cwd, activeCondition()); await cycleUntil(api, 1, "requested");
    const before = { ...durable.calls };
    if (drift === "head") { writeFileSync(join(cwd, "drift"), drift); git(cwd, "add", "drift"); git(cwd, "commit", "-m", drift); }
    else durable.adapterRegistry = createObservationAdapterRegistry([{ ref: "oracle", version: drift === "adapter" ? "2" : "1", deterministic: true, reset: "clean", resourceClaims: drift === "claims" ? [{ key: "fixture:changed", mode: "exclusive", capacity: 1, reset: "clean" }] : [], artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" }, validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] } }]);
    const status = JSON.parse(await invoke(api, "goal_status", {})); const run = [...loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime").observationRuns.values()].find(value => value.cycle === 1);
    assert.equal(status.status, "R10A3_OBSERVATION_MANAGED_ATTENTION", drift); assert.equal(run.phase, "requested", drift);
    for (const key of ["prepare", "start", "recover", "artifact"]) assert.equal(durable.calls[key], before[key], `${drift}:${key}`);
  }
});

test("single active PASS release requires R11 finalization without action offer", async () => {
  const cwd = repo(), api = pi(cwd); api.cwd = cwd; createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: observationHost(cwd, { codes: ["PASS", "PASS"] }) }); await activateProduct(api, cwd, activeCondition()); await cycleUntil(api, 1, "released");
  const status = JSON.parse(await invoke(api, "goal_status", {})); assert.equal(status.status, "R11_FINALIZATION_REQUIRED"); assert.equal(observationEvents(cwd).includes("goal.finalized"), false); assert.equal(observationEvents(cwd).includes("goal.action_offered"), false); assert.equal(status.action_token, undefined); assert.equal(status.machineAction, undefined);
});
