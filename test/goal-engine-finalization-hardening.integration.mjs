import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildObligationFinalizationManifest, validateObligationFinalizationManifest } from "../scripts/lib/goal-engine/finalization.mjs";
import { evaluateConditionGraph } from "../scripts/lib/goal-engine/condition-validity.mjs";
import { fingerprintSettlementEvidence, normalizeSettlementEvidence } from "../scripts/lib/goal-engine/settlement-evidence.mjs";

const h = letter => letter.repeat(64);
const baseHead = "b".repeat(40);
const executorHead = "c".repeat(40);
const ref = letter => `sha256:${h(letter)}`;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function evidence(head = baseHead, criterion = "criterion-1", immutableRefs = [{ criterion: "d", output: "e" }, { criterion: "a", output: "f" }]) {
  const identity = { goalId: "goal-hardening", taskId: "task-1", runId: "executor-1", attempt: 1, contractHash: h("a"), head };
  const make = refs => normalizeSettlementEvidence({ identity, criteria: [{ id: criterion, status: "satisfied", evidence: [ref(refs.criterion)] }], commandsRun: [{ command: "node --test", result: "passed", outputRef: ref(refs.output) }], changedFiles: ["src/goal.mjs"] }, { expectedIdentity: identity, expectedCriteria: [criterion], outcome: "succeeded" });
  const subagent = make(immutableRefs[0]), main = make(immutableRefs[1]);
  return { schemaVersion: "goal-engine.settlement-evidence.v1", path: `acceptance-evidence/sha256/${h("9")}.yaml`, sha256: h("9"), subagentFingerprint: fingerprintSettlementEvidence(subagent), mainFingerprint: fingerprintSettlementEvidence(main), subagent, main, mainSessionId: "root-1" };
}

function fixture() {
  const settlementEvidence = evidence();
  const task = { id: "task-1", status: "accepted", attempts: 1, contractHash: h("a"), acceptance: { criteria: [{ id: "criterion-1" }] }, acceptanceVerification: "integrated", executorBinding: { attempt: 1, runId: "executor-1", contractHash: h("a"), asyncDir: "/tmp/executor", workspacePath: "/tmp/workspace", workspaceLeaseId: h("d"), headAtDispatch: baseHead }, lastExecutorProof: { runId: "executor-1", proofId: h("e"), rootSessionId: "root-1", observedAt: 1, outcome: "succeeded" }, settlement: { attempt: 1, executorHead: baseHead, executorRunId: "executor-1", terminalProofId: h("e"), evidence: settlementEvidence }, workspace: { attempt: 1, path: "/tmp/workspace", branch: "ge/goal/task/1", baseCommit: baseHead, originRef: "refs/heads/main", requestedAction: "integrate", strategy: "merge", executorHead: baseHead, originHeadBefore: baseHead, legacyOriginRef: false, originHead: baseHead, phase: "disposed", disposition: "integrated", released: true } };
  const definition = { id: "condition-1", depends_on: [], oracle_ref: "adapter", environment_ref: "environment", fixture_refs: ["fixture"], invalidation: { paths: ["src/**"], task_ids: ["task-1"] }, stability: { mode: "single", require_fresh_environment: true } };
  const proof = h("a");
  const observation = { evidenceId: "evidence-1", conditionId: "condition-1", executionRevision: 7, executionContractHash: h("a"), conditionHash: h("c"), head: baseHead, adapter: { ref: "adapter", version: "1" }, environment: { ref: "environment", fingerprint: "environment-1" }, fixtures: [{ ref: "fixture", fingerprint: "fixture-1" }], artifact: { id: "artifact", hash: h("b") }, run: { runId: "observation-1", state: "terminal" }, terminalProofHash: proof, verdict: { kind: "passed" }, sequence: 1, mutationSequence: 0 };
  const projection = { goalId: "goal-hardening", executionRevision: 7, executionContractHash: h("a"), tasks: new Map([["task-1", task]]), taskApplicability: new Map([["task-1", { state: "applicable" }]]), conditions: new Map([["condition-1", { definition, conditionHash: h("c"), status: "satisfied", supportingEvidenceIds: ["evidence-1"] }]]), evidenceHistory: [observation], observationRuns: new Map([["observation-1", { runId: "observation-1", conditionId: "condition-1", phase: "released", terminalProofHash: proof, releaseReceiptHash: h("3") }]]), findings: new Map(), repairEpisodes: new Map(), taskMutationSequences: new Map([["task-1", 0]]), mutationSequence: 0 };
  const worldSnapshot = { safe: true, worldHash: h("f"), repo: { root: "/repo", head: baseHead, branch: "main", trackedDirty: [], untracked: [], unmerged: [], sequencer: null }, adapters: [{ ref: "adapter", version: "1" }], environments: [{ ref: "environment", fingerprint: "environment-1", available: true }], fixtures: [{ ref: "fixture", fingerprint: "fixture-1", available: true }], resources: [{ key: "validation", holders: [], capacity: 1 }], activeRuns: [], capturedAt: "2026-08-19T00:00:00.000Z" };
  return { projection, worldSnapshot, resourceInventory: worldSnapshot.resources, conditionValidity: evaluateConditionGraph({ projection, worldSnapshot, gitRunner: () => { throw Error("unexpected git"); } }).conditions };
}
const manifest = input => buildObligationFinalizationManifest(input);
const blocked = input => assert.equal(manifest(input).complete, false, JSON.stringify(manifest(input).blockers));

// RED1: executor completion is an output commit, not the dispatch base commit.
test("RED1 accepts an integrated executor HEAD distinct from dispatch base HEAD", () => { const input = fixture(), task = input.projection.tasks.get("task-1"); task.settlement.executorHead = executorHead; task.settlement.evidence = evidence(executorHead); task.workspace.executorHead = executorHead; task.workspace.originHead = executorHead; input.worldSnapshot.repo.head = executorHead; input.projection.evidenceHistory[0].head = executorHead; input.conditionValidity = evaluateConditionGraph({ projection: input.projection, worldSnapshot: input.worldSnapshot, gitRunner: () => { throw Error("unexpected git"); } }).conditions; assert.equal(manifest(input).complete, true); });

test("RED2 rejects dual evidence whose canonical immutable content changes under a retained fingerprint", () => { const input = fixture(), task = input.projection.tasks.get("task-1"); task.settlement.evidence = structuredClone(task.settlement.evidence); task.settlement.evidence.subagent.criteria[0].evidence[0] = ref("8"); blocked(input); });
test("RED2 rejects dual evidence sharing an immutable reference despite distinct fingerprints", () => { const input = fixture(), task = input.projection.tasks.get("task-1"); task.settlement.evidence = structuredClone(task.settlement.evidence); const e = task.settlement.evidence; e.main.commandsRun[0].outputRef = e.subagent.commandsRun[0].outputRef; blocked(input); });
test("RED2 rejects evidence wrapper identity, path, schema, and root-session drift", () => { const input = fixture(), e = input.projection.tasks.get("task-1").settlement.evidence; e.path = "other.yaml"; e.schemaVersion = "wrong"; e.mainSessionId = "other-root"; blocked(input); });

test("RED3 rejects executor binding workspace, lease, dispatch-head, contract, and attempt drift", () => { const actual = ["workspacePath", "workspaceLeaseId", "headAtDispatch", "contractHash", "attempt"].map(field => { const input = fixture(), b = input.projection.tasks.get("task-1").executorBinding; b[field] = field === "attempt" ? 2 : field === "headAtDispatch" ? "d".repeat(40) : "drift"; return manifest(input).complete; }); assert.deepEqual(actual, [false, false, false, false, false]); });
test("RED3 rejects incomplete terminal proof identity and non-finite observations", () => { const actual = [["rootSessionId", ""], ["observedAt", Infinity], ["outcome", "failed"], ["runId", "other"], ["proofId", "not-a-hash"]].map(([field, value]) => { const input = fixture(); input.projection.tasks.get("task-1").lastExecutorProof[field] = value; return manifest(input).complete; }); assert.deepEqual(actual, [false, false, false, false, false]); });
test("RED3 rejects settlement and workspace executor-head, attempt, and run drift", () => { const actual = [["settlement", "executorHead", "d".repeat(40)], ["settlement", "executorRunId", "other"], ["workspace", "executorHead", "d".repeat(40)], ["workspace", "attempt", 2]].map(([target, field, value]) => { const input = fixture(); input.projection.tasks.get("task-1")[target][field] = value; return manifest(input).complete; }); assert.deepEqual(actual, [false, false, false, false]); });

test("RED4 permits an idle zero-capacity Current World resource", () => { const input = fixture(); input.worldSnapshot.resources[0].capacity = 0; input.resourceInventory[0].capacity = 0; assert.equal(manifest(input).complete, true); });
test("RED5 permits only resolved or rejected_by_user findings and blocks unknown closed states", () => { const actual = ["resolved", "rejected_by_user", "closed", "accepted"].map(status => { const input = fixture(); input.projection.findings.set("finding", { status }); return manifest(input).complete; }); assert.deepEqual(actual, [true, true, false, false]); });

// Canonical task criteria, not evidence-controlled criteria, are the authority.
test("RED6 build blocks dual evidence rewritten from criterion-1 to criterion-2", () => { const input = fixture(); input.projection.tasks.get("task-1").settlement.evidence = evidence(baseHead, "criterion-2"); assert.ok(manifest(input).blockers.some(item => item.code === "TASK_DUAL_EVIDENCE_INVALID")); });
test("RED6 validator rejects recomputed dual-evidence criteria forgery against task authority", () => {
  const out = structuredClone(manifest(fixture())), task = out.tasks[0], forged = evidence(baseHead, "criterion-2", [{ criterion: "8", output: "6" }, { criterion: "7", output: "5" }]);
  // This is the canonical authority that a manifest task summary must retain.
  task.acceptanceCriteria = ["criterion-1"];
  task.settlement.subagentFingerprint = forged.subagentFingerprint; task.settlement.mainFingerprint = forged.mainFingerprint;
  task.settlementEvidence = { ...forged, valid: true };
  task.settlementHash = sha(task.settlement);
  out.stateHash = sha({ goalId: out.goalId, revision: out.revision, contractHash: out.contractHash, tasks: out.tasks, conditions: out.conditions, debts: out.debts });
  out.obligationStateHash = sha({ stateHash: out.stateHash, head: out.head, worldHash: out.worldHash });
  out.manifestHash = sha({ ...out, manifestHash: null });
  assert.equal(validateObligationFinalizationManifest(freeze(out)), false);
});

// RED6: a caller who can see every manifest field must not forge semantic validity by hashing it again.
test("RED6 validator rejects every semantic field tampered with a recomputed manifest hash", () => { const actual = ["goalId", "revision", "contractHash", "head", "worldHash", "stateHash", "obligationStateHash", "tasks", "conditions", "debts", "blockers"].map(field => { const out = structuredClone(manifest(fixture())); if (field === "tasks") out.tasks[0].status = "pending"; else if (field === "conditions") out.conditions[0].status = "stale"; else if (field === "debts") out.debts.resources[0].capacity = 2; else if (field === "blockers") out.blockers = [{ code: "forged" }]; else out[field] = field === "revision" ? 8 : h("0"); out.manifestHash = sha({ ...out, manifestHash: null }); return validateObligationFinalizationManifest(freeze(out)); }); assert.deepEqual(actual, Array(11).fill(false)); });
test("RED6 validator cannot forge completion by deleting a real blocker and recomputing visible hashes", () => { const input = fixture(); input.projection.tasks.get("task-1").status = "pending"; const blockedManifest = manifest(input); assert.ok(blockedManifest.blockers.length > 0); assert.equal(blockedManifest.complete, false); const out = structuredClone(blockedManifest); out.blockers = []; out.complete = true; out.stateHash = sha({ goalId: out.goalId, revision: out.revision, contractHash: out.contractHash, tasks: out.tasks, conditions: out.conditions, debts: out.debts }); out.obligationStateHash = sha({ goalId: out.goalId, revision: out.revision, contractHash: out.contractHash, tasks: out.tasks, conditions: out.conditions, debts: out.debts, worldHash: out.worldHash }); out.manifestHash = sha({ ...out, manifestHash: null }); assert.equal(validateObligationFinalizationManifest(freeze(out)), false); });
