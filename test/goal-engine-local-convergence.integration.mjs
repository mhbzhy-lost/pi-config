import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
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

test("hybrid calibration uses real approval, Cycle0 managed protocol, and activation without attention", async () => {
  const cwd = repo(), api = pi(cwd), durable = observationHost(cwd); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: durable });
  await approveAndActivate(api, cwd, hybridInit());
  const projection = loadProjection(join(cwd, ".state/goal-engine"), "harden-runtime");
  assert.equal(projection.runtimeState, "active"); assert.deepEqual([...projection.observationRuns.values()].filter(run => run.cycle === 0).map(run => run.conditionId).sort(), ["backend-condition", "full-flow-condition"]); assert.ok(durable.calls.prepare >= 2); assert.ok(durable.calls.start >= 2); assert.ok(durable.calls.release >= 2);
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
