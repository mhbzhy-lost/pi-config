import { parsePlanDocument } from "./plan-document.mjs";
import { compilePlanToIR } from "./ir/index.mjs";

function amendmentEventData(prepared, validated, input) {
  return { revision: prepared.manifest.revision, parentRevision: prepared.manifest.parentRevision, manifestSha256: prepared.manifestSha256, sourceBytesSha256: prepared.manifest.sourceBytesSha256, planHash: prepared.manifest.planHash, irHash: prepared.manifest.irHash, taskHashes: validated.taskHashes, diff: validated.diff, supersededAttemptIds: validated.supersededAttemptIds, requestId: input.requestId, reason: input.reason };
}

function validateServiceInput(input) {
  const keys = ["baseRevision", "expectedProjectionVersion", "reason", "requestId", "source"];
  if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(keys)) throw new Error("invalid Plan amendment input keys");
  if (!Number.isSafeInteger(input.expectedProjectionVersion) || input.expectedProjectionVersion < 0) throw new Error("invalid Plan amendment projection version");
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1) throw new Error("invalid Plan amendment base revision");
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.requestId)) throw new Error("invalid Plan amendment requestId");
  if (typeof input.reason !== "string" || !input.reason.trim() || Buffer.byteLength(input.reason, "utf8") > 4096) throw new Error("invalid Plan amendment reason");
  if (typeof input.source !== "string" || Buffer.byteLength(input.source, "utf8") > 1024 * 1024) throw new Error("invalid Plan amendment source");
}

export function createPlanAmendmentService({ revisionStore, eventWriter, currentProjection, supersedeAttempt } = {}) {
  if (!revisionStore || typeof revisionStore.readRevision !== "function" || typeof revisionStore.prepareRevision !== "function" || typeof revisionStore.writeCurrent !== "function" || !eventWriter || typeof eventWriter.append !== "function" || typeof currentProjection !== "function" || typeof supersedeAttempt !== "function") throw new Error("invalid Plan amendment service dependencies");
  async function amend(input) {
    validateServiceInput(input);
    const projection = currentProjection();
    if (!projection?.revision || typeof projection.planId !== "string" || !projection.planId) throw new Error("Plan amendment requires committed revision identity");
    if (projection.version !== input.expectedProjectionVersion) throw new Error("Plan projection version conflict");
    if (projection.revision.number !== input.baseRevision) throw new Error("Plan base revision is stale");
    const sourceMatch = [...projection.attempts.entries()].find(([, attempt]) => attempt.attention?.requestId === input.requestId && attempt.attention.status === "resolved" && attempt.attention.blocking === true);
    if (!sourceMatch) throw new Error("Plan amendment requires a resolved blocking Supervisor request");
    const [sourceAttemptId, sourceAttempt] = sourceMatch;
    const current = await revisionStore.readRevision(projection.planId, input.baseRevision);
    if (!current || current.manifest.planHash !== projection.revision.planHash || current.manifest.irHash !== projection.revision.irHash) throw new Error("Plan amendment current revision identity does not match projection");
    const parsed = parsePlanDocument(input.source, current.sourcePath);
    if (parsed.revision !== input.baseRevision + 1 || parsed.parentPlanHash !== current.manifest.planHash) throw new Error("Plan amendment revision chain does not match");
    const nextIr = compilePlanToIR(parsed);
    const validated = validateAmendment({ projection, oldIr: current.ir, newIr: nextIr });
    const prepared = await revisionStore.prepareRevision({ planId: projection.planId, sourceBytes: Buffer.from(input.source, "utf8"), expectedIrHash: nextIr.hash, reason: input.reason, initiator: { kind: "supervisor-request", requestId: input.requestId, taskId: sourceAttempt.taskId, attemptId: sourceAttemptId, runId: sourceAttempt.runId } });
    await eventWriter.append({ expectedProjectionVersion: input.expectedProjectionVersion, planId: projection.planId, type: "plan.amended", data: amendmentEventData(prepared, validated, input) });
    await revisionStore.writeCurrent(prepared);
    const errors = [];
    for (const attemptId of validated.supersededAttemptIds) {
      try { await supersedeAttempt({ attemptId, expectedTaskHash: projection.attempts.get(attemptId)?.taskHash ?? projection.revision.taskHashes[projection.attempts.get(attemptId)?.taskId]?.effective }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Plan amendment committed with pending Attempt supersede cleanup");
    return { revision: prepared.revision, irHash: nextIr.hash, ...validated };
  }
  return Object.freeze({ amend });
}

const CONTRACT_ATTEMPT_STATUSES = new Set(["workspace-allocated", "dispatch-requested", "active", "waiting-attention", "succeeded", "validated"]);
const RESOURCE_RELEASED_ATTEMPT_STATUSES = new Set(["cancelled", "failed", "integrated"]);
const IMMUTABLE_STATUSES = new Set(["accepted", "integrated"]);

function nodesById(ir) {
  return new Map(ir.nodes.map((node) => [node.id, node]));
}

function attemptHistory(projection, taskId) {
  return [...projection.attempts.values()].some((attempt) => attempt.taskId === taskId);
}

function taskIsImmutable(projection, taskId) {
  return IMMUTABLE_STATUSES.has(projection.tasks.get(taskId)?.status)
    || [...projection.attempts.values()].some((attempt) => attempt.taskId === taskId && attempt.status === "integrated");
}

function validateRetirements(projection, diff) {
  for (const taskId of diff.retired) {
    const status = projection.tasks.get(taskId)?.status;
    if (taskIsImmutable(projection, taskId)) {
      throw new Error(`accepted task cannot be deleted: ${taskId}`);
    }
    if (status !== "pending") throw new Error(`retired task is not pending: ${taskId}`);
    if (attemptHistory(projection, taskId)) throw new Error(`retired task has attempt history: ${taskId}`);
  }
}

function validateHistoricalIds(projection, oldById, diff) {
  for (const taskId of diff.added) {
    if (!oldById.has(taskId) && (projection.tasks.has(taskId) || attemptHistory(projection, taskId))) {
      throw new Error(`historical task ID cannot be reused: ${taskId}`);
    }
  }
}

function validateImmutableTasks(projection, oldById, newById) {
  for (const [taskId] of oldById) {
    if (!taskIsImmutable(projection, taskId)) continue;
    const next = newById.get(taskId);
    if (!next) throw new Error(`accepted task cannot be deleted: ${taskId}`);
    if (oldById.get(taskId).hashes.full !== next.hashes.full) {
      const kind = projection.tasks.get(taskId)?.status === "accepted" ? "accepted" : "integrated";
      throw new Error(`${kind} task contract is immutable: ${taskId}`);
    }
  }
}

function validateResourceCapacity(projection, oldById, newIr) {
  const claims = new Map();
  for (const attempt of projection.attempts.values()) {
    if (attempt.workspaceReleased === true || RESOURCE_RELEASED_ATTEMPT_STATUSES.has(attempt.status)) continue;
    const node = oldById.get(attempt.taskId);
    if (!node) continue;
    for (const resource of node.resources ?? []) {
      claims.set(resource.id, (claims.get(resource.id) ?? 0) + 1);
    }
  }
  for (const [resourceId, count] of claims) {
    if (!Number.isSafeInteger(newIr.resourceCapacities?.[resourceId]) || newIr.resourceCapacities[resourceId] < count) {
      throw new Error(`resource capacity is below active claims: ${resourceId}`);
    }
  }
}

export function diffPlanRevisions(oldIr, newIr) {
  const oldById = nodesById(oldIr);
  const newById = nodesById(newIr);
  const added = [...newById.keys()].filter((id) => !oldById.has(id)).sort();
  const retired = [...oldById.keys()].filter((id) => !newById.has(id)).sort();
  const changed = [...oldById.keys()]
    .filter((id) => newById.has(id) && oldById.get(id).hashes.full !== newById.get(id).hashes.full)
    .sort();
  const rebound = [...oldById.keys()]
    .filter((id) => newById.has(id)
      && oldById.get(id).hashes.full === newById.get(id).hashes.full
      && oldById.get(id).hashes.effective !== newById.get(id).hashes.effective)
    .sort();
  const unchanged = [...oldById.keys()]
    .filter((id) => newById.has(id) && oldById.get(id).hashes.effective === newById.get(id).hashes.effective)
    .sort();
  return { added, changed, rebound, retired, unchanged };
}

export function validateAmendment({ projection, oldIr, newIr }) {
  const oldById = nodesById(oldIr);
  const newById = nodesById(newIr);
  const diff = diffPlanRevisions(oldIr, newIr);

  validateImmutableTasks(projection, oldById, newById);
  validateRetirements(projection, diff);
  validateHistoricalIds(projection, oldById, diff);
  validateResourceCapacity(projection, oldById, newIr);

  const supersededAttemptIds = [...projection.attempts]
    .filter(([, attempt]) => CONTRACT_ATTEMPT_STATUSES.has(attempt.status)
      && oldById.has(attempt.taskId)
      && newById.has(attempt.taskId)
      && oldById.get(attempt.taskId).hashes.effective !== newById.get(attempt.taskId).hashes.effective)
    .map(([attemptId]) => attemptId)
    .sort();
  const taskHashes = Object.fromEntries([...newById.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([taskId, node]) => [taskId, {
      full: node.hashes.full,
      effective: node.hashes.effective,
      scheduling: node.hashes.scheduling,
    }]));

  return { diff, supersededAttemptIds, taskHashes };
}
