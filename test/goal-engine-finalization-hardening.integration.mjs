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

function evidence(head = baseHead) {
  const identity = { goalId: "goal-hardening", taskId: "task-1", runId: "executor-1", attempt: 1, contractHash: h("a"), head };
  const make = letter => normalizeSettlementEvidence({ identity, criteria: [{ id: "criterion-1", status: "satisfied", evidence: [ref(letter)] }], commandsRun: [{ command: "node --test", result: "passed", outputRef: ref(letter === "d" ? "e" : "f") }], changedFiles: ["src/goal.mjs"] }, { expectedIdentity: identity, expectedCriteria: ["criterion-1"], outcome: "succeeded" });
  const subagent = make("d"), main = make("a");
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
test("RED1 accepts an integrated executor HEAD distinct from dispatch base HEAD", () => { const input = fixture(), task = input.projection.tasks.get("task-1"); task.settlement.executorHead = executorHead; task.settlement.evidence = evidence(executorHead); task.workspace.executorHead = executorHead; task.workspace.originHead = executorHead; input.worldSnapshot.repo.head = executorHead; input.conditionValidity = evaluateConditionGraph({ projection: input.projection, worldSnapshot: input.worldSnapshot, gitRunner: () => { throw Error("unexpected git"); } }).conditions; assert.equal(manifest(input).complete, true); });

test("RED2 rejects dual evidence whose canonical immutable content changes under a retained fingerprint", () => { const input = fixture(), task = input.projection.tasks.get("task-1"); task.settlement.evidence = structuredClone(task.settlement.evidence); task.settlement.evidence.subagent.criteria[0].evidence[0] = ref("8"); blocked(input); });
test("RED2 rejects dual evidence sharing an immutable reference despite distinct fingerprints", () => { const input = fixture(), task = input.projection.tasks.get("task-1"); task.settlement.evidence = structuredClone(task.settlement.evidence); const e = task.settlement.evidence; e.main.commandsRun[0].outputRef = e.subagent.commandsRun[0].outputRef; blocked(input); });
test("RED2 rejects evidence wrapper identity, path, schema, and root-session drift", () => { const input = fixture(), e = input.projection.tasks.get("task-1").settlement.evidence; e.path = "other.yaml"; e.schemaVersion = "wrong"; e.mainSessionId = "other-root"; blocked(input); });

test("RED3 rejects executor binding workspace, lease, dispatch-head, contract, and attempt drift", () => { for (const field of ["workspacePath", "workspaceLeaseId", "headAtDispatch", "contractHash", "attempt"]) { const input = fixture(), b = input.projection.tasks.get("task-1").executorBinding; b[field] = field === "attempt" ? 2 : field === "headAtDispatch" ? "d".repeat(40) : "drift"; blocked(input); } });
test("RED3 rejects incomplete terminal proof identity and non-finite observations", () => { for (const [field, value] of [["rootSessionId", ""], ["observedAt", Infinity], ["outcome", "failed"], ["runId", "other"], ["proofId", "not-a-hash"]]) { const input = fixture(); input.projection.tasks.get("task-1").lastExecutorProof[field] = value; blocked(input); } });
test("RED3 rejects settlement and workspace executor-head, attempt, and run drift", () => { for (const [target, field, value] of [["settlement", "executorHead", "d".repeat(40)], ["settlement", "executorRunId", "other"], ["workspace", "executorHead", "d".repeat(40)], ["workspace", "attempt", 2]]) { const input = fixture(); input.projection.tasks.get("task-1")[target][field] = value; blocked(input); } });

test("RED4 permits an idle zero-capacity Current World resource", () => { const input = fixture(); input.worldSnapshot.resources[0].capacity = 0; input.resourceInventory[0].capacity = 0; assert.equal(manifest(input).complete, true); });
test("RED5 permits only resolved or rejected_by_user findings and blocks unknown closed states", () => { for (const [status, complete] of [["resolved", true], ["rejected_by_user", true], ["closed", false], ["accepted", false]]) { const input = fixture(); input.projection.findings.set("finding", { status }); assert.equal(manifest(input).complete, complete, status); } });

// RED6: a caller who can see every manifest field must not forge semantic validity by hashing it again.
test("RED6 validator rejects every semantic field tampered with a recomputed manifest hash", () => { for (const field of ["goalId", "revision", "contractHash", "head", "worldHash", "stateHash", "obligationStateHash", "tasks", "conditions", "debts", "blockers"]) { const out = structuredClone(manifest(fixture())); if (field === "tasks") out.tasks[0].status = "pending"; else if (field === "conditions") out.conditions[0].status = "stale"; else if (field === "debts") out.debts.resources[0].capacity = 2; else if (field === "blockers") out.blockers = [{ code: "forged" }]; else out[field] = field === "revision" ? 8 : h("0"); out.manifestHash = sha({ ...out, manifestHash: null }); assert.equal(validateObligationFinalizationManifest(freeze(out)), false, field); } });
test("RED6 validator cannot forge completion by deleting a real blocker and recomputing visible hashes", () => { const out = structuredClone(manifest(fixture())); out.blockers = []; out.complete = true; out.manifestHash = sha({ ...out, manifestHash: null }); assert.equal(validateObligationFinalizationManifest(freeze(out)), false); });
