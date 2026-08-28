import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { appendEvent, appendEventBatch, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { suspensionClosureHash } from "../scripts/lib/goal-engine/events.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const rootFor = cwd => join(cwd, ".state/goal-engine");
const projectionFor = cwd => loadProjection(rootFor(cwd), "harden-runtime");
const event = (goalId, type, data) => ({ schemaVersion: "goal-runtime.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data });
const count = (cwd, type) => (readFileSync(join(rootFor(cwd), "goals/harden-runtime/events.jsonl"), "utf8").match(new RegExp(`"type":"${type}"`, "g")) || []).length;

function repo() { const cwd = mkdtempSync(join(tmpdir(), "r10-resume-")); git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test"); writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init"); return cwd; }
function pi(cwd, entries = [], sessionId = "owner") { const tools = [], listeners = new Map(); let leaf = entries.at(-1)?.id ?? null, sequence = entries.length; const append = entry => { const value = { id: `entry-${++sequence}`, parentId: leaf, timestamp: new Date(Date.now() + sequence).toISOString(), ...entry }; entries.push(value); leaf = value.id; return value; }; const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => join(cwd, `session-${sessionId}`), getLeafId: () => leaf, getEntries: () => entries, getBranch: () => entries }; return { cwd, tools, entries, sessionManager, registerTool: tool => tools.push(tool), on: (name, handler) => listeners.set(name, handler), appendEntry: (customType, data) => append({ type: "custom", customType, data }), handlers: { get: name => { const handler = listeners.get(name); if (name !== "input" || !handler) return handler; return async (input, ctx) => { const result = await handler(input, ctx); append({ type: "message", message: { role: "user", content: input.text } }); return result; }; } } }; }
function host(cwd) { const adapter = { ref: "oracle", version: "1", deterministic: true, reset: "clean", resourceClaims: [], artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" }, validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] } }; let phase = "lease_allocated"; const receipt = input => { const id = `managed-${createHash("sha256").update(input.ownerId).digest("hex").slice(0, 8)}`; return { id, stateRoot: rootFor(cwd), receiptPath: join(rootFor(cwd), `managed-validations/${id}.json`), workspacePath: null, phase, terminal: null, recorded: null, recordCount: 0, cleanupDebt: false }; }; return { registries: runtimeRegistries, adapterRegistry: createObservationAdapterRegistry([adapter]), captureCurrentWorld: () => ({ safe: true, repo: { root: cwd, head: git(cwd, "rev-parse", "HEAD"), trackedDirty: [], untracked: [], sequencer: null }, adapters: [{ ref: "oracle", version: "1" }], environments: [{ ref: "local", fingerprint: "local-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "sample-1", available: true }], resources: [], activeRuns: [], capturedAt: new Date().toISOString() }), prepareManagedValidation: receipt, inspectManagedValidation: value => ({ ...value, phase }), async startManagedValidation(value, { onProcessBound }) { phase = "process_bound"; await onProcessBound({ processIdentityHash: createHash("sha256").update(value.id).digest("hex") }); phase = "recorded"; return { ...value, phase, terminal: { status: "passed", code: 0 } }; }, async recoverManagedValidation(value) { return { ...value, phase, terminal: { status: "passed", code: 0 } }; }, releaseManagedValidation: value => ({ id: value.id, released: true }), artifactRefForRun() { const path = join(cwd, ".state/artifact.json"); writeFileSync(path, JSON.stringify({ code: "PASS" }), { mode: 0o600 }); return { id: "artifact", path }; } }; }
async function invoke(api, name, input = {}) { return (await api.tools.find(tool => tool.name === name).execute("call", input, undefined, undefined, { cwd: api.cwd, sessionManager: api.sessionManager })).details.value; }
async function suspended({ batch, incomplete = false } = {}) { const cwd = repo(), api = pi(cwd); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd), ...(batch ? { appendEventBatch: batch } : {}) }); await invoke(api, "goal_init", runtimeInit()); await invoke(api, "goal_status"); await api.handlers.get("input")({ type: "input", text: "approve", source: "interactive" }, { cwd, sessionManager: api.sessionManager }); for (let i = 0; i < 30 && projectionFor(cwd).runtimeState !== "active"; i++) await invoke(api, "goal_status"); assert.equal(projectionFor(cwd).runtimeState, "active"); const initial = { suspensionId: "resume-closure", reason: "host_pause", affectedTaskIds: incomplete ? ["binding-smoke"] : [], affectedRunIds: incomplete ? ["77c124bb-d889-4752-ba51-ca8b6610d731"] : [], requestedAt: "2026-08-20T00:00:00.000Z", resourcesQuarantined: false }; let projection = projectionFor(cwd); appendEvent(rootFor(cwd), event(projection.goalId, "goal.runtime_suspended", initial), projection.version); if (incomplete) return { cwd, api, closure: initial }; const closure = { ...initial, resourcesQuarantined: true, terminalProofRefs: [], workspaceClosureProofRefs: [], resourceClosureProofRefs: [] }; projection = projectionFor(cwd); appendEvent(rootFor(cwd), event(projection.goalId, "goal.runtime_suspended", closure), projection.version); return { cwd, api, closure }; }

test("incomplete suspension closure exposes blockers instead of silently removing resume", async () => {
  const { api } = await suspended({ incomplete: true });
  const status = JSON.parse(await invoke(api, "goal_status"));
  assert.deepEqual(status.machineAction, { tool: "goal_amend", params: { goal_id: "harden-runtime", operation: "abandon_runtime" } });
  assert.equal(typeof status.action_token, "string");
  assert.deepEqual(status.blocking.map(item => item.code).filter(code => code.startsWith("SUSPENSION_")).sort(), ["SUSPENSION_RESOURCE_CLOSURE_PENDING", "SUSPENSION_TERMINAL_PROOF_PENDING", "SUSPENSION_WORKSPACE_CLOSURE_PENDING"]);
});

// Break caught: a frontier-issued resume_runtime offer was rejected by goal_amend, permanently stranding a fully closed runtime.
test("full suspension closure issues and atomically consumes the exact resume offer", async () => { const { cwd, api, closure } = await suspended(); const status = JSON.parse(await invoke(api, "goal_status")); assert.deepEqual(status.machineAction, { tool: "goal_amend", params: { goal_id: "harden-runtime", operation: "resume_runtime" } }); assert.equal(typeof status.action_token, "string"); await invoke(api, "goal_amend", { goal_id: "harden-runtime", operation: "resume_runtime", action_token: status.action_token }); const projection = projectionFor(cwd); assert.equal(projection.runtimeState, "active"); assert.equal(projection.suspension, null); assert.equal(projection.actionOffer?.consumed, true); assert.equal(count(cwd, "goal.action_consumed"), 1); assert.equal(count(cwd, "goal.runtime_resumed"), 1); assert.equal(suspensionClosureHash(closure).length, 64); });

test("fully closed suspended reload reconciles stale owner intent and reissues resume authority", async () => {
  const { cwd, api } = await suspended();
  const beforeReload = JSON.parse(await invoke(api, "goal_status"));
  assert.equal(beforeReload.machineAction?.params?.operation, "resume_runtime");
  // Simulate the exact durable pre-fix metadata restored from the old owner session.
  api.appendEntry("goal-engine-runtime-intent-pending", { goalId: "harden-runtime", sessionId: "owner", source: "interactive" });
  assert.ok(api.entries.some(entry => entry.customType === "goal-engine-runtime-intent-pending"), "fixture must persist the owner intent gate");

  const reloaded = pi(cwd, structuredClone(api.entries));
  createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: host(cwd) });
  reloaded.handlers.get("session_start")({}, { cwd, sessionManager: reloaded.sessionManager });
  const preStatus = reloaded.handlers.get("before_agent_start")({}, { cwd, sessionManager: reloaded.sessionManager });
  assert.notEqual(preStatus?.message?.content, "R10B_SUSPENSION_REQUIRED", "session_start must reconcile the stale gate before pre-status R10B injection");
  await reloaded.handlers.get("input")({ type: "input", text: "first ordinary owner input after reload", source: "interactive" }, { cwd, sessionManager: reloaded.sessionManager });
  assert.equal(reloaded.__goalRuntimeIntentGate({ sessionManager: reloaded.sessionManager }, { goal_id: "harden-runtime" }), false, "a suspended runtime must not recreate the gate from the first ordinary input");
  const afterReload = JSON.parse(await invoke(reloaded, "goal_status"));

  assert.notEqual(afterReload.status, "R10B_SUSPENSION_REQUIRED");
  assert.deepEqual(afterReload.machineAction, { tool: "goal_amend", params: { goal_id: "harden-runtime", operation: "resume_runtime" } });
  assert.equal(typeof afterReload.action_token, "string");
  assert.notEqual(afterReload.action_token, beforeReload.action_token, "reload must issue fresh authority");
  await invoke(reloaded, "goal_amend", { ...afterReload.machineAction.params, action_token: afterReload.action_token });
  assert.equal(projectionFor(cwd).runtimeState, "active");
});

test("resume rejects malformed or stale authority without consuming its offer", async () => { const { cwd, api } = await suspended(); const status = JSON.parse(await invoke(api, "goal_status")); for (const input of [{ goal_id: "harden-runtime", operation: "resume_runtime", action_token: "wrong" }, { goal_id: "harden-runtime", operation: "resume_runtime", action_token: status.action_token, extra: true }]) await assert.rejects(invoke(api, "goal_amend", input)); assert.equal(projectionFor(cwd).runtimeState, "suspended"); assert.equal(projectionFor(cwd).actionOffer.token, status.action_token); assert.equal(count(cwd, "goal.action_consumed"), 0); });

test("resume batch is retryable before append and idempotent after durable throw", async () => { let mode = "off"; const { cwd, api } = await suspended({ batch(root, events, version) { if (mode === "pre") { mode = "retry"; throw Error("pre-append"); } const value = appendEventBatch(root, events, version); if (mode === "durable") throw Error("durable-then-throw"); return value; } }); let status = JSON.parse(await invoke(api, "goal_status")); mode = "pre"; await assert.rejects(invoke(api, "goal_amend", { ...status.machineAction.params, action_token: status.action_token }), /pre-append/); assert.equal(projectionFor(cwd).actionOffer.token, status.action_token); status = JSON.parse(await invoke(api, "goal_status")); mode = "durable"; await invoke(api, "goal_amend", { ...status.machineAction.params, action_token: status.action_token }); assert.equal(projectionFor(cwd).runtimeState, "active"); assert.equal(count(cwd, "goal.runtime_resumed"), 1); });
