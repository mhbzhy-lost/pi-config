import assert from "node:assert/strict";
import test from "node:test";
import { buildObligationFinalizationManifest, validateObligationFinalizationManifest } from "../scripts/lib/goal-engine/finalization.mjs";
import { evaluateConditionGraph } from "../scripts/lib/goal-engine/condition-validity.mjs";
import { fingerprintSettlementEvidence, normalizeSettlementEvidence } from "../scripts/lib/goal-engine/settlement-evidence.mjs";

const h = (letter) => letter.repeat(64);
const head = "b".repeat(40);
const ref = (letter) => `sha256:${h(letter)}`;

function dualPath() {
  const identity = { goalId: "goal-r11", taskId: "task-1", runId: "executor-r11", attempt: 1, contractHash: h("a"), head };
  const make = (letter) => normalizeSettlementEvidence({
    identity,
    criteria: [{ id: "criterion-1", status: "satisfied", evidence: [ref(letter)] }],
    commandsRun: [{ command: "node --test", result: "passed", outputRef: ref(letter === "c" ? "d" : "f") }],
    changedFiles: ["src/goal.mjs"],
  }, { expectedIdentity: identity, expectedCriteria: ["criterion-1"], outcome: "succeeded" });
  const subagent = make("c"), main = make("e");
  return { schemaVersion: "goal-engine.settlement-evidence.v1", path: `acceptance-evidence/sha256/${h("9")}.yaml`, sha256: h("9"), subagentFingerprint: fingerprintSettlementEvidence(subagent), mainFingerprint: fingerprintSettlementEvidence(main), subagent, main, mainSessionId: "root-r11" };
}

function fixture({ worldHash = h("f") } = {}) {
  const settlementEvidence = dualPath();
  const task = {
    id: "task-1", status: "accepted", attempts: 1, contractHash: h("a"),
    acceptance: { criteria: [{ id: "criterion-1" }] }, acceptanceVerification: "integrated",
    executorBinding: { attempt: 1, runId: "executor-r11", contractHash: h("a"), asyncDir: "/tmp/r11", workspacePath: "/tmp/workspace-r11", workspaceLeaseId: h("d"), headAtDispatch: head },
    lastExecutorProof: { runId: "executor-r11", proofId: h("e"), rootSessionId: "root-r11", observedAt: 1, outcome: "succeeded" },
    // `task.settlement` is the event projection shape: it has no synthetic proofHash.
    settlement: { attempt: 1, executorHead: head, executorRunId: "executor-r11", terminalProofId: h("e"), evidence: settlementEvidence },
    workspace: {
      attempt: 1, path: "/tmp/workspace-r11", branch: "ge/goal-r11/task-1/1", baseCommit: head,
      originRef: "refs/heads/main", requestedAction: "integrate", strategy: "merge", executorHead: head,
      originHeadBefore: head, legacyOriginRef: false, originHead: head,
      phase: "disposed", disposition: "integrated", released: true,
    },
  };
  const definition = { id: "condition-1", depends_on: [], oracle_ref: "adapter-r11", environment_ref: "environment-r11", fixture_refs: ["fixture-r11"], invalidation: { paths: ["src/**"], task_ids: ["task-1"] }, stability: { mode: "single", require_fresh_environment: true } };
  const evidence = { evidenceId: "evidence-r11", conditionId: "condition-1", executionRevision: 7, executionContractHash: h("a"), conditionHash: h("c"), head, adapter: { ref: "adapter-r11", version: "1" }, environment: { ref: "environment-r11", fingerprint: "environment-fingerprint-r11" }, fixtures: [{ ref: "fixture-r11", fingerprint: "fixture-fingerprint-r11" }], artifact: { id: "artifact-r11", hash: h("b") }, run: { runId: "observation-r11", state: "terminal" }, terminalProofHash: h("a"), verdict: { kind: "passed" }, sequence: 1, mutationSequence: 0 };
  const projection = { goalId: "goal-r11", executionRevision: 7, executionContractHash: h("a"), tasks: new Map([["task-1", task]]), taskApplicability: new Map([["task-1", { state: "applicable" }]]), conditions: new Map([["condition-1", { definition, conditionHash: h("c"), status: "satisfied", supportingEvidenceIds: ["evidence-r11"] }]]), evidenceHistory: [evidence], observationRuns: new Map([["observation-r11", { runId: "observation-r11", conditionId: "condition-1", phase: "released", allocationId: "allocation-r11", leaseReceiptHash: h("1"), processIdentityHash: h("2"), terminalProofHash: h("a"), evidenceId: "evidence-r11", releaseReceiptHash: h("3") }]]), findings: new Map(), repairEpisodes: new Map(), taskMutationSequences: new Map([["task-1", 0]]), mutationSequence: 0 };
  const worldSnapshot = { safe: true, ...(worldHash ? { worldHash } : {}), repo: { root: "/repo/r11", head, branch: "main", trackedDirty: [], untracked: [], unmerged: [], sequencer: null }, adapters: [{ ref: "adapter-r11", version: "1" }], environments: [{ ref: "environment-r11", fingerprint: "environment-fingerprint-r11", available: true }], fixtures: [{ ref: "fixture-r11", fingerprint: "fixture-fingerprint-r11", available: true }], resources: [{ key: "validation/r11", holders: [], capacity: 1 }], activeRuns: [], capturedAt: "2026-08-19T00:00:00.000Z" };
  const conditionValidity = evaluateConditionGraph({ projection, worldSnapshot, gitRunner: () => { throw new Error("git must not run when heads match"); } }).conditions;
  return { projection, worldSnapshot, conditionValidity, resourceInventory: worldSnapshot.resources };
}

function manifest(input = fixture()) { return buildObligationFinalizationManifest(input); }
function expectBlock(mutator, code) { const input = fixture(); mutator(input); const out = manifest(input); assert.ok(out.blockers.some((item) => item.code === code), `${code}: ${JSON.stringify(out.blockers)}`); }

// The happy fixture is deliberately complete apart from the new authority API:
// production must derive a world snapshot hash rather than require caller worldHash.
test("happy runtime projection derives authoritative world hash and is complete", () => {
  const input = fixture({ worldHash: null });
  const out = manifest(input);
  assert.equal(out.complete, true);
  assert.equal(validateObligationFinalizationManifest(out), true);
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.tasks) && Object.isFrozen(out.debts));
  assert.equal(out.tasks[0].settlementEvidence.subagentFingerprint, input.projection.tasks.get("task-1").settlement.evidence.subagentFingerprint);
});

test("condition validity comes from evaluateConditionGraph's conditions Map", () => {
  const input = fixture();
  assert.equal(input.conditionValidity.get("condition-1").status, "fresh", input.conditionValidity.get("condition-1").reason);
  assert.equal(manifest(input).conditions[0].freshness, "fresh");
});

test("superseded task remains accepted without executor proof", () => {
  const input = fixture(); const task = input.projection.tasks.get("task-1");
  input.projection.taskApplicability.set("task-1", { state: "superseded" }); task.executorBinding = null; task.lastExecutorProof = null;
  assert.equal(manifest(input).complete, true);
});

for (const [name, mutate, code] of [
  ["pending applicable task", ({ projection }) => projection.tasks.get("task-1").status = "pending", "TASK_NOT_ACCEPTED"],
  ["reverify-required task", ({ projection }) => projection.taskApplicability.set("task-1", { state: "reverify_required" }), "TASK_REVERIFY_REQUIRED"],
  ["accepted task missing executor binding", ({ projection }) => projection.tasks.get("task-1").executorBinding = null, "TASK_EXECUTOR_BINDING_MISSING"],
  ["executor binding drift", ({ projection }) => projection.tasks.get("task-1").executorBinding.runId = "other-run", "TASK_EXECUTOR_BINDING_DRIFT"],
  ["accepted task missing terminal proof", ({ projection }) => projection.tasks.get("task-1").lastExecutorProof = null, "TASK_EXECUTOR_PROOF_MISSING"],
  ["terminal proof run drift", ({ projection }) => projection.tasks.get("task-1").lastExecutorProof.runId = "other-run", "TASK_EXECUTOR_PROOF_DRIFT"],
  ["terminal proof id drift", ({ projection }) => projection.tasks.get("task-1").lastExecutorProof.proofId = h("c"), "TASK_EXECUTOR_PROOF_DRIFT"],
  ["terminal proof outcome failure", ({ projection }) => projection.tasks.get("task-1").lastExecutorProof.outcome = "failed", "TASK_EXECUTOR_PROOF_DRIFT"],
  ["accepted task missing settlement", ({ projection }) => projection.tasks.get("task-1").settlement = null, "TASK_SETTLEMENT_MISSING"],
  ["settlement attempt drift", ({ projection }) => projection.tasks.get("task-1").settlement.attempt = 2, "TASK_SETTLEMENT_DRIFT"],
  ["settlement head drift", ({ projection }) => projection.tasks.get("task-1").settlement.executorHead = "c".repeat(40), "TASK_SETTLEMENT_DRIFT"],
  ["duplicate dual fingerprints", ({ projection }) => projection.tasks.get("task-1").settlement.evidence.mainFingerprint = projection.tasks.get("task-1").settlement.evidence.subagentFingerprint, "TASK_DUAL_EVIDENCE_INVALID"],
  ["acceptance is not integrated", ({ projection }) => projection.tasks.get("task-1").acceptanceVerification = "manual", "TASK_ACCEPTANCE_NOT_INTEGRATED"],
  ["workspace is not disposed", ({ projection }) => projection.tasks.get("task-1").workspace.phase = "active", "TASK_WORKSPACE_UNCLOSED"],
  ["workspace is not integrated", ({ projection }) => projection.tasks.get("task-1").workspace.disposition = "preserved", "TASK_WORKSPACE_UNCLOSED"],
  ["workspace is unreleased", ({ projection }) => projection.tasks.get("task-1").workspace.released = false, "TASK_WORKSPACE_UNCLOSED"],
]) test(`task gate: ${name}`, () => expectBlock(mutate, code));

for (const [name, mutate] of [
  ["host is missing", ({ worldSnapshot }) => worldSnapshot.safe = false],
  ["condition status is not satisfied", ({ projection }) => projection.conditions.get("condition-1").status = "inactive"],
  ["support IDs are empty", ({ projection }) => projection.conditions.get("condition-1").supportingEvidenceIds = []],
  ["support IDs are duplicate", ({ projection }) => projection.conditions.get("condition-1").supportingEvidenceIds = ["evidence-r11", "evidence-r11"]],
  ["support evidence is missing", ({ projection }) => projection.evidenceHistory = []],
  ["support evidence crosses conditions", ({ projection }) => projection.evidenceHistory[0].conditionId = "other-condition"],
  ["evidence revision is old", ({ projection }) => projection.evidenceHistory[0].executionRevision = 6],
  ["evidence contract is old", ({ projection }) => projection.evidenceHistory[0].executionContractHash = h("d")],
  ["evidence condition hash is old", ({ projection }) => projection.evidenceHistory[0].conditionHash = h("d")],
  ["failed condition verdict", ({ projection }) => projection.evidenceHistory[0].verdict = { kind: "failed", failureCode: "assertion_failed", findingFingerprint: h("d") }],
  ["artifact is invalid", ({ projection }) => projection.evidenceHistory[0].artifact = { id: "", hash: h("b") }],
]) test(`condition gate: ${name}`, () => expectBlock(mutate, "CONDITION_STALE"));

test("support IDs retain causal order; reverse order gets a sequence blocker", () => {
  const input = fixture(); const p = input.projection;
  p.conditions.get("condition-1").definition.stability = { mode: "consecutive", count: 2, require_distinct_environment: true };
  p.conditions.get("condition-1").supportingEvidenceIds = ["evidence-r11", "evidence-r12"];
  p.evidenceHistory.push({ ...p.evidenceHistory[0], evidenceId: "evidence-r12", sequence: 2, environment: { ref: "environment-r11", fingerprint: "environment-fingerprint-r12" } });
  p.conditions.get("condition-1").supportingEvidenceIds.reverse();
  const out = manifest(input);
  assert.ok(out.blockers.some((item) => item.code === "CONDITION_SEQUENCE_INVALID"));
});

for (const [name, mutate, code] of [
  ["open finding", ({ projection }) => projection.findings.set("finding", { status: "open" }), "OPEN_FINDING"],
  ["repairing finding", ({ projection }) => projection.findings.set("finding", { status: "repairing" }), "OPEN_FINDING"],
  ["reverification finding", ({ projection }) => projection.findings.set("finding", { status: "reverification" }), "OPEN_FINDING"],
  ["waiting repair episode", ({ projection }) => projection.repairEpisodes.set("episode", { status: "waiting_for_tasks" }), "ACTIVE_REPAIR_EPISODE"],
  ["reverifying repair episode", ({ projection }) => projection.repairEpisodes.set("episode", { status: "reverifying" }), "ACTIVE_REPAIR_EPISODE"],
  ["cancelled resource debt", ({ projection }) => projection.repairEpisodes.set("episode", { status: "cancelled", cancellation: { resourceDebt: true } }), "CANCELLED_RESOURCE_DEBT"],
  ["observation lease remains allocated", ({ projection }) => projection.observationRuns.get("observation-r11").phase = "lease_allocated", "OBSERVATION_NOT_RELEASED"],
  ["preserved workspace debt", ({ projection }) => { const t = projection.tasks.get("task-1"); t.workspace.disposition = "preserved"; t.workspace.released = false; }, "TASK_WORKSPACE_UNCLOSED"],
  ["suspension remains open", ({ projection }) => projection.suspension = { suspensionId: "s" }, "SUSPENSION"],
  ["pending decision remains", ({ projection }) => projection.pendingHumanDecision = { id: "d" }, "PENDING_HUMAN_DECISION"],
]) test(`debt gate: ${name}`, () => expectBlock(mutate, code));

for (const [name, mutate, code] of [
  ["unsafe world", ({ worldSnapshot }) => worldSnapshot.safe = false, "UNSAFE_WORLD"],
  ["tracked dirty world", ({ worldSnapshot }) => worldSnapshot.repo.trackedDirty = ["src/goal.mjs"], "DIRTY_WORLD"],
  ["untracked world", ({ worldSnapshot }) => worldSnapshot.repo.untracked = ["tmp"], "DIRTY_WORLD"],
  ["unmerged world", ({ worldSnapshot }) => worldSnapshot.repo.unmerged = ["src/goal.mjs"], "UNMERGED_WORLD"],
  ["sequencer active", ({ worldSnapshot }) => worldSnapshot.repo.sequencer = "rebase-merge", "SEQUENCER_ACTIVE"],
  ["head missing", ({ worldSnapshot }) => worldSnapshot.repo.head = null, "UNKNOWN_WORLD"],
  ["executor run remains active", ({ worldSnapshot }) => worldSnapshot.activeRuns = [{ runId: "executor-r11", kind: "executor", state: "running" }], "ACTIVE_RUN_DEBT"],
  ["resource holder remains", ({ worldSnapshot }) => worldSnapshot.resources[0].holders = ["executor-r11"], "RESOURCE_HOLDERS_ACTIVE"],
  ["resource capacity is invalid", ({ worldSnapshot }) => worldSnapshot.resources[0].capacity = -1, "RESOURCE_INVENTORY_INVALID"],
]) test(`world/resource gate: ${name}`, () => expectBlock(mutate, code));

test("obligation state hash ignores caller stateHash and volatile metadata", () => {
  const left = fixture(), right = fixture();
  left.projection.stateHash = h("1"); right.projection.stateHash = h("2"); right.worldSnapshot.capturedAt = "2099-01-01T00:00:00.000Z";
  right.projection.actionOffer = { random: "random-id" }; right.projection.progressLedger = [{ random: "random-id" }];
  assert.equal(manifest(left).obligationStateHash, manifest(right).obligationStateHash);
});

test("semantic task, condition, debt, resource, head, and support order changes alter obligation hash", () => {
  const base = manifest(fixture()).obligationStateHash;
  for (const mutate of [
    ({ projection }) => projection.tasks.get("task-1").status = "pending",
    ({ projection }) => projection.conditions.get("condition-1").status = "stale",
    ({ projection }) => projection.findings.set("finding", { status: "open" }),
    ({ worldSnapshot }) => worldSnapshot.resources[0].capacity = 2,
    ({ worldSnapshot }) => worldSnapshot.repo.head = "c".repeat(40),
  ]) { const input = fixture(); mutate(input); assert.notEqual(manifest(input).obligationStateHash, base); }
});

test("manifest uses only event-projected task, settlement, workspace, and condition references", () => {
  const input = fixture(), out = manifest(input), task = out.tasks[0], condition = out.conditions[0];
  assert.equal(Object.hasOwn(task, "settlementProofHash"), false);
  assert.deepEqual(task.executorProof, { runId: "executor-r11", proofId: h("e") });
  assert.deepEqual(task.settlement, {
    attempt: 1, executorHead: head, executorRunId: "executor-r11", terminalProofId: h("e"),
    subagentFingerprint: input.projection.tasks.get("task-1").settlement.evidence.subagentFingerprint,
    mainFingerprint: input.projection.tasks.get("task-1").settlement.evidence.mainFingerprint,
  });
  const workspace = input.projection.tasks.get("task-1").workspace;
  assert.deepEqual(task.workspaceProof, {
    attempt: workspace.attempt, path: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit,
    originRef: workspace.originRef, requestedAction: workspace.requestedAction, strategy: workspace.strategy,
    executorHead: workspace.executorHead, originHeadBefore: workspace.originHeadBefore,
    legacyOriginRef: workspace.legacyOriginRef, originHead: workspace.originHead,
    phase: workspace.phase, disposition: workspace.disposition, released: workspace.released,
  });
  assert.deepEqual(condition.supportingEvidenceRefs, [{ evidenceId: "evidence-r11", terminalProofHash: h("a"), artifact: { id: "artifact-r11", hash: h("b") } }]);
  const p = input.projection; p.conditions.get("condition-1").supportingEvidenceIds = ["evidence-r11", "evidence-r12"];
  p.evidenceHistory.push({ ...p.evidenceHistory[0], evidenceId: "evidence-r12", artifact: { id: "artifact-r12", hash: h("d") }, terminalProofHash: h("e"), sequence: 2 });
  assert.deepEqual(manifest(input).conditions[0].supportingEvidenceRefs.map(ref => ref.evidenceId), ["evidence-r11", "evidence-r12"]);
});

test("settlement hash derives from canonical settlement identity and dual evidence, never a projection field", () => {
  const base = manifest(fixture());
  for (const mutate of [
    ({ projection }) => projection.tasks.get("task-1").settlement.executorRunId = "executor-r12",
    ({ projection }) => projection.tasks.get("task-1").settlement.evidence.mainFingerprint = h("d"),
    ({ projection }) => projection.tasks.get("task-1").settlement.terminalProofId = h("d"),
  ]) { const input = fixture(); mutate(input); assert.notEqual(manifest(input).tasks[0].settlementHash, base.tasks[0].settlementHash); }
});

test("cancelled repair episode without resource debt has no blocker", () => {
  const input = fixture();
  input.projection.repairEpisodes.set("episode", { status: "cancelled", cancellation: { resourceDebt: false } });
  assert.equal(manifest(input).blockers.some(item => item.code === "CANCELLED_RESOURCE_DEBT"), false);
  assert.equal(manifest(input).blockers.some(item => item.code === "ACTIVE_REPAIR_EPISODE"), false);
});

for (const [name, mutate, code] of [
  ["active repair episode", ({ projection }) => projection.repairEpisodes.set("episode", { status: "active" }), "ACTIVE_REPAIR_EPISODE"],
  ["blocked repair episode", ({ projection }) => projection.repairEpisodes.set("episode", { status: "blocked" }), "ACTIVE_REPAIR_EPISODE"],
  ["cancel pending repair episode", ({ projection }) => projection.repairEpisodes.set("episode", { status: "cancel_pending" }), "ACTIVE_REPAIR_EPISODE"],
  ["requested observation", ({ projection }) => projection.observationRuns.get("observation-r11").phase = "requested", "OBSERVATION_NOT_RELEASED"],
  ["process-bound observation", ({ projection }) => projection.observationRuns.get("observation-r11").phase = "process_bound", "OBSERVATION_NOT_RELEASED"],
  ["terminal observation", ({ projection }) => projection.observationRuns.get("observation-r11").phase = "terminal", "OBSERVATION_NOT_RELEASED"],
  ["recorded observation", ({ projection }) => projection.observationRuns.get("observation-r11").phase = "recorded", "OBSERVATION_NOT_RELEASED"],
  ["untriaged discovery", ({ projection }) => projection.discovery = { untriaged: true }, "UNTRIAGED_DISCOVERY"],
  ["preserved workspace with release debt", ({ projection }) => { const w = projection.tasks.get("task-1").workspace; w.disposition = "preserved"; w.released = false; }, "TASK_WORKSPACE_UNCLOSED"],
]) test(`complete debt gate: ${name}`, () => expectBlock(mutate, code));

for (const field of ["terminalProofHash", "releaseReceiptHash"]) test(`released observation requires ${field}`, () => {
  expectBlock(({ projection }) => projection.observationRuns.get("observation-r11")[field] = null, "OBSERVATION_PROOF_MISSING");
});

for (const [name, mutate] of [
  ["resource inventory missing", input => input.resourceInventory = undefined],
  ["resource inventory null", input => input.resourceInventory = null],
  ["resource inventory non-array", input => input.resourceInventory = {}],
  ["duplicate resource key", input => input.resourceInventory = [...input.worldSnapshot.resources, { key: "validation/r11", holders: [], capacity: 1 }]],
  ["holders non-array", input => input.resourceInventory = [{ key: "validation/r11", holders: "executor-r11", capacity: 1 }]],
  ["holders non-string", input => input.resourceInventory = [{ key: "validation/r11", holders: [1], capacity: 1 }]],
  ["holders empty string", input => input.resourceInventory = [{ key: "validation/r11", holders: [""], capacity: 1 }]],
  ["capacity negative", input => input.resourceInventory = [{ key: "validation/r11", holders: [], capacity: -1 }]],
  ["capacity fractional", input => input.resourceInventory = [{ key: "validation/r11", holders: [], capacity: 1.5 }]],
]) test(`resource inventory rejects ${name}`, () => {
  const input = fixture(); mutate(input); assert.ok(manifest(input).blockers.some(item => item.code === "RESOURCE_INVENTORY_INVALID"));
});

test("resource inventory is authoritative and must match world resources", () => {
  const input = fixture(); input.resourceInventory = [{ key: "validation/r11", holders: [], capacity: 2 }];
  assert.ok(manifest(input).blockers.some(item => item.code === "RESOURCE_AUTHORITY_MISMATCH"));
});

test("support order affects obligation hash while caller world hash and capturedAt do not", () => {
  const left = fixture(), reversed = fixture();
  for (const input of [left, reversed]) {
    const p = input.projection; p.conditions.get("condition-1").definition.stability = { mode: "consecutive", count: 2, require_distinct_environment: true };
    p.conditions.get("condition-1").supportingEvidenceIds = ["evidence-r11", "evidence-r12"];
    p.evidenceHistory.push({ ...p.evidenceHistory[0], evidenceId: "evidence-r12", sequence: 2, environment: { ref: "environment-r11", fingerprint: "environment-fingerprint-r12" } });
  }
  reversed.projection.conditions.get("condition-1").supportingEvidenceIds.reverse();
  assert.notEqual(manifest(left).obligationStateHash, manifest(reversed).obligationStateHash);
  const callerHash = fixture(), captured = fixture(); callerHash.worldSnapshot.worldHash = h("0"); captured.worldSnapshot.capturedAt = "2099-01-01T00:00:00.000Z";
  assert.equal(manifest(fixture()).worldHash, manifest(callerHash).worldHash);
  assert.equal(manifest(fixture()).obligationStateHash, manifest(callerHash).obligationStateHash);
  assert.equal(manifest(fixture()).obligationStateHash, manifest(captured).obligationStateHash);
});

test("validator rejects cloned or partially unfrozen manifests and all non-JSON-safe values without throwing", () => {
  const out = manifest(fixture()), cloned = structuredClone(out), nested = structuredClone(out);
  Object.freeze(cloned);
  const nestedTask = { ...nested.tasks[0] }; nested.tasks = [nestedTask];
  Object.freeze(nested.tasks); Object.freeze(nested.conditions); Object.freeze(nested.debts); Object.freeze(nested.blockers); Object.freeze(nested);
  assert.equal(validateObligationFinalizationManifest(cloned), false);
  assert.equal(validateObligationFinalizationManifest(nested), false);
  for (const value of [undefined, () => {}, 1n, NaN, new Map([["x", 1]])]) {
    const bad = { ...out, worldHash: value };
    assert.doesNotThrow(() => validateObligationFinalizationManifest(bad));
    assert.equal(validateObligationFinalizationManifest(bad), false);
  }
});

test("validator rejects complete/blocker mismatch even with a recomputed manifest hash", () => {
  const out = structuredClone(manifest(fixture())); out.complete = false;
  assert.equal(validateObligationFinalizationManifest(out), false);
});

test("validator rejects extra or missing top-level keys, stale hashes, non-JSON values, and unfrozen nested data", () => {
  const out = manifest(fixture());
  for (const bad of [
    { ...out, extra: true },
    (() => { const x = { ...out }; delete x.tasks; return x; })(),
    { ...out, manifestHash: h("0") },
    { ...out, complete: !out.complete },
  ]) assert.equal(validateObligationFinalizationManifest(bad), false);
});

test("build and validate are pure: injected git/network/managed callbacks remain unused", () => {
  let calls = 0; const input = fixture();
  input.gitRunner = input.network = input.managed = () => { calls += 1; throw new Error("must not run"); };
  const out = manifest(input); validateObligationFinalizationManifest(out);
  assert.equal(calls, 0);
});
