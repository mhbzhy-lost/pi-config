import { createHash } from "node:crypto";

const UNSUPPORTED_GENERATIONS = new Set(["goal-engine.event.v1", "goal-engine.event.v2", "goal-engine.event.v3", "planned.v1"]);
const MANIFEST_KEYS = ["schemaVersion", "goalId", "revision", "contractHash", "head", "worldHash", "stateHash", "obligationStateHash", "tasks", "conditions", "debts", "blockers", "complete", "manifestHash"];
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const head = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const canonical = value => {
  if (value instanceof Map) return canonical(Object.fromEntries(value));
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const freeze = value => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const rowEntries = value => value instanceof Map ? [...value.entries()] : isObject(value) ? Object.entries(value) : Array.isArray(value) ? value.map((row, i) => [String(i), row]) : [];
const sortedRows = value => rowEntries(value).map(([key, row]) => [String(row?.id ?? row?.definition?.id ?? key), row]).sort(([a], [b]) => a.localeCompare(b));
const get = (value, id) => value instanceof Map ? value.get(id) : value?.[id];
const add = (blockers, code, id) => blockers.push(id === undefined ? { code } : { code, id });

function currentWorld(world) {
  const { worldHash: _worldHash, capturedAt: _capturedAt, ...stable } = world;
  return canonical(stable);
}
function validInventory(inventory, world) {
  // The old empty-object baseline denotes an empty inventory; real inventories are arrays.
  const actual = Array.isArray(inventory) ? inventory : isObject(inventory) && !Object.keys(inventory).length && !Array.isArray(world?.resources) ? [] : null;
  if (!actual) return { rows: [], valid: false, matches: false };
  const valid = new Set();
  for (const row of actual) {
    if (!isObject(row) || typeof row.key !== "string" || !row.key || valid.has(row.key) || !Array.isArray(row.holders) || row.holders.some(holder => typeof holder !== "string" || !holder) || !Number.isSafeInteger(row.capacity) || row.capacity < 1) return { rows: actual, valid: false, matches: false };
    valid.add(row.key);
  }
  const matches = Array.isArray(world?.resources) ? JSON.stringify(canonical(actual)) === JSON.stringify(canonical(world.resources)) : actual.length === 0;
  return { rows: actual, valid: true, matches };
}
function taskManifest(id, task, applicability, blockers) {
  const out = { id, applicability, status: task?.status ?? null };
  if (applicability === "reverify_required") add(blockers, "TASK_REVERIFY_REQUIRED", id);
  if (applicability !== "superseded" && task?.status !== "accepted") add(blockers, "TASK_NOT_ACCEPTED", id);
  if (applicability === "superseded") return out;
  const binding = task?.executorBinding, proof = task?.lastExecutorProof, settlement = task?.settlement, workspace = task?.workspace;
  if (!binding) add(blockers, "TASK_EXECUTOR_BINDING_MISSING", id);
  if (!proof) add(blockers, "TASK_EXECUTOR_PROOF_MISSING", id);
  if (!settlement) add(blockers, "TASK_SETTLEMENT_MISSING", id);
  if (!binding || !proof || !settlement) return out;
  const bindingOK = binding.attempt === task.attempts && binding.contractHash === task.contractHash && typeof binding.runId === "string" && binding.runId === proof.runId;
  if (!bindingOK) add(blockers, "TASK_EXECUTOR_BINDING_DRIFT", id);
  if (proof.runId !== binding.runId || proof.proofId !== settlement.terminalProofId || proof.outcome !== "succeeded" || !hash(proof.proofId)) add(blockers, "TASK_EXECUTOR_PROOF_DRIFT", id);
  const evidence = settlement.evidence;
  if (settlement.attempt !== binding.attempt || settlement.executorRunId !== binding.runId || settlement.executorHead !== binding.headAtDispatch || settlement.terminalProofId !== proof.proofId || !head(settlement.executorHead)) add(blockers, "TASK_SETTLEMENT_DRIFT", id);
  if (!evidence || !hash(evidence.subagentFingerprint) || !hash(evidence.mainFingerprint) || evidence.subagentFingerprint === evidence.mainFingerprint) add(blockers, "TASK_DUAL_EVIDENCE_INVALID", id);
  if (task.acceptanceVerification !== "integrated") add(blockers, "TASK_ACCEPTANCE_NOT_INTEGRATED", id);
  if (!workspace || workspace.phase !== "disposed" || workspace.disposition !== "integrated" || workspace.released !== true) add(blockers, "TASK_WORKSPACE_UNCLOSED", id);
  out.executorProof = { runId: proof.runId, proofId: proof.proofId };
  out.settlement = { attempt: settlement.attempt, executorHead: settlement.executorHead, executorRunId: settlement.executorRunId, terminalProofId: settlement.terminalProofId, subagentFingerprint: evidence?.subagentFingerprint ?? null, mainFingerprint: evidence?.mainFingerprint ?? null };
  out.settlementEvidence = { subagentFingerprint: evidence?.subagentFingerprint ?? null, mainFingerprint: evidence?.mainFingerprint ?? null };
  out.settlementHash = sha(out.settlement);
  if (workspace) out.workspaceProof = { attempt: workspace.attempt, path: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit, originRef: workspace.originRef, requestedAction: workspace.requestedAction, strategy: workspace.strategy, executorHead: workspace.executorHead, originHeadBefore: workspace.originHeadBefore, legacyOriginRef: workspace.legacyOriginRef, originHead: workspace.originHead, phase: workspace.phase, disposition: workspace.disposition, released: workspace.released };
  return out;
}
function conditionManifest(id, condition, validity, projection, blockers) {
  const support = Array.isArray(condition?.supportingEvidenceIds) ? condition.supportingEvidenceIds : [];
  const evidence = Array.isArray(projection.evidenceHistory) ? projection.evidenceHistory : [];
  const selected = support.map(evidenceId => evidence.find(row => row?.evidenceId === evidenceId));
  const fresh = validity?.status === "fresh";
  const baseOK = condition?.status === "satisfied" && support.length > 0 && new Set(support).size === support.length && selected.every(Boolean) && selected.every(row => row.conditionId === id && row.executionRevision === projection.executionRevision && row.executionContractHash === projection.executionContractHash && row.conditionHash === condition.conditionHash && row.verdict?.kind === "passed" && hash(row.terminalProofHash) && row.artifact?.id && hash(row.artifact?.hash) && row.run?.state === "terminal");
  const policy = condition?.definition?.stability;
  let sequenceOK = true;
  if (policy?.mode === "single") sequenceOK = selected.length === 1 && (!policy.require_fresh_environment || !!selected[0]?.environment?.fingerprint);
  if (policy?.mode === "consecutive") sequenceOK = selected.length === policy.count && selected.every((row, i) => i === 0 || row.sequence === selected[i - 1].sequence + 1) && (!policy.require_distinct_environment || new Set(selected.map(row => `${row.environment?.ref}\0${row.environment?.fingerprint}`)).size === selected.length);
  if (!fresh || !baseOK) add(blockers, !fresh && validity === undefined ? "CONDITION_MISSING" : "CONDITION_STALE", id);
  if (!sequenceOK) add(blockers, "CONDITION_SEQUENCE_INVALID", id);
  return { id, status: condition?.status ?? null, freshness: fresh && baseOK && sequenceOK ? "fresh" : "stale", supportingEvidenceIds: support, supportingEvidenceRefs: selected.filter(Boolean).map(row => ({ evidenceId: row.evidenceId, terminalProofHash: row.terminalProofHash, artifact: { id: row.artifact?.id, hash: row.artifact?.hash } })), stability: policy ?? null, conditionHash: condition?.conditionHash ?? null };
}
function debtManifest(projection, world, inventory, blockers) {
  const findings = sortedRows(projection.findings).map(([id, row]) => ({ id, status: row?.status ?? null }));
  const episodes = sortedRows(projection.repairEpisodes).map(([id, row]) => ({ id, status: row?.status ?? null, resourceDebt: row?.cancellation?.resourceDebt === true }));
  const observations = sortedRows(projection.observationRuns).map(([id, row]) => ({ id, conditionId: row?.conditionId ?? null, phase: row?.phase ?? null, terminalProofHash: row?.terminalProofHash ?? null, releaseReceiptHash: row?.releaseReceiptHash ?? null }));
  const workspaces = sortedRows(projection.tasks).filter(([, task]) => task?.workspace).map(([id, task]) => ({ id, phase: task.workspace.phase ?? null, disposition: task.workspace.disposition ?? null, released: task.workspace.released ?? null }));
  for (const row of findings) if (!['resolved', 'closed', 'accepted'].includes(row.status)) add(blockers, 'OPEN_FINDING', row.id);
  for (const row of episodes) if (['active', 'blocked', 'cancel_pending', 'waiting_for_tasks', 'reverifying'].includes(row.status) || row.resourceDebt) add(blockers, row.resourceDebt ? 'CANCELLED_RESOURCE_DEBT' : 'ACTIVE_REPAIR_EPISODE', row.id);
  for (const row of observations) { if (row.phase !== 'released') add(blockers, 'OBSERVATION_NOT_RELEASED', row.id); else if (!hash(row.terminalProofHash) || !hash(row.releaseReceiptHash)) add(blockers, 'OBSERVATION_PROOF_MISSING', row.id); }
  for (const row of workspaces) if (row.phase !== 'disposed' || row.disposition !== 'integrated' || row.released !== true) add(blockers, 'TASK_WORKSPACE_UNCLOSED', row.id);
  if (projection.suspension) add(blockers, 'SUSPENSION'); if (projection.pendingHumanDecision) add(blockers, 'PENDING_HUMAN_DECISION');
  const discovery = projection.discovery ?? projection.discoveryDebt; if (discovery && (Array.isArray(discovery) ? discovery.length : discovery.untriaged)) add(blockers, 'UNTRIAGED_DISCOVERY');
  const activeRuns = Array.isArray(world.activeRuns) ? world.activeRuns.map(row => ({ runId: row?.runId, kind: row?.kind, state: row?.state })) : null;
  if (activeRuns === null || activeRuns.length) add(blockers, 'ACTIVE_RUN_DEBT');
  return { findings, episodes, observations, workspaces, resources: inventory, activeRuns, suspension: projection.suspension ?? null, pendingHumanDecision: projection.pendingHumanDecision ?? null, discovery: discovery ?? null };
}

export function buildObligationFinalizationManifest({ projection, worldSnapshot, conditionValidity, resourceInventory } = {}) {
  if (!isObject(projection) || !isObject(worldSnapshot)) throw new Error('projection and worldSnapshot are required');
  const blockers = [], inventory = validInventory(resourceInventory, worldSnapshot);
  if (!inventory.valid) add(blockers, 'RESOURCE_INVENTORY_INVALID'); else if (!inventory.matches) add(blockers, 'RESOURCE_AUTHORITY_MISMATCH');
  if (inventory.rows.some(row => row.holders.length)) add(blockers, 'RESOURCE_HOLDERS_ACTIVE');
  if (worldSnapshot.safe !== true) add(blockers, 'UNSAFE_WORLD');
  if (!head(worldSnapshot.repo?.head)) add(blockers, 'UNKNOWN_WORLD');
  if (!Array.isArray(worldSnapshot.repo?.trackedDirty) || !Array.isArray(worldSnapshot.repo?.untracked) || worldSnapshot.repo.trackedDirty.length || worldSnapshot.repo.untracked.length) add(blockers, 'DIRTY_WORLD');
  if (worldSnapshot.repo?.unmerged !== undefined && (!Array.isArray(worldSnapshot.repo.unmerged) || worldSnapshot.repo.unmerged.length)) add(blockers, 'UNMERGED_WORLD');
  if (worldSnapshot.repo?.sequencer) add(blockers, 'SEQUENCER_ACTIVE');
  if (!projection.goalId || !Number.isSafeInteger(projection.executionRevision ?? projection.revision) || !hash(projection.executionContractHash ?? projection.contractHash)) add(blockers, 'REVISION_OR_CONTRACT_UNKNOWN');
  const tasks = sortedRows(projection.tasks).map(([id, task]) => taskManifest(id, task, get(projection.taskApplicability, id)?.state ?? 'applicable', blockers));
  const conditions = sortedRows(projection.conditions).map(([id, condition]) => conditionManifest(id, condition, get(conditionValidity, id), projection, blockers));
  if (worldSnapshot.safe !== true) for (const condition of conditions) add(blockers, 'CONDITION_STALE', condition.id);
  const debts = debtManifest(projection, worldSnapshot, inventory.rows, blockers);
  const semantic = { goalId: projection.goalId ?? null, revision: projection.executionRevision ?? projection.revision ?? null, contractHash: projection.executionContractHash ?? projection.contractHash ?? null, tasks, conditions, debts, world: currentWorld(worldSnapshot) };
  const manifest = { schemaVersion: 'goal-runtime.v1.finalization-manifest.v1', goalId: semantic.goalId, revision: semantic.revision, contractHash: semantic.contractHash, head: worldSnapshot.repo?.head ?? null, worldHash: sha(currentWorld(worldSnapshot)), stateHash: sha({ goalId: semantic.goalId, revision: semantic.revision, contractHash: semantic.contractHash, tasks, conditions, debts }), obligationStateHash: sha(semantic), tasks, conditions, debts, blockers: blockers.sort((a, b) => `${a.code}:${a.id ?? ''}`.localeCompare(`${b.code}:${b.id ?? ''}`)), complete: false, manifestHash: null };
  manifest.complete = manifest.blockers.length === 0; manifest.manifestHash = sha({ ...manifest, manifestHash: null });
  return freeze(manifest);
}
function jsonSafe(value) { if (value === null || typeof value === 'string' || typeof value === 'boolean') return true; if (typeof value === 'number') return Number.isFinite(value); if (Array.isArray(value)) return value.every(jsonSafe); return isObject(value) && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(jsonSafe); }
function frozen(value) { return !!value && typeof value === 'object' && Object.isFrozen(value) && Object.values(value).every(child => typeof child !== 'object' || child === null || frozen(child)); }
export function validateObligationFinalizationManifest(manifest) { try { return isObject(manifest) && Object.keys(manifest).sort().join('\0') === [...MANIFEST_KEYS].sort().join('\0') && frozen(manifest) && jsonSafe(manifest) && hash(manifest.manifestHash) && hash(manifest.obligationStateHash) && manifest.complete === (Array.isArray(manifest.blockers) && manifest.blockers.length === 0) && manifest.manifestHash === sha({ ...manifest, manifestHash: null }); } catch { return false; } }
export function finalizationUnsupportedError(eventSchemaVersion) { const error = new Error(`FINALIZATION_UNSUPPORTED_GENERATION: ${eventSchemaVersion ?? 'unknown'}`); error.code = 'FINALIZATION_UNSUPPORTED_GENERATION'; return error; }
export function finalizeGoal(projection, _options = {}) { throw finalizationUnsupportedError(projection?.eventSchemaVersion); }
