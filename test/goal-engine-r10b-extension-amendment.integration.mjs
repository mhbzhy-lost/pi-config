import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { appendEvent, appendEventBatch, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { hashRuntimeExecutionContract, normalizeRuntimeGoalInit } from "../scripts/lib/goal-engine/obligation-contract.mjs";
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
function seedEvent(type, data, n) { return { schemaVersion: "goal-runtime.v1", eventId: `extension-seed-${n}`, goalId: "harden-runtime", occurredAt: `2026-08-23T00:00:${String(n).padStart(2, "0")}.000Z`, type, data }; }
async function pendingProposalFixture() {
  const { cwd, api } = await activeRuntime(), root = rootFor(cwd), active = projectionFor(cwd);
  const initial = { suspensionId: "extension-amendment", reason: "execution_amendment", affectedTaskIds: [], affectedRunIds: [], requestedAt: "2026-08-23T00:00:16.000Z", resourcesQuarantined: false };
  const closure = { ...initial, resourcesQuarantined: true, terminalProofRefs: [], workspaceClosureProofRefs: [], resourceClosureProofRefs: [] };
  const source = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries);
  const target = normalizeRuntimeGoalInit({ ...source, execution: { ...source.execution, tasks: [{ ...source.execution.tasks[0], description: "Store seeded extension proposal" }] } }, runtimeRegistries);
  const changes = { update_tasks: [{ id: "task-1", description: "Store seeded extension proposal" }] };
  const material = { goalId: "harden-runtime", proposalId: "extension-proposal", changes, changesHash: sha(changes), targetExecutionContract: target, targetContractHash: hashRuntimeExecutionContract(target), baseHead: active.runtimeBaseHead, ownerSessionId: "owner", oldRevision: active.executionRevision, newRevision: active.executionRevision + 1 };
  const proposal = { ...material, proposalHash: sha(material) };
  appendEventBatch(root, [seedEvent("goal.runtime_suspended", initial, 16), seedEvent("goal.runtime_suspended", closure, 17), seedEvent("execution.amendment_proposed", proposal, 18)], active.version);
  assert.equal(projectionFor(cwd).pendingHumanDecision.phase, "proposed", "fixture is Reducer-validated Store state, not a Map mutation");
  return { cwd, api, proposal };
}
function amendmentEntries(api, suffix) { return api.entries.filter((entry) => entry.customType === `goal-engine-execution-amendment-${suffix}`); }
async function decideSeeded(choice, options = {}) {
  const fixture = await pendingProposalFixture();
  if (options.branch) fixture.api.sessionManager.getBranch = () => options.branch;
  await fixture.api.handlers.get("input")({ type: "input", text: choice, source: options.source || "interactive", ...(options.images ? { images: options.images } : {}), ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}) }, { cwd: fixture.cwd, sessionManager: fixture.api.sessionManager });
  return fixture;
}

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

// RED: Store-seeded approval is deliberately independent of the still-missing goal_amend schema.
test("R10B approve records the exact active-branch decision before exposing apply-required", async () => {
  const { cwd, api, proposal } = await decideSeeded("approve");
  const intent = amendmentEntries(api, "intent")[0]; assert.ok(intent, "hook writes one audit intent before Pi appends the real user message");
  assert.equal(amendmentEntries(api, "decision").length, 0);
  await invoke(api, "goal_status", {});
  const decision = amendmentEntries(api, "decision")[0]?.data, user = api.entries.findLast((entry) => entry.type === "message" && entry.message?.role === "user");
  assert.deepEqual({ choice: decision?.choice, approved: decision?.approved, proposalId: decision?.proposalId, userEntryId: decision?.userEntryId }, { choice: "approve", approved: true, proposalId: proposal.proposalId, userEntryId: user.id });
  assert.equal(projectionFor(cwd).pendingHumanDecision.phase, "approved");
  assert.match(await invoke(api, "goal_status", {}), /R10B_AMENDMENT_APPLY_REQUIRED/);
});

test("R10B reject is durable rejected/reproposal-required and never signs, resumes, or applies", async () => {
  const { cwd, api } = await decideSeeded("reject"); await invoke(api, "goal_status", {});
  const pending = projectionFor(cwd).pendingHumanDecision, visible = `${events(cwd)}\n${JSON.stringify(api.entries)}`;
  assert.equal(pending.phase, "rejected"); assert.equal(pending.choice, "reject"); assert.equal(pending.approved, false);
  assert.match(await invoke(api, "goal_status", {}), /R10B_AMENDMENT_REJECTED|R10B_AMENDMENT_REPROPOSAL_REQUIRED/);
  assert.doesNotMatch(visible, /amendment_capability_consumed|goal\.runtime_resumed|amendment_applied/);
});

test("R10B accepts exactly one complete Pi compaction in the intent-to-user parent chain", async () => {
  const { cwd, api } = await decideSeeded("approve"); const intent = amendmentEntries(api, "intent")[0]; assert.ok(intent, "hook creates the approval intent"); const user = api.entries.at(-1), t = Date.now();
  intent.timestamp = new Date(t).toISOString(); user.timestamp = new Date(t + 2).toISOString();
  const compact = { id: "pi-compact", parentId: intent.id, timestamp: new Date(t + 1).toISOString(), type: "compaction", summary: "kept context", firstKeptEntryId: "first-kept", tokensBefore: 1 };
  user.parentId = compact.id; api.entries.splice(-1, 0, compact); await invoke(api, "goal_status", {});
  assert.equal(projectionFor(cwd).pendingHumanDecision.phase, "approved");
});

for (const invalid of ["fromHook", "empty-summary", "empty-first-kept", "tokens", "before-intent", "after-user", "two", "custom", "assistant", "broken-parent"]) test(`R10B rejects invalid ${invalid} approval chain`, async () => {
  const { cwd, api } = await decideSeeded("approve"); const intent = amendmentEntries(api, "intent")[0]; assert.ok(intent, "hook creates the approval intent"); const user = api.entries.at(-1), compact = { id: "bad-compact", parentId: intent.id, timestamp: new Date().toISOString(), type: "compaction", summary: "summary", firstKeptEntryId: "first", tokensBefore: 1 };
  const start = Date.now(); intent.timestamp = new Date(start).toISOString(); user.timestamp = new Date(start + 2).toISOString(); compact.timestamp = new Date(start + 1).toISOString();
  if (invalid === "fromHook") compact.fromHook = true; if (invalid === "empty-summary") compact.summary = ""; if (invalid === "empty-first-kept") compact.firstKeptEntryId = ""; if (invalid === "tokens") compact.tokensBefore = -1; if (invalid === "custom") compact.type = "custom"; if (invalid === "assistant") { compact.type = "message"; compact.message = { role: "assistant", content: "approve" }; }
  if (invalid === "before-intent") compact.timestamp = new Date(start - 1).toISOString(); if (invalid === "after-user") compact.timestamp = new Date(start + 3).toISOString();
  user.parentId = invalid === "broken-parent" ? "missing" : compact.id; api.entries.splice(-1, 0, compact);
  if (invalid === "two") { const second = { ...compact, id: "bad-compact-2", parentId: compact.id }; user.parentId = second.id; api.entries.splice(-1, 0, second); }
  await invoke(api, "goal_status", {}); assert.equal(amendmentEntries(api, "decision").length, 0); assert.equal(projectionFor(cwd).pendingHumanDecision.phase, "proposed");
});

test("R10B ignores off-branch, duplicate, extension, image, streaming, and cross-session amendment input", async () => {
  for (const options of [{ branch: [] }, { images: [{ type: "image", data: "x", mimeType: "image/png" }] }, { streamingBehavior: "steer" }, { source: "extension" }]) {
    const { cwd, api } = await decideSeeded("approve", options); await invoke(api, "goal_status", {}); assert.equal(amendmentEntries(api, "decision").length, 0); assert.equal(projectionFor(cwd).pendingHumanDecision.phase, "proposed");
  }
  const { cwd, api } = await decideSeeded("approve"); const intent = amendmentEntries(api, "intent")[0]; assert.ok(intent, "hook creates the approval intent"); api.appendEntry("goal-engine-execution-amendment-intent", intent.data); await invoke(api, "goal_status", {}); assert.equal(amendmentEntries(api, "decision").length, 0); assert.equal(projectionFor(cwd).pendingHumanDecision.phase, "proposed");
  const other = await pendingProposalFixture(); await other.api.handlers.get("input")({ type: "input", text: "approve", source: "interactive" }, { cwd: other.cwd, sessionManager: { ...other.api.sessionManager, getSessionId: () => "other" } }); await invoke(other.api, "goal_status", {}); assert.equal(amendmentEntries(other.api, "decision").length, 0); assert.equal(projectionFor(other.cwd).pendingHumanDecision.phase, "proposed");
});

test("R10B retries pre-append failure, recovers one durable decision, and reload re-proves its active branch", async () => {
  const fixture = await pendingProposalFixture(), cwd = fixture.cwd, api = pi(cwd, structuredClone(fixture.api.entries)); let approvalAppends = 0;
  const approvalEvents = () => events(cwd).trim().split("\n").filter((line) => JSON.parse(line).type === "execution.amendment_approved").length;
  createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd), appendEvent(root, event, version) {
    if (event.type !== "execution.amendment_approved") return appendEvent(root, event, version);
    if (++approvalAppends === 1) throw Error("before decision append");
    appendEvent(root, event, version); throw Error("after decision append");
  } });
  await api.handlers.get("input")({ type: "input", text: "approve", source: "interactive" }, { cwd, sessionManager: api.sessionManager });
  assert.ok(amendmentEntries(api, "intent")[0], "hook creates the approval intent before durable append handling");
  await assert.rejects(invoke(api, "goal_status", {}), /before decision append/); assert.equal(projectionFor(cwd).pendingHumanDecision.phase, "proposed"); assert.equal(approvalEvents(), 0);
  assert.match(await invoke(api, "goal_status", {}), /R10B_AMENDMENT_DECISION_RECORDED/); assert.equal(projectionFor(cwd).pendingHumanDecision.phase, "approved"); assert.equal(approvalEvents(), 1); assert.equal(amendmentEntries(api, "decision").length, 1);
  const reload = pi(cwd, structuredClone(api.entries), { branch: api.sessionManager.getBranch() }); createGoalEngineExtension(reload, { goalStateEnv: {}, runtimeHost: host(cwd) }); reload.handlers.get("session_start")({}, { sessionManager: reload.sessionManager }); await invoke(reload, "goal_status", {});
  assert.equal(projectionFor(cwd).pendingHumanDecision.phase, "approved"); assert.equal(approvalEvents(), 1); assert.equal(amendmentEntries(reload, "decision").length, 1);
});
