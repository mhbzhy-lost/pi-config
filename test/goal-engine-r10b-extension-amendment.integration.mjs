import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { appendEvent, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const rootFor = (cwd) => join(cwd, ".state/goal-engine");
const projectionFor = (cwd) => loadProjection(rootFor(cwd), "harden-runtime");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const sha = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "r10b-extension-amendment-"));
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init");
  return cwd;
}

function pi(cwd, entries = [], { sessionId = "owner", branch = null } = {}) {
  const tools = [], listeners = new Map(); let leaf = entries.at(-1)?.id ?? null, sequence = entries.length;
  const append = (entry) => { const value = { id: `entry-${++sequence}`, parentId: leaf, timestamp: new Date(Date.now() + sequence).toISOString(), ...entry }; entries.push(value); leaf = value.id; return value; };
  const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => join(cwd, `session-${sessionId}`), getLeafId: () => leaf, getEntries: () => [...entries], getBranch: () => branch || [...entries] };
  return { cwd, entries, tools, sessionManager, registerTool: (tool) => tools.push(tool), on: (name, handler) => listeners.set(name, handler), appendEntry: (customType, data) => append({ type: "custom", customType, data }), handlers: { get(name) { const handler = listeners.get(name); if (name !== "input" || !handler) return handler; return async (event, ctx) => { const result = await handler(event, ctx); append({ type: "message", message: { role: "user", content: event.text } }); return result; }; } } };
}

function host(cwd) {
  const adapter = { ref: "oracle", version: "1", deterministic: true, reset: "clean", resourceClaims: [], artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" }, validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] } };
  let phase = "lease_allocated";
  const receipt = { id: "managed-cycle0", stateRoot: rootFor(cwd), receiptPath: join(rootFor(cwd), "managed-validations/managed-cycle0.json"), workspacePath: null, phase, terminal: null, recorded: null, recordCount: 0, cleanupDebt: false };
  return { registries: runtimeRegistries, adapterRegistry: createObservationAdapterRegistry([adapter]), captureCurrentWorld() { return { safe: true, repo: { root: cwd, head: git(cwd, "rev-parse", "HEAD"), trackedDirty: [], untracked: [], sequencer: null }, adapters: [{ ref: "oracle", version: "1" }], environments: [{ ref: "local", fingerprint: "local-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "sample-1", available: true }], resources: [], activeRuns: [], capturedAt: new Date().toISOString() }; }, prepareManagedValidation(input) { const id = `managed-${createHash("sha256").update(`${input.ownerKind}:${input.ownerId}:${input.integratedHead}`).digest("hex").slice(0, 16)}`; return { ...receipt, id, receiptPath: join(rootFor(cwd), `managed-validations/${id}.json`), phase }; }, inspectManagedValidation(value) { return { ...value, phase, terminal: phase === "recorded" ? { status: "passed", code: 0 } : null }; }, async startManagedValidation(value, { onProcessBound }) { phase = "process_bound"; await onProcessBound({ processIdentityHash: createHash("sha256").update(value.id).digest("hex") }); phase = "recorded"; return { ...value, phase, terminal: { status: "passed", code: 0 } }; }, async recoverManagedValidation(value) { return { ...value, phase, terminal: { status: "passed", code: 0 } }; }, releaseManagedValidation(value) { return { id: value.id, released: true }; }, artifactRefForRun() { const path = join(cwd, ".state/cycle0-artifact.json"); writeFileSync(path, JSON.stringify({ code: "PASS" }), { mode: 0o600 }); return { id: "cycle0-artifact", path }; } };
}

async function invoke(api, name, input) { return (await api.tools.find((tool) => tool.name === name).execute("call", input, undefined, undefined, { cwd: api.cwd, sessionManager: api.sessionManager })).details.value; }
async function activeRuntime() {
  const cwd = repo(), api = pi(cwd); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd) });
  await invoke(api, "goal_init", runtimeInit()); await invoke(api, "goal_status", {});
  await api.handlers.get("input")({ type: "input", text: "approve", source: "interactive" }, { cwd, sessionManager: api.sessionManager });
  for (let n = 0; n < 10 && projectionFor(cwd).runtimeState !== "active"; n++) await invoke(api, "goal_status", {});
  assert.equal(projectionFor(cwd).runtimeState, "active", "fixture reaches real Cycle0 activation");
  return { cwd, api };
}
function events(cwd) { return readFileSync(join(rootFor(cwd), "goals/harden-runtime/events.jsonl"), "utf8"); }

// RED: ordinary human input must become a durable execution-amendment boundary, not an in-memory custom gate.
test("R10B idle interactive and rpc input suspend the active owner without storing the raw amendment", async () => {
  for (const source of ["interactive", "rpc"]) {
    const { cwd, api } = await activeRuntime(); const raw = `amend ${source} private wording`;
    await api.handlers.get("input")({ type: "input", text: raw, source }, { cwd, sessionManager: api.sessionManager });
    const projection = projectionFor(cwd);
    assert.equal(projection.runtimeState, "suspended");
    assert.equal(projection.suspension.reason, "execution_amendment");
    assert.deepEqual(projection.suspension.affectedTaskIds, []);
    assert.equal(projection.suspension.resourcesQuarantined, true, "no owned resource still receives the full empty closure update");
    assert.doesNotMatch(events(cwd), new RegExp(raw));
  }
});

// RED: target contracts, hashes, revision, session and proposal IDs are Host-derived and cannot be caller authority.
test("R10B goal_amend exposes only strict Host-derived propose_execution_change", async () => {
  const { cwd, api } = await activeRuntime();
  await api.handlers.get("input")({ type: "input", text: "change task", source: "interactive" }, { cwd, sessionManager: api.sessionManager });
  const valid = { goal_id: "harden-runtime", operation: "propose_execution_change", reason: "update acceptance", changes: { update_tasks: [{ id: "task-1", description: "Amended by Host" }] } };
  await invoke(api, "goal_amend", valid);
  const pending = projectionFor(cwd).pendingHumanDecision;
  assert.equal(pending.phase, "proposed"); assert.equal(pending.targetExecutionContract.execution.tasks[0].description, "Amended by Host");
  for (const extra of [{ targetContractHash: sha("forged") }, { proposalId: "forged" }, { sessionId: "other" }, { revision: 9 }]) await assert.rejects(invoke(api, "goal_amend", { ...valid, ...extra }));
});

test("R10B proposal validation rejects invalid task changes before append", async () => {
  const { cwd, api } = await activeRuntime(); await api.handlers.get("input")({ type: "input", text: "change task", source: "interactive" }, { cwd, sessionManager: api.sessionManager });
  const before = events(cwd);
  const base = { goal_id: "harden-runtime", operation: "propose_execution_change", reason: "strict validation" };
  for (const changes of [
    { update_tasks: [{ id: "missing", description: "no" }] },
    { update_tasks: [{ id: "task-1", unknown: "field" }] },
    { update_tasks: [{ id: "task-1", deps: ["task-1"] }] },
    { update_tasks: [{ id: "task-1", writePaths: ["../outside"] }] },
    { update_tasks: [{ id: "task-1", adapter: { ref: "unknown", version: "1" } }] },
    { update_tasks: [{ id: "task-1", environment_ref: "missing" }] },
  ]) await assert.rejects(invoke(api, "goal_amend", { ...base, changes }), /unknown task|unknown field|cycle|path|adapter|environment|fixture/i);
  assert.equal(events(cwd), before, "invalid source changes append neither proposal nor partial amendment");
});

// RED: only an exact intent and its real, active-branch user entry may decide the Store proposal.
test("R10B status turns one active-branch approve or reject intent into an exact durable decision", async () => {
  const { cwd, api } = await activeRuntime();
  await api.handlers.get("input")({ type: "input", text: "change task", source: "interactive" }, { cwd, sessionManager: api.sessionManager });
  await invoke(api, "goal_amend", { goal_id: "harden-runtime", operation: "propose_execution_change", reason: "decision fixture", changes: { update_tasks: [{ id: "task-1", description: "Decision fixture" }] } });
  await api.handlers.get("input")({ type: "input", text: "reject", source: "interactive" }, { cwd, sessionManager: api.sessionManager });
  const intent = api.entries.find((entry) => entry.customType === "goal-engine-execution-amendment-intent");
  assert.ok(intent, "input hook writes only an audit intent before Pi appends the real message");
  await invoke(api, "goal_status", {});
  const pending = projectionFor(cwd).pendingHumanDecision;
  assert.deepEqual(Object.keys(pending).filter((key) => ["proposalId", "proposalHash", "ownerSessionId", "userEntryId", "userEntryHash", "branchBindingHash", "source", "recordedAt", "decisionId", "choice", "approved"].includes(key)).sort(), ["approved", "branchBindingHash", "choice", "decisionId", "ownerSessionId", "proposalHash", "proposalId", "recordedAt", "source", "userEntryHash", "userEntryId"]);
  assert.equal(pending.choice, "reject"); assert.equal(pending.approved, false); assert.equal(pending.phase, "rejected");
  assert.match(await invoke(api, "goal_status", {}), /R10B_AMENDMENT_APPLY_REQUIRED/);
});
