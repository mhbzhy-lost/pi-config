import { createHash } from "node:crypto";
import { assertIndependentSettlementEvidence, fingerprintSettlementEvidence, normalizeSettlementEvidence } from "./settlement-evidence.mjs";

const UNSUPPORTED_GENERATIONS = new Set(["goal-engine.event.v1", "goal-engine.event.v2", "goal-engine.event.v3", "planned.v1"]);
const MANIFEST_KEYS = ["schemaVersion", "goalId", "revision", "contractHash", "head", "worldHash", "stateHash", "obligationStateHash", "tasks", "conditions", "debts", "blockers", "complete", "manifestHash"];
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const head = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const canonical = value => value instanceof Map ? canonical(Object.fromEntries(value)) : Array.isArray(value) ? value.map(canonical) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const freeze = value => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const rows = value => (value instanceof Map ? [...value.entries()] : isObject(value) ? Object.entries(value) : Array.isArray(value) ? value.map((row, index) => [String(index), row]) : []).map(([key, row]) => [String(row?.id ?? row?.definition?.id ?? key), row]).sort(([a], [b]) => a.localeCompare(b));
const get = (value, id) => value instanceof Map ? value.get(id) : value?.[id];
const add = (blockers, code, id) => blockers.push(id === undefined ? { code } : { code, id });
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

function currentWorld(world) { const { worldHash: _hash, capturedAt: _capturedAt, ...stable } = world ?? {}; return canonical(stable); }
function inventory(value, world) {
  const actual = Array.isArray(value) ? value : isObject(value) && !Object.keys(value).length && !Array.isArray(world?.resources) ? [] : null;
  if (!actual) return { rows: [], valid: false, matches: false };
  const keys = new Set();
  for (const row of actual) if (!isObject(row) || typeof row.key !== "string" || !row.key || keys.has(row.key) || !Array.isArray(row.holders) || row.holders.some(holder => typeof holder !== "string" || !holder) || !Number.isSafeInteger(row.capacity) || row.capacity < 0) return { rows: actual, valid: false, matches: false }; else keys.add(row.key);
  return { rows: actual, valid: true, matches: Array.isArray(world?.resources) ? same(actual, world.resources) : actual.length === 0 };
}
function evidenceSummary(task, settlement, proof) {
  const evidence = settlement?.evidence;
  const expectedIdentity = { goalId: task?.goalId, taskId: task?.id, runId: proof?.runId, attempt: task?.attempts, contractHash: task?.contractHash, head: settlement?.executorHead };
  const expectedCriteria = task?.acceptance?.criteria?.map(item => item?.id);
  try {
    if (!isObject(evidence) || evidence.schemaVersion !== "goal-engine.settlement-evidence.v1" || typeof evidence.path !== "string" || !new RegExp(`^acceptance-evidence/sha256/${evidence.sha256}\\.yaml$`).test(evidence.path) || !hash(evidence.sha256) || evidence.mainSessionId !== proof?.rootSessionId) throw Error("wrapper");
    const subagent = normalizeSettlementEvidence(evidence.subagent, { expectedIdentity, expectedCriteria, outcome: "succeeded" });
    const main = normalizeSettlementEvidence(evidence.main, { expectedIdentity, expectedCriteria, outcome: "succeeded" });
    assertIndependentSettlementEvidence(subagent, main);
    if (fingerprintSettlementEvidence(subagent) !== evidence.subagentFingerprint || fingerprintSettlementEvidence(main) !== evidence.mainFingerprint) throw Error("fingerprint");
    return { schemaVersion: evidence.schemaVersion, path: evidence.path, sha256: evidence.sha256, subagentFingerprint: evidence.subagentFingerprint, mainFingerprint: evidence.mainFingerprint, mainSessionId: evidence.mainSessionId, subagent, main, valid: true };
  } catch { return { schemaVersion: evidence?.schemaVersion ?? null, path: evidence?.path ?? null, sha256: evidence?.sha256 ?? null, subagentFingerprint: evidence?.subagentFingerprint ?? null, mainFingerprint: evidence?.mainFingerprint ?? null, mainSessionId: evidence?.mainSessionId ?? null, subagent: evidence?.subagent ?? null, main: evidence?.main ?? null, valid: false }; }
}
function taskManifest(goalId, id, task, applicability) {
  const binding = task?.executorBinding, proof = task?.lastExecutorProof, settlement = task?.settlement, workspace = task?.workspace;
  const out = { id, applicability, status: task?.status ?? null, attempts: task?.attempts ?? null, contractHash: task?.contractHash ?? null, acceptanceVerification: task?.acceptanceVerification ?? null };
  if (applicability === "superseded") return out;
  out.binding = binding ? { attempt: binding.attempt, runId: binding.runId, contractHash: binding.contractHash, asyncDir: binding.asyncDir, workspacePath: binding.workspacePath, workspaceLeaseId: binding.workspaceLeaseId, headAtDispatch: binding.headAtDispatch } : null;
  out.executorProof = proof ? { runId: proof.runId, proofId: proof.proofId } : null;
  out.executorProofIdentity = proof ? { runId: proof.runId, proofId: proof.proofId, rootSessionId: proof.rootSessionId, observedAt: proof.observedAt, outcome: proof.outcome } : null;
  out.settlement = settlement ? { attempt: settlement.attempt, executorHead: settlement.executorHead, executorRunId: settlement.executorRunId, terminalProofId: settlement.terminalProofId, subagentFingerprint: settlement.evidence?.subagentFingerprint ?? null, mainFingerprint: settlement.evidence?.mainFingerprint ?? null } : null;
  out.settlementEvidence = evidenceSummary({ ...task, goalId, id }, settlement, proof);
  out.settlementHash = sha(out.settlement);
  out.workspaceProof = workspace ? { attempt: workspace.attempt, path: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit, originRef: workspace.originRef, requestedAction: workspace.requestedAction, strategy: workspace.strategy, executorHead: workspace.executorHead, originHeadBefore: workspace.originHeadBefore, legacyOriginRef: workspace.legacyOriginRef, originHead: workspace.originHead, phase: workspace.phase, disposition: workspace.disposition, released: workspace.released } : null;
  return out;
}
function conditionManifest(id, condition, validity, projection) {
  const support = Array.isArray(condition?.supportingEvidenceIds) ? condition.supportingEvidenceIds : [];
  const evidence = Array.isArray(projection.evidenceHistory) ? projection.evidenceHistory : [], selected = support.map(evidenceId => evidence.find(row => row?.evidenceId === evidenceId));
  const fresh = validity?.status === "fresh";
  const base = condition?.status === "satisfied" && support.length > 0 && new Set(support).size === support.length && selected.every(Boolean) && selected.every(row => row.conditionId === id && row.executionRevision === projection.executionRevision && row.executionContractHash === projection.executionContractHash && row.conditionHash === condition.conditionHash && row.verdict?.kind === "passed" && hash(row.terminalProofHash) && row.artifact?.id && hash(row.artifact?.hash) && row.run?.state === "terminal");
  const policy = condition?.definition?.stability; let sequence = true;
  if (policy?.mode === "single") sequence = selected.length === 1 && (!policy.require_fresh_environment || !!selected[0]?.environment?.fingerprint);
  if (policy?.mode === "consecutive") sequence = selected.length === policy.count && selected.every((row, index) => !index || row.sequence === selected[index - 1].sequence + 1) && (!policy.require_distinct_environment || new Set(selected.map(row => `${row.environment?.ref}\0${row.environment?.fingerprint}`)).size === selected.length);
  return { id, status: condition?.status ?? null, freshness: fresh && base && sequence ? "fresh" : "stale", sequenceValid: sequence, supportingEvidenceIds: support, supportingEvidenceRefs: selected.filter(Boolean).map(row => ({ evidenceId: row.evidenceId, terminalProofHash: row.terminalProofHash, artifact: { id: row.artifact?.id, hash: row.artifact?.hash } })), stability: policy ?? null, conditionHash: condition?.conditionHash ?? null };
}
function debts(projection, world, resourceRows, resourceInventoryValid) { return { resourceInventoryValid, findings: rows(projection.findings).map(([id, row]) => ({ id, status: row?.status ?? null })), episodes: rows(projection.repairEpisodes).map(([id, row]) => ({ id, status: row?.status ?? null, resourceDebt: row?.cancellation?.resourceDebt === true })), observations: rows(projection.observationRuns).map(([id, row]) => ({ id, conditionId: row?.conditionId ?? null, phase: row?.phase ?? null, terminalProofHash: row?.terminalProofHash ?? null, releaseReceiptHash: row?.releaseReceiptHash ?? null })), workspaces: rows(projection.tasks).filter(([, task]) => task?.workspace).map(([id, task]) => ({ id, phase: task.workspace.phase ?? null, disposition: task.workspace.disposition ?? null, released: task.workspace.released ?? null })), resources: resourceRows, activeRuns: Array.isArray(world?.activeRuns) ? world.activeRuns.map(row => ({ runId: row?.runId, kind: row?.kind, state: row?.state })) : null, suspension: projection.suspension ?? null, pendingHumanDecision: projection.pendingHumanDecision ?? null, discovery: projection.discovery ?? projection.discoveryDebt ?? null, world: currentWorld(world) }; }
function deriveBlockers({ goalId, revision, contractHash, head: manifestHead, worldHash, tasks, conditions, debts: debt }) {
  const blockers = [], world = debt?.world, repo = world?.repo;
  if (!goalId || !Number.isSafeInteger(revision) || !hash(contractHash)) add(blockers, "REVISION_OR_CONTRACT_UNKNOWN");
  if (!same(sha(world), worldHash) || !head(manifestHead) || manifestHead !== repo?.head) add(blockers, "UNKNOWN_WORLD");
  if (world?.safe !== true) add(blockers, "UNSAFE_WORLD");
  if (!Array.isArray(repo?.trackedDirty) || !Array.isArray(repo?.untracked) || repo.trackedDirty.length || repo.untracked.length) add(blockers, "DIRTY_WORLD");
  if (repo?.unmerged !== undefined && (!Array.isArray(repo.unmerged) || repo.unmerged.length)) add(blockers, "UNMERGED_WORLD"); if (repo?.sequencer) add(blockers, "SEQUENCER_ACTIVE");
  if (debt?.resourceInventoryValid !== true || !Array.isArray(debt?.resources) || debt.resources.some(row => !isObject(row) || typeof row.key !== "string" || !row.key || !Array.isArray(row.holders) || row.holders.some(holder => typeof holder !== "string" || !holder) || !Number.isSafeInteger(row.capacity) || row.capacity < 0)) add(blockers, "RESOURCE_INVENTORY_INVALID");
  else { if (!same(debt.resources, world?.resources ?? [])) add(blockers, "RESOURCE_AUTHORITY_MISMATCH"); if (debt.resources.some(row => row.holders.length)) add(blockers, "RESOURCE_HOLDERS_ACTIVE"); }
  if (!Array.isArray(debt?.activeRuns) || debt.activeRuns.length) add(blockers, "ACTIVE_RUN_DEBT");
  for (const task of Array.isArray(tasks) ? tasks : []) { const id = task?.id; if (task?.applicability === "reverify_required") add(blockers, "TASK_REVERIFY_REQUIRED", id); if (task?.applicability !== "superseded" && task?.status !== "accepted") add(blockers, "TASK_NOT_ACCEPTED", id); if (task?.applicability === "superseded") continue; const b = task?.binding, p = task?.executorProofIdentity, s = task?.settlement, w = task?.workspaceProof;
    if (!b) add(blockers, "TASK_EXECUTOR_BINDING_MISSING", id); if (!p) add(blockers, "TASK_EXECUTOR_PROOF_MISSING", id); if (!s) add(blockers, "TASK_SETTLEMENT_MISSING", id); if (!b || !p || !s) continue;
    if (!Number.isSafeInteger(task.attempts) || task.attempts < 1 || b.attempt !== task.attempts || b.contractHash !== task.contractHash || typeof b.runId !== "string" || !b.runId || b.runId !== p.runId || typeof b.asyncDir !== "string" || !b.asyncDir.startsWith("/") || typeof b.workspacePath !== "string" || !b.workspacePath.startsWith("/") || !hash(b.workspaceLeaseId) || !head(b.headAtDispatch)) add(blockers, "TASK_EXECUTOR_BINDING_DRIFT", id);
    if (p.runId !== b.runId || p.proofId !== s.terminalProofId || p.outcome !== "succeeded" || !hash(p.proofId) || typeof p.rootSessionId !== "string" || !p.rootSessionId || !Number.isFinite(p.observedAt)) add(blockers, "TASK_EXECUTOR_PROOF_DRIFT", id);
    if (s.attempt !== b.attempt || s.executorRunId !== b.runId || !head(s.executorHead) || s.terminalProofId !== p.proofId) add(blockers, "TASK_SETTLEMENT_DRIFT", id);
    if (w && w.executorHead !== s.executorHead) add(blockers, "TASK_SETTLEMENT_DRIFT", id);
    if (!w || w.attempt !== b.attempt || w.path !== b.workspacePath || w.baseCommit !== b.headAtDispatch || w.executorHead !== s.executorHead || w.phase !== "disposed" || w.disposition !== "integrated" || w.released !== true) add(blockers, "TASK_WORKSPACE_UNCLOSED", id);
    if (task.acceptanceVerification !== "integrated") add(blockers, "TASK_ACCEPTANCE_NOT_INTEGRATED", id);
    const e = task.settlementEvidence; try { const expected = { goalId, taskId: id, runId: p.runId, attempt: task.attempts, contractHash: task.contractHash, head: s.executorHead }; if (!e?.valid || e.schemaVersion !== "goal-engine.settlement-evidence.v1" || typeof e.path !== "string" || !hash(e.sha256) || e.path !== `acceptance-evidence/sha256/${e.sha256}.yaml` || e.mainSessionId !== p.rootSessionId || e.subagentFingerprint !== s.subagentFingerprint || e.mainFingerprint !== s.mainFingerprint) throw Error("evidence"); const sub = normalizeSettlementEvidence(e.subagent, { expectedIdentity: expected, expectedCriteria: e.subagent?.criteria?.map(row => row.id), outcome: "succeeded" }), main = normalizeSettlementEvidence(e.main, { expectedIdentity: expected, expectedCriteria: e.subagent?.criteria?.map(row => row.id), outcome: "succeeded" }); assertIndependentSettlementEvidence(sub, main); if (fingerprintSettlementEvidence(sub) !== e.subagentFingerprint || fingerprintSettlementEvidence(main) !== e.mainFingerprint) throw Error("fingerprint"); } catch { add(blockers, "TASK_DUAL_EVIDENCE_INVALID", id); }
  }
  for (const condition of Array.isArray(conditions) ? conditions : []) { if (condition?.freshness !== "fresh") add(blockers, "CONDITION_STALE", condition?.id); if (condition?.sequenceValid === false) add(blockers, "CONDITION_SEQUENCE_INVALID", condition?.id); }
  if (world?.safe !== true) for (const condition of Array.isArray(conditions) ? conditions : []) add(blockers, "CONDITION_STALE", condition?.id);
  for (const row of Array.isArray(debt?.findings) ? debt.findings : []) if (!["resolved", "rejected_by_user"].includes(row?.status)) add(blockers, "OPEN_FINDING", row?.id);
  for (const row of Array.isArray(debt?.episodes) ? debt.episodes : []) if (["active", "blocked", "cancel_pending", "waiting_for_tasks", "reverifying"].includes(row?.status) || row?.resourceDebt) add(blockers, row.resourceDebt ? "CANCELLED_RESOURCE_DEBT" : "ACTIVE_REPAIR_EPISODE", row?.id);
  for (const row of Array.isArray(debt?.observations) ? debt.observations : []) if (row?.phase !== "released") add(blockers, "OBSERVATION_NOT_RELEASED", row?.id); else if (!hash(row.terminalProofHash) || !hash(row.releaseReceiptHash)) add(blockers, "OBSERVATION_PROOF_MISSING", row?.id);
  for (const row of Array.isArray(debt?.workspaces) ? debt.workspaces : []) if (row?.phase !== "disposed" || row?.disposition !== "integrated" || row?.released !== true) add(blockers, "TASK_WORKSPACE_UNCLOSED", row?.id);
  if (debt?.suspension) add(blockers, "SUSPENSION"); if (debt?.pendingHumanDecision) add(blockers, "PENDING_HUMAN_DECISION"); if (debt?.discovery && (Array.isArray(debt.discovery) ? debt.discovery.length : debt.discovery.untriaged)) add(blockers, "UNTRIAGED_DISCOVERY");
  return blockers.sort((a, b) => `${a.code}:${a.id ?? ""}`.localeCompare(`${b.code}:${b.id ?? ""}`));
}

export function buildObligationFinalizationManifest({ projection, worldSnapshot, conditionValidity, resourceInventory } = {}) {
  if (!isObject(projection) || !isObject(worldSnapshot)) throw new Error("projection and worldSnapshot are required");
  const resource = inventory(resourceInventory, worldSnapshot), tasks = rows(projection.tasks).map(([id, task]) => taskManifest(projection.goalId, id, task, get(projection.taskApplicability, id)?.state ?? "applicable")), conditions = rows(projection.conditions).map(([id, condition]) => conditionManifest(id, condition, get(conditionValidity, id), projection)), debt = debts(projection, worldSnapshot, resource.rows, resource.valid);
  const base = { schemaVersion: "goal-runtime.v1.finalization-manifest.v1", goalId: projection.goalId ?? null, revision: projection.executionRevision ?? projection.revision ?? null, contractHash: projection.executionContractHash ?? projection.contractHash ?? null, head: worldSnapshot.repo?.head ?? null, worldHash: sha(currentWorld(worldSnapshot)), tasks, conditions, debts: debt };
  const stateHash = sha({ goalId: base.goalId, revision: base.revision, contractHash: base.contractHash, tasks, conditions, debts: debt });
  const obligationStateHash = sha({ stateHash, head: base.head, worldHash: base.worldHash });
  const blockers = deriveBlockers({ ...base, stateHash, obligationStateHash }); blockers.sort((a, b) => `${a.code}:${a.id ?? ""}`.localeCompare(`${b.code}:${b.id ?? ""}`));
  const manifest = { ...base, stateHash, obligationStateHash, blockers, complete: blockers.length === 0, manifestHash: null }; manifest.manifestHash = sha(manifest); return freeze(manifest);
}
function jsonSafe(value) { return value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value) || Array.isArray(value) && value.every(jsonSafe) || isObject(value) && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(jsonSafe); }
function frozen(value) { return !!value && typeof value === "object" && Object.isFrozen(value) && Object.values(value).every(child => typeof child !== "object" || child === null || frozen(child)); }
export function validateObligationFinalizationManifest(manifest) { try { if (!isObject(manifest) || Object.keys(manifest).sort().join("\0") !== [...MANIFEST_KEYS].sort().join("\0") || !frozen(manifest) || !jsonSafe(manifest) || manifest.schemaVersion !== "goal-runtime.v1.finalization-manifest.v1" || typeof manifest.goalId !== "string" || !manifest.goalId || !Number.isSafeInteger(manifest.revision) || !hash(manifest.contractHash) || !head(manifest.head) || !hash(manifest.worldHash) || !Array.isArray(manifest.tasks) || !Array.isArray(manifest.conditions) || !isObject(manifest.debts) || !Array.isArray(manifest.blockers) || !hash(manifest.manifestHash) || !hash(manifest.stateHash) || !hash(manifest.obligationStateHash)) return false; const stateHash = sha({ goalId: manifest.goalId, revision: manifest.revision, contractHash: manifest.contractHash, tasks: manifest.tasks, conditions: manifest.conditions, debts: manifest.debts }); if (stateHash !== manifest.stateHash || sha({ stateHash, head: manifest.head, worldHash: manifest.worldHash }) !== manifest.obligationStateHash) return false; const blockers = deriveBlockers(manifest); if (!same(blockers, manifest.blockers) || manifest.complete !== (blockers.length === 0)) return false; return manifest.manifestHash === sha({ ...manifest, manifestHash: null }); } catch { return false; } }
export function finalizationUnsupportedError(eventSchemaVersion) { const error = new Error(`FINALIZATION_UNSUPPORTED_GENERATION: ${eventSchemaVersion ?? "unknown"}`); error.code = "FINALIZATION_UNSUPPORTED_GENERATION"; return error; }
export function finalizeGoal(projection, _options = {}) { throw finalizationUnsupportedError(projection?.eventSchemaVersion); }
