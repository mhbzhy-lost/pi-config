import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { appendEvent, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { issueActionOffer } from "../scripts/lib/goal-engine/action-offer.mjs";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { runtimeInit, runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const rootFor = cwd => join(cwd, ".state/goal-engine");
const projectionFor = cwd => loadProjection(rootFor(cwd), "harden-runtime");
const event = (goalId, type, data) => ({ schemaVersion: "goal-runtime.v1", eventId: crypto.randomUUID(), goalId, type, occurredAt: new Date().toISOString(), data });
function appendRuntime(cwd, type, data) { const projection = projectionFor(cwd); return appendEvent(rootFor(cwd), event(projection.goalId, type, data), projection.version); }

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "r10b-extension-"));
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "init");
  return cwd;
}

function pi(cwd, entries = []) {
  const tools = [], listeners = new Map(); let leaf = entries.at(-1)?.id ?? null, sequence = entries.length;
  const append = entry => { const value = { id: `entry-${++sequence}`, parentId: leaf, timestamp: new Date(Date.now() + sequence).toISOString(), ...entry }; entries.push(value); leaf = value.id; return value; };
  const sessionManager = { getSessionId: () => "owner", getSessionFile: () => join(cwd, "session-owner"), getLeafId: () => leaf, getEntries: () => entries, getBranch: () => [...entries] };
  return {
    cwd, entries, tools, sessionManager,
    registerTool: tool => tools.push(tool), on: (name, handler) => listeners.set(name, handler),
    appendEntry: (customType, data) => append({ type: "custom", customType, data }),
    handlers: { get: name => {
      const handler = listeners.get(name);
      if (name !== "input" || !handler) return handler;
      return async (event, ctx) => { const result = await handler(event, ctx); append({ type: "message", message: { role: "user", content: event.text } }); return result; };
    } },
  };
}

function runtimeHost(cwd, stopCalls) {
  const adapter = { ref: "oracle", version: "1", deterministic: true, reset: "clean", resourceClaims: [], artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" }, validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 50, maxOutputBytes: 100, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] } };
  let phase = "lease_allocated";
  const receipt = { id: "managed-cycle0", stateRoot: rootFor(cwd), receiptPath: join(rootFor(cwd), "managed-validations/managed-cycle0.json"), workspacePath: null, phase, terminal: null, recorded: null, recordCount: 0, cleanupDebt: false };
  return {
    registries: runtimeRegistries, adapterRegistry: createObservationAdapterRegistry([adapter]),
    captureCurrentWorld() { return { safe: true, repo: { root: cwd, head: git(cwd, "rev-parse", "HEAD"), trackedDirty: [], untracked: [], sequencer: null }, adapters: [{ ref: "oracle", version: "1" }], environments: [{ ref: "local", fingerprint: "local-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "sample-1", available: true }], resources: [], activeRuns: [], capturedAt: new Date().toISOString() }; },
    prepareManagedValidation(input) { const id = `managed-${createHash("sha256").update(`${input.ownerKind}:${input.ownerId}:${input.integratedHead}`).digest("hex").slice(0, 16)}`; return { ...receipt, id, receiptPath: join(rootFor(cwd), `managed-validations/${id}.json`), phase }; }, inspectManagedValidation(value) { return { ...value, phase, terminal: phase === "recorded" ? { status: "passed", code: 0 } : null }; },
    async startManagedValidation(value, { onProcessBound }) { phase = "process_bound"; await onProcessBound({ processIdentityHash: createHash("sha256").update(value.id).digest("hex") }); phase = "recorded"; return { ...value, phase, terminal: { status: "passed", code: 0 } }; },
    async recoverManagedValidation(value) { return { ...value, phase, terminal: { status: "passed", code: 0 } }; }, releaseManagedValidation(value) { return { id: value.id, released: true }; },
    artifactRefForRun() { const path = join(cwd, ".state/cycle0-artifact.json"); writeFileSync(path, JSON.stringify({ code: "PASS" }), { mode: 0o600 }); return { id: "cycle0-artifact", path }; },
    async stopOwnedRun(request) { const reloaded = projectionFor(cwd); stopCalls.push({ request, runtimeState: reloaded.runtimeState, actionOffer: reloaded.actionOffer }); return { state: "observed", proof: { id: "host-proof" } }; },
  };
}

async function invoke(api, name, input) { return (await api.tools.find(tool => tool.name === name).execute("call", input, undefined, undefined, { cwd: api.cwd, sessionManager: api.sessionManager })).details.value; }
async function readyDispatch() {
  const cwd = repo(), stops = [], api = pi(cwd); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: runtimeHost(cwd, stops) });
  await invoke(api, "goal_init", runtimeInit()); await invoke(api, "goal_status", {});
  await api.handlers.get("input")({ type: "input", text: "approve", source: "interactive" }, { cwd, sessionManager: api.sessionManager });
  for (let i = 0; i < 10 && projectionFor(cwd).runtimeState !== "active"; i++) await invoke(api, "goal_status", {});
  assert.equal(projectionFor(cwd).runtimeState, "active", "fixture must reach real Cycle0 activation");
  // Establish only the canonical durable executor binding this host test needs.
  // Store reducers validate every event; no projection collection is mutated here.
  let projection = projectionFor(cwd), task = projection.tasks.get("task-1"), attempt = task.attempts + 1, contractHash = createHash("sha256").update("r10b-canonical-contract").digest("hex"), runId = `r10b-run-${attempt}`, asyncDir = join(tmpdir(), runId), workspaceLeaseId = createHash("sha256").update("r10b-canonical-lease").digest("hex"), headAtDispatch = git(cwd, "rev-parse", "HEAD");
  appendRuntime(cwd, "task.dispatched", { taskId: "task-1", contractHash, workspace: { attempt, path: join(tmpdir(), `r10b-workspace-${attempt}`), branch: `ge/harden-runtime/task-1/${attempt}`, baseCommit: headAtDispatch, originRef: "refs/heads/main" } });
  appendRuntime(cwd, "task.executor_bound", { taskId: "task-1", attempt, runId, contractHash, asyncDir, workspacePath: join(tmpdir(), `r10b-workspace-${attempt}`), workspaceLeaseId, headAtDispatch });
  projection = projectionFor(cwd); task = projection.tasks.get("task-1");
  const offer = issueActionOffer(projection, { tool: "goal_dispatch", params: { goal_id: projection.goalId, task_id: "task-1" } }, "owner");
  appendRuntime(cwd, "goal.action_offered", offer);
  projection = projectionFor(cwd);
  assert.ok(task.executorBinding, "fixture must use canonical dispatch executor binding"); assert.ok(projection.actionOffer, "fixture must use Store action offer projection");
  return { cwd, api, stops, task };
}

for (const [streamingBehavior, reason] of [["steer", "interactive_steer"], ["followUp", "follow_up"]]) test(`${streamingBehavior} durably suspends and revokes before its owned Host stop`, async () => {
  const { cwd, api, stops, task } = await readyDispatch(), raw = `private ${streamingBehavior} input`;
  await api.handlers.get("input")({ type: "input", text: raw, source: "interactive", streamingBehavior }, { cwd, sessionManager: api.sessionManager });
  const projection = projectionFor(cwd), events = readFileSync(join(rootFor(cwd), "goals/harden-runtime/events.jsonl"), "utf8");
  assert.equal(projection.runtimeState, "suspended"); assert.equal(projection.actionOffer, null);
  assert.equal(stops.length, 1); assert.equal(stops[0].runtimeState, "suspended"); assert.equal(stops[0].actionOffer, null);
  assert.deepEqual(stops[0].request, { runId: task.executorBinding.runId, asyncDir: task.executorBinding.asyncDir, sessionId: "owner" });
  assert.match(events, /"type":"goal.runtime_suspended"/); assert.doesNotMatch(events, new RegExp(raw));
  for (const value of [JSON.stringify(projection.suspension), JSON.stringify(stops[0].request), JSON.stringify(await invoke(api, "goal_status", {}))]) assert.doesNotMatch(value, new RegExp(raw));
});

test("abort listener suspends durably before stop without waiting for agent_end", async () => {
  const { cwd, api, stops } = await readyDispatch(); const controller = new AbortController();
  const start = api.handlers.get("agent_start"); assert.equal(typeof start, "function", "Extension must register agent_start abort listener");
  await start({}, { cwd, sessionManager: api.sessionManager, signal: controller.signal }); controller.abort();
  assert.equal(projectionFor(cwd).runtimeState, "suspended"); assert.equal(stops.length, 1); assert.equal(stops[0].runtimeState, "suspended");
});

test("invalid input, durable append failure, identity mismatch, and reload never authorize an unsafe stop", async () => {
  const { cwd, api, stops } = await readyDispatch();
  for (const event of [{ type: "input", text: "image", source: "interactive", images: [{ type: "image", data: "x", mimeType: "image/png" }] }, { type: "input", text: "stream", source: "interactive", streamingBehavior: "streaming" }, { type: "input", text: "other", source: "extension", streamingBehavior: "steer" }]) await api.handlers.get("input")(event, { cwd, sessionManager: api.sessionManager });
  assert.equal(stops.length, 0); assert.equal(projectionFor(cwd).runtimeState, "active");
  // The implementation must additionally retain this durable suspension across a fresh Extension and stop exactly once only after a complete re-derived identity; current pending-gate metadata is deliberately insufficient.
  const reloaded = pi(cwd, structuredClone(api.entries)); createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: runtimeHost(cwd, stops) }); reloaded.handlers.get("session_start")({}, { cwd, sessionManager: reloaded.sessionManager });
  assert.equal(projectionFor(cwd).runtimeState, "suspended", "reload must recover pending durable suspension, not custom intent metadata"); assert.equal(stops.length, 1);
});
