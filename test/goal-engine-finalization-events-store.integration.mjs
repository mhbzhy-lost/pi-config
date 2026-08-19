import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent, createProjection } from "../scripts/lib/goal-engine/events.mjs";
import { appendEvent, appendEventBatch, loadProjection } from "../scripts/lib/goal-engine/store.mjs";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract } from "../scripts/lib/goal-engine/obligation-contract.mjs";
import { runtimeRegistries } from "./helpers/goal-runtime-fixtures.mjs";

const head = "a".repeat(40);
const finalReviewApproval = { entryId: "final-review-user", sessionId: "owner", source: "user" };
const hex = (n) => n.toString(16).padStart(64, "0");
const event = (type, data, n, goalId = "finalization-goal") => ({ schemaVersion: "goal-runtime.v1", eventId: `${goalId}-${n}`, goalId, occurredAt: `2026-08-30T00:00:${String(n).padStart(2, "0")}.000Z`, type, data });
function zeroTaskRuntime() { return { objective: "Finalization event contract", execution: { schema: "goal-runtime.v1", tasks: [], conditions: [{ id: "final-condition", role: "terminal", enforcement: "final", statement: "Finalization fixture passes", observable: "fixture", expected: "passing", depends_on: [], oracle_ref: "oracle", environment_ref: "local", fixture_refs: ["sample"], invalidation: { paths: [], task_ids: [] }, remediation: { policy: "user-approved", allowed_paths: ["test/**"], max_attempts: 0 }, stability: { mode: "single", require_fresh_environment: true } }], write_policy: { allowed_paths: ["test/**"] }, budgets: { max_observations: 2, max_repairs: 0, max_elapsed_minutes: 1, max_no_progress: 1 } } }; }
function approvalHash(value) { return createHash("sha256").update(JSON.stringify({ baseHead: value.baseHead, executionContractHash: value.executionContractHash, goalId: "finalization-goal", proposalId: value.proposalId, sessionId: value.sessionId })).digest("hex"); }
function observation(p, cycle, n) { const common = { runId: `run-${cycle}`, conditionId: "final-condition" }, evidence = { executionRevision: p.executionRevision, executionContractHash: p.executionContractHash, conditionHash: p.conditions.get("final-condition").conditionHash, head, adapter: { ref: "oracle", version: "1" }, environment: { ref: "local", fingerprint: `environment-${cycle}` }, fixtures: [{ ref: "sample", fingerprint: "fixture" }], artifact: { id: `artifact-${cycle}`, hash: hex(n + 5) } }; return [event("condition.observation_requested", { ...common, cycle, head, executionRevision: p.executionRevision, executionContractHash: p.executionContractHash, conditionHash: p.conditions.get("final-condition").conditionHash, adapter: { ref: "oracle", version: "1" }, worldSnapshotHash: hex(n), resourceClaimsHash: hex(n + 1) }, n), event("condition.observation_lease_allocated", { ...common, allocationId: `lease-${cycle}`, leaseReceiptHash: hex(n + 2) }, n + 1), event("condition.observation_process_bound", { ...common, processIdentityHash: hex(n + 3) }, n + 2), event("condition.observation_terminal", { ...common, terminalProofHash: hex(n + 4) }, n + 3), event("condition.observation_recorded", { ...common, evidenceId: hex(n + 6), verdict: { kind: "passed" }, evidence }, n + 4), event("condition.observation_released", { ...common, releaseReceiptHash: hex(n + 7) }, n + 5)]; }
function activeEvents() { const contract = normalizeRuntimeGoalInit(zeroTaskRuntime(), runtimeRegistries), records = []; let p = createProjection(); const apply = (row) => { records.push(row); p = applyEvent(p, row); }; apply(event("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), baseHead: head, readiness: "draft" }, 1)); apply(event("goal.session_bound", { sessionId: "owner", leafId: "leaf" }, 2)); apply(event("goal.runtime_readiness_recorded", { readiness: "ready", reasons: [] }, 3)); const approval = { proposalId: "proposal", executionContractHash: p.executionContractHash, baseHead: head, sessionId: "owner" }; apply(event("goal.runtime_approval_recorded", { ...approval, proposalHash: approvalHash(approval), userEntryId: "user-entry", capabilityDigest: hex(2) }, 4)); for (const row of observation(p, 0, 5)) apply(row); apply(event("goal.runtime_activated", {}, 11)); for (const row of observation(p, 1, 12)) apply(row); return { projection: p, records }; }
function active() { return activeEvents().projection; }
function storedActive() { const root = mkdtempSync(join(tmpdir(), "goal-finalization-events-")); let p = createProjection(); for (const row of activeEvents().records) p = appendEvent(root, row, p.version); return { root, projection: p }; }
function started(p, n = 18, overrides = {}) { return event("goal.final_review_started", { reviewId: "review-1", manifestHash: hex(101), stateHash: hex(102), worldHash: hex(103), head, approval: finalReviewApproval, ...overrides }, n); }
function recorded(p, severity = "none", n = 19, overrides = {}) { return event("goal.final_review_recorded", { reviewId: "review-1", resultHash: hex(104), severity, status: ["none", "minor"].includes(severity) ? "recorded" : "changes_required", ...overrides }, n); }
function completed(n = 20, overrides = {}) { return event("goal.completed", { verdict: "COMPLETE", reviewId: "review-1", manifestHash: hex(101), stateHash: hex(102), worldHash: hex(103), head, resultHash: hex(104), ...overrides }, n); }
function files(root) { const goal = join(root, "goals", "finalization-goal"); return ["events.jsonl", "projection.json"].map((name) => readFileSync(join(goal, name), "utf8")); }

function withStarted() { const p = active(); return applyEvent(p, started(p)); }

// The payload is an identity record, not a carrier for provider/report text.
test("runtime final review start persists the complete exact identity", () => {
  const p = active(), next = applyEvent(p, started(p));
  assert.deepEqual(next.finalReview, { reviewId: "review-1", manifestHash: hex(101), stateHash: hex(102), worldHash: hex(103), head, approval: finalReviewApproval, status: "started" });
});

test("runtime final review start rejects duplicate review identity", () => {
  const p = withStarted();
  assert.throws(() => applyEvent(p, started(p, 19)), /final review start|duplicate/i);
});
test("runtime final review start rejects conflicting review identity", () => {
  const p = withStarted();
  assert.throws(() => applyEvent(p, started(p, 20, { reviewId: "review-2" })), /final review start|duplicate/i);
});
for (const [name, overrides] of [
  ["missing approval", { approval: undefined }], ["extra approval field", { approval: { entryId: "final-review-user", sessionId: "owner", source: "user", extra: true } }],
  ["approval source not user", { approval: { entryId: "final-review-user", sessionId: "owner", source: "system" } }],
  ["approval session mismatch", { approval: { entryId: "final-review-user", sessionId: "other", source: "user" } }], ["invalid head", { head: "not-a-commit-head" }],
  ["non-hash manifest", { manifestHash: "bad" }], ["non-hash state", { stateHash: "bad" }],
  ["non-hash world", { worldHash: "bad" }], ["raw provider text", { providerText: "do not persist" }],
]) test(`runtime final review start rejects ${name}`, () => {
  const p = active(); assert.throws(() => applyEvent(p, started(p, 21, overrides)), /final review start|invalid/i);
});

test("runtime final review start rejects suspended runtime", () => {
  let p = active(); p = applyEvent(p, event("goal.runtime_suspended", { suspensionId: "s", reason: "interactive_steer", affectedTaskIds: [], affectedRunIds: [], requestedAt: "2026-08-30T00:00:18.000Z", resourcesQuarantined: false }, 18));
  assert.throws(() => applyEvent(p, started(p, 22)), /active|final review/i);
});
test("runtime final review start rejects non-active lifecycle", () => {
  const p = applyEvent(active(), event("goal.blocked", { reason: "awaiting operator intervention" }, 23));
  assert.throws(() => applyEvent(p, started(p, 24)), /active|final review|terminal/i);
});

test("runtime final review start accepts and persists a different legal head", () => {
  const alternateHead = "b".repeat(40);
  const next = applyEvent(active(), started(active(), 25, { head: alternateHead }));
  assert.equal(next.finalReview.head, alternateHead);
});

for (const severity of ["none", "minor", "important", "critical"]) test(`runtime records ${severity} with its canonical status`, () => {
  const p = withStarted(), next = applyEvent(p, recorded(p, severity));
  assert.equal(next.finalReview.status, ["none", "minor"].includes(severity) ? "recorded" : "changes_required");
  assert.deepEqual(Object.keys(next.finalReview).sort(), ["approval", "head", "manifestHash", "resultHash", "reviewId", "severity", "stateHash", "status", "worldHash"].sort());
});
for (const [name, overrides] of [["wrong status", { status: "recorded" }], ["wrong review", { reviewId: "other" }], ["raw report", { report: "provider response" }], ["extra field", { extra: true }]]) test(`runtime record rejects ${name}`, () => {
  const p = withStarted(); assert.throws(() => applyEvent(p, recorded(p, "important", 17, overrides)), /final review record|invalid/i);
});

test("changes_required is a standalone durable runtime record", () => {
  const { root, projection } = storedActive();
  try {
    const began = appendEvent(root, started(projection), projection.version);
    const next = appendEvent(root, recorded(began, "important"), began.version);
    assert.equal(next.lifecycle, "active"); assert.equal(next.finalReview.status, "changes_required");
    assert.equal(loadProjection(root, "finalization-goal").finalReview.status, "changes_required");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const severity of ["none", "minor"]) test(`${severity} review record cannot be appended standalone`, () => {
  const { root, projection } = storedActive();
  try {
    const began = appendEvent(root, started(projection), projection.version), before = files(root);
    assert.throws(() => appendEvent(root, recorded(began, severity), began.version), /atomic|batch|complete/i);
    assert.deepEqual(files(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical pass batch records then completes atomically and reloads", () => {
  const { root, projection } = storedActive();
  try {
    const alternateHead = "b".repeat(40);
    const began = appendEvent(root, started(projection, 18, { head: alternateHead }), projection.version);
    const next = appendEventBatch(root, [recorded(began), completed(20, { head: alternateHead })], began.version);
    assert.equal(next.lifecycle, "completed"); assert.equal(next.completionVerdict, "COMPLETE");
    const reloaded = loadProjection(root, "finalization-goal");
    assert.equal(reloaded.finalReview.head, alternateHead);
    assert.equal(reloaded.completionHistory.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [name, rows] of [
  ["standalone completion", (p) => [completed()]],
  ["reversed completion batch", (p) => [completed(), recorded(p)]],
  ["record-only batch", (p) => [recorded(p)]],
  ["extra batch event", (p) => [recorded(p), completed(), event("goal.checkpoint", { canonicalFingerprint: hex(200), advanced: true, sequence: 1 }, 19)]],
  ["cross-goal batch", (p) => [recorded(p), { ...completed(), goalId: "another-goal" }]],
]) test(`store rejects ${name} without changing finalization files`, () => {
  const { root, projection } = storedActive();
  try {
    const began = appendEvent(root, started(projection), projection.version), before = files(root);
    assert.throws(() => appendEventBatch(root, rows(began), began.version), /atomic|final|goalId|complete/i);
    assert.deepEqual(files(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [name, overrides] of [
  ["review drift", { reviewId: "other" }], ["manifest drift", { manifestHash: hex(201) }], ["state drift", { stateHash: hex(202) }],
  ["world drift", { worldHash: hex(203) }], ["head drift", { head: "b".repeat(40) }], ["result drift", { resultHash: hex(204) }],
]) test(`store rejects completed identity ${name} without writing`, () => {
  const { root, projection } = storedActive();
  try {
    const began = appendEvent(root, started(projection), projection.version), before = files(root);
    assert.throws(() => appendEventBatch(root, [recorded(began), completed(18, overrides)], began.version), /identity|final|complete/i);
    assert.deepEqual(files(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const severity of ["important", "critical"]) test(`${severity} review cannot complete`, () => {
  const { root, projection } = storedActive();
  try {
    const began = appendEvent(root, started(projection), projection.version), before = files(root);
    assert.throws(() => appendEventBatch(root, [recorded(began, severity), completed()], began.version), /severity|changes|required|complete/i);
    assert.deepEqual(files(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("completion batch is CAS protected after a Goal version change", () => {
  const { root, projection } = storedActive();
  try {
    const began = appendEvent(root, started(projection), projection.version);
    const changed = appendEvent(root, event("goal.checkpoint", { canonicalFingerprint: hex(250), advanced: true, sequence: 1 }, 17), began.version);
    const before = files(root);
    assert.throws(() => appendEventBatch(root, [recorded(changed), completed(18)], began.version), /version conflict/i);
    assert.deepEqual(files(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repeated canonical completion batch is rejected without duplicate history", () => {
  const { root, projection } = storedActive();
  try {
    const began = appendEvent(root, started(projection), projection.version);
    const completedProjection = appendEventBatch(root, [recorded(began), completed()], began.version), before = files(root);
    assert.throws(() => appendEventBatch(root, [recorded(completedProjection, "none", 19), completed(20)], completedProjection.version), /terminal|duplicate|final/i);
    assert.deepEqual(files(root), before);
    assert.equal(loadProjection(root, "finalization-goal").completionHistory.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
