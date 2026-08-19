import { createHash } from "node:crypto";

const UNSUPPORTED_GENERATIONS = new Set([
  "goal-engine.event.v1",
  "goal-engine.event.v2",
  "goal-engine.event.v3",
  "planned.v1",
]);

export function finalizationUnsupportedError(eventSchemaVersion) {
  const error = new Error(`FINALIZATION_UNSUPPORTED_GENERATION: ${eventSchemaVersion ?? "unknown"}`);
  error.code = "FINALIZATION_UNSUPPORTED_GENERATION";
  return error;
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const entries = value => value instanceof Map ? [...value.entries()] : isObject(value) ? Object.entries(value) : Array.isArray(value) ? value.map((v, i) => [String(i), v]) : [];
const rows = value => entries(value).map(([, v]) => v);
const idOf = (key, row) => row?.id ?? row?.definition?.id ?? row?.taskId ?? row?.conditionId ?? key;
const canonical = value => {
  if (value instanceof Map) return canonical(Object.fromEntries(entries(value)));
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
};
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const clone = value => value === undefined ? null : JSON.parse(JSON.stringify(canonical(value)));
const deepFreeze = value => { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; };
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const collection = (value, name) => entries(value).map(([key, row]) => [String(idOf(key, row)), row]).sort(([a], [b]) => a.localeCompare(b));

function conditionProof(id, condition, validity, projection) {
  const result = validity instanceof Map ? validity.get(id) : validity?.[id];
  const evidence = Array.isArray(projection.evidenceHistory) ? projection.evidenceHistory : [];
  const ids = Array.isArray(condition?.supportingEvidenceIds) ? [...condition.supportingEvidenceIds] : [];
  const proof = ids.map(evidenceId => evidence.find(row => row?.evidenceId === evidenceId)).filter(Boolean);
  const validityIds = result?.supportingEvidenceIds ?? result?.evidenceIds;
  const idsMatch = validityIds === undefined || (Array.isArray(validityIds) && validityIds.length === ids.length && validityIds.every((value, index) => value === ids[index]));
  const stable = result?.status === "fresh" && ids.length > 0 && idsMatch && proof.length === ids.length && proof.every(row => row.conditionId === id && row.executionRevision === projection.executionRevision && row.executionContractHash === projection.executionContractHash && row.conditionHash === condition?.conditionHash && row.verdict?.kind === "passed");
  return { id, status: condition?.status ?? null, freshness: stable ? "fresh" : result?.status ?? "missing", supportingEvidenceIds: ids.sort(), evidenceRefs: proof.map(row => ({ evidenceId: row.evidenceId, terminalProofHash: row.terminalProofHash, head: row.head, environment: row.environment })).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)), stability: result?.stability ?? condition?.stability ?? condition?.definition?.stability ?? null, conditionHash: condition?.conditionHash ?? null, valid: stable };
}

function debtSummary(projection, world, inventory) {
  const findings = collection(projection.findings ?? {}).map(([id, row]) => ({ id, status: row?.status ?? null }));
  const episodes = collection(projection.repairEpisodes ?? {}).map(([id, row]) => ({ id, status: row?.status ?? null, resourceDebt: row?.cancellation?.resourceDebt === true }));
  const observations = collection(projection.observationRuns ?? {}).map(([id, row]) => ({ id, conditionId: row?.conditionId ?? null, phase: row?.phase ?? null, status: row?.status ?? null }));
  const workspaces = collection(projection.tasks ?? {}).map(([id, row]) => row?.workspace ? { id, phase: row.workspace.phase ?? null, disposition: row.workspace.disposition ?? null, released: row.workspace.released ?? null } : null).filter(Boolean);
  const activeRuns = Array.isArray(world?.activeRuns) ? world.activeRuns.map(run => ({ runId: run?.runId, kind: run?.kind, state: run?.state })).sort((a, b) => String(a.runId).localeCompare(String(b.runId))) : null;
  return { findings, episodes, observations, workspaces, resources: clone(inventory ?? world?.resources ?? []), activeRuns, suspension: clone(projection.suspension ?? null), pendingHumanDecision: projection.pendingHumanDecision ?? null, discovery: clone(projection.discovery ?? projection.discoveryDebt ?? null) };
}

function blockersFor(projection, world, tasks, conditions, debts) {
  const blockers = [];
  const add = (code, id = null) => blockers.push(id == null ? { code } : { code, id });
  for (const task of tasks) if (task.applicability === "applicable" && task.status !== "accepted") add("TASK_NOT_ACCEPTED", task.id); else if (task.applicability === "reverify_required") add("TASK_REVERIFY_REQUIRED", task.id);
  for (const condition of conditions) if (!condition.valid || condition.freshness !== "fresh") add(condition.freshness === "missing" ? "CONDITION_MISSING" : "CONDITION_STALE", condition.id);
  for (const finding of debts.findings) if (!["resolved", "closed", "accepted"].includes(finding.status)) add("OPEN_FINDING", finding.id);
  for (const episode of debts.episodes) if (["active", "blocked", "cancel_pending"].includes(episode.status) || episode.resourceDebt) add(episode.resourceDebt ? "CANCELLED_RESOURCE_DEBT" : "ACTIVE_REPAIR_EPISODE", episode.id);
  for (const observation of debts.observations) if (observation.phase !== "released") add("OBSERVATION_NOT_RELEASED", observation.id);
  for (const workspace of debts.workspaces) if (workspace.released !== true && !["released", "discarded", "preserved"].includes(workspace.disposition)) add("ACTIVE_WORKSPACE_DEBT", workspace.id);
  if (debts.activeRuns === null || debts.activeRuns.length) add("ACTIVE_RUN_DEBT");
  if (debts.suspension) add("SUSPENSION");
  if (debts.pendingHumanDecision) add("PENDING_HUMAN_DECISION");
  if (debts.discovery && (Array.isArray(debts.discovery) ? debts.discovery.length : debts.discovery.untriaged)) add("UNTRIAGED_DISCOVERY");
  const inventoryRows = Array.isArray(debts.resources) ? debts.resources : Object.values(debts.resources ?? {});
  if (inventoryRows.some(row => row?.resourceDebt || row?.cleanupDebt || row?.active || row?.blocked || row?.processDebt)) add("RESOURCE_OR_CLEANUP_DEBT");
  if (world?.safe !== true) add("UNSAFE_WORLD");
  if (!hash(world?.worldHash) || !world?.repo?.head) add("UNKNOWN_WORLD");
  if (!projection.goalId || !Number.isSafeInteger(projection.executionRevision ?? projection.revision) || !hash(projection.executionContractHash ?? projection.contractHash)) add("REVISION_OR_CONTRACT_UNKNOWN");
  if (world?.repo?.sequencer) add("SEQUENCER_ACTIVE");
  if (!Array.isArray(world?.repo?.trackedDirty) || !Array.isArray(world?.repo?.untracked) || world.repo.trackedDirty.length || world.repo.untracked.length) add("DIRTY_WORLD");
  if (projection.revisionHash && projection.stateHash && projection.revisionHash !== projection.stateHash) add("REVISION_HASH_MISMATCH");
  return blockers.sort((a, b) => `${a.code}:${a.id ?? ""}`.localeCompare(`${b.code}:${b.id ?? ""}`));
}

export function buildObligationFinalizationManifest({ projection, worldSnapshot, conditionValidity, resourceInventory } = {}) {
  if (!isObject(projection) || !isObject(worldSnapshot)) throw new Error("projection and worldSnapshot are required");
  const tasks = collection(projection.tasks ?? {}).map(([id, row]) => ({ id, applicability: projection.taskApplicability instanceof Map ? projection.taskApplicability.get(id)?.state ?? "applicable" : projection.taskApplicability?.[id]?.state ?? "applicable", status: row?.status ?? null, settlementProofHash: row?.settlement?.proofHash ?? row?.settlement?.settlementHash ?? row?.settlementEvidence?.sha256 ?? null }));
  const conditions = collection(projection.conditions ?? {}).map(([id, row]) => conditionProof(id, row, conditionValidity, projection));
  const debts = debtSummary(projection, worldSnapshot, resourceInventory);
  const blockers = blockersFor(projection, worldSnapshot, tasks, conditions, debts);
  const semantic = { goalId: projection.goalId ?? null, revision: projection.executionRevision ?? projection.revision ?? null, contractHash: projection.executionContractHash ?? projection.contractHash ?? null, tasks, conditions, debts, world: { safe: worldSnapshot.safe, head: worldSnapshot.repo?.head ?? worldSnapshot.head ?? null, worldHash: worldSnapshot.worldHash ?? digest(worldSnapshot) } };
  const manifest = { schemaVersion: "goal-runtime.v1.finalization-manifest.v1", goalId: semantic.goalId, revision: semantic.revision, contractHash: semantic.contractHash, head: semantic.world.head, worldHash: semantic.world.worldHash, stateHash: projection.stateHash ?? projection.obligationStateHash ?? digest(semantic), obligationStateHash: digest(semantic), tasks, conditions, debts, blockers, complete: blockers.length === 0, manifestHash: null };
  manifest.manifestHash = digest({ ...manifest, manifestHash: null });
  return deepFreeze(manifest);
}

export function validateObligationFinalizationManifest(manifest) {
  if (!isObject(manifest) || manifest.schemaVersion !== "goal-runtime.v1.finalization-manifest.v1" || !hash(manifest.manifestHash) || !hash(manifest.obligationStateHash)) return false;
  if (manifest.manifestHash !== digest({ ...manifest, manifestHash: null })) return false;
  if (manifest.complete !== (Array.isArray(manifest.blockers) && manifest.blockers.length === 0)) return false;
  return true;
}

// R1 deliberately has no successful finalization path. Keeping this guard pure
// ensures legacy goals cannot allocate review or execution resources.
export function finalizeGoal(projection, _options = {}) {
  if (UNSUPPORTED_GENERATIONS.has(projection?.eventSchemaVersion)) throw finalizationUnsupportedError(projection.eventSchemaVersion);
  throw finalizationUnsupportedError(projection?.eventSchemaVersion);
}
