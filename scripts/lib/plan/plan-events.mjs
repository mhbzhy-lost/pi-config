import { createHash } from "node:crypto";

import { createAttentionRequest } from "./attention.mjs";

const SCHEMA_VERSION = "pi-plan-event.v1";
const GATES = new Set(["deterministic", "plan-audit", "external-review", "final-completeness"]);
const TERMINAL_LIFECYCLES = new Set(["validated", "blocked", "cancelled", "interrupted"]);
const OPEN_ATTEMPT_STATUSES = new Set(["workspace-allocated", "dispatch-requested", "active", "waiting-attention", "validated"]);
const AMENDMENT_CONTRACT_ATTEMPT_STATUSES = new Set(["workspace-allocated", "dispatch-requested", "active", "waiting-attention", "succeeded", "validated"]);
const SETTLED_OUTCOMES = new Set(["succeeded", "failed", "interrupted", "cancelled", "blocked"]);
const BLOCKER_CODE = /^[a-z0-9][a-z0-9:_-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const AMENDMENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createProjection() {
  return {
    planId: null,
    version: 0,
    lifecycle: null,
    tasks: new Map(),
    attempts: new Map(),
    gates: new Map(),
    workspace: null,
    revision: null,
    validatedHead: null,
    eventIds: new Set(),
    amendmentRequestIds: new Set(),
  };
}

export function applyEvent(projection, event) {
  validateEnvelope(event);
  validatePlanIdentity(projection, event);

  if (projection.eventIds.has(event.eventId)) {
    throw new Error(`duplicate eventId: ${event.eventId}`);
  }
  if (TERMINAL_LIFECYCLES.has(projection.lifecycle)) {
    throw new Error(`plan is terminal: ${projection.lifecycle}`);
  }

  const next = copyProjection(projection);
  switch (event.type) {
    case "plan.created":
      createPlan(next, event);
      break;
    case "plan.amended":
      amendPlan(next, event.data);
      break;
    case "attempt.workspace-allocated":
      allocateAttemptWorkspace(next, event.data);
      break;
    case "attempt.dispatch-requested":
      requestDispatch(next, event.data);
      break;
    case "attempt.bound":
      bindAttempt(next, event.data);
      break;
    case "attempt.attention-requested":
      requestAttention(next, event);
      break;
    case "attempt.attention-escalated":
      escalateAttention(next, event.data);
      break;
    case "attempt.attention-resolved":
      resolveAttention(next, event.data);
      break;
    case "attempt.settled":
      settleAttempt(next, event.data);
      break;
    case "attempt.validated":
      validateAttempt(next, event.data);
      break;
    case "integration.requested":
      requestIntegration(next, event.data);
      break;
    case "integration.finished":
      finishIntegration(next, event.data);
      break;
    case "attempt.superseded":
      supersedeAttempt(next, event.data);
      break;
    case "attempt.workspace-released":
      releaseAttemptWorkspace(next, event.data);
      break;
    case "task.accepted":
      acceptTask(next, event.data);
      break;
    case "workspace.head-observed":
      observeHead(next, event.data);
      break;
    case "gate.finished":
      finishGate(next, event.data);
      break;
    case "plan.validated":
      validatePlan(next, event.data);
      break;
    case "plan.blocked":
    case "plan.cancelled":
    case "plan.interrupted":
      requireNonterminalPlan(next);
      next.lifecycle = event.type.slice(5);
      break;
    default:
      throw new Error(`unsupported event type: ${event.type}`);
  }
  next.version = projection.version + 1;
  next.eventIds.add(event.eventId);
  return next;
}

function validateEnvelope(event) {
  if (!event || event.schemaVersion !== SCHEMA_VERSION) throw new Error("invalid schemaVersion");
  for (const field of ["eventId", "planId", "occurredAt", "type"]) {
    if (typeof event[field] !== "string" || event[field].trim() === "") {
      throw new Error(`invalid ${field}`);
    }
  }
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    throw new Error("invalid data");
  }
}

function validatePlanIdentity(projection, event) {
  if (projection.planId === null) {
    if (event.type !== "plan.created") throw new Error("plan.created must be first event");
    return;
  }
  if (event.planId !== projection.planId) throw new Error("different planId");
  if (event.type === "plan.created") throw new Error("plan already created");
}

function copyProjection(projection) {
  return {
    ...projection,
    tasks: new Map(projection.tasks),
    attempts: new Map(projection.attempts),
    gates: new Map(projection.gates),
    eventIds: new Set(projection.eventIds),
    amendmentRequestIds: new Set(projection.amendmentRequestIds ?? []),
  };
}

function createPlan(projection, event) {
  const { workspace, tasks, revision } = event.data;
  if (revision !== undefined && JSON.stringify(Object.keys(event.data).sort()) !== JSON.stringify(["revision", "tasks", "workspace"])) throw new Error("invalid plan.created data");
  const workspaceFields = revision
    ? ["originRoot", "worktree", "baseCommit", "headCommit"]
    : ["originRoot", "worktree", "baseCommit", "headCommit", "planPath", "planHash"];
  for (const field of workspaceFields) {
    if (typeof workspace?.[field] !== "string" || workspace[field].trim() === "") throw new Error(`invalid workspace.${field}`);
  }
  if (revision && JSON.stringify(Object.keys(workspace).sort()) !== JSON.stringify([...workspaceFields].sort())) throw new Error("invalid workspace keys");
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must be nonempty");
  if (new Set(tasks).size !== tasks.length) throw new Error("tasks must be unique");
  for (const taskId of tasks) requireIdentity({ taskId }, "taskId");
  const validatedRevision = revision === undefined ? null : validateRevision(revision, tasks);
  projection.planId = event.planId;
  projection.lifecycle = "created";
  projection.workspace = Object.fromEntries(workspaceFields.map((field) => [field, workspace[field]]));
  projection.revision = validatedRevision;
  for (const taskId of tasks) projection.tasks.set(taskId, { status: "pending" });
}

function validateRevision(revision, tasks) {
  if (!revision || typeof revision !== "object" || Array.isArray(revision) || !Number.isSafeInteger(revision.number) || revision.number < 1 || !["plan-ir.v1", "plan-ir.v2", "plan-ir.v3"].includes(revision.irVersion)) throw new Error("invalid revision");
  if (JSON.stringify(Object.keys(revision).sort()) !== JSON.stringify(["irHash", "irVersion", "manifestSha256", "number", "planHash", "sourceBytesSha256", "taskHashes"])) throw new Error("invalid revision keys");
  for (const field of ["manifestSha256", "sourceBytesSha256", "planHash", "irHash"]) if (typeof revision[field] !== "string" || !SHA256.test(revision[field])) throw new Error(`invalid revision.${field}`);
  if (!revision.taskHashes || typeof revision.taskHashes !== "object" || Array.isArray(revision.taskHashes) || JSON.stringify(Object.keys(revision.taskHashes).sort()) !== JSON.stringify([...tasks].sort())) throw new Error("invalid revision.taskHashes");
  const taskHashes = {};
  for (const taskId of tasks) {
    const hashes = revision.taskHashes[taskId];
    if (!hashes || JSON.stringify(Object.keys(hashes).sort()) !== JSON.stringify(["effective", "full", "scheduling"])) throw new Error("invalid revision.taskHashes");
    for (const field of ["full", "effective", "scheduling"]) if (typeof hashes[field] !== "string" || !SHA256.test(hashes[field])) throw new Error("invalid revision.taskHashes");
    taskHashes[taskId] = { full: hashes.full, effective: hashes.effective, scheduling: hashes.scheduling };
  }
  return { number: revision.number, manifestSha256: revision.manifestSha256, sourceBytesSha256: revision.sourceBytesSha256, planHash: revision.planHash, irVersion: revision.irVersion, irHash: revision.irHash, taskHashes };
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedIdentifiers(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "") || new Set(value).size !== value.length || !sameStrings(value, [...value].sort())) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function immutableTask(projection, taskId) {
  return projection.tasks.get(taskId)?.status === "accepted"
    || [...projection.attempts.values()].some((attempt) => attempt.taskId === taskId && attempt.status === "integrated");
}

function amendPlan(projection, data) {
  const keys = ["diff", "irHash", "manifestSha256", "parentRevision", "planHash", "reason", "requestId", "revision", "sourceBytesSha256", "supersededAttemptIds", "taskHashes"];
  if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(keys)) throw new Error("invalid plan.amended data keys");
  if (!projection.revision) throw new Error("plan.amended requires committed revision identity");
  requireAmendmentRequestId(data.requestId);
  requireAmendmentReason(data.reason);
  if (projection.amendmentRequestIds.has(data.requestId)) throw new Error(`duplicate amendment requestId: ${data.requestId}`);
  if ([...projection.attempts.values()].some((attempt) => hasSupersedeCleanupFence(attempt))) {
    throw new Error("supersede cleanup is pending");
  }
  if (!Number.isSafeInteger(data.revision) || data.revision !== projection.revision.number + 1 || data.parentRevision !== projection.revision.number) throw new Error("invalid amendment revision chain");
  for (const field of ["manifestSha256", "sourceBytesSha256", "planHash", "irHash"]) if (typeof data[field] !== "string" || !SHA256.test(data[field])) throw new Error(`invalid amendment ${field}`);
  const oldHashes = projection.revision.taskHashes;
  const oldTaskIds = Object.keys(oldHashes).sort();
  const newRevision = validateRevision({ number: data.revision, manifestSha256: data.manifestSha256, sourceBytesSha256: data.sourceBytesSha256, planHash: data.planHash, irVersion: projection.revision.irVersion, irHash: data.irHash, taskHashes: data.taskHashes }, Object.keys(data.taskHashes));
  const newTaskIds = Object.keys(newRevision.taskHashes).sort();
  const diff = data.diff;
  if (!diff || typeof diff !== "object" || Array.isArray(diff) || JSON.stringify(Object.keys(diff).sort()) !== JSON.stringify(["added", "changed", "rebound", "retired", "unchanged"])) throw new Error("invalid amendment diff");
  for (const field of ["added", "changed", "rebound", "retired", "unchanged"]) sortedIdentifiers(diff[field], `amendment diff.${field}`);
  const added = newTaskIds.filter((id) => !oldHashes[id]);
  const retired = oldTaskIds.filter((id) => !newRevision.taskHashes[id]);
  const changed = oldTaskIds.filter((id) => newRevision.taskHashes[id] && oldHashes[id].full !== newRevision.taskHashes[id].full);
  const rebound = oldTaskIds.filter((id) => newRevision.taskHashes[id] && oldHashes[id].full === newRevision.taskHashes[id].full && oldHashes[id].effective !== newRevision.taskHashes[id].effective);
  const unchanged = oldTaskIds.filter((id) => newRevision.taskHashes[id] && oldHashes[id].full === newRevision.taskHashes[id].full && oldHashes[id].effective === newRevision.taskHashes[id].effective);
  if (!sameStrings(diff.added, added) || !sameStrings(diff.retired, retired) || !sameStrings(diff.changed, changed) || !sameStrings(diff.rebound, rebound) || !sameStrings(diff.unchanged, unchanged)) throw new Error("amendment diff does not match task hashes");
  for (const taskId of added) {
    if (projection.tasks.has(taskId) || [...projection.attempts.values()].some((attempt) => attempt.taskId === taskId)) throw new Error(`historical task ID cannot be reused: ${taskId}`);
  }
  for (const taskId of oldTaskIds) {
    if (immutableTask(projection, taskId) && (!newRevision.taskHashes[taskId] || oldHashes[taskId].full !== newRevision.taskHashes[taskId].full)) throw new Error(`accepted task contract is immutable: ${taskId}`);
  }
  for (const taskId of retired) {
    if (projection.tasks.get(taskId)?.status !== "pending") throw new Error(`retired task is not pending: ${taskId}`);
    if ([...projection.attempts.values()].some((attempt) => attempt.taskId === taskId)) throw new Error(`retired task has attempt history: ${taskId}`);
  }
  const supersededAttemptIds = [...projection.attempts.entries()]
    .filter(([, attempt]) => AMENDMENT_CONTRACT_ATTEMPT_STATUSES.has(attempt.status) && newRevision.taskHashes[attempt.taskId] && oldHashes[attempt.taskId]?.effective !== newRevision.taskHashes[attempt.taskId].effective)
    .map(([attemptId]) => attemptId).sort();
  if (!sameStrings(sortedIdentifiers(data.supersededAttemptIds, "supersededAttemptIds"), supersededAttemptIds)) throw new Error("supersededAttemptIds do not match affected attempts");
  projection.revision = newRevision;
  for (const taskId of added) projection.tasks.set(taskId, { status: "pending" });
  for (const taskId of retired) projection.tasks.set(taskId, { status: "retired" });
  for (const attemptId of supersededAttemptIds) {
    const attempt = projection.attempts.get(attemptId);
    const supersededTaskHash = attempt.taskHash ?? oldHashes[attempt.taskId].effective;
    if (attempt.taskHash && attempt.taskHash !== oldHashes[attempt.taskId].effective) {
      throw new Error(`attempt taskHash does not match old revision: ${attemptId}`);
    }
    const supersededAttention = attempt.status === "waiting-attention"
      && attempt.attention?.blocking
      && attempt.attention.status !== "resolved"
      ? {
        ...attempt.attention,
        status: "superseded",
        supersededByRevision: data.revision,
        projectionVersion: projection.version + 1,
      }
      : attempt.attention;
    projection.attempts.set(attemptId, {
      ...attempt,
      status: "supersede-requested",
      ...(supersededAttention ? { attention: supersededAttention } : {}),
      supersededFromStatus: attempt.status,
      supersededTaskHash,
      supersededByRevision: data.revision,
    });
  }
  projection.amendmentRequestIds.add(data.requestId);
}

function validateAttemptWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) throw new Error("invalid attempt workspace");
  for (const field of ["path", "branch", "ownerToken"]) requireIdentity(workspace, field);
  const validated = { path: workspace.path, branch: workspace.branch, ownerToken: workspace.ownerToken };
  for (const field of ["planId", "taskId", "attemptId", "originRoot", "stateRoot", "baseCommit", "leasePath", "createdAt"]) {
    if (workspace[field] !== undefined) {
      requireIdentity(workspace, field);
      validated[field] = workspace[field];
    }
  }
  return validated;
}

function sameAttemptWorkspace(left, right) {
  return left?.path === right?.path && left?.branch === right?.branch && left?.ownerToken === right?.ownerToken;
}

function allocateAttemptWorkspace(projection, data) {
  requireActivePlan(projection);
  requireIdentity(data, "attemptId");
  requireIdentity(data, "taskId");
  requireIdentity(data, "baseCommit");
  if (projection.attempts.has(data.attemptId)) throw new Error(`attempt already exists: ${data.attemptId}`);
  const task = projection.tasks.get(data.taskId);
  if (!task) throw new Error(`unknown task: ${data.taskId}`);
  if (task.status !== "pending") throw new Error(`task is not pending: ${data.taskId}`);
  for (const [attemptId, attempt] of projection.attempts) {
    if ((OPEN_ATTEMPT_STATUSES.has(attempt.status) || hasSupersedeCleanupFence(attempt)) && attempt.taskId === data.taskId) {
      throw new Error(`active attempt already exists for task ${data.taskId}: ${attemptId}`);
    }
  }
  projection.attempts.set(data.attemptId, {
    taskId: data.taskId,
    status: "workspace-allocated",
    baseCommit: data.baseCommit,
    workspace: validateAttemptWorkspace(data.workspace),
  });
  projection.lifecycle = "running";
}

function bindAttempt(projection, data) {
  requireActivePlan(projection);
  requireIdentity(data, "attemptId");
  requireIdentity(data, "taskId");
  requireIdentity(data, "dispatchId");
  const existing = projection.attempts.get(data.attemptId);
  if (existing?.status !== "dispatch-requested") throw new Error(`attempt is not dispatch-requested: ${data.attemptId}`);
  if (existing.taskId !== data.taskId) throw new Error(`attempt task does not match: ${data.attemptId}`);
  if (existing.dispatchId !== data.dispatchId) throw new Error(`attempt dispatch does not match: ${data.attemptId}`);
  requireIdentity(data, "runId");
  for (const field of ["asyncDir", "sessionFile"]) {
    if (data[field] !== null && (typeof data[field] !== "string" || data[field].trim() === "")) {
      throw new Error(`invalid ${field}`);
    }
  }
  projection.attempts.set(data.attemptId, {
    ...existing,
    status: "active",
    runId: data.runId,
    asyncDir: data.asyncDir,
    sessionFile: data.sessionFile,
  });
  projection.lifecycle = "running";
}

function requestDispatch(projection, data) {
  requireActivePlan(projection);
  for (const field of ["attemptId", "taskId", "dispatchId", "baseCommit", "toolHash"]) requireIdentity(data, field);
  const attempt = projection.attempts.get(data.attemptId);
  if (!attempt || attempt.status !== "workspace-allocated") throw new Error(`attempt workspace is not allocated: ${data.attemptId}`);
  if (attempt.taskId !== data.taskId) throw new Error(`attempt task does not match: ${data.attemptId}`);
  if (attempt.baseCommit !== data.baseCommit) throw new Error(`attempt baseCommit does not match: ${data.attemptId}`);
  if (!sameAttemptWorkspace(attempt.workspace, data.workspace)) throw new Error(`attempt workspace does not match: ${data.attemptId}`);
  validateTool(data.tool);
  if (data.tool.cwd !== attempt.workspace.path) throw new Error(`tool cwd does not match attempt workspace: ${data.attemptId}`);
  if (projection.revision) {
    const revisionDispatchKeys = ["attemptId", "baseCommit", "dispatchContextHash", "dispatchId", "planIrHash", "schedulingHash", "taskHash", "taskId", "tool", "toolHash", "workspace"];
    if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(revisionDispatchKeys)) throw new Error("invalid dispatch revision keys");
    for (const field of ["planIrHash", "taskHash", "schedulingHash", "dispatchContextHash"]) if (typeof data[field] !== "string" || !SHA256.test(data[field])) throw new Error(`invalid ${field}`);
    const expected = projection.revision.taskHashes[data.taskId];
    if (data.planIrHash !== projection.revision.irHash || data.taskHash !== expected.effective || data.schedulingHash !== expected.scheduling) throw new Error("dispatch revision identity does not match");
  }
  projection.attempts.set(data.attemptId, {
    ...attempt,
    status: "dispatch-requested",
    dispatchId: data.dispatchId,
    tool: { ...data.tool },
    toolHash: data.toolHash,
    ...(projection.revision ? { planIrHash: data.planIrHash, taskHash: data.taskHash, schedulingHash: data.schedulingHash, dispatchContextHash: data.dispatchContextHash } : {}),
  });
  projection.lifecycle = "running";
}

function settleAttempt(projection, data) {
  requireActivePlan(projection);
  requireIdentity(data, "attemptId");
  if (!SETTLED_OUTCOMES.has(data.outcome)) throw new Error("invalid outcome");
  const attempt = projection.attempts.get(data.attemptId);
  if (!attempt || attempt.status !== "active") throw new Error(`attempt is not active: ${data.attemptId}`);
  if (data.outcome === "succeeded") requireIdentity(data, "resultCommit");
  let blocked;
  if (data.outcome === "blocked") {
    requireIdentity(data, "blockerReason");
    if (!BLOCKER_CODE.test(data.blockerReason)
      || !Array.isArray(data.blockers) || data.blockers.length === 0 || data.blockers.length > 32
      || data.blockers.some((blocker) => typeof blocker !== "string" || !BLOCKER_CODE.test(blocker))
      || new Set(data.blockers).size !== data.blockers.length
      || data.blockers.some((blocker, index) => index > 0 && data.blockers[index - 1] > blocker)
      || (data.evidenceSha256 !== undefined
        && (typeof data.evidenceSha256 !== "string" || !SHA256.test(data.evidenceSha256)))) {
      throw new Error("invalid blocked disposition");
    }
    blocked = {
      blockerReason: data.blockerReason,
      blockers: [...data.blockers],
      ...(data.evidenceSha256 ? { evidenceSha256: data.evidenceSha256 } : {}),
    };
  }
  projection.attempts.set(data.attemptId, {
    ...attempt,
    status: data.outcome,
    ...(data.outcome === "succeeded" ? { resultCommit: data.resultCommit } : {}),
    ...blocked,
  });
}

function messageSha256(message) {
  return createHash("sha256").update(message).digest("hex");
}

function attentionEvidence(evidence) {
  if (evidence === undefined) return null;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("invalid attention evidence");
  for (const field of ["bodyPath", "bodySha256"]) requireIdentity(evidence, field);
  return { bodyPath: evidence.bodyPath, bodySha256: evidence.bodySha256 };
}

function redactedAttention(request, evidence, status = "pending") {
  return {
    requestId: request.requestId,
    kind: request.kind,
    blocking: request.blocking,
    status,
    messageSha256: messageSha256(request.message),
    projectionVersion: request.projectionVersion,
    createdAt: request.createdAt,
    evidence: attentionEvidence(evidence),
  };
}

function requestAttention(projection, event) {
  requireActivePlan(projection);
  const request = createAttentionRequest({ ...event.data, planId: event.planId });
  const attempt = projection.attempts.get(request.attemptId);
  if (!attempt) throw new Error(`unknown attempt: ${request.attemptId}`);
  if (attempt.attention?.blocking && attempt.attention.status !== "resolved") {
    throw new Error(`unresolved blocking attention already exists: ${request.attemptId}`);
  }
  if (attempt.status !== "active") throw new Error(`attempt is not active: ${request.attemptId}`);
  if (attempt.taskId !== request.taskId) throw new Error(`attention task does not match: ${request.attemptId}`);
  if (attempt.runId !== request.runId) throw new Error(`attention runId does not match: ${request.attemptId}`);
  if (request.projectionVersion !== projection.version + 1) throw new Error("attention projection version does not match next projection");
  const redacted = redactedAttention(request, event.data.evidence);
  projection.attempts.set(request.attemptId, request.blocking
    ? { ...attempt, status: "waiting-attention", attention: redacted }
    : { ...attempt, lastProgress: redacted });
}

function requirePendingAttention(projection, data) {
  requireIdentity(data, "attemptId");
  requireIdentity(data, "requestId");
  requireIdentity(data, "runId");
  if (!Number.isInteger(data.expectedProjectionVersion) || data.expectedProjectionVersion !== projection.version) {
    throw new Error("attention projection version is stale");
  }
  const attempt = projection.attempts.get(data.attemptId);
  if (!attempt || attempt.status !== "waiting-attention") throw new Error(`attempt is not waiting-attention: ${data.attemptId}`);
  if (attempt.runId !== data.runId) throw new Error(`attention runId does not match: ${data.attemptId}`);
  if (attempt.attention?.requestId !== data.requestId || attempt.attention.status !== "pending") {
    throw new Error(`attention request does not match: ${data.attemptId}`);
  }
  return attempt;
}

function escalateAttention(projection, data) {
  requireActivePlan(projection);
  const attempt = requirePendingAttention(projection, data);
  projection.attempts.set(data.attemptId, {
    ...attempt,
    attention: {
      ...attempt.attention,
      escalated: true,
      evidence: attentionEvidence(data.evidence),
      projectionVersion: projection.version + 1,
    },
  });
}

function resolveAttention(projection, data) {
  requireActivePlan(projection);
  const attempt = requirePendingAttention(projection, data);
  requireIdentity(data, "resolutionSha256");
  projection.attempts.set(data.attemptId, {
    ...attempt,
    status: "active",
    attention: {
      ...attempt.attention,
      status: "resolved",
      resolutionSha256: data.resolutionSha256,
      projectionVersion: projection.version + 1,
    },
  });
}

function validateAttempt(projection, data) {
  requireActivePlan(projection);
  for (const field of ["attemptId", "resultCommit", "validationHash"]) requireIdentity(data, field);
  if (!Array.isArray(data.evidence)) throw new Error("invalid validation evidence");
  if (data.changedPaths !== undefined && (!Array.isArray(data.changedPaths) || !data.changedPaths.every((item) => typeof item === "string" && item))) {
    throw new Error("invalid validation changedPaths");
  }
  if (data.diffSha256 !== undefined) requireIdentity(data, "diffSha256");
  const attempt = projection.attempts.get(data.attemptId);
  if (!attempt || attempt.status !== "succeeded") throw new Error(`attempt is not succeeded: ${data.attemptId}`);
  if (attempt.resultCommit !== data.resultCommit) throw new Error(`attempt resultCommit does not match: ${data.attemptId}`);
  projection.attempts.set(data.attemptId, {
    ...attempt,
    status: "validated",
    validationHash: data.validationHash,
    validationDiffSha256: data.diffSha256 ?? null,
    validationChangedPaths: data.changedPaths ? [...data.changedPaths] : [],
    validationEvidence: data.evidence.map((item) => ({ ...item })),
  });
}

function requestIntegration(projection, data) {
  requireActivePlan(projection);
  for (const field of ["attemptId", "expectedHead", "resultCommit", "diffSha256"]) requireIdentity(data, field);
  const attempt = projection.attempts.get(data.attemptId);
  if (!attempt || attempt.status !== "validated") throw new Error(`attempt is not validated: ${data.attemptId}`);
  if (attempt.resultCommit !== data.resultCommit) throw new Error(`attempt resultCommit does not match: ${data.attemptId}`);
  if (attempt.integration?.status === "requested") throw new Error(`integration already requested: ${data.attemptId}`);
  projection.attempts.set(data.attemptId, {
    ...attempt,
    integration: { status: "requested", expectedHead: data.expectedHead, resultCommit: data.resultCommit, diffSha256: data.diffSha256 },
  });
}

function finishIntegration(projection, data) {
  requireActivePlan(projection);
  for (const field of ["attemptId", "previousHead", "newHead"]) requireIdentity(data, field);
  const attempt = projection.attempts.get(data.attemptId);
  if (!attempt || attempt.status !== "validated" || attempt.integration?.status !== "requested") {
    throw new Error(`integration is not requested: ${data.attemptId}`);
  }
  if (attempt.integration.expectedHead !== data.previousHead) throw new Error(`integration previousHead does not match: ${data.attemptId}`);
  projection.attempts.set(data.attemptId, {
    ...attempt,
    status: "integrated",
    integration: { ...attempt.integration, status: "finished", previousHead: data.previousHead, newHead: data.newHead },
  });
  projection.tasks.set(attempt.taskId, { status: "accepted" });
  projection.workspace = { ...projection.workspace, headCommit: data.newHead };
  projection.gates.clear();
  projection.lifecycle = "running";
}

function supersedeAttempt(projection, data) {
  const keys = ["attemptId", "evidence", "oldTaskHash", "supersededByRevision", "taskId"];
  if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(keys)) throw new Error("invalid attempt.superseded data keys");
  requireIdentity(data, "attemptId");
  requireIdentity(data, "taskId");
  if (typeof data.oldTaskHash !== "string" || !SHA256.test(data.oldTaskHash)) throw new Error("invalid oldTaskHash");
  if (!Number.isSafeInteger(data.supersededByRevision)) throw new Error("invalid supersededByRevision");
  const attempt = projection.attempts.get(data.attemptId);
  if (!attempt || attempt.status !== "supersede-requested") throw new Error(`attempt is not supersede-requested: ${data.attemptId}`);
  if (attempt.taskId !== data.taskId) throw new Error(`attempt task does not match: ${data.attemptId}`);
  if (attempt.supersededTaskHash !== data.oldTaskHash) throw new Error("oldTaskHash does not match supersede request");
  if (attempt.supersededByRevision !== data.supersededByRevision) throw new Error("supersededByRevision does not match supersede request");
  const evidence = validateSupersedeEvidence(attempt, data.evidence);
  projection.attempts.set(data.attemptId, {
    ...attempt,
    status: "superseded",
    ...evidence.runBinding,
    supersedeProof: evidence.proof,
  });
}

function validateSupersedeEvidence(attempt, evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("invalid supersede evidence");
  if (evidence.kind === "never-started") {
    if (JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(["dispatchId", "kind"])) throw new Error("invalid never-started evidence keys");
    if (attempt.supersededFromStatus === "workspace-allocated" && evidence.dispatchId === null) return { proof: { kind: evidence.kind, dispatchId: null }, runBinding: {} };
    if (attempt.supersededFromStatus === "dispatch-requested" && evidence.dispatchId === attempt.dispatchId) return { proof: { kind: evidence.kind, dispatchId: evidence.dispatchId }, runBinding: {} };
    throw new Error("never-started dispatchId does not match attempt");
  }
  if (evidence.kind !== "terminal" || JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(["artifactSha256", "asyncDir", "dispatchId", "kind", "runId"])) throw new Error("invalid terminal evidence keys");
  for (const field of ["dispatchId", "runId", "asyncDir"]) requireIdentity(evidence, field);
  if (typeof evidence.artifactSha256 !== "string" || !SHA256.test(evidence.artifactSha256)) throw new Error("invalid terminal artifactSha256");
  if (attempt.supersededFromStatus === "dispatch-requested") {
    if (evidence.dispatchId !== attempt.dispatchId) throw new Error("terminal dispatchId does not match attempt");
    return { proof: { ...evidence }, runBinding: { runId: evidence.runId, asyncDir: evidence.asyncDir } };
  }
  if (!["active", "waiting-attention", "succeeded", "validated"].includes(attempt.supersededFromStatus)
    || evidence.dispatchId !== attempt.dispatchId || evidence.runId !== attempt.runId || evidence.asyncDir !== attempt.asyncDir) throw new Error("terminal identity does not match attempt");
  return { proof: { ...evidence }, runBinding: {} };
}

function hasSupersedeCleanupFence(attempt) {
  return attempt.status === "supersede-requested" || (attempt.status === "superseded" && attempt.workspaceReleased !== true);
}

function releaseAttemptWorkspace(projection, data) {
  requireActivePlan(projection);
  for (const field of ["attemptId", "disposition"]) requireIdentity(data, field);
  const attempt = projection.attempts.get(data.attemptId);
  if (!attempt) throw new Error(`unknown attempt: ${data.attemptId}`);
  if (attempt.workspaceReleased === true) throw new Error(`attempt workspace is already released: ${data.attemptId}`);
  if (attempt.status === "superseded" && !["superseded-cleanup", "superseded-preserve"].includes(data.disposition)) {
    throw new Error("invalid superseded workspace disposition");
  }
  if (attempt.status !== "superseded" && ["superseded-cleanup", "superseded-preserve"].includes(data.disposition)) {
    throw new Error("superseded workspace disposition requires superseded attempt");
  }
  if (!data.evidence || typeof data.evidence !== "object" || Array.isArray(data.evidence)) throw new Error("invalid workspace release evidence");
  projection.attempts.set(data.attemptId, {
    ...attempt,
    workspaceReleased: true,
    workspaceDisposition: data.disposition,
    workspaceReleaseEvidence: { ...data.evidence },
  });
}

function acceptTask(projection, data) {
  requireActivePlan(projection);
  requireIdentity(data, "taskId");
  const task = projection.tasks.get(data.taskId);
  if (!task) throw new Error(`unknown task: ${data.taskId}`);
  if (task.status !== "pending") throw new Error(`task is not pending: ${data.taskId}`);
  projection.tasks.set(data.taskId, { status: "accepted" });
}

function finishGate(projection, data) {
  requireActivePlan(projection);
  if (!GATES.has(data.type)) throw new Error(`unknown gate: ${data.type}`);
  if (!["passed", "failed", "unavailable"].includes(data.status)) throw new Error("invalid gate status");
  if (data.inputHead !== projection.workspace.headCommit) throw new Error("gate inputHead does not match headCommit");
  for (const field of ["gateId", "changeSetHash"]) requireIdentity(data, field);
  if (!Array.isArray(data.evidence)) throw new Error("invalid gate evidence");
  if (!Array.isArray(data.findings)) throw new Error("invalid gate findings");
  if (projection.gates.has(data.type)) throw new Error(`gate already finished: ${data.type}`);
  projection.gates.set(data.type, {
    type: data.type,
    status: data.status,
    inputHead: data.inputHead,
    gateId: data.gateId,
    changeSetHash: data.changeSetHash,
    evidence: data.evidence,
    findings: data.findings,
  });
  projection.lifecycle = "verifying";
}

function observeHead(projection, data) {
  requireActivePlan(projection);
  requireIdentity(data, "headCommit");
  for (const attempt of projection.attempts.values()) {
    if (OPEN_ATTEMPT_STATUSES.has(attempt.status) || hasSupersedeCleanupFence(attempt)) throw new Error("active attempt prevents HEAD observation");
  }
  if (data.headCommit === projection.workspace.headCommit) throw new Error("HEAD is already observed");
  projection.workspace = { ...projection.workspace, headCommit: data.headCommit };
  projection.gates.clear();
  projection.lifecycle = "running";
}

function validatePlan(projection, data) {
  if (projection.lifecycle !== "verifying") throw new Error("plan is not verifying");
  if (data.worktreeClean !== true) throw new Error("worktree clean is required");
  for (const [taskId, task] of projection.tasks) {
    if (task.status !== "accepted") throw new Error(`task is not accepted: ${taskId}`);
  }
  for (const [attemptId, attempt] of projection.attempts) {
    if (OPEN_ATTEMPT_STATUSES.has(attempt.status) || hasSupersedeCleanupFence(attempt)) throw new Error(`active attempt: ${attemptId}`);
  }
  for (const gate of GATES) {
    const result = projection.gates.get(gate);
    if (!result) throw new Error(`missing gate: ${gate}`);
    if (result.inputHead !== projection.workspace.headCommit) {
      throw new Error(`gate did not pass current head: ${gate}`);
    }
    if (result.status !== "passed" && result.status !== "unavailable") {
      throw new Error(`gate did not pass current head: ${gate}`);
    }
  }
  projection.lifecycle = "validated";
  projection.validatedHead = projection.workspace.headCommit;
}

function requireActivePlan(projection) {
  if (!["created", "running", "verifying"].includes(projection.lifecycle)) throw new Error("plan is not active");
}

function requireNonterminalPlan(projection) {
  if (projection.lifecycle === null || TERMINAL_LIFECYCLES.has(projection.lifecycle)) throw new Error("plan is terminal");
}

function requireAmendmentRequestId(requestId) {
  if (typeof requestId !== "string" || !AMENDMENT_REQUEST_ID.test(requestId)) throw new Error("invalid amendment requestId");
}

function requireAmendmentReason(reason) {
  if (typeof reason !== "string" || reason.trim() === "" || Buffer.byteLength(reason, "utf8") > 4096) {
    throw new Error("invalid amendment reason");
  }
}

function requireIdentity(data, field) {
  if (typeof data[field] !== "string" || data[field].trim() === "") throw new Error(`invalid ${field}`);
}

function validateTool(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error("invalid tool");
  for (const field of ["agent", "task", "cwd", "context"]) requireIdentity(tool, field);
  if (tool.context !== "fresh" || tool.async !== true || tool.clarify !== false || tool.worktree !== false) throw new Error("invalid tool flags");
}
