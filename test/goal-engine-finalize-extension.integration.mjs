import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { appendEvent, appendEventBatch, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../scripts/lib/goal-engine/obligation-contract.mjs";
import { createObservationAdapterRegistry } from "../scripts/lib/goal-engine/observation-adapters.mjs";
import { runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const head = cwd => git(cwd, "rev-parse", "HEAD");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const rootFor = cwd => join(cwd, ".state/goal-engine");
const event = (goalId, type, data, n) => ({ schemaVersion: "goal-runtime.v1", eventId: `${goalId}-${n}`, goalId, occurredAt: `2026-09-01T00:00:${String(n).padStart(2, "0")}.000Z`, type, data });
const intentKeys = ["choices", "goalId", "head", "manifestHash", "protocol", "sessionId", "stateHash", "worldHash"];

function runtimeInit() {
  return { objective: "Finalize converged runtime", execution: { schema: "goal-runtime.v1", tasks: [], conditions: [{ id: "final-condition", role: "terminal", enforcement: "final", statement: "Final fixture passes", observable: "fixture", expected: "passing", depends_on: [], oracle_ref: "oracle", environment_ref: "local", fixture_refs: ["sample"], invalidation: { paths: [], task_ids: [] }, remediation: { policy: "user-approved", allowed_paths: ["test/**"], max_attempts: 0 }, stability: { mode: "single", require_fresh_environment: true } }], write_policy: { allowed_paths: ["test/**"] }, budgets: { max_observations: 1, max_repairs: 0, max_elapsed_minutes: 1, max_no_progress: 1 } } };
}
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "goal-finalize-extension-"));
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: 初始化终审仓库");
  return cwd;
}
function pi(cwd, entries = [], sessionId = "owner") {
  const tools = [], listeners = new Map(); let sequence = entries.length, leaf = entries.at(-1)?.id ?? null;
  const append = row => { const entry = { id: `entry-${++sequence}`, parentId: leaf, timestamp: new Date(1_800_000_000_000 + sequence).toISOString(), ...row }; entries.push(entry); leaf = entry.id; return entry; };
  const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => join(cwd, `session-${sessionId}`), getLeafId: () => leaf, getEntries: () => entries, getBranch: () => entries };
  return { cwd, tools, entries, sessionManager, registerTool: tool => tools.push(tool), on: (name, handler) => listeners.set(name, handler), appendEntry: (customType, data) => append({ type: "custom", customType, data }), appendMessage: (text, extra = {}) => append({ type: "message", message: { role: "user", content: text }, ...extra }), handlers: { get(name) { const handler = listeners.get(name); if (name !== "input" || !handler) return handler; return async (input, ctx) => { const result = await handler(input, ctx); if (["interactive", "rpc"].includes(input.source)) append({ type: "message", message: { role: "user", content: input.text }, ...(input.images !== undefined ? { images: input.images } : {}), ...(input.streamingBehavior !== undefined ? { streamingBehavior: input.streamingBehavior } : {}) }); return result; }; } } };
}
function host(cwd, calls) {
  const adapter = { ref: "oracle", version: "1", deterministic: true, reset: "clean", resourceClaims: [], artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" }, validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 1, maxOutputBytes: 1, terminationGraceMs: 1, maxConcurrentWorkspaces: 1 }, actions: [{ id: "check", kind: "validation", executable: "/usr/bin/true", args: [] }] } };
  return { registries: runtimeRegistries, captureCurrentWorld() { calls.world++; return { safe: true, repo: { root: cwd, head: head(cwd), trackedDirty: [], untracked: [], unmerged: [], sequencer: null }, adapters: [{ ref: "oracle", version: "1" }], environments: [{ ref: "local", fingerprint: "fixture-environment-1", available: true }], fixtures: [{ ref: "sample", fingerprint: "fixture", available: true }], resources: [], activeRuns: [], capturedAt: new Date().toISOString() }; }, adapterRegistry: createObservationAdapterRegistry([adapter]), prepareManagedValidation() { calls.managed++; throw Error("finalization must not start managed validation"); }, artifactRefForRun() { throw Error("finalization must not request an observation artifact"); }, startManagedValidation() { calls.start++; throw Error("finalization must not start an observation"); }, recoverManagedValidation() { calls.recover++; throw Error("finalization must not recover an observation"); }, releaseManagedValidation() { calls.release++; throw Error("finalization must not release an observation"); } };
}
function converged(cwd, api, { append = appendEvent } = {}) {
  const goalId = "finalize-converged", root = rootFor(cwd), contract = normalizeRuntimeGoalInit(runtimeInit(), runtimeRegistries); let projection;
  const write = (type, data, n) => { projection = append(root, event(goalId, type, data, n), projection?.version ?? 0); };
  write("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), baseHead: head(cwd), readiness: "draft" }, 1);
  write("goal.session_bound", { sessionId: api.sessionManager.getSessionId(), leafId: "fixture-leaf" }, 2);
  write("goal.runtime_readiness_recorded", { readiness: "ready", reasons: [] }, 3);
  const approval = { proposalId: "fixture-activation", executionContractHash: projection.executionContractHash, baseHead: head(cwd), sessionId: api.sessionManager.getSessionId() };
  const proposalHash = hash(JSON.stringify({ baseHead: approval.baseHead, executionContractHash: approval.executionContractHash, goalId, proposalId: approval.proposalId, sessionId: approval.sessionId }));
  write("goal.runtime_approval_recorded", { ...approval, proposalHash, userEntryId: "activation-user", capabilityDigest: "a".repeat(64) }, 4);
  const recordCycle = (cycle, prefix, n) => { const condition = projection.conditions.get("final-condition"), common = { runId: `${prefix}-run`, conditionId: "final-condition", cycle, head: head(cwd), executionRevision: projection.executionRevision, executionContractHash: projection.executionContractHash, conditionHash: condition.conditionHash, adapter: { ref: "oracle", version: "1" }, worldSnapshotHash: "1".repeat(64), resourceClaimsHash: "2".repeat(64) };
    write("condition.observation_requested", common, n); write("condition.observation_lease_allocated", { runId: common.runId, conditionId: common.conditionId, allocationId: `${prefix}-lease`, leaseReceiptHash: "3".repeat(64) }, n + 1); write("condition.observation_process_bound", { runId: common.runId, conditionId: common.conditionId, processIdentityHash: "4".repeat(64) }, n + 2); write("condition.observation_terminal", { runId: common.runId, conditionId: common.conditionId, terminalProofHash: "5".repeat(64) }, n + 3);
    const evidence = { executionRevision: common.executionRevision, executionContractHash: common.executionContractHash, conditionHash: common.conditionHash, head: common.head, adapter: common.adapter, environment: { ref: "local", fingerprint: `fixture-environment-${cycle}` }, fixtures: [{ ref: "sample", fingerprint: "fixture" }], artifact: { id: `${prefix}-artifact`, hash: "6".repeat(64) } };
    write("condition.observation_recorded", { runId: common.runId, conditionId: common.conditionId, evidenceId: `${cycle}`.repeat(64), verdict: { kind: "passed" }, evidence }, n + 4); write("condition.observation_released", { runId: common.runId, conditionId: common.conditionId, releaseReceiptHash: "8".repeat(64) }, n + 5); };
  recordCycle(0, "calibration", 5); write("goal.runtime_activated", {}, 11); recordCycle(1, "final", 12);
  return { goalId, root };
}
async function invoke(api, name, input = {}) { return (await api.tools.find(tool => tool.name === name).execute("call", input, undefined, undefined, { cwd: api.cwd, sessionManager: api.sessionManager })).details.value; }
function events(cwd, goalId) { return readFileSync(join(rootFor(cwd), "goals", goalId, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse); }
function count(cwd, goalId, type) { return events(cwd, goalId).filter(row => row.type === type).length; }
function finalIntent(api) { return api.entries.filter(row => row.customType === "goal-engine-final-review-approval-intent"); }
function setup(options = {}) { const cwd = repo(), calls = { world: 0, adapter: 0, managed: 0, start: 0, recover: 0, release: 0, provider: 0 };  const api = pi(cwd); createGoalEngineExtension(api, { goalStateEnv: {}, runtimeHost: host(cwd, calls), finalReviewProvider: async input => { calls.provider++; return options.provider?.(input) ?? { severity: "none", reportRef: `sha256:${"b".repeat(64)}` }; }, ...(options.append ? { appendEvent: options.append } : {}), ...(options.appendBatch ? { appendEventBatch: options.appendBatch } : {}), ...options.extension }); const fixture = converged(cwd, api, options); return { cwd, api, calls, ...fixture }; }
async function requestFinalReview(fixture) { return JSON.parse(await invoke(fixture.api, "goal_status", { goal_id: fixture.goalId })); }
async function approve(fixture, text = "approve") { await fixture.api.handlers.get("input")({ type: "input", source: "interactive", text }, { cwd: fixture.cwd, sessionManager: fixture.api.sessionManager }); return requestFinalReview(fixture); }

// A real Store-backed runtime ledger is converged before every case; no test supplies a projection.
test("fake Pi input wrapper 只为 interactive/rpc 追加 user message 并保留 images/streamingBehavior 字段", async () => {
  const fixture = setup();
  await fixture.api.handlers.get("input")({ type: "input", source: "interactive", text: "hello", images: [{ type: "image" }], streamingBehavior: "steer" }, { cwd: fixture.cwd, sessionManager: fixture.api.sessionManager });
  const message = fixture.api.entries.at(-1);
  assert.equal(message.type, "message"); assert.deepEqual(message.message, { role: "user", content: "hello" });
  assert.deepEqual(message.images, [{ type: "image" }]); assert.equal(message.streamingBehavior, "steer");
  const before = fixture.api.entries.length;
  await fixture.api.handlers.get("input")({ type: "input", source: "extension", text: "ignored" }, { cwd: fixture.cwd, sessionManager: fixture.api.sessionManager });
  assert.equal(fixture.api.entries.length, before);
});

test("首次 status 只追加精确的终审配对 intent，reload 保持唯一且不签 offer", async () => {
  const fixture = setup(), first = await requestFinalReview(fixture);
  assert.equal(first.status, "APPROVAL_REQUIRED"); assert.equal(first.action_token, undefined);
  const [entry] = finalIntent(fixture.api); assert.ok(entry);
  assert.deepEqual(Object.keys(entry.data).sort(), intentKeys);
  assert.deepEqual(entry.data, { protocol: "goal-engine-final-review-approval-intent.v1", goalId: fixture.goalId, manifestHash: entry.data.manifestHash, stateHash: entry.data.stateHash, worldHash: entry.data.worldHash, head: head(fixture.cwd), sessionId: "owner", choices: ["approve", "reject"] });
  const reloaded = pi(fixture.cwd, structuredClone(fixture.api.entries)); createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: host(fixture.cwd, fixture.calls) }); await invoke(reloaded, "goal_status", { goal_id: fixture.goalId });
  assert.equal(finalIntent(reloaded).length, 1); assert.equal(count(fixture.cwd, fixture.goalId, "goal.action_offered"), 0);
});

test("pending intent 后 direct user approve 不 suspend，并签发绑定该 entry 的 finalize offer", async () => {
  const fixture = setup(); await requestFinalReview(fixture); const status = await approve(fixture);
  const user = fixture.api.entries.at(-1); assert.equal(loadProjection(fixture.root, fixture.goalId).runtimeState, "active");
  assert.equal(status.machineAction.tool, "goal_finalize"); assert.equal(typeof status.action_token, "string");
  assert.equal(status.machineAction.params.approval_entry_id, user.id); assert.equal(count(fixture.cwd, fixture.goalId, "goal.runtime_suspended"), 0);
});

test("reject 不签发 offer，后续 status 可产生新的终审 intent", async () => {
  const fixture = setup(); await requestFinalReview(fixture); const rejected = await approve(fixture, "reject");
  assert.equal(rejected.action_token, undefined); assert.equal(count(fixture.cwd, fixture.goalId, "goal.action_offered"), 0);
  const fresh = await requestFinalReview(fixture); assert.equal(fresh.status, "APPROVAL_REQUIRED"); assert.equal(finalIntent(fixture.api).length, 2);
});

test("approval chain 的非分支、非用户和非法 compaction 均不签 offer 或写 Goal final event", async t => {
  for (const mutation of ["off-branch", "assistant", "extension", "image", "streaming", "duplicate-intent", "broken-parent", "bad-compaction", "double-compaction"]) await t.test(mutation, async () => {
    const fixture = setup(); await requestFinalReview(fixture);
    const [intent] = finalIntent(fixture.api);
    assert.equal(finalIntent(fixture.api).length, 1);
    assert.equal(intent.parentId, fixture.api.entries.at(-2)?.id ?? null);
    assert.deepEqual(Object.keys(intent.data).sort(), intentKeys);
    assert.equal(intent.data.protocol, "goal-engine-final-review-approval-intent.v1"); assert.equal(intent.data.goalId, fixture.goalId); assert.equal(intent.data.head, head(fixture.cwd)); assert.equal(intent.data.sessionId, "owner");
    if (mutation === "off-branch") fixture.api.sessionManager.getBranch = () => [];
    else if (mutation === "duplicate-intent") { const duplicate = fixture.api.appendEntry(intent.customType, structuredClone(intent.data)); assert.equal(finalIntent(fixture.api).length, 2); assert.equal(duplicate.parentId, intent.id); assert.deepEqual(duplicate.data, intent.data); }
    else if (mutation === "extension") await fixture.api.handlers.get("input")({ type: "input", source: "extension", text: "approve" }, { cwd: fixture.cwd, sessionManager: fixture.api.sessionManager });
    else { const user = fixture.api.appendMessage("approve", mutation === "image" ? { images: [{ type: "image" }] } : mutation === "streaming" ? { streamingBehavior: "steer" } : {}); if (mutation === "assistant") user.message.role = "assistant"; if (mutation === "broken-parent") user.parentId = "broken"; if (mutation.includes("compaction")) { const compact = { id: "compact", parentId: intent.id, timestamp: user.timestamp, type: "compaction", summary: mutation === "bad-compaction" ? "" : "ok", firstKeptEntryId: intent.id, tokensBefore: 1 }; user.parentId = compact.id; fixture.api.entries.splice(-1, 0, compact); if (mutation === "double-compaction") { const second = { ...compact, id: "compact-2", parentId: compact.id }; user.parentId = second.id; fixture.api.entries.splice(-1, 0, second); } } }
    const status = await requestFinalReview(fixture);
    assert.equal(status.action_token, undefined); assert.equal(count(fixture.cwd, fixture.goalId, "goal.action_offered"), 0); assert.equal(count(fixture.cwd, fixture.goalId, "goal.final_review_started"), 0); assert.equal(count(fixture.cwd, fixture.goalId, "goal.completed"), 0);
  });
});

test("错误 token、session、approval entry、extra、planned 与缺失 provider 均在 file/event/provider 前拒绝", async () => {
  const fixture = setup(); await requestFinalReview(fixture); const offered = await approve(fixture);
  for (const input of [{ ...offered.machineAction.params, action_token: "wrong" }, { ...offered.machineAction.params, action_token: offered.action_token, approval_entry_id: "wrong" }, { ...offered.machineAction.params, action_token: offered.action_token, extra: true }]) await assert.rejects(invoke(fixture.api, "goal_finalize", input));
  const wrongSession = pi(fixture.cwd, structuredClone(fixture.api.entries), "other"); createGoalEngineExtension(wrongSession, { goalStateEnv: {}, runtimeHost: host(fixture.cwd, fixture.calls) });
  await assert.rejects(invoke(wrongSession, "goal_finalize", { ...offered.machineAction.params, action_token: offered.action_token }));
  assert.equal(fixture.calls.provider, 0); assert.equal(count(fixture.cwd, fixture.goalId, "goal.final_review_started"), 0); assert.equal(count(fixture.cwd, fixture.goalId, "goal.completed"), 0);
  const plannedCwd = repo(), planned = pi(plannedCwd), plannedCalls = { world: 0, adapter: 0, managed: 0, start: 0, recover: 0, release: 0, provider: 0 };
  createGoalEngineExtension(planned, { goalStateEnv: {}, runtimeHost: host(plannedCwd, plannedCalls), finalReviewProvider: async () => { plannedCalls.provider++; return { severity: "none", reportRef: `sha256:${"a".repeat(64)}` }; } });
  const plannedGoal = JSON.parse(await invoke(planned, "goal_init", { objective: "Real planned finalize rejection", tasks: [{ id: "planned-task", description: "real planned task", writePaths: ["test/**"], acceptance: { criteria: [{ id: "planned-criterion", statement: "planned remains a real goal", evidenceKinds: ["tests"] }] }, workflow: "tdd" }] })).goalId;
  await assert.rejects(invoke(planned, "goal_finalize", { goal_id: plannedGoal, action_token: "planned-token", approval_entry_id: "planned-entry" }));
  assert.equal(plannedCalls.provider, 0); assert.equal(count(plannedCwd, plannedGoal, "goal.final_review_started"), 0); assert.equal(count(plannedCwd, plannedGoal, "goal.completed"), 0);
  const noProvider = setup({ extension: { finalReviewProvider: undefined } }); await requestFinalReview(noProvider); const noProviderOffer = await approve(noProvider); await assert.rejects(invoke(noProvider.api, "goal_finalize", { ...noProviderOffer.machineAction.params, action_token: noProviderOffer.action_token })); assert.equal(count(noProvider.cwd, noProvider.goalId, "goal.final_review_started"), 0);
});

test("none provider 在 unlocked durable started+intent 后原子 recorded/completed，reload 不重复调用", async () => {
  const fixture = setup({ provider: input => { assert.equal(input.writerLockHeld, false); assert.equal(count(fixture.cwd, fixture.goalId, "goal.final_review_started"), 1); return { severity: "none", reportRef: `sha256:${"c".repeat(64)}` }; } }); await requestFinalReview(fixture); const offer = await approve(fixture); await invoke(fixture.api, "goal_finalize", { ...offer.machineAction.params, action_token: offer.action_token });
  assert.equal(count(fixture.cwd, fixture.goalId, "goal.action_consumed"), 1); assert.equal(count(fixture.cwd, fixture.goalId, "goal.final_review_recorded"), 1); assert.equal(count(fixture.cwd, fixture.goalId, "goal.completed"), 1); assert.equal(loadProjection(fixture.root, fixture.goalId).completionHistory.length, 1); const before = fixture.calls.provider; await invoke(fixture.api, "goal_status", { goal_id: fixture.goalId }); assert.equal(fixture.calls.provider, before);
});

test("important 与 critical 只 changes_required，Goal 保持 active 且新的 approval 可开始下一 review", async t => {
  for (const severity of ["important", "critical"]) await t.test(severity, async () => {
    const fixture = setup({ provider: () => ({ severity, reportRef: `sha256:${"d".repeat(64)}` }) }); await requestFinalReview(fixture); const offer = await approve(fixture); await invoke(fixture.api, "goal_finalize", { ...offer.machineAction.params, action_token: offer.action_token });
    assert.equal(loadProjection(fixture.root, fixture.goalId).lifecycle, "active"); assert.equal(count(fixture.cwd, fixture.goalId, "goal.completed"), 0); assert.equal((await requestFinalReview(fixture)).status, "APPROVAL_REQUIRED");
  });
});

test("provider throw 后 reload/status 只给同一 recovery action，显式 retry 才完成", async () => {
  let fail = true, firstKey; const fixture = setup({ provider: input => { firstKey ??= input.idempotencyKey; if (fail) throw Error("timeout"); assert.equal(input.idempotencyKey, firstKey); return { severity: "none", reportRef: `sha256:${"e".repeat(64)}` }; } }); await requestFinalReview(fixture); const offer = await approve(fixture);
  await assert.rejects(invoke(fixture.api, "goal_finalize", { ...offer.machineAction.params, action_token: offer.action_token })); assert.equal(fixture.calls.provider, 1);
  fail = false; const reloaded = pi(fixture.cwd, structuredClone(fixture.api.entries)); createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: host(fixture.cwd, fixture.calls), finalReviewProvider: async input => { fixture.calls.provider++; assert.equal(input.idempotencyKey, firstKey); return { severity: "none", reportRef: `sha256:${"e".repeat(64)}` }; } });
  const recovery = await requestFinalReview({ ...fixture, api: reloaded }); assert.equal(recovery.machineAction.tool, "goal_finalize"); assert.equal(recovery.action_token, offer.action_token); assert.equal(fixture.calls.provider, 1);
  await invoke(reloaded, "goal_finalize", { ...recovery.machineAction.params, action_token: recovery.action_token }); assert.equal(fixture.calls.provider, 2); assert.equal(count(fixture.cwd, fixture.goalId, "goal.action_consumed"), 1); assert.equal(count(fixture.cwd, fixture.goalId, "goal.final_review_started"), 1); assert.equal(count(fixture.cwd, fixture.goalId, "goal.completed"), 1);
});

test("result 已 durable 而 Goal completion batch pre-append throw 时 reload recovery 不重跑 provider 且只完成一次", async () => {
  let throwBeforeCompletion = true; const fixture = setup({ appendBatch(root, rows, version) { if (rows.some(row => row.type === "goal.completed") && throwBeforeCompletion) { throwBeforeCompletion = false; throw Error("before durable completion batch"); } return appendEventBatch(root, rows, version); } }); await requestFinalReview(fixture); const offer = await approve(fixture); await assert.rejects(invoke(fixture.api, "goal_finalize", { ...offer.machineAction.params, action_token: offer.action_token })); const calls = fixture.calls.provider;
  assert.equal(count(fixture.cwd, fixture.goalId, "goal.final_review_recorded"), 0); assert.equal(count(fixture.cwd, fixture.goalId, "goal.completed"), 0); assert.equal(fixture.calls.provider, 1);
  const reloaded = pi(fixture.cwd, structuredClone(fixture.api.entries)); createGoalEngineExtension(reloaded, { goalStateEnv: {}, runtimeHost: host(fixture.cwd, fixture.calls), finalReviewProvider: async () => { fixture.calls.provider++; throw Error("provider must not rerun"); } }); const recovery = await requestFinalReview({ ...fixture, api: reloaded }); assert.equal(recovery.machineAction.tool, "goal_finalize"); assert.equal(recovery.action_token, offer.action_token); assert.equal(fixture.calls.provider, calls); await invoke(reloaded, "goal_finalize", { ...recovery.machineAction.params, action_token: recovery.action_token }); assert.equal(fixture.calls.provider, calls); assert.equal(count(fixture.cwd, fixture.goalId, "goal.completed"), 1); assert.equal(loadProjection(fixture.root, fixture.goalId).completionHistory.length, 1);
});

test("appendEventBatch durable completion 后 throw 时同一调用 reload completed 且不 retry provider", async () => {
  let throwAfterCompletion = true; const fixture = setup({ appendBatch(root, rows, version) { const value = appendEventBatch(root, rows, version); if (rows.some(row => row.type === "goal.completed") && throwAfterCompletion) { throwAfterCompletion = false; throw Error("after durable completion batch"); } return value; } }); await requestFinalReview(fixture); const offer = await approve(fixture); const result = await invoke(fixture.api, "goal_finalize", { ...offer.machineAction.params, action_token: offer.action_token });
  assert.equal(fixture.calls.provider, 1); assert.equal(result.status, "completed"); assert.equal(count(fixture.cwd, fixture.goalId, "goal.completed"), 1); assert.equal(loadProjection(fixture.root, fixture.goalId).completionHistory.length, 1);
});

test("started 后 Goal version 或 world/head/resource 漂移只记录 stale，不 complete，并要求 fresh approval", async () => {
  const fixture = setup({ provider: () => { git(fixture.cwd, "commit", "--allow-empty", "-m", "test: 漂移终审世界"); return { severity: "none", reportRef: `sha256:${"f".repeat(64)}` }; } }); await requestFinalReview(fixture); const offer = await approve(fixture); await invoke(fixture.api, "goal_finalize", { ...offer.machineAction.params, action_token: offer.action_token }); assert.equal(count(fixture.cwd, fixture.goalId, "goal.final_review_recorded"), 1); assert.equal(count(fixture.cwd, fixture.goalId, "goal.completed"), 0); assert.equal((await requestFinalReview(fixture)).status, "APPROVAL_REQUIRED");
});

test("goal_finalize 只 captureCurrentWorld 和 ledger，不调用 observation adapter、managed 或业务 Oracle", async () => {
  const fixture = setup(); await requestFinalReview(fixture); const offer = await approve(fixture); await invoke(fixture.api, "goal_finalize", { ...offer.machineAction.params, action_token: offer.action_token }); assert.ok(fixture.calls.world > 0); assert.equal(fixture.calls.adapter, 0); assert.equal(fixture.calls.managed, 0); assert.equal(fixture.calls.start, 0); assert.equal(fixture.calls.recover, 0); assert.equal(fixture.calls.release, 0);
});
