import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { realpathSync, openSync, closeSync, fstatSync, lstatSync, readFileSync, constants as fsConstants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { hashGoalMetadataProposal, recordHumanChoice, createRuntimeActivationChallenge } from "./human-decision.mjs";
import { normalizeRuntimeGoalInit, hashRuntimeExecutionContract, validateRuntimeReadiness } from "./obligation-contract.mjs";
import { captureCurrentWorld } from "./current-world.mjs";
import { requestObservation, startObservation, recoverObservation, recordObservation, releaseObservation } from "./observation-runner.mjs";
import { hostObservationAdapter } from "./observation-adapters.mjs";
import { prepareManagedValidation } from "./managed-validation.mjs";
import { actionableFrontier, nextObligationAction, obligationProgressFingerprint } from "./obligation-policy.mjs";
import { evaluateConditionGraph } from "./condition-validity.mjs";
import { generationCapabilities } from "./generation-capabilities.mjs";
import { buildTransferChallenge, listCwdGoals, ownerSessionId, transferChallengeState, workspaceReleased } from "./session-transfer.mjs";
import { validateDAG, runnableFrontier, goalProgress, taskActionState, nextDispatchAttempt, orphanWorkspaceActionState } from "./graph.mjs";
import { appendEvent, appendEventBatch, appendEventBatchWithSettlementEvidence, loadProjection, loadFinalizationProjection, listGoals, listGoalIds } from "./store.mjs";
import { assertIndependentSettlementEvidence, fingerprintSettlementEvidence, normalizeSettlementEvidence, serializeSettlementEvidenceYaml } from "./settlement-evidence.mjs";
import { compileTaskContract, assertPendingTaskContractsCompile } from "./dispatch.mjs";
import { splitDispatchEnvelope } from "./dispatch-ir.mjs";
import { issueActionOffer, verifyAndConsumeActionOffer } from "./action-offer.mjs";
import {
  buildContinuityCheckpoint,
  buildDiscovery,
  buildSessionBinding,
  formatRecoveryInjection,
  selectContinuityCandidate,
} from "./continuity.mjs";
import { applyEvent, createProjection, PLANNED_SCHEMA_VERSION, schemaVersionForMutation, suspensionClosureHash, validateNextAction } from "./events.mjs";
import { completionVerdictFor } from "./evidence.mjs";
import { finalizeGoal, buildObligationFinalizationManifest } from "./finalization.mjs";
import { createFinalReviewFileStore, runRecoverableFinalReview } from "./final-review.mjs";
import { deriveFindingFromFailedEvidence, openRepairEpisode, buildRemediationTaskCandidate, createRepairChallenge, recordRepairUserDecision, issueRepairCapability, validateRemediationTask, planRepairObservationLink, repairEpisodeTransition } from "./repair-policy.mjs";
import {
  assertExecutorBindingTicketCurrent,
  assertExecutorSettlementProof,
  executorBoundEventData,
  prepareExecutorBindingTicket,
} from "./executor-binding.mjs";
import { bindGoalExecutorCoordinator, inspectRootBrokerExecutorProof } from "../subagent-dispatch/root-broker-registry.ts";
import { parseProcessTerminal } from "../subagent-dispatch/root-broker-protocol.ts";
import { validateTaskDefinitions } from "./task-definition.mjs";
import { buildSuspensionPlan, deriveOwnedExecutorStopRequest } from "./suspension.mjs";
import { ensureGoalStateIdentity, resolveGoalStateScope, selectGoalStateRoot } from "./state-scope.mjs";
import {
  allocateExecutorWorkspace,
  markExecutorWorkspaceCleanupDebt,
  loadExecutorWorkspaceLease,
  inspectExecutorWorkspace,
  inspectOrphanedExecutorWorkspace,
  inspectExecutorWorkspaceResources,
  assertWorkspaceChangesWithinPaths,
  isExecutorWorkspaceIntegrated,
  inspectOriginIntegrationBaseline,
  integrateExecutorWorkspace,
  releaseExecutorWorkspace,
} from "./workspace.mjs";

const STATE_ROOT_REL = ".state/goal-engine";
const GOAL_ID_RE = /[^a-zA-Z0-9._-]+/g;
const CHECKPOINT_REMINDER_THRESHOLD = 5;
const LEGACY_EVENT_VERSION = "goal-engine.event.v2";
const CURRENT_EVENT_VERSION = "goal-engine.event.v3";
const DEFAULT_DISPOSITION_STRATEGY = "cherry-pick";
const MANAGED_OWNER_TOKEN = /^worktree-owner\.v1:[a-f0-9]{64}$/;

function workspaceResourcesRemain(lease, resources) {
  return resources.workspaceExists || resources.leaseExists
    || (typeof lease.ownerToken === "string" && lease.ownerToken !== "restored" && !MANAGED_OWNER_TOKEN.test(lease.ownerToken) && resources.branchExists);
}

function initError(code, observed, remediation) {
  return Object.assign(new Error(`${code}: observed=${observed}; remediation=${remediation}; stateChanged=false`), { code });
}

function orphanRecoveryError(code, observed, remediation, requiredNextAction, blockingReason) {
  const stateChanged = false;
  const error = Object.assign(initError(code, observed, remediation), {
    code, observed, remediation, stateChanged, requiredNextAction, blockingReason,
  });
  error.message = `${error.message}; recoveryContract=${JSON.stringify({
    code, observed, remediation, stateChanged, requiredNextAction, blockingReason,
  })}`;
  return error;
}

function assertNoOrphanedExecutorWorkspace(goalId, taskId, attempt, cwd, root) {
  const orphanInventory = inspectOrphanedExecutorWorkspace({
    goalId, taskId, attempt, originRoot: cwd, stateRoot: root,
  });
  if (orphanInventory.kind === "none") return;

  const actionState = orphanWorkspaceActionState(taskId, orphanInventory);
  const code = actionState.blockingReason.code;
  const observed = {
    taskId,
    candidate: { attempt },
    resources: orphanInventory.resources,
  };
  const remediation = code === "ORPHANED_EXECUTOR_WORKSPACE"
    ? "review the orphaned executor workspace and explicitly choose discard or preserve via goal_integrate"
    : "inspect the authoritative recovery state with goal_status before any workspace action";
  const requiredNextAction = code === "ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED"
    ? { tool: "goal_status", params: { goal_id: goalId } }
    : null;
  throw orphanRecoveryError(code, observed, remediation, requiredNextAction, actionState.blockingReason);
}

function gitOutput(cwd, args, code, observed, remediation, allowedStatuses = [], requiredNextAction) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) {
    if (allowedStatuses.includes(error.status)) return null;
    throw preflightError(code, observed, remediation, requiredNextAction);
  }
}

function realpathForPreflight(path, observed, remediation, requiredNextAction) {
  try { return realpathSync(path); }
  catch { throw preflightError("GIT_INFRASTRUCTURE_ERROR", observed, remediation, requiredNextAction); }
}

function preflightError(code, observed, remediation, requiredNextAction) {
  const error = initError(code, observed, remediation);
  if (requiredNextAction) {
    error.requiredNextAction = requiredNextAction;
    error.message = `${error.message}; requiredNextAction=${JSON.stringify(requiredNextAction)}`;
  }
  return error;
}

function readChildSettlementEvidence(task, supplied, identity, criteria) {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied) || Object.keys(supplied).sort().join(",") !== "content,sha256") throw new Error("subagent_evidence must contain exactly sha256 and content");
  if (!/^[a-f0-9]{64}$/.test(supplied.sha256)) throw new Error("subagent_evidence sha256 is invalid");
  if (task.executorBinding.workspacePath !== task.workspace.path) throw new Error("executor binding workspacePath mismatch");
  const normalized = normalizeSettlementEvidence(supplied.content, { expectedIdentity: identity, expectedCriteria: criteria, outcome: "succeeded" });
  if (fingerprintSettlementEvidence(normalized, { expectedIdentity: identity, expectedCriteria: criteria, outcome: "succeeded" }) !== supplied.sha256) throw new Error("subagent_evidence fingerprint mismatch");
  const path = join(task.workspace.path, ".pi-subagents", "acceptance-evidence", `${supplied.sha256}.yaml`);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600) throw new Error("unsafe subagent evidence artifact");
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes, receipt;
  try { receipt = fstatSync(fd); bytes = readFileSync(fd); } finally { closeSync(fd); }
  const after = lstatSync(path);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || (after.mode & 0o7777) !== 0o600 || before.dev !== receipt.dev || before.ino !== receipt.ino || after.dev !== receipt.dev || after.ino !== receipt.ino || receipt.size !== bytes.length) throw new Error("subagent evidence identity replacement");
  if (!bytes.equals(Buffer.from(serializeSettlementEvidenceYaml(normalized, { expectedIdentity: identity, expectedCriteria: criteria, outcome: "succeeded" })))) throw new Error("subagent evidence bytes mismatch");
  return normalized;
}

function settlementIdentityError(code, observed, requiredNextAction, remediation = "return to the executor workspace, verify the settled attempt and commit identity, then retry goal_integrate") {
  return preflightError(code, observed, remediation, requiredNextAction);
}

function isInspectionInternalHeadDrift(error) {
  return String(error?.message || error) === "Executor workspace HEAD changed during inspection";
}

function inspectionSnapshotsMatch(first, second) {
  return first.headCommit === second.headCommit
    && first.clean === second.clean
    && JSON.stringify(first.dirtyFiles) === JSON.stringify(second.dirtyFiles)
    && JSON.stringify(first.untrackedFiles) === JSON.stringify(second.untrackedFiles);
}

function workspaceMutationError(error, requiredNextAction) {
  const observed = String(error?.message || error);
  const code = /persisted lease not found/i.test(observed) ? "EXECUTOR_LEASE_NOT_FOUND"
    : /Executor workspace is missing|workspace is required/i.test(observed) ? "EXECUTOR_WORKSPACE_MISSING"
      : /workspace identity|lease .*mismatch|live branch mismatch/i.test(observed) ? "EXECUTOR_WORKSPACE_IDENTITY_MISMATCH"
        : "GIT_INFRASTRUCTURE_ERROR";
  return preflightError(code, observed, "stop modifying the workspace and use the typed goal_status recovery action", requiredNextAction);
}

function assertRepositoryPreflight(cwd, { operation, requiredNextAction, stateStorage = "legacy" }) {
  const retry = `repair Git and retry ${operation}`;
  const realpathRemediation = requiredNextAction ? retry : "repair filesystem access and retry goal_init";
  const physicalCwd = realpathForPreflight(cwd, `cwd realpath could not be read: ${cwd}`, realpathRemediation, requiredNextAction);
  const topLevel = gitOutput(cwd, ["rev-parse", "--show-toplevel"], "GIT_INFRASTRUCTURE_ERROR", "Git worktree top-level could not be read", retry, [], requiredNextAction);
  if (realpathForPreflight(topLevel, `Git top-level realpath could not be read: ${topLevel}`, realpathRemediation, requiredNextAction) !== physicalCwd) throw preflightError("UNSAFE_GIT_CWD", `cwd=${physicalCwd}, topLevel=${topLevel}`, `run ${operation} from the repository top-level`, requiredNextAction);
  gitOutput(cwd, ["rev-parse", "--verify", "HEAD"], "INVALID_GIT_HEAD", "HEAD is unborn or invalid", `create a commit on an attached branch before ${operation}`, [], requiredNextAction);
  const ref = gitOutput(cwd, ["symbolic-ref", "--quiet", "HEAD"], "DETACHED_GIT_HEAD", "HEAD is detached", `checkout an attached branch before ${operation}`, [1], requiredNextAction);
  if (!ref) throw preflightError("DETACHED_GIT_HEAD", "HEAD is detached", `checkout an attached branch before ${operation}`, requiredNextAction);
  if (stateStorage === "legacy") {
    const tracked = gitOutput(cwd, ["ls-files", "--", STATE_ROOT_REL], "GIT_INFRASTRUCTURE_ERROR", "could not inspect tracked state entries", retry, [], requiredNextAction);
    if (tracked) throw preflightError("STATE_TRACKED", `tracked entries: ${tracked}`, `remove .state/goal-engine from the Git index before retrying ${operation}`, requiredNextAction);
    const ignored = gitOutput(cwd, ["check-ignore", "-q", ".state/goal-engine/"], "GIT_INFRASTRUCTURE_ERROR", "could not inspect .state/goal-engine ignore rule", "repair Git ignore configuration", [1], requiredNextAction);
    if (ignored === null) throw preflightError("STATE_NOT_IGNORED", ".state/goal-engine/ is not ignored", `add .state/goal-engine/ to .gitignore before retrying ${operation}`, requiredNextAction);
  }
}

function assertInitPreflight(cwd, stateStorage) {
  assertRepositoryPreflight(cwd, { operation: "goal_init", stateStorage });
}

function validateProjectionForDispatch(projection, cwd) {
  validateTaskDefinitions([...projection.tasks.keys()], taskDefsFromProjection(projection), {
    cwd,
    realpathCwd: realpathSync(cwd),
    planned: projection.eventSchemaVersion === PLANNED_SCHEMA_VERSION,
  });
  assertPendingTaskContractsCompile(projection, cwd);
}

function gitHead(cwd) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

function currentOriginRef(cwd) {
  try { return execFileSync("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd, encoding: "utf8" }).trim(); }
  catch { throw new Error("Origin ref must be an attached symbolic ref (detached HEAD is not supported)"); }
}

function workspacePaths(stateRoot, goalId, taskId, attempt) {
  const normalizedRoot = resolve(stateRoot);
  const worktreesRoot = join(normalizedRoot, "worktrees");
  return {
    workspacePath: resolve(worktreesRoot, `${goalId}-${taskId}-${attempt}`),
    leasePath: resolve(worktreesRoot, `.${goalId}-${taskId}-${attempt}.lease.json`),
  };
}

function workspaceLeaseIdentityFromProjection(taskWorkspace, goalId, taskId, cwd, root) {
  if (!taskWorkspace) {
    throw new Error("workspace is required");
  }

  const attempt = taskWorkspace.attempt;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`invalid workspace attempt for task ${taskId}`);
  }

  const snapshotPath = taskWorkspace.path;
  const branch = taskWorkspace.branch;
  const baseCommit = taskWorkspace.baseCommit;
  const originRef = taskWorkspace.originRef;
  if (typeof snapshotPath !== "string" || !snapshotPath) {
    throw new Error(`workspace snapshot missing path for task ${taskId}`);
  }
  if (typeof branch !== "string" || !branch) {
    throw new Error(`workspace snapshot missing branch for task ${taskId}`);
  }
  if (typeof baseCommit !== "string" || !baseCommit) {
    throw new Error(`workspace snapshot missing baseCommit for task ${taskId}`);
  }
  if (typeof originRef !== "string" || !originRef) {
    throw new Error(`workspace snapshot missing originRef for task ${taskId}`);
  }

  const { workspacePath, leasePath } = workspacePaths(root, goalId, taskId, attempt);
  const expected = {
    goalId,
    taskId,
    attempt,
    path: workspacePath,
    branch: `ge/${goalId}/${taskId}/${attempt}`,
    baseCommit,
    originRef,
    originRoot: resolve(cwd),
    stateRoot: resolve(root),
    leasePath,
  };

  if (snapshotPath !== expected.path) {
    throw new Error(`workspace snapshot mismatch for task ${taskId}`);
  }
  if (branch !== expected.branch) {
    throw new Error(`workspace snapshot branch mismatch for task ${taskId}`);
  }

  return expected;
}

function assertLeaseIdentity(lease, expected, label) {
  for (const [field, value] of Object.entries(expected)) {
    if (lease?.[field] !== value) {
      throw new Error(`${label} workspace lease ${field} mismatch for task ${expected.taskId}`);
    }
  }
}

function classifyDispatchAppendFailure(loadProjectionFn, root, goalId, taskId, projectionBefore, attempt, contract, lease) {
  let recovered;
  try {
    recovered = loadProjectionFn(root, goalId);
  } catch {
    return "ambiguous";
  }
  if (typeof recovered?.goalId !== "string" || recovered.goalId !== goalId) return "ambiguous";
  const task = recovered.tasks?.get(taskId);
  const workspace = task?.workspace;
  const committed = task?.status === "dispatched"
    && task.attempts === attempt
    && task.contractHash === contract.hash
    && workspace?.phase === "active"
    && workspace.attempt === attempt
    && workspace.path === lease.path
    && workspace.branch === lease.branch
    && workspace.baseCommit === lease.baseCommit
    && workspace.originRef === lease.originRef;
  if (committed) return "committed";

  const beforeTask = projectionBefore.tasks.get(taskId);
  const notCommitted = recovered?.version === projectionBefore.version
    && task?.status === "pending"
    && task.attempts === beforeTask.attempts
    && workspace?.attempt !== attempt;
  return notCommitted ? "not_committed" : "ambiguous";
}

function ambiguousDispatchCommitError(goalId, taskId, attempt, cause) {
  return Object.assign(
    new Error(`ambiguous dispatch commit for goal ${goalId}, task ${taskId}, attempt ${attempt}`),
    { code: "AMBIGUOUS_DISPATCH_COMMIT", cause },
  );
}

function toolResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    details: { value },
  };
}

function registerGoalTool(pi, definition) {
  const { handler, prepareArguments, prepareInExecute = true, ...publicDefinition } = definition;
  if (typeof handler !== "function") throw new Error(`Goal tool ${definition.name} is missing its domain handler`);
  pi.registerTool({
    ...publicDefinition,
    ...(prepareArguments ? { prepareArguments } : {}),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const prepared = prepareArguments && prepareInExecute ? prepareArguments(params) : params;
      if (definition.name !== "goal_status" && pi.__goalRuntimeIntentGate?.(ctx, prepared)) throw new Error("R10B_SUSPENSION_REQUIRED");
      return toolResult(await handler(prepared, ctx));
    },
  });
}

function stateRoot(cwd) {
  return join(cwd, STATE_ROOT_REL);
}

function taskDefsFromProjection(projection) {
  return Object.fromEntries([...projection.tasks].map(([taskId, task]) => [taskId, {
    description: task.description,
    deps: task.deps,
    writePaths: task.writePaths,
    acceptance: task.acceptance,
    workflow: task.workflow,
  }]));
}

export function executionScope(ctx) {
  if (!ctx?.cwd || typeof ctx.cwd !== "string" || !isAbsolute(ctx.cwd)) {
    throw new Error("Goal Engine requires a non-empty absolute ExtensionContext.cwd");
  }
  return { cwd: ctx.cwd, root: stateRoot(ctx.cwd) };
}

function leaseKey(cwd, goalId, taskId) {
  return `${cwd}\0${goalId}\0${taskId}`;
}

function slugify(raw) {
  if (typeof raw !== "string") throw new Error("objective must be a non-empty string");
  const slug = raw.toLowerCase().replace(GOAL_ID_RE, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 80);
  if (!slug) throw new Error("objective must produce a non-empty goal id");
  return slug;
}

function makeEvent(type, data, goalId, schemaVersion = CURRENT_EVENT_VERSION) {
  return {
    schemaVersion,
    eventId: crypto.randomUUID(),
    goalId,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}


function ambiguousAcceptCommitError(goalId, taskId, cause) {
  return Object.assign(new Error(`ambiguous accept commit for goal ${goalId}, task ${taskId}`), {
    code: "AMBIGUOUS_ACCEPT_COMMIT",
    cause,
  });
}

function sessionIdentity(ctx) {
  const manager = ctx?.sessionManager;
  const identity = manager?.getSessionId?.() || manager?.getSessionFile?.();
  if (typeof identity !== "string" || !identity) throw new Error("Goal Engine requires a durable session identity");
  return identity;
}

function machineActionForProjection(projection, cwd, root) {
  const untriaged = Object.values(projection.continuity?.observations || {}).filter((observation) => observation.status === "untriaged");
  if (untriaged.length > 0) return { tool: "goal_amend", params: { goal_id: projection.goalId } };
  if (projection.lifecycle !== "active") {
    if (projection.sessionBindings?.some((binding) => binding.state === "watching")) {
      return { tool: "goal_amend", params: { goal_id: projection.goalId, operation: "detach_session" } };
    }
    return null;
  }
  // Keep independent runnable work moving before asking an already dispatched
  // task to settle. Orphaned workspaces remain excluded for recovery handling.
  for (const [taskId] of projection.tasks) {
    const attempt = nextDispatchAttempt(projection, taskId);
    if (attempt === null) continue;
    const inventory = inspectOrphanedExecutorWorkspace({
      goalId: projection.goalId, taskId, attempt, originRoot: cwd, stateRoot: root,
    });
    const required = taskActionState(projection, taskId).requiredNextAction;
    if (inventory.kind === "none" && required?.tool === "goal_dispatch") {
      return { tool: required.tool, params: { goal_id: projection.goalId, ...required.params } };
    }
  }
  for (const [taskId] of projection.tasks) {
    const attempt = nextDispatchAttempt(projection, taskId);
    if (attempt !== null) {
      const inventory = inspectOrphanedExecutorWorkspace({
        goalId: projection.goalId, taskId, attempt, originRoot: cwd, stateRoot: root,
      });
      if (inventory.kind !== "none") continue;
    }
    const required = taskActionState(projection, taskId).requiredNextAction;
    if (required) return { tool: required.tool, params: { goal_id: projection.goalId, ...required.params } };
  }
  for (const [taskId, task] of projection.tasks) {
    if (task.status === "pending" && task.deps.some((depId) => projection.tasks.get(depId)?.status === "superseded")) {
      return { tool: "goal_amend", params: { goal_id: projection.goalId, operation: "patch_active", task_id: taskId } };
    }
  }
  return null;
}

function statusResponse(projection, cwd, root, { machineAction = null, actionToken = null } = {}) {
  const progress = goalProgress(projection);
  const orphanInventories = new Map();
  for (const [taskId] of projection.tasks) {
    const attempt = nextDispatchAttempt(projection, taskId);
    if (attempt !== null) {
      orphanInventories.set(taskId, inspectOrphanedExecutorWorkspace({
        goalId: projection.goalId, taskId, attempt, originRoot: cwd, stateRoot: root,
      }));
    }
  }
  const blockedTaskIds = new Set([...orphanInventories].filter(([, inventory]) => inventory.kind !== "none").map(([taskId]) => taskId));
  const runnable = runnableFrontier(projection, { blockedTaskIds });
  return JSON.stringify({
    goalId: projection.goalId,
    lifecycle: projection.lifecycle,
    epoch: projection.epoch,
    completionHistory: projection.completionHistory,
    coordinationState: projection.coordinationState,
    continuity: projection.continuity,
    machineAction,
    action_token: actionToken,
    objective: projection.objective,
    scope: projection.scope,
    nonGoals: projection.nonGoals,
    dod: projection.dod,
    progress,
    runnable,
    nextAction: projection.nextAction,
    checkpointCount: projection.checkpointCount,
    tasks: Object.fromEntries([...projection.tasks].map(([id, t]) => {
      const inventory = orphanInventories.get(id);
      const actionState = inventory && inventory.kind !== "none"
        ? orphanWorkspaceActionState(id, inventory)
        : taskActionState(projection, id);
      return [id, {
        description: t.description,
        status: t.status,
        deps: t.deps,
        writePaths: t.writePaths,
        acceptance: t.acceptance,
        workflow: t.workflow,
        evidence_count: t.evidence.length,
        attempts: t.attempts,
        contractHash: t.contractHash,
        ...(Object.hasOwn(t, "executorBinding") ? { executorBinding: t.executorBinding ? { ...t.executorBinding } : null } : {}),
        workspace: t.workspace ? { ...t.workspace } : null,
        allowedActions: actionState.allowedActions,
        requiredNextAction: actionState.requiredNextAction,
        blockingReason: actionState.blockingReason,
      }];
    })),
  }, null, 2);
}

function validateSchema(schema, value, path = "goal_amend") {
  if (schema.anyOf) {
    if (!schema.anyOf.some((branch) => { try { validateSchema(branch, value, path); return true; } catch { return false; } })) throw new Error(`${path} schema invalid operation or unknown field shape`);
    return;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} schema expected object`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${path} schema missing ${key}`);
    if (schema.minProperties && Object.keys(value).length < schema.minProperties) throw new Error(`${path} schema requires properties`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (Object.hasOwn(value, key)) validateSchema(child, value[key], `${path}.${key}`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties || {}, key)) throw new Error(`${path} schema additional property ${key}`);
    if (typeof schema.additionalProperties === "object") for (const [key, child] of Object.entries(value)) if (!Object.hasOwn(schema.properties || {}, key)) validateSchema(schema.additionalProperties, child, `${path}.${key}`);
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} schema expected array`);
    for (const item of value) validateSchema(schema.items, item, `${path}[]`);
  } else if (schema.type === "string" && typeof value !== "string") throw new Error(`${path} schema expected string`);
  else if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`${path} schema expected integer`);
  if (schema.const !== undefined && value !== schema.const) throw new Error(`${path} schema invalid const`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} schema invalid enum`);
}

const string = { type: "string" };
const criterionSchema = {
  type: "object",
  properties: {
    id: string,
    statement: string,
    evidenceKinds: { type: "array", items: { type: "string", enum: ["changed-files", "tests", "command", "manual-review"] } },
  },
  required: ["id", "statement", "evidenceKinds"],
  additionalProperties: false,
};
const acceptanceSchema = { type: "object", properties: { criteria: { type: "array", items: criterionSchema } }, required: ["criteria"], additionalProperties: false };
const taskSchema = { type: "object", properties: { id: string, description: string, deps: { type: "array", items: string }, writePaths: { type: "array", items: string }, acceptance: acceptanceSchema, workflow: { type: "string", enum: ["tdd", "existing-tests", "docs-only"] } }, required: ["id", "description", "writePaths", "acceptance"], additionalProperties: false };
const resolutionSchema = { type: "object", properties: { id: string, disposition: { type: "string", enum: ["tasked", "out_of_scope", "duplicate", "new_goal"] }, task_id: string, reason: string }, required: ["id", "disposition", "reason"], additionalProperties: false };
const updateTaskSchema = { type: "object", properties: { description: string, deps: { type: "array", items: string }, writePaths: { type: "array", items: string }, acceptance: acceptanceSchema, workflow: { type: "string", enum: ["tdd", "existing-tests", "docs-only"] } }, additionalProperties: false };
const executionChangeTaskSchema = { type: "object", properties: { id: string, description: string, deps: { type: "array", items: string }, writePaths: { type: "array", items: string }, acceptance: acceptanceSchema, workflow: { type: "string", enum: ["tdd", "existing-tests", "docs-only"] } }, required: ["id"], additionalProperties: false };
const goalAmendSchema = { type: "object", anyOf: [
  { type: "object", properties: { goal_id: string, operation: { type: "string", const: "patch_active" }, reason: string, action_token: string, add_tasks: { type: "array", items: taskSchema }, remove_tasks: { type: "array", items: string }, update_tasks: { type: "object", additionalProperties: updateTaskSchema } }, required: ["operation", "reason", "action_token"], additionalProperties: false },
  { type: "object", properties: { goal_id: string, operation: { type: "string", const: "resolve_blocked" }, reason: string, action_token: string, blocked_resolution: { type: "string", enum: ["retry", "supersede"] }, blocked_task_id: string, replacement_task_id: string, add_tasks: { type: "array", items: taskSchema }, remove_tasks: { type: "array", items: string }, update_tasks: { type: "object", additionalProperties: updateTaskSchema } }, required: ["operation", "reason", "action_token", "blocked_resolution", "blocked_task_id"], additionalProperties: false },
  { type: "object", properties: { goal_id: string, operation: { type: "string", const: "triage" }, reason: string, action_token: string, resolve_discoveries: { type: "array", items: resolutionSchema } }, required: ["operation", "reason", "action_token", "resolve_discoveries"], additionalProperties: false },
  { type: "object", properties: { goal_id: string, operation: { type: "string", const: "reopen_completed" }, reason: string, action_token: string, basis: { type: "object", properties: { epoch: { type: "integer" }, discovery_ids: { type: "array", items: string } }, required: ["epoch"], additionalProperties: false }, resolve_discoveries: { type: "array", items: resolutionSchema }, add_tasks: { type: "array", items: taskSchema } }, required: ["operation", "reason", "action_token", "basis", "resolve_discoveries", "add_tasks"], additionalProperties: false },
  { type: "object", properties: { goal_id: string, operation: { type: "string", const: "detach_session" }, reason: string, action_token: string, session_id: string }, required: ["operation", "reason", "action_token"], additionalProperties: false },
  { type: "object", properties: { goal_id: string, operation: { type: "string", const: "propose_update_goal" }, reason: string, changes: { type: "object", properties: { objective: string, scope: { type: "array", items: string }, non_goals: { type: "array", items: string }, dod: { type: "array", items: string } }, additionalProperties: false, minProperties: 1 } }, required: ["operation", "reason", "changes"], additionalProperties: false },
  { type: "object", properties: { goal_id: string, operation: { type: "string", const: "update_goal" }, challenge_id: string, action_token: string }, required: ["operation", "challenge_id", "action_token"], additionalProperties: false },
  { type: "object", properties: { goal_id: string, operation: { type: "string", const: "propose_transfer_session" }, reason: string }, required: ["goal_id", "operation", "reason"], additionalProperties: false },
  { type: "object", properties: { goal_id: string, operation: { type: "string", const: "transfer_session" }, challenge_id: string, reason: string, action_token: string }, required: ["goal_id", "operation", "challenge_id", "reason", "action_token"], additionalProperties: false },
  { type: "object", properties: { goal_id: string, operation: { type: "string", const: "propose_execution_change" }, reason: string, changes: { type: "object", properties: { update_tasks: { type: "array", items: executionChangeTaskSchema } }, required: ["update_tasks"], additionalProperties: false } }, required: ["goal_id", "operation", "reason", "changes"], additionalProperties: false },
  { type: "object", properties: { goal_id: string, operation: { type: "string", const: "resume_runtime" }, action_token: string }, required: ["operation", "action_token"], additionalProperties: false },
] };

export function createGoalEngineExtension(pi, options = {}) {
  const store = options.store || {};
  const appendEventFn = options.appendEvent || store.appendEvent || appendEvent;
  const appendEventBatchFn = options.appendEventBatch || store.appendEventBatch
    || (options.appendEvent || store.appendEvent
      ? (root, events, version) => events.reduce((projection, event) => appendEventFn(root, event, projection.version), { version })
      : appendEventBatch);
  const loadProjectionFn = store.loadProjection || loadProjection;
  const listGoalsFn = store.listGoals || listGoals;
  const listGoalIdsFn = store.listGoalIds || listGoalIds;
  // Runtime authority is Host-owned: callers never supply registries, snapshots, or run facts.
  const runtimeHost = options.runtimeHost || null;
  // Host-only entropy; callers cannot pass a capability nonce through tools.
  const runtimeNonceFactory = typeof runtimeHost?.nonceFactory === "function" ? runtimeHost.nonceFactory : () => randomBytes(32);
  const amendmentNonceFactory = typeof runtimeHost?.amendmentNonceFactory === "function" ? runtimeHost.amendmentNonceFactory : runtimeNonceFactory;
  const goalStateEnv = options.goalStateEnv ?? process.env;
  const executionScopeFor = (ctx, { operation = "read", goalId } = {}) => {
    const legacyScope = executionScope(ctx);
    let resolvedStateScope;
    try {
      resolvedStateScope = resolveGoalStateScope({ cwd: legacyScope.cwd, env: goalStateEnv });
    } catch (error) {
      if (["ENOENT", "EACCES", "ELOOP", "ENOTDIR"].includes(error?.code)) {
        throw preflightError(
          "GIT_INFRASTRUCTURE_ERROR",
          `cwd realpath could not be read: ${legacyScope.cwd}`,
          operation === "init"
            ? "repair filesystem access and retry goal_init"
            : "restore filesystem access to ExtensionContext.cwd and retry the typed Goal operation",
        );
      }
      throw error;
    }
    const stateScope = {
      ...resolvedStateScope,
      legacyRoot: legacyScope.root,
    };
    const selected = selectGoalStateRoot(stateScope, {
      operation,
      goalId,
      listActive: listGoalsFn,
      hasGoal: (root, candidateGoalId) => Boolean(loadProjectionFn(root, candidateGoalId)),
    });
    if (selected.storage === "global" && operation !== "init" && listGoalIdsFn(selected.root).length > 0) {
      ensureGoalStateIdentity(stateScope);
    }
    return { cwd: legacyScope.cwd, root: selected.root, storage: selected.storage, stateScope };
  };
  const enforceActionTokens = options.enforceActionTokens !== false;
  const legacyEventSchemaVersion = enforceActionTokens ? CURRENT_EVENT_VERSION : LEGACY_EVENT_VERSION;
  const makeGoalEvent = (type, data, goalId, projection = null) => {
    if (type !== "goal.created" && !projection) throw new Error(`projection is required to write ${type}`);
    return makeEvent(type, data, goalId, schemaVersionForMutation(projection, legacyEventSchemaVersion));
  };
  const inspectExecutorWorkspaceFn = options.inspectExecutorWorkspace || inspectExecutorWorkspace;
  const inspectExecutorProofFn = options.inspectExecutorProof || ((runId) => inspectRootBrokerExecutorProof(pi, runId));
  const beforePreservedWorkspaceCleanupBarrier = options.beforePreservedWorkspaceCleanupBarrier;
  const inspectOrphanedExecutorWorkspaceBarrier = options.inspectOrphanedExecutorWorkspaceBarrier;
  const betweenOrphanInventoriesBarrier = options.betweenOrphanInventoriesBarrier;
  const activeLeases = new Map();
  let turnsSinceSettle = 0;
  let pendingInput = null;
  let recoveryLatch = null;
  const abortSignals = new WeakSet();
  const metadataChallenges = new Map();
  const orphanChallenges = new Map();
  const transferChallenges = new Map();
  const runtimeChallenges = new Map();
  const runtimeIntentGates = new Map();
  pi.__goalRuntimeIntentGate = (ctx, params = {}) => {
    let sessionId; try { sessionId = sessionIdentity(ctx); } catch { return false; }
    // A pending intent is authority for exactly its owner and goal, never a
    // same-session blanket lock over unrelated Goals.
    return [...runtimeIntentGates.values()].some((gate) => gate.sessionId === sessionId && (!params.goal_id || gate.goalId === params.goal_id));
  };
  const persistMetadata = (type, data) => {
    if (typeof pi.appendEntry !== "function") throw new Error(`Cannot persist ${type}: pi.appendEntry is unavailable`);
    pi.appendEntry(type, data);
  };
  // Pi custom entries are untrusted recovery input. Runtime authority is only
  // reconstructed from the exact shapes emitted below, never by object merge.
  const exactPlainObject = (value, fields) => value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0
    && Object.getOwnPropertyNames(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
  const nonEmptyString = (value) => typeof value === "string" && value.trim() === value && value.length > 0;
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const canonicalHash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
  const finalReviewProvider = options.finalReviewProvider;
  const finalIntentType = "goal-engine-final-review-approval-intent";
  const finalIntentFields = ["protocol", "goalId", "manifestHash", "stateHash", "worldHash", "head", "sessionId", "choices"];
  const finalIntent = (manifest, sessionId) => ({ protocol: "goal-engine-final-review-approval-intent.v1", goalId: manifest.goalId, manifestHash: manifest.manifestHash, stateHash: manifest.stateHash, worldHash: manifest.worldHash, head: manifest.head, sessionId, choices: ["approve", "reject"] });
  const exactFinalIntent = (entry, goalId, sessionId) => entry?.type === "custom" && entry.customType === finalIntentType
    && exactPlainObject(entry.data, finalIntentFields) && entry.data.protocol === "goal-engine-final-review-approval-intent.v1"
    && entry.data.goalId === goalId && entry.data.sessionId === sessionId && Array.isArray(entry.data.choices)
    && entry.data.choices.length === 2 && entry.data.choices[0] === "approve" && entry.data.choices[1] === "reject"
    && /^[a-f0-9]{64}$/.test(entry.data.manifestHash) && /^[a-f0-9]{64}$/.test(entry.data.stateHash)
    && /^[a-f0-9]{64}$/.test(entry.data.worldHash) && /^[a-f0-9]{40}$/.test(entry.data.head);
  const finalApprovalPair = (goalId, sessionId, manifest, ctx) => {
    const branch = ctx?.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return null;
    const matches = branch.filter((entry) => exactFinalIntent(entry, goalId, sessionId)
      && entry.data.manifestHash === manifest.manifestHash && entry.data.stateHash === manifest.stateHash
      && entry.data.worldHash === manifest.worldHash && entry.data.head === manifest.head);
    if (!matches.length) return null;
    const byId = new Map(branch.map((entry) => [entry.id, entry]));
    const validIntent = (intent) => nonEmptyString(intent.id) && validTimestamp(intent.timestamp);
    const validMessage = (message) => exactPlainObject(message, ["id", "parentId", "timestamp", "type", "message"])
      && message.type === "message" && exactPlainObject(message.message, ["role", "content"])
      && message.message.role === "user" && ["approve", "reject"].includes(message.message.content)
      && nonEmptyString(message.id) && validTimestamp(message.timestamp);
    const pairFor = (intent) => {
      const child = branch.find((entry) => entry.parentId === intent.id);
      if (!child) return { kind: "pending" };
      const message = child.type === "compaction" ? branch.find((entry) => entry.parentId === child.id) : child;
      if (!message || !validMessage(message) || Date.parse(message.timestamp) <= Date.parse(intent.timestamp)) return { kind: "invalid" };
      if (message.parentId === intent.id) return { kind: "terminal", intent, message, choice: message.message.content };
      const compact = byId.get(message.parentId);
      if (!exactPlainObject(compact, ["id", "parentId", "timestamp", "type", "summary", "firstKeptEntryId", "tokensBefore"])
        || compact.type !== "compaction" || compact.parentId !== intent.id || !nonEmptyString(compact.id)
        || !validTimestamp(compact.timestamp) || !nonEmptyString(compact.summary) || compact.firstKeptEntryId !== intent.id
        || !Number.isSafeInteger(compact.tokensBefore) || compact.tokensBefore < 0
        || Date.parse(compact.timestamp) <= Date.parse(intent.timestamp) || Date.parse(message.timestamp) <= Date.parse(compact.timestamp)) return { kind: "invalid" };
      return { kind: "terminal", intent, message, choice: message.message.content };
    };
    const classified = matches.map((intent) => validIntent(intent) ? pairFor(intent) : { kind: "invalid" });
    const latest = classified.at(-1);
    // An old matching request may only be retained when it has a complete,
    // valid terminal decision.  This prevents ambiguous duplicate pendings.
    if (!latest || latest.kind === "invalid" || classified.slice(0, -1).some((entry) => entry.kind !== "terminal")) return null;
    return latest.kind === "terminal" ? latest : null;
  };
  const repairNow = () => {
    try {
      const value = typeof runtimeHost?.clock === "function" ? runtimeHost.clock()
        : typeof runtimeHost?.now === "function" ? runtimeHost.now() : Date.now();
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch { return null; }
  };
  const repairTaskDef = (condition) => ({
    description: `Remediate condition ${condition.id}: ${condition.statement}`,
    deps: [], writePaths: [...condition.remediation.allowed_paths],
    acceptance: { criteria: [{ id: condition.id, statement: `Condition ${condition.id} expected: ${condition.expected}`, evidenceKinds: ["tests"] }] }, workflow: "tdd",
  });
  const validTimestamp = (value) => nonEmptyString(value) && !Number.isNaN(Date.parse(value));
  const runtimeProposalHash = ({ goalId, proposalId, executionContractHash, baseHead, sessionId }) => createHash("sha256")
    .update(JSON.stringify({ baseHead, executionContractHash, goalId, proposalId, sessionId })).digest("hex");
  // Observation authority is deliberately assembled here, rather than exposed
  // through tool parameters. Store and CurrentWorld remain Extension-owned.
  const observationHostAvailable = () => runtimeHost?.adapterRegistry
    && typeof runtimeHost.artifactRefForRun === "function";
  const canonicalManagedReceipt = (value, root) => {
    const fields = ["id", "stateRoot", "receiptPath", "workspacePath", "phase", "terminal", "recorded", "recordCount", "cleanupDebt"];
    if (!exactPlainObject(value, fields) || typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.id) || !isAbsolute(value.stateRoot) || !isAbsolute(value.receiptPath) || !(value.workspacePath === null || (typeof value.workspacePath === "string" && isAbsolute(value.workspacePath)))) throw Error("invalid managed public receipt");
    const stateRoot = resolve(value.stateRoot), expectedRoot = resolve(root);
    const badWorkspace = value.workspacePath !== null && !resolve(value.workspacePath).startsWith(`${expectedRoot}/`);
    if (stateRoot !== expectedRoot || value.receiptPath !== join(stateRoot, "managed-validations", `${value.id}.json`) || badWorkspace) throw Error("managed receipt identity conflict");
    return value;
  };
  const observationServices = (goalId, cwd, root, world) => ({
    adapterRegistry: runtimeHost.adapterRegistry,
    originRoot: cwd,
    stateRoot: root,
    integratedHead: world.repo?.head || world.head,
    loadProjection: async () => loadProjectionFn(root, goalId),
    persistEvent: async ({ type, data }) => {
      const current = loadProjectionFn(root, goalId);
      const recordEvent = makeEvent(type, data, goalId, "goal-runtime.v1");
      // A failed product observation must not become durable without its repair
      // ownership. Build the repair plan only from the event-sourced ledger,
      // then commit the complete sequence through the Store batch boundary.
      if (type === "condition.observation_recorded") {
        const recorded = applyEvent(current, recordEvent);
        const run = recorded.observationRuns.get(data.runId);
        if (run?.cycle >= 1 && data.verdict?.kind === "failed") {
          const findingPlan = deriveFindingFromFailedEvidence({ projection: recorded, runId: data.runId, evidenceId: data.evidenceId });
          const findingEvents = findingPlan.events.map(({ type: eventType, data: eventData }) => makeEvent(eventType, eventData, goalId, "goal-runtime.v1"));
          const withFinding = findingEvents.reduce((projection, event) => applyEvent(projection, event), recorded);
          const episodePlan = findingPlan.finding.episodeId === null
            ? openRepairEpisode({ projection: withFinding, findingIds: [findingPlan.finding.findingId] })
            : { events: [] };
          const episodeEvents = episodePlan.events.map(({ type: eventType, data: eventData }) => makeEvent(eventType, eventData, goalId, "goal-runtime.v1"));
          appendEventBatchFn(root, [recordEvent, ...findingEvents, ...episodeEvents], current.version);
          return;
        }
        const episode = [...recorded.repairEpisodes.values()].find(candidate => candidate?.status === "reverifying" && candidate.ownedRunIds?.includes(data.runId));
        if (episode) {
          const resolution = repairEpisodeTransition({ projection: recorded, episodeId: episode.episodeId, event: { type, conditionId: run?.conditionId, runId: data.runId, evidenceId: data.evidenceId }, worldSnapshot: world });
          const resolutionEvents = resolution.events.map(({ type: eventType, data: eventData }) => makeEvent(eventType, eventData, goalId, "goal-runtime.v1"));
          if (resolutionEvents.length) {
            try { appendEventBatchFn(root, [recordEvent, ...resolutionEvents], current.version); }
            catch (cause) {
              const recovered = loadProjectionFn(root, goalId);
              const resolvedEpisode = recovered?.repairEpisodes.get(episode.episodeId);
              const resolution = resolvedEpisode?.resolution;
              if (recovered?.observationRuns.get(data.runId)?.phase !== "recorded" || recovered.observationRuns.get(data.runId)?.evidenceId !== data.evidenceId || resolvedEpisode?.status !== "resolved" || resolution?.runId !== data.runId || resolution?.evidenceId !== data.evidenceId || resolution?.supportingEvidenceRefs?.at(-1)?.runId !== data.runId || resolution?.supportingEvidenceRefs?.at(-1)?.evidenceId !== data.evidenceId) throw cause;
            }
            return;
          }
        }
      }
      try { appendEventFn(root, recordEvent, current.version); }
      catch (cause) {
        const recovered = loadProjectionFn(root, goalId)?.observationRuns.get(data.runId);
        if (recovered?.phase !== "recorded" || recovered.evidenceId !== data.evidenceId) throw cause;
      }
    },
    prepareManagedValidation(input) { return canonicalManagedReceipt((runtimeHost.prepareManagedValidation || prepareManagedValidation)(input), root); },
    ...(typeof runtimeHost.startManagedValidation === "function" ? { startManagedValidation: runtimeHost.startManagedValidation } : {}),
    ...(typeof runtimeHost.inspectManagedValidation === "function" ? { inspectManagedValidation: runtimeHost.inspectManagedValidation } : {}),
    ...(typeof runtimeHost.recoverManagedValidation === "function" ? { recoverManagedValidation: runtimeHost.recoverManagedValidation } : {}),
    ...(typeof runtimeHost.releaseManagedValidation === "function" ? { releaseManagedValidation: runtimeHost.releaseManagedValidation } : {}),
  });
  const observationReceiptForRun = (projection, run) => {
    const condition = projection.conditions.get(run.conditionId);
    const adapter = condition && hostObservationAdapter(runtimeHost.adapterRegistry, condition.definition.oracle_ref);
    if (!condition || !Number.isSafeInteger(run.cycle) || run.cycle < 0 || (projection.runtimeState === "calibrating" ? run.cycle !== 0 : projection.runtimeState === "active" && run.cycle < 1) || !/^[a-f0-9]{40}$/.test(run.head || "") || !/^[a-f0-9]{64}$/.test(run.worldSnapshotHash || "") || !/^[a-f0-9]{64}$/.test(run.resourceClaimsHash || "") || !Number.isSafeInteger(run.executionRevision) || !/^[a-f0-9]{64}$/.test(run.executionContractHash || "") || !/^[a-f0-9]{64}$/.test(run.conditionHash || "") || !run.adapter || run.executionRevision !== projection.executionRevision || run.executionContractHash !== projection.executionContractHash || run.conditionHash !== condition.conditionHash || run.adapter.ref !== condition.definition.oracle_ref || run.adapter.ref !== adapter?.ref || run.adapter.version !== adapter?.version || canonicalHash(adapter?.resourceClaims) !== run.resourceClaimsHash) throw Error("observation run identity conflict");
    return {
      schema: "dispatch-ir.v1.observation-receipt", runId: run.runId, conditionId: run.conditionId,
      cycle: run.cycle, goalId: projection.goalId, head: run.head, executionRevision: run.executionRevision,
      executionContractHash: run.executionContractHash, conditionHash: run.conditionHash,
      worldSnapshotHash: run.worldSnapshotHash, resourceClaimsHash: run.resourceClaimsHash,
      adapter: { ref: run.adapter.ref, version: run.adapter.version }, phase: run.phase,
      managedReceipt: null, terminal: null, recorded: run.evidenceId ? { evidenceId: run.evidenceId } : null,
      cleanupDebt: run.phase === "cleanup_debt",
    };
  };
  const calibrationStep = async ({ projection, goalId, cwd, root, world }) => {
    if (!observationHostAvailable()) return { attention: ["RUNTIME_OBSERVATION_HOST_UNAVAILABLE"] };
    const services = observationServices(goalId, cwd, root, world);
    let selected = null;
    for (const [conditionId] of projection.conditions) {
      const runs = [...projection.observationRuns.values()].filter((run) => run.conditionId === conditionId && run.cycle === 0);
      const latest = runs.at(-1);
      if (!latest || !["released"].includes(latest.phase)) { selected = { conditionId, run: latest }; break; }
    }
    const head = world.repo?.head || world.head;
    if (typeof head !== "string" || !/^[a-f0-9]{40}$/.test(head) || head !== projection.runtimeBaseHead) return { attention: ["RUNTIME_CALIBRATION_MANAGED_ATTENTION"] };
    if (!selected) {
      const ready = [...projection.conditions.keys()].every((conditionId) => {
        const run = [...projection.observationRuns.values()].filter((value) => value.conditionId === conditionId && value.cycle === 0).at(-1);
        const evidence = run?.evidenceId && projection.evidenceHistory.find((value) => value.evidenceId === run.evidenceId);
        return run && ["recorded", "released"].includes(run.phase) && ["passed", "failed"].includes(evidence?.verdict?.kind);
      });
      if (!ready) return { attention: ["RUNTIME_CALIBRATION_BLOCKED"] };
      const current = loadProjectionFn(root, goalId);
      appendEventFn(root, makeEvent("goal.runtime_activated", {}, goalId, "goal-runtime.v1"), current.version);
      return { activated: true };
    }
    try {
      if (!selected.run) {
        // A requested run is durable recovery authority before any managed
        // allocation. Receipt validation and allocation occur on the next
        // status through startObservation's Extension-owned prepare wrapper.
        const requested = requestObservation({ projection, conditionId: selected.conditionId, cycle: 0, worldSnapshot: world, services });
        await services.persistEvent(requested.event);
        return { step: "request" };
      }
      if (selected.run.phase === "cleanup_debt") return { attention: ["RUNTIME_CALIBRATION_CLEANUP_DEBT"] };
      let receipt = observationReceiptForRun(projection, selected.run);
      if (["requested", "lease_allocated", "process_bound"].includes(selected.run.phase)) {
        if (selected.run.phase !== "requested") {
          const condition = projection.conditions.get(selected.conditionId);
          const adapter = hostObservationAdapter(runtimeHost.adapterRegistry, condition.definition.oracle_ref);
          const prepared = services.prepareManagedValidation({ ownerKind: "goal-observation", ownerId: receipt.runId, originRoot: cwd, stateRoot: root, integratedHead: head, plan: adapter.validationPlan, resourceClaims: adapter.resourceClaims });
          if (prepared.id !== selected.run.allocationId) return { attention: ["RUNTIME_CALIBRATION_MANAGED_ATTENTION"] };
          receipt = { ...receipt, managedReceipt: prepared };
        }
        const result = selected.run.phase === "requested"
          ? await startObservation(receipt, services)
          : await recoverObservation(receipt, services);
        return result.status === "attention" || result.status === "blocked" ? { attention: ["RUNTIME_CALIBRATION_MANAGED_ATTENTION"] } : { step: "start_or_recover" };
      }
      if (selected.run.phase === "terminal") {
        const condition = projection.conditions.get(selected.conditionId);
        const adapter = hostObservationAdapter(runtimeHost.adapterRegistry, condition.definition.oracle_ref);
        const prepared = services.prepareManagedValidation({ ownerKind: "goal-observation", ownerId: receipt.runId, originRoot: cwd, stateRoot: root, integratedHead: head, plan: adapter.validationPlan, resourceClaims: adapter.resourceClaims });
        if (prepared.id !== selected.run.allocationId) return { attention: ["RUNTIME_CALIBRATION_MANAGED_ATTENTION"] };
        receipt = { ...receipt, managedReceipt: prepared };
        const recovered = await recoverObservation(receipt, services);
        if (recovered.phase === "cleanup_debt" || recovered.status === "attention") return { attention: ["RUNTIME_CALIBRATION_MANAGED_ATTENTION"] };
        const artifactRef = await runtimeHost.artifactRefForRun({ goalId, runId: selected.run.runId, managedTerminal: recovered.runReceipt?.terminal || recovered.terminal });
        const result = await recordObservation({ projection: loadProjectionFn(root, goalId), runReceipt: recovered.runReceipt || recovered, artifactRef, worldSnapshot: world, services });
        return result.blocked ? { attention: ["RUNTIME_CALIBRATION_INDETERMINATE"] } : { step: "record" };
      }
      if (selected.run.phase === "recorded") {
        // Projection deliberately stores no private terminal body. Recreate the
        // deterministic managed receipt before handing release to the runner.
        const condition = projection.conditions.get(selected.conditionId);
        const adapter = hostObservationAdapter(runtimeHost.adapterRegistry, condition.definition.oracle_ref);
        const prepared = services.prepareManagedValidation({ ownerKind: "goal-observation", ownerId: receipt.runId, originRoot: cwd, stateRoot: root, integratedHead: head, plan: adapter.validationPlan, resourceClaims: adapter.resourceClaims });
        if (prepared.id !== selected.run.allocationId) return { attention: ["RUNTIME_CALIBRATION_MANAGED_ATTENTION"] };
        receipt = { ...receipt, managedReceipt: prepared };
        const result = await releaseObservation({ ...receipt, phase: "recorded", recorded: { evidenceId: selected.run.evidenceId } }, services);
        return result.status === "attention" ? { attention: ["RUNTIME_CALIBRATION_CLEANUP_DEBT"] } : { step: "release" };
      }
      return { attention: ["RUNTIME_CALIBRATION_MANAGED_ATTENTION"] };
    } catch { return { attention: ["RUNTIME_CALIBRATION_MANAGED_ATTENTION"] }; }
  };
  const activeObservationInventory = (projection) => {
    const claims = {};
    try {
      for (const [conditionId, condition] of projection.conditions) {
        claims[conditionId] = hostObservationAdapter(runtimeHost.adapterRegistry, condition.definition.oracle_ref).resourceClaims;
      }
      return { claims };
    } catch { return null; }
  };
  const activeObservationStep = async ({ projection, goalId, cwd, root, world, selected }) => {
    if (!observationHostAvailable()) return { attention: ["RUNTIME_OBSERVATION_HOST_UNAVAILABLE"] };
    const services = observationServices(goalId, cwd, root, world);
    try {
      if (selected.tool === "request_observation") {
        const requested = requestObservation({ projection, conditionId: selected.params.condition_id, cycle: selected.params.cycle, worldSnapshot: world, services });
        await services.persistEvent(requested.event);
        return { step: "request" };
      }
      if (!new Set(["observation_start", "observation_recover", "record_observation", "release_observation"]).has(selected.tool)) return { attention: ["R10A3_OBSERVATION_ACTION_UNAVAILABLE"] };
      const run = projection.observationRuns.get(selected.params.run_id);
      if (!run) return { attention: ["R10A3_OBSERVATION_MANAGED_ATTENTION"] };
      let receipt = observationReceiptForRun(projection, run);
      if ((world.repo?.head || world.head) !== receipt.head) throw Error("observation HEAD drift");
      const prepare = () => {
        const condition = projection.conditions.get(run.conditionId);
        const adapter = hostObservationAdapter(runtimeHost.adapterRegistry, condition.definition.oracle_ref);
        const managedReceipt = services.prepareManagedValidation({ ownerKind: "goal-observation", ownerId: receipt.runId, originRoot: cwd, stateRoot: root, integratedHead: world.repo?.head || world.head, plan: adapter.validationPlan, resourceClaims: adapter.resourceClaims });
        if (run.allocationId && managedReceipt.id !== run.allocationId) throw Error("managed allocation identity conflict");
        receipt = { ...receipt, managedReceipt };
      };
      if (selected.tool === "observation_start") {
        if (run.phase === "requested") {
          const result = await startObservation(receipt, services);
          return result.status === "attention" || result.status === "blocked" ? { attention: ["R10A3_OBSERVATION_MANAGED_ATTENTION"] } : { step: "start" };
        }
        if (run.phase !== "lease_allocated") return { attention: ["R10A3_OBSERVATION_MANAGED_ATTENTION"] };
        prepare();
        const result = await recoverObservation(receipt, services);
        return result.status === "attention" || result.status === "blocked" || result.phase === "cleanup_debt" ? { attention: ["R10A3_OBSERVATION_MANAGED_ATTENTION"] } : { step: "recover" };
      }
      prepare();
      if (selected.tool === "observation_recover") {
        const result = await recoverObservation(receipt, services);
        return result.status === "attention" || result.status === "blocked" || result.phase === "cleanup_debt" ? { attention: ["R10A3_OBSERVATION_MANAGED_ATTENTION"] } : { step: "recover" };
      }
      if (selected.tool === "record_observation") {
        const recovered = await recoverObservation(receipt, services);
        if (recovered.phase === "cleanup_debt" || recovered.status === "attention") return { attention: ["R10A3_OBSERVATION_MANAGED_ATTENTION"] };
        const artifactRef = await runtimeHost.artifactRefForRun({ goalId, runId: run.runId, managedTerminal: recovered.runReceipt?.terminal || recovered.terminal });
        const result = await recordObservation({ projection: loadProjectionFn(root, goalId), runReceipt: recovered.runReceipt || recovered, artifactRef, worldSnapshot: world, services });
        if (result.verdict?.kind === "failed") return { attention: ["R10A3_REPAIR_REQUIRED"] };
        return result.blocked ? { attention: ["R10A3_OBSERVATION_BLOCKED"] } : { step: "record" };
      }
      const result = await releaseObservation({ ...receipt, phase: "recorded", recorded: { evidenceId: run.evidenceId } }, services);
      return result.status === "attention" ? { attention: ["R10A3_OBSERVATION_MANAGED_ATTENTION"] } : { step: "release" };
    } catch { return { attention: ["R10A3_OBSERVATION_MANAGED_ATTENTION"] }; }
  };
  const isRuntimeChallenge = (data) => {
    const fields = ["id", "kind", "choices", "requestedAt", "goalId", "contractHash", "baseHead", "sessionId", "proposalId", "executionContractHash", "proposalHash"];
    return exactPlainObject(data, fields) && data.kind === "runtime_activation_approval"
      && Array.isArray(data.choices) && data.choices.length === 2 && data.choices[0] === "approve" && data.choices[1] === "reject"
      && [data.id, data.goalId, data.sessionId, data.proposalId].every(nonEmptyString)
      && validTimestamp(data.requestedAt) && /^[a-f0-9]{64}$/.test(data.contractHash)
      && /^[a-f0-9]{64}$/.test(data.executionContractHash) && /^[a-f0-9]{64}$/.test(data.proposalHash)
      && /^[a-f0-9]{40}$/.test(data.baseHead) && data.executionContractHash === data.contractHash
      && data.proposalHash === runtimeProposalHash(data);
  };
  const isRuntimeDecision = (data, challenge) => {
    const fields = ["id", "challengeId", "kind", "choice", "goalId", "contractHash", "baseHead", "proposalId", "userEntryId", "sessionId", "source", "proposalHash", "receiptId"];
    return exactPlainObject(data, fields) && data.id === challenge.id && data.challengeId === challenge.id
      && data.kind === "runtime_activation_approval" && ["approve", "reject"].includes(data.choice)
      && [data.userEntryId, data.receiptId].every(nonEmptyString) && ["interactive", "rpc"].includes(data.source)
      && data.goalId === challenge.goalId && data.contractHash === challenge.contractHash && data.baseHead === challenge.baseHead
      && data.sessionId === challenge.sessionId && data.proposalId === challenge.proposalId && data.proposalHash === challenge.proposalHash;
  };
  const isRuntimeIntent = (data) => exactPlainObject(data, ["protocol", "challengeId", "goalId", "proposalId", "contractHash", "baseHead", "sessionId", "choice", "source", "proposalHash"])
    && data.protocol === "goal-engine-runtime-approval-intent.v1"
    && [data.challengeId, data.goalId, data.proposalId, data.sessionId, data.proposalHash].every(nonEmptyString)
    && ["approve", "reject"].includes(data.choice) && ["interactive", "rpc"].includes(data.source)
    && /^[a-f0-9]{64}$/.test(data.contractHash) && /^[a-f0-9]{64}$/.test(data.proposalHash) && /^[a-f0-9]{40}$/.test(data.baseHead);
  const strictApprovalCompaction = (intent, middle, message) => middle?.type !== "compaction" || !(middle.fromHook === true || !nonEmptyString(middle.id) || !validTimestamp(middle.timestamp) || !nonEmptyString(middle.summary) || !nonEmptyString(middle.firstKeptEntryId) || !Number.isSafeInteger(middle.tokensBefore) || middle.tokensBefore < 0 || middle.parentId !== intent.id || Date.parse(middle.timestamp) < Date.parse(intent.timestamp) || Date.parse(middle.timestamp) > Date.parse(message?.timestamp));
  const runtimeApprovalPair = (challenge, ctx) => {
    const branch = ctx.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return null;
    const intents = branch.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === "custom" && entry.customType === "goal-engine-runtime-approval-intent" && isRuntimeIntent(entry.data)
      && entry.data.challengeId === challenge.id && entry.data.goalId === challenge.goalId && entry.data.proposalId === challenge.proposalId && entry.data.contractHash === challenge.contractHash && entry.data.baseHead === challenge.baseHead && entry.data.sessionId === challenge.sessionId && entry.data.proposalHash === challenge.proposalHash);
    if (intents.length !== 1) return null;
    const { entry: intent, index } = intents[0];
    const middle = branch[index + 1];
    const message = middle?.type === "compaction" ? branch[index + 2] : middle;
    const content = message?.type === "message" && message.message?.role === "user" ? message.message.content : null;
    const text = typeof content === "string" ? content : Array.isArray(content) && content.length === 1 && content[0]?.type === "text" ? content[0].text : null;
    const compacted = middle?.type === "compaction";
    if (!nonEmptyString(intent.id) || !validTimestamp(intent.timestamp) || !strictApprovalCompaction(intent, middle, message) || (!compacted && message?.parentId !== intent.id) || !message || message.parentId !== (compacted ? middle.id : intent.id) || !nonEmptyString(message.id) || !validTimestamp(message.timestamp) || Date.parse(message.timestamp) <= Date.parse(challenge.requestedAt) || text !== intent.data.choice) return null;
    return { intent, message, choice: intent.data.choice };
  };
  const isAmendmentIntent = (data, proposal) => exactPlainObject(data, ["protocol", "proposalId", "proposalHash", "goalId", "ownerSessionId", "choice", "source"])
    && data.protocol === "goal-engine-execution-amendment-intent.v1" && ["approve", "reject"].includes(data.choice)
    && ["interactive", "rpc"].includes(data.source) && data.proposalId === proposal.proposalId && data.proposalHash === proposal.proposalHash
    && data.goalId === proposal.goalId && data.ownerSessionId === proposal.ownerSessionId;
  const amendmentApprovalPair = (proposal, ctx) => {
    const branch = ctx.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return null;
    const intents = branch.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry?.type === "custom" && entry.customType === "goal-engine-execution-amendment-intent" && isAmendmentIntent(entry.data, proposal));
    if (intents.length !== 1) return null;
    const { entry: intent, index } = intents[0], middle = branch[index + 1], compacted = middle?.type === "compaction", message = compacted ? branch[index + 2] : middle;
    const content = message?.message?.content, text = typeof content === "string" ? content : Array.isArray(content) && content.length === 1 && content[0]?.type === "text" ? content[0].text : null;
    if (!nonEmptyString(intent.id) || !validTimestamp(intent.timestamp) || !message || message.type !== "message" || message.message?.role !== "user" || message.images?.length || message.streamingBehavior !== undefined || !nonEmptyString(message.id) || !validTimestamp(message.timestamp) || text !== intent.data.choice || Date.parse(message.timestamp) <= Date.parse(intent.timestamp) || !strictApprovalCompaction(intent, middle, message) || message.parentId !== (compacted ? middle.id : intent.id)) return null;
    const identity = (entry) => ({ id: entry.id, parentId: entry.parentId ?? null, timestamp: entry.timestamp, message: entry.message });
    return { intent, message, choice: intent.data.choice, userEntryHash: canonicalHash(identity(message)), branchBindingHash: canonicalHash({ proposalHash: proposal.proposalHash, intent: identity(intent), compaction: compacted ? { id: middle.id, parentId: middle.parentId, timestamp: middle.timestamp, summary: middle.summary, firstKeptEntryId: middle.firstKeptEntryId, tokensBefore: middle.tokensBefore } : null, user: identity(message), choice: intent.data.choice, source: intent.data.source, sessionId: proposal.ownerSessionId }) };
  };
  const isRepairIntent = (data, challenge) => {
    const fields = ["protocol", "challengeId", "challengeHash", "goalId", "executionRevision", "executionContractHash", "baseHead", "episodeId", "conditionId", "findingIds", "subjectHash", "taskId", "taskDefHash", "sessionId", "choice", "source"];
    return exactPlainObject(data, fields) && data.protocol === "goal-engine-repair-approval-intent.v1"
      && ["approve", "reject"].includes(data.choice) && ["interactive", "rpc"].includes(data.source)
      && Array.isArray(data.findingIds) && JSON.stringify(data.findingIds) === JSON.stringify(challenge.findingIds)
      && ["challengeId", "challengeHash", "goalId", "executionRevision", "executionContractHash", "baseHead", "episodeId", "conditionId", "subjectHash", "taskId", "taskDefHash", "sessionId"].every((key) => data[key] === challenge[key]);
  };
  const repairApprovalPair = (challenge, ctx) => {
    const branch = ctx.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return null;
    const intents = branch.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry?.type === "custom" && entry.customType === "goal-engine-repair-approval-intent" && isRepairIntent(entry.data, challenge));
    if (intents.length !== 1) return null;
    const { entry: intent, index } = intents[0];
    const middle = branch[index + 1], compacted = middle?.type === "compaction", message = compacted ? branch[index + 2] : middle;
    const text = typeof message?.message?.content === "string" ? message.message.content : Array.isArray(message?.message?.content) && message.message.content.length === 1 && message.message.content[0]?.type === "text" ? message.message.content[0].text : null;
    if (!nonEmptyString(intent.id) || !validTimestamp(intent.timestamp) || !message || message.type !== "message" || message.message?.role !== "user" || !nonEmptyString(message.id) || !validTimestamp(message.timestamp) || message.images?.length || message.streamingBehavior !== undefined || text !== intent.data.choice || Date.parse(message.timestamp) <= challenge.requestedAt) return null;
    if (!strictApprovalCompaction(intent, middle, message)) return null;
    if (message.parentId !== (compacted ? middle.id : intent.id)) return null;
    const identity = (entry) => ({ id: entry.id, parentId: entry.parentId ?? null, timestamp: entry.timestamp, message: entry.message });
    const userEntryHash = canonicalHash(identity(message));
    const branchBindingHash = canonicalHash({ challengeHash: challenge.challengeHash, intent: identity(intent), compaction: compacted ? { id: middle.id, parentId: middle.parentId, timestamp: middle.timestamp, summary: middle.summary, firstKeptEntryId: middle.firstKeptEntryId, tokensBefore: middle.tokensBefore } : null, user: identity(message), choice: intent.data.choice, source: intent.data.source, sessionId: challenge.sessionId });
    return { intent, message, choice: intent.data.choice, userEntryHash, branchBindingHash };
  };
  const publicRepairChallenge = (challenge) => ({ challengeId: challenge.challengeId, challengeHash: challenge.challengeHash, episodeId: challenge.episodeId, action: challenge.action, subjectHash: challenge.subjectHash, taskId: challenge.taskId, taskDefHash: challenge.taskDefHash, sessionId: challenge.sessionId, requestedAt: challenge.requestedAt, expiresAt: challenge.expiresAt, choices: ["approve", "reject"], status: challenge.phase });
  const restoreMetadata = (ctx) => {
    metadataChallenges.clear(); orphanChallenges.clear(); transferChallenges.clear(); runtimeChallenges.clear(); runtimeIntentGates.clear();
    for (const entry of ctx.sessionManager?.getEntries?.() || []) {
      if (entry.type !== "custom") continue;
      const data = entry.data;
      if (entry.customType === "goal-engine-runtime-intent-pending" && exactPlainObject(data, ["goalId", "sessionId", "source"]) && [data.goalId, data.sessionId].every(nonEmptyString) && ["interactive", "rpc"].includes(data.source)) runtimeIntentGates.set(`${data.goalId}:${data.sessionId}`, { ...data, kind: "pending" });
      if (entry.customType?.startsWith("goal-engine-runtime-approval-")) {
        const id = data?.id;
        const current = typeof id === "string" ? runtimeChallenges.get(id) : null;
        if (entry.customType === "goal-engine-runtime-approval-challenge") {
          if (!isRuntimeChallenge(data)) {
            if (current) runtimeChallenges.set(id, { ...current, invalid: true });
          } else if (!current) runtimeChallenges.set(id, { challenge: data });
          else if (!current.invalid && !isDeepStrictEqual(current.challenge, data)) runtimeChallenges.set(id, { ...current, invalid: true });
        } else if (entry.customType === "goal-engine-runtime-approval-decision") {
          const pair = current?.challenge && runtimeApprovalPair(current.challenge, ctx);
          if (!current?.challenge || current.invalid || !isRuntimeDecision(data, current.challenge) || current.decision || !pair || data.userEntryId !== pair.message.id || data.choice !== pair.choice || data.source !== pair.intent.data.source) {
            if (current) runtimeChallenges.set(id, { ...current, invalid: true });
          } else runtimeChallenges.set(id, { ...current, decision: data });
        } // Runtime terminal receipts are audit-only; Goal Projection and re-proven decisions remain authoritative.
      }
      if (entry.customType?.startsWith("goal-engine-metadata-")) {
        if (!data?.id) continue;
        const current = metadataChallenges.get(data.id) || {};
        metadataChallenges.set(data.id, { ...current, ...(entry.customType === "goal-engine-metadata-challenge" ? { challenge: data } : {}), ...(entry.customType === "goal-engine-metadata-decision" ? { decision: { ...data, id: data.receiptId } } : {}), ...(entry.customType === "goal-engine-metadata-rejected" ? { rejected: true } : {}), ...(entry.customType === "goal-engine-metadata-consumed" ? { consumed: true } : {}) });
      }
      if (entry.customType?.startsWith("goal-engine-session-transfer-") && (data?.id || data?.challenge_id)) {
        const id = data.id || data.challenge_id; const current = transferChallenges.get(id) || {};
        transferChallenges.set(id, { ...current, ...(entry.customType.endsWith("challenge") ? { challenge: data } : {}), ...(entry.customType.endsWith("decision") ? { decision: data } : {}), ...(entry.customType.endsWith("rejected") ? { rejected: true } : {}), ...(entry.customType.endsWith("consumed") ? { consumed: true } : {}), ...(entry.customType.endsWith("stale") ? { stale: true } : {}) });
      }
      if (!entry.customType?.startsWith("goal-engine-orphan-disposition-") || !data?.challenge_id && !data?.id) continue;
      const id = data.challenge_id || data.id; const current = orphanChallenges.get(id) || {};
      orphanChallenges.set(id, { ...current, ...(entry.customType.endsWith("challenge") ? { challenge: data } : {}), ...(entry.customType.endsWith("decision") ? { decision: { ...data, id: data.receipt_id } } : {}), ...(entry.customType.endsWith("stale") ? { stale: true } : {}), ...(entry.customType.endsWith("consumed") ? { consumed: true } : {}) });
    }
  };
  const stableHash = (value) => {
    const canonical = (item) => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item;
    return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
  };
  const workspaceLeaseId = (lease) => createHash("sha256").update(lease.ownerToken).digest("hex");
  const executorCoordinator = {
    prepareSpawn({ contract, contractHash, ctx }) {
      const { cwd, root } = executionScopeFor(ctx);
      const tickets = [];
      for (const goalId of listGoalsFn(root)) {
        const projection = loadProjectionFn(root, goalId);
        const ticket = prepareExecutorBindingTicket({
          projection,
          contract,
          contractHash,
          controlCwd: cwd,
          workspaceLeaseIdForTask(taskId) {
            const task = projection.tasks.get(taskId);
            const lease = resolveLease(task, goalId, taskId, cwd, root);
            const inspection = inspectExecutorWorkspace(lease);
            if (!inspection.clean || inspection.aheadCount !== 0 || inspection.headCommit !== task.workspace.baseCommit) {
              throw preflightError("EXECUTOR_BINDING_MISMATCH", "Goal workspace changed before executor spawn", "inspect goal_status and do not attribute the existing workspace changes to a new run");
            }
            return workspaceLeaseId(lease);
          },
        });
        if (ticket) tickets.push(ticket);
      }
      if (tickets.length > 1) throw preflightError("EXECUTOR_BINDING_MISMATCH", "coding spawn matches multiple Goal tickets", "inspect Goal state and retry the exact dispatched contract");
      return tickets[0] ?? null;
    },
    bindSpawn(ticket, binding) {
      const { root } = executionScopeFor({ cwd: ticket.controlCwd }, { goalId: ticket.goalId });
      let projection = loadProjectionFn(root, ticket.goalId);
      const task = assertExecutorBindingTicketCurrent(ticket, projection);
      const currentLeaseId = workspaceLeaseId(resolveLease(task, ticket.goalId, ticket.taskId, ticket.controlCwd, root));
      if (currentLeaseId !== ticket.workspaceLeaseId) {
        throw preflightError("EXECUTOR_BINDING_MISMATCH", "workspace lease identity changed after spawn", "inspect goal_status and do not bind this run");
      }
      const data = executorBoundEventData(ticket, binding);
      if (task.executorBinding) {
        const expected = { ...data }; delete expected.taskId;
        if (isDeepStrictEqual(task.executorBinding, expected)) return task.executorBinding;
        throw preflightError("EXECUTOR_BINDING_MISMATCH", "attempt already has a different executor binding", "do not replace the bound run; inspect goal_status");
      }
      const event = makeGoalEvent("task.executor_bound", data, ticket.goalId, projection);
      try {
        projection = appendEventFn(root, event, projection.version);
      } catch (error) {
        const recovered = loadProjectionFn(root, ticket.goalId);
        const observed = recovered.tasks.get(ticket.taskId)?.executorBinding;
        const expected = { ...data }; delete expected.taskId;
        if (isDeepStrictEqual(observed, expected)) return observed;
        throw error;
      }
      return projection.tasks.get(ticket.taskId).executorBinding;
    },
  };
  bindGoalExecutorCoordinator(pi, executorCoordinator);
  const orphanRecord = (goalId, taskId, attempt, sessionId, inventory) => {
    const hash = stableHash(inventory);
    const records = [...orphanChallenges.values()].filter((r) => r.challenge?.goalId === goalId && r.challenge?.taskId === taskId && r.challenge?.attempt === attempt && r.challenge?.sessionId === sessionId);
    let record = records.at(-1);
    if (record?.stale || record?.consumed) {
      record = null;
    } else if (record && record.challenge.inventoryHash !== hash) {
      persistMetadata("goal-engine-orphan-disposition-stale", { challenge_id: record.challenge.id });
      orphanChallenges.set(record.challenge.id, { ...record, stale: true });
      record = null;
    }
    if (!record) {
      const presentation = { baseCommit: inventory.lease.baseCommit, branch: inventory.lease.branch, executorHead: inventory.executorHead, originRef: inventory.lease.originRef, resources: inventory.resources };
      const challenge = { id: crypto.randomUUID(), kind: "orphan_disposition", goalId, taskId, attempt, sessionId, requestedAt: new Date().toISOString(), choices: ["discard", "preserve"], inventory: presentation, inventoryHash: hash };
      persistMetadata("goal-engine-orphan-disposition-challenge", challenge);
      record = { challenge }; orphanChallenges.set(challenge.id, record);
    }
    return record;
  };
  const metadataState = (projection, sessionId) => {
    const records = [...metadataChallenges.values()].filter((record) => record.challenge?.goalId === projection.goalId && record.challenge?.sessionId === sessionId);
    const record = records.at(-1);
    if (!record) return null;
    const applied = projection.contractHistory?.some((entry) => entry.proposalHash === record.challenge.proposalHash);
    const base = record.challenge.baseMetadata && hashGoalMetadataProposal(record.challenge.baseMetadata) === hashGoalMetadataProposal({ objective: projection.objective, scope: projection.scope, nonGoals: projection.nonGoals, dod: projection.dod });
    if (applied || record.consumed) return { status: "CONSUMED", record };
    if (record.rejected || record.decision?.choice === "reject") return { status: "REJECTED", record };
    if (!base) return { status: "REPROPOSE_REQUIRED", record };
    if (record.decision?.choice === "approve") return { status: "APPROVED", record };
    return { status: "AWAITING_USER_DECISION", record };
  };

  const activateRecoveryLatch = (goalId, error) => {
    recoveryLatch = { state: "active", goalId: goalId || recoveryLatch?.goalId || "unknown", reason: String(error?.message || error) };
    try { pi.appendEntry?.("goal-engine-recovery-latch", recoveryLatch); } catch { /* preserve the in-memory fail-closed boundary */ }
    return recoveryLatch;
  };

  const consumeOfferedAction = (projection, params, tool, goalId, ctx, root) => {
    if (!enforceActionTokens) return projection;
    if (typeof params.action_token !== "string" || !params.action_token) {
      throw new Error(`goal_status action_token is required before ${tool}`);
    }
    const offer = projection.actionOffer;
    if (!offer) throw new Error(`goal_status must issue an action offer before ${tool}`);
    const offeredTaskId = offer.params.task_id;
    const boundDependencyAmendment = offer.tool === "goal_amend" && offer.params.operation === "patch_active" && offeredTaskId !== undefined;
    if (boundDependencyAmendment) {
      const updateTaskIds = Object.keys(params.update_tasks || {});
      const update = params.update_tasks?.[offeredTaskId];
      if (tool !== "goal_amend" || params.operation !== "patch_active"
        || params.add_tasks || params.remove_tasks || updateTaskIds.length !== 1 || updateTaskIds[0] !== offeredTaskId
        || !update || Object.keys(update).length !== 1 || !Object.hasOwn(update, "deps")) {
        throw new Error("bound dependency amendment must update only the offered task deps");
      }
    }
    const supplied = { goal_id: goalId, task_id: params.task_id ?? params.blocked_task_id ?? (boundDependencyAmendment ? offeredTaskId : undefined), action: params.action, strategy: params.strategy, operation: params.operation, challenge_id: params.challenge_id };
    const boundParams = {};
    for (const key of Object.keys(offer.params)) {
      if (supplied[key] === undefined) throw new Error(`action offer params do not match: missing ${key}`);
      boundParams[key] = supplied[key];
    }
    const consumed = verifyAndConsumeActionOffer(projection, {
      token: params.action_token,
      tool,
      params: boundParams,
      sessionId: sessionIdentity(ctx),
    });
    return appendEventFn(root, makeGoalEvent("goal.action_consumed", consumed, goalId, projection), projection.version);
  };

  const ownedBySession = (projection, sessionId) => ownerSessionId(projection) === sessionId;
  const resolveGoalId = (goalId, root, ctx) => {
    if (!enforceActionTokens) {
      if (goalId) return goalId;
      const active = listGoalsFn(root);
      if (active.length === 0) return null;
      if (active.length > 1) throw new Error(`Multiple active goals: ${active.join(", ")}. Specify goal_id.`);
      return active[0];
    }
    const sessionId = sessionIdentity(ctx);
    if (goalId) {
      const projection = loadProjectionFn(root, goalId);
      return !projection?.sessionBindings?.length || ownedBySession(projection, sessionId) ? goalId : null;
    }
    const active = listGoalsFn(root).filter((id) => ownedBySession(loadProjectionFn(root, id), sessionId));
    if (active.length === 0) return null;
    if (active.length > 1) throw new Error(`Multiple active goals: ${active.join(", ")}. Specify goal_id.`);
    return active[0];
  };

  const resolveWorkspaceLease = (task, goalId, taskId, cwd, root, { allowSynthetic = false } = {}) => {
    const expected = workspaceLeaseIdentityFromProjection(task.workspace, goalId, taskId, cwd, root);
    let lease;

    try {
      lease = loadExecutorWorkspaceLease({ goalId, taskId, attempt: expected.attempt, stateRoot: expected.stateRoot });
    } catch (error) {
      if (!String(error.message).includes("Executor workspace lease not found")) {
        throw error;
      }
    }

    if (lease) {
      assertLeaseIdentity(lease, expected, "persisted");
    } else if (allowSynthetic) {
      lease = {
        ...expected,
        ownerToken: "restored",
        createdAt: new Date().toISOString(),
      };
    } else {
      throw new Error("Executor workspace persisted lease not found");
    }

    return lease;
  };

  const resolveLease = (task, goalId, taskId, cwd, root, options) => {
    const key = leaseKey(cwd, goalId, taskId);
    const expected = workspaceLeaseIdentityFromProjection(task.workspace, goalId, taskId, cwd, root);
    const cached = activeLeases.get(key);
    if (cached) {
      assertLeaseIdentity(cached, expected, "cached");
    }
    const lease = resolveWorkspaceLease(task, goalId, taskId, cwd, root, options);
    activeLeases.set(key, lease);
    return lease;
  };

  registerGoalTool(pi, {
    name: "goal_init",
    description: "当跨多轮、compaction 或多个独立验收 task 时使用；创建并持久化 task DAG。不要用于单步短任务或已有 active goal 时重复创建。",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "一句话目标" },
        scope: { type: "array", items: { type: "string" } },
        non_goals: { type: "array", items: { type: "string" } },
        dod: { type: "array", items: { type: "string" }, description: "Definition of Done 条目" },
        execution: { type: "object", description: "goal-runtime.v1 Host-normalized execution contract" },
        tasks: {
          type: "array",
          items: taskSchema,
          description: "任务 DAG（含依赖、写入范围、验收标准）",
        },
      },
      required: ["objective"],
      anyOf: [{ required: ["tasks"] }, { required: ["execution"] }],
    },
    async handler(params, ctx) {
      const { cwd, root, storage, stateScope } = executionScopeFor(ctx, { operation: "init" });
      assertInitPreflight(cwd, storage);
      if (storage === "global") ensureGoalStateIdentity(stateScope);
      const sessionId = sessionIdentity(ctx);
      if (params.tasks && params.execution) throw initError("INVALID_GOAL_CONTRACT", "top-level tasks cannot be mixed with execution", "submit either legacy tasks or runtime execution, not both");
      const activeGoals = enforceActionTokens
        ? listGoalsFn(root).filter((id) => ownedBySession(loadProjectionFn(root, id), sessionId))
        : listGoalsFn(root);
      if (activeGoals.length > 0) {
        const goalId = activeGoals[0];
        throw Object.assign(initError("ACTIVE_GOAL_EXISTS", `active goal=${goalId}`, "call goal_status before creating another goal"), {
          code: "ACTIVE_GOAL_EXISTS",
          requiredNextAction: { tool: "goal_status", params: { goal_id: goalId } },
          message: `${initError("ACTIVE_GOAL_EXISTS", `active goal=${goalId}`, "call goal_status before creating another goal").message}; ${JSON.stringify({ requiredNextAction: { tool: "goal_status", params: { goal_id: goalId } } })}`,
        });
      }
      let goalId;
      try {
        const baseGoalId = slugify(params.objective);
        goalId = baseGoalId;
        while (loadProjectionFn(root, goalId)) goalId = `${baseGoalId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
      } catch (error) {
        throw initError("INVALID_GOAL_CONTRACT", error.message, "provide a non-empty objective that produces a goal id, then retry goal_init");
      }
      if (params.execution) {
        if (!runtimeHost?.registries || typeof runtimeHost.captureCurrentWorld !== "function") throw initError("RUNTIME_READINESS_BLOCKER", "runtime Host authority is unavailable", "configure runtimeHost registries and safe CurrentWorld capture");
        let contract, world, readiness;
        try { contract = normalizeRuntimeGoalInit(params, runtimeHost.registries); world = runtimeHost.captureCurrentWorld({ cwd }); readiness = validateRuntimeReadiness(contract, runtimeHost.registries); }
        catch (error) { throw initError("RUNTIME_READINESS_BLOCKER", error.message, "repair runtime registry authority and retry"); }
        // A safe=false snapshot may be persisted as a draft, but an absent or
        // malformed canonical HEAD has no event authority and must fail before append.
        if (!/^[a-f0-9]{40}$/.test(world?.repo?.head || "")) throw initError("RUNTIME_READINESS_BLOCKER", "CurrentWorld canonical repo.head is absent or invalid", "capture a canonical repository HEAD and retry runtime initialization");
        if (!world.safe) readiness = { readiness: "unsafe_to_run", reasons: ["CurrentWorld is unsafe"] };
        const runtimeEvent = makeEvent("goal.runtime_drafted", { runtimeInit: contract, executionContractHash: hashRuntimeExecutionContract(contract), baseHead: world.repo.head }, goalId, "goal-runtime.v1");
        const candidate = applyEvent(createProjection(), runtimeEvent);
        const binding = buildSessionBinding({ projection: candidate, sessionId, leafId: ctx.sessionManager?.getLeafId?.() || "goal-init" });
        const events = [runtimeEvent, makeEvent("goal.session_bound", binding, goalId, "goal-runtime.v1"), makeEvent("goal.runtime_readiness_recorded", readiness, goalId, "goal-runtime.v1")];
        const projection = appendEventBatchFn(root, events, 0);
        return JSON.stringify({ goalId, lifecycle: "active", runtimeState: projection.runtimeState, readiness: projection.readiness, attention: projection.runtimeState === "draft" ? "RUNTIME_READINESS_REQUIRED" : undefined });
      }
      const taskDefs = {};
      const taskIds = [];
      for (const t of params.tasks) {
        taskIds.push(t.id);
        taskDefs[t.id] = {
          description: t.description,
          deps: t.deps || [],
          writePaths: t.writePaths,
          acceptance: t.acceptance,
          workflow: t.workflow || "tdd",
        };
      }
      try {
        validateTaskDefinitions(taskIds, taskDefs, { cwd, realpathCwd: realpathSync(cwd), planned: true });
      } catch (error) {
        throw initError("INVALID_TASK_CONTRACT", error.message, "correct structured criteria and writePaths, then retry goal_init");
      }

      const event = makeGoalEvent("goal.created", {
        objective: params.objective,
        scope: params.scope || [],
        nonGoals: params.non_goals || [],
        dod: params.dod || [],
        tasks: taskIds,
        taskDefs,
      }, goalId);
      try {
        const candidate = applyEvent(createProjection(), event);
        assertPendingTaskContractsCompile(candidate, cwd);
      } catch (error) {
        throw initError("INVALID_GOAL_CONTRACT", error.message, "correct derived task, goal metadata, or requirements limits, then retry goal_init");
      }
      let projection;
      if (enforceActionTokens) {
        const candidate = applyEvent(createProjection(), event);
        const binding = buildSessionBinding({ projection: candidate, sessionId: sessionIdentity(ctx), leafId: ctx.sessionManager?.getLeafId?.() || "goal-init" });
        projection = appendEventBatchFn(root, [event, makeGoalEvent("goal.session_bound", binding, goalId, candidate)], 0);
      } else projection = appendEventFn(root, event, 0);

      return JSON.stringify({
        goalId,
        lifecycle: "active",
        runnable: runnableFrontier(projection),
        total_tasks: taskIds.length,
      });
    },
  });

  registerGoalTool(pi, {
    name: "goal_status",
    description: "当存在或可能存在 active goal 时，在每个协调轮次开始及 compact/reload 后首先使用；返回恢复权威的 projection 和 machine action。不要凭对话历史猜进度。",
    parameters: { type: "object", anyOf: [
      { type: "object", properties: { goal_id: string }, additionalProperties: false },
      { type: "object", properties: { list_cwd_goals: { type: "boolean", const: true } }, required: ["list_cwd_goals"], additionalProperties: false },
      { type: "object", properties: { transfer_challenge_id: string }, required: ["transfer_challenge_id"], additionalProperties: false },
    ] },
    async handler(params, ctx) {
      const { cwd, root } = executionScopeFor(ctx, { operation: "read", goalId: params.goal_id });
      const sessionId = sessionIdentity(ctx);
      if (params.list_cwd_goals === true) return JSON.stringify(listCwdGoals(loadAllProjections(root), sessionId));
      if (params.transfer_challenge_id) {
        const record = transferChallenges.get(params.transfer_challenge_id);
        if (!record?.challenge || record.challenge.toSessionId !== sessionId) return "NO_ACTIVE_GOAL";
        let projection = loadProjectionFn(root, record.challenge.goalId);
        const status = transferChallengeState(record, projection, sessionId, cwd);
        const targetHasActiveGoal = loadAllProjections(root).some((candidate) => candidate.goalId !== projection.goalId && candidate.lifecycle === "active" && ownerSessionId(candidate) === sessionId);
        if (targetHasActiveGoal) return JSON.stringify({ challenge_id: record.challenge.id, status: "TARGET_SESSION_HAS_ACTIVE_GOAL" });
        if (!workspaceReleased(projection)) return JSON.stringify({ challenge_id: record.challenge.id, status: "ACTIVE_WORKSPACE" });
        if (status !== "APPROVED") return JSON.stringify({ challenge_id: record.challenge.id, status });
        const machineAction = { tool: "goal_amend", params: { goal_id: record.challenge.goalId, operation: "transfer_session", challenge_id: record.challenge.id, reason: record.challenge.reason } };
        const offer = issueActionOffer(projection, machineAction, sessionId);
        projection = appendEventFn(root, makeGoalEvent("goal.action_offered", offer, projection.goalId, projection), projection.version);
        return JSON.stringify({ challenge_id: record.challenge.id, status, machineAction, action_token: offer.token });
      }
      const goalId = resolveGoalId(params.goal_id, root, ctx);
      if (!goalId) return "NO_ACTIVE_GOAL";
      let projection = loadProjectionFn(root, goalId);
      if (!projection) return "NO_ACTIVE_GOAL";
      if (projection.eventSchemaVersion === "goal-runtime.v1" && projection.runtimeState === "suspended") {
        await retrySuspendedOwnedStop(ctx, projection);
        projection = loadProjectionFn(root, goalId);
      }
      if (projection.eventSchemaVersion === "goal-runtime.v1" && runtimeIntentGates.get(`${goalId}:${sessionId}`)?.kind === "pending") return JSON.stringify({ status: "R10B_SUSPENSION_REQUIRED" });
      if (projection.eventSchemaVersion === "goal-runtime.v1") {
        if (!runtimeHost?.registries || typeof runtimeHost.captureCurrentWorld !== "function") return JSON.stringify({ goalId, status: "RUNTIME_READINESS_BLOCKER", attention: ["RUNTIME_HOST_AUTHORITY_UNAVAILABLE"] });
        let world;
        try { world = runtimeHost.captureCurrentWorld({ cwd }); } catch { world = null; }
        if (!world?.safe) return JSON.stringify({ goalId, status: "RUNTIME_READINESS_BLOCKER", attention: ["WORLD_SNAPSHOT_UNSAFE"] });
        if (projection.finalReview?.status === "started" && projection.actionOffer?.tool === "goal_finalize" && projection.actionOffer.consumed === true) {
          return JSON.stringify({ goalId, status: "APPROVAL_REQUIRED", machineAction: { tool: "goal_finalize", params: projection.actionOffer.params }, action_token: projection.actionOffer.token });
        }
        // A stale durable review can only be replaced by a fresh status cycle;
        // never reuse its approval or result as completion authority.
        if (projection.finalReview?.status === "stale") return JSON.stringify({ goalId, status: "APPROVAL_REQUIRED", machineAction: null });
        const pendingFinalIntent = ctx.sessionManager?.getBranch?.()?.some((entry) => exactFinalIntent(entry, goalId, sessionId));
        if (!pendingFinalIntent && projection.finalReview?.status !== "started") {
          const fingerprint = obligationProgressFingerprint({ projection, worldSnapshot: world });
          const previous = projection.progressLedger?.at(-1);
          projection = appendEventFn(root, makeEvent("goal.checkpoint", { canonicalFingerprint: fingerprint, advanced: !previous || previous.canonicalFingerprint !== fingerprint, sequence: (projection.progressLedger?.length || 0) + 1 }, goalId, "goal-runtime.v1"), projection.version);
        }
        if (projection.runtimeState === "awaiting_user_approval") {
          const terminal = [...runtimeChallenges.values()].filter((item) => !item.invalid && item.challenge?.goalId === goalId && item.challenge?.sessionId === sessionId && (item.stale || item.rejected)).at(-1);
          if (terminal) return JSON.stringify({ goalId, status: terminal.rejected ? "RUNTIME_APPROVAL_REJECTED" : "RUNTIME_APPROVAL_STALE", attention: [terminal.rejected ? "RUNTIME_APPROVAL_REJECTED" : "RUNTIME_APPROVAL_STALE"] });
          let record = [...runtimeChallenges.values()].filter((item) => !item.invalid && item.challenge?.goalId === goalId && item.challenge?.sessionId === sessionId && !item.consumed && !item.stale && !item.rejected).at(-1);
          if (!record) { const baseChallenge = createRuntimeActivationChallenge({ goalId, contractHash: projection.executionContractHash, baseHead: projection.runtimeBaseHead, sessionId, proposalId: crypto.randomUUID() }); const challenge = { ...baseChallenge, executionContractHash: projection.executionContractHash, proposalHash: stableHash({ goalId, proposalId: baseChallenge.proposalId, executionContractHash: projection.executionContractHash, baseHead: projection.runtimeBaseHead, sessionId }) }; persistMetadata("goal-engine-runtime-approval-challenge", challenge); record = { challenge }; runtimeChallenges.set(challenge.id, record); }
          if (!record.decision) {
            const pair = runtimeApprovalPair(record.challenge, ctx);
            if (pair) {
              const decision = { id: record.challenge.id, challengeId: record.challenge.id, kind: "runtime_activation_approval", choice: pair.choice, goalId, contractHash: record.challenge.contractHash, baseHead: record.challenge.baseHead, proposalId: record.challenge.proposalId, userEntryId: pair.message.id, sessionId, source: pair.intent.data.source, proposalHash: record.challenge.proposalHash, receiptId: crypto.randomUUID() };
              persistMetadata("goal-engine-runtime-approval-decision", decision);
              record = { ...record, decision };
              runtimeChallenges.set(record.challenge.id, record);
            }
          }
          if (record.decision?.choice === "reject") {
            persistMetadata("goal-engine-runtime-approval-rejected", { id: record.challenge.id }); runtimeChallenges.set(record.challenge.id, { ...record, rejected: true });
            return JSON.stringify({ goalId, status: "RUNTIME_APPROVAL_REJECTED", attention: ["RUNTIME_APPROVAL_REJECTED"] });
          }
          if (record.decision?.choice === "approve" && record.decision.contractHash === projection.executionContractHash && record.decision.proposalHash === record.challenge.proposalHash && record.decision.baseHead === projection.runtimeBaseHead && world.repo.head === projection.runtimeBaseHead) {
            const nonce = runtimeNonceFactory();
            const capabilityDigest = createHash("sha256").update(Buffer.isBuffer(nonce) ? nonce : String(nonce)).digest("hex");
            try { projection = appendEventFn(root, makeEvent("goal.runtime_approval_recorded", { proposalId: record.challenge.proposalId, proposalHash: record.challenge.proposalHash, executionContractHash: projection.executionContractHash, baseHead: projection.runtimeBaseHead, sessionId, userEntryId: record.decision.userEntryId, capabilityDigest }, goalId, "goal-runtime.v1"), projection.version); } catch (error) { const recovered = loadProjectionFn(root, goalId), approval = recovered?.runtimeApproval; if (recovered?.runtimeState !== "calibrating" || approval?.proposalHash !== record.challenge.proposalHash || approval?.userEntryId !== record.decision.userEntryId || approval?.sessionId !== record.challenge.sessionId || approval?.executionContractHash !== record.challenge.executionContractHash || approval?.baseHead !== record.challenge.baseHead || approval?.capabilityDigest !== capabilityDigest) throw error; projection = recovered; }
            persistMetadata("goal-engine-runtime-approval-consumed", { id: record.challenge.id }); runtimeChallenges.set(record.challenge.id, { ...record, consumed: true });
            // Approval consumption is this status call's sole business step.
            return JSON.stringify({ goalId, runtimeState: projection.runtimeState, readiness: projection.readiness, progressLedger: projection.progressLedger });
          } else if (record.decision) {
            persistMetadata("goal-engine-runtime-approval-stale", { id: record.challenge.id }); runtimeChallenges.set(record.challenge.id, { ...record, stale: true });
            return JSON.stringify({ goalId, status: "RUNTIME_APPROVAL_STALE", attention: ["RUNTIME_APPROVAL_STALE"] });
          } else return JSON.stringify({ goalId, proposalId: record.challenge.proposalId, proposalHash: record.challenge.proposalHash, executionContractHash: projection.executionContractHash, baseHead: projection.runtimeBaseHead, session: sessionId, choices: record.challenge.choices });
        }
        if (projection.runtimeState === "calibrating") {
          const outcome = await calibrationStep({ projection, goalId, cwd, root, world });
          const current = loadProjectionFn(root, goalId);
          return JSON.stringify({ goalId, runtimeState: current.runtimeState, readiness: current.readiness, ...(outcome.attention ? { status: outcome.attention[0], attention: outcome.attention } : {}), progressLedger: current.progressLedger });
        }
        const amendment = projection.pendingHumanDecision;
        if (amendment?.phase === "proposed") {
          const pair = amendment.ownerSessionId === sessionId ? amendmentApprovalPair(amendment, ctx) : null;
          if (!pair) return JSON.stringify({ goalId, status: "R10B_AMENDMENT_APPROVAL_REQUIRED", proposalId: amendment.proposalId, choices: ["approve", "reject"] });
          const recordedAt = new Date().toISOString();
          const material = { proposalId: amendment.proposalId, proposalHash: amendment.proposalHash, ownerSessionId: amendment.ownerSessionId, userEntryId: pair.message.id, userEntryHash: pair.userEntryHash, branchBindingHash: pair.branchBindingHash, choice: pair.choice, approved: pair.choice === "approve", source: pair.intent.data.source, recordedAt };
          const event = makeEvent("execution.amendment_approved", { ...material, decisionId: canonicalHash(material) }, goalId, "goal-runtime.v1");
          const expected = applyEvent(projection, event);
          try { projection = appendEventFn(root, event, projection.version); }
          catch (cause) {
            const recovered = loadProjectionFn(root, goalId);
            if (!isDeepStrictEqual(recovered, expected)) throw cause;
            projection = recovered;
          }
          try { persistMetadata("goal-engine-execution-amendment-decision", { proposalId: amendment.proposalId, decisionId: event.data.decisionId, choice: pair.choice, approved: pair.choice === "approve", source: pair.intent.data.source, userEntryId: pair.message.id, ownerSessionId: amendment.ownerSessionId }); } catch { /* Projection is authoritative. */ }
          return JSON.stringify({ goalId, status: "R10B_AMENDMENT_DECISION_RECORDED" });
        }
        if (amendment?.phase === "approved") {
          const closure = projection.suspension;
          let normalizedTarget;
          const closed = closure?.resourcesQuarantined
            && closure.terminalProofRefs?.length === closure.affectedRunIds?.length
            && closure.workspaceClosureProofRefs?.length === closure.affectedTaskIds?.length
            && closure.resourceClosureProofRefs?.length === closure.affectedRunIds?.length;
          try { normalizedTarget = normalizeRuntimeGoalInit(amendment.targetExecutionContract, runtimeHost.registries); } catch { normalizedTarget = null; }
          const drift = amendment.ownerSessionId !== sessionId || !ownedBySession(projection, sessionId)
            || amendment.oldRevision !== projection.executionRevision
            || amendment.executionContractHash !== undefined && amendment.executionContractHash !== projection.executionContractHash
            || amendment.targetContractHash !== hashRuntimeExecutionContract(amendment.targetExecutionContract)
            || !normalizedTarget || !isDeepStrictEqual(normalizedTarget, amendment.targetExecutionContract)
            || !world.repo || world.repo.head !== amendment.baseHead || world.repo.trackedDirty?.length || world.repo.untracked?.length || world.repo.sequencer
            || projection.runtimeState !== "suspended" || !closed || suspensionClosureHash(closure) !== suspensionClosureHash(projection.suspension)
            || amendment.phase !== "approved";
          if (drift) return JSON.stringify({ goalId, status: "R10B_AMENDMENT_DRIFT", attention: ["R10B_AMENDMENT_DRIFT"] });
          const nonce = amendmentNonceFactory();
          const nonceDigest = canonicalHash({ schema: "goal-user-capability.v1", goalId, proposalId: amendment.proposalId, proposalHash: amendment.proposalHash, ownerSessionId: amendment.ownerSessionId, oldRevision: amendment.oldRevision, newRevision: amendment.newRevision, executionContractHash: projection.executionContractHash, targetContractHash: amendment.targetContractHash, baseHead: amendment.baseHead, closureHash: suspensionClosureHash(closure), nonce: Buffer.isBuffer(nonce) ? nonce.toString("base64") : String(nonce) });
          const source = new Set(amendment.sourceTaskIds), target = new Set(amendment.targetExecutionContract.execution.tasks.map((task) => task.id));
          const taskIds = [...new Set([...source, ...target])].sort();
          const facts = taskIds.map((taskId) => ({ taskId, revision: amendment.newRevision, state: !source.has(taskId) ? "applicable" : !target.has(taskId) ? "superseded" : "applicable", reason: "execution_amendment" }));
          const reconciliation = facts.map(({ taskId }) => ({ taskId, action: !source.has(taskId) ? "add" : !target.has(taskId) ? "supersede" : "keep" }));
          const events = [
            makeEvent("execution.amendment_capability_consumed", { proposalId: amendment.proposalId, nonceDigest }, goalId, "goal-runtime.v1"),
            ...facts.map((data) => makeEvent("task.applicability_changed", data, goalId, "goal-runtime.v1")),
            ...[...projection.conditions.keys()].sort().map((conditionId) => makeEvent("condition.evidence_invalidated", { conditionId, revision: amendment.newRevision, priorEvidenceIds: projection.conditions.get(conditionId).supportingEvidenceIds, reason: "execution_amendment" }, goalId, "goal-runtime.v1")),
            makeEvent("execution.amendment_applied", { proposalId: amendment.proposalId, proposalHash: amendment.proposalHash, oldRevision: amendment.oldRevision, newRevision: amendment.newRevision, targetContractHash: amendment.targetContractHash, reconciliation }, goalId, "goal-runtime.v1"),
            makeEvent("goal.runtime_resumed", { suspensionId: closure.suspensionId, closureHash: suspensionClosureHash(closure) }, goalId, "goal-runtime.v1"),
          ];
          const expected = events.reduce((candidate, event) => applyEvent(candidate, event), projection);
          try { projection = appendEventBatchFn(root, events, projection.version); }
          catch (cause) { const recovered = loadProjectionFn(root, goalId); if (!isDeepStrictEqual(recovered, expected)) throw cause; projection = recovered; }
          return JSON.stringify({ goalId, status: "R10B_AMENDMENT_APPLIED", proposalId: amendment.proposalId });
        }
        if (amendment?.phase === "rejected") return JSON.stringify({ goalId, status: "R10B_AMENDMENT_REJECTED", proposalId: amendment.proposalId });
        // Repair approval continuation deliberately precedes R9: created and
        // approved challenges are no longer selected by obligation policy.
        const repairChallenges = [...projection.repairChallenges.values()].filter((challenge) => challenge.action === "authorize_task" && challenge.sessionId === sessionId);
        const created = repairChallenges.filter((challenge) => challenge.phase === "created");
        const approved = repairChallenges.filter((challenge) => challenge.phase === "approved");
        // A consumed capability without its atomic link is a corrupt pending
        // authority, not permission to resume R9.
        const pending = repairChallenges.filter((challenge) => ["created", "approved", "consumed"].includes(challenge.phase));
        if (pending.length && (pending.length !== 1 || pending[0]?.phase === "consumed")) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_ATTENTION", attention: ["R10A3_REPAIR_APPROVAL_AMBIGUOUS"] });
        if (created.length === 1) {
          const challenge = created[0], now = repairNow();
          if (now === null) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_CLOCK_INVALID", attention: ["R10A3_REPAIR_APPROVAL_CLOCK_INVALID"] });
          if (now >= challenge.expiresAt) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_EXPIRED", attention: ["R10A3_REPAIR_APPROVAL_EXPIRED"] });
          const pair = repairApprovalPair(challenge, ctx);
          if (pair) {
            const occurredAt = Date.parse(pair.message.timestamp), recordedAt = Math.max(now, occurredAt);
            const decision = recordRepairUserDecision({ projection, challengeId: challenge.challengeId, sessionId, userEntryId: pair.message.id, userEntryHash: pair.userEntryHash, branchBindingHash: pair.branchBindingHash, userEntryOccurredAt: occurredAt, choice: pair.choice, approved: pair.choice === "approve", source: pair.intent.data.source, recordedAt });
            const event = makeEvent(decision.events[0].type, decision.events[0].data, goalId, "goal-runtime.v1");
            try { projection = appendEventFn(root, event, projection.version); }
            catch (cause) {
              const expected = applyEvent(projection, event).repairChallenges.get(challenge.challengeId);
              const recovered = loadProjectionFn(root, goalId)?.repairChallenges.get(challenge.challengeId);
              if (!isDeepStrictEqual(recovered, expected)) throw cause;
              projection = loadProjectionFn(root, goalId);
            }
            try { persistMetadata("goal-engine-repair-approval-decision", { challengeId: challenge.challengeId, decisionId: decision.events[0].data.decisionId, recordedAt, approved: pair.choice === "approve", source: pair.intent.data.source, userEntryId: pair.message.id, challengeHash: challenge.challengeHash, sessionId }); } catch { /* Projection is authority; audit is best effort. */ }
            return JSON.stringify({ goalId, status: pair.choice === "reject" ? "R10A3_REPAIR_APPROVAL_REJECTED" : "R10A3_REPAIR_APPROVAL_RECORDED", challenge: publicRepairChallenge(projection.repairChallenges.get(challenge.challengeId)) });
          }
          return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_REQUIRED", challenge: publicRepairChallenge(challenge) });
        }
        if (created.length > 1) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_ATTENTION", attention: ["R10A3_REPAIR_APPROVAL_AMBIGUOUS"] });
        if (approved.length === 1) {
          const challenge = approved[0], episode = projection.repairEpisodes.get(challenge.episodeId), condition = projection.conditions.get(challenge.conditionId)?.definition, now = repairNow();
          if (now === null) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_CLOCK_INVALID", attention: ["R10A3_REPAIR_APPROVAL_CLOCK_INVALID"] });
          if (now < challenge.recordedAt) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_DRIFT", attention: ["R10A3_REPAIR_APPROVAL_DRIFT"] });
          if (now >= challenge.expiresAt) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_EXPIRED", attention: ["R10A3_REPAIR_APPROVAL_EXPIRED"] });
          if (world.repo?.head !== challenge.baseHead || projection.executionRevision !== challenge.executionRevision || projection.executionContractHash !== challenge.executionContractHash || episode?.status !== "active" || !condition?.remediation) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_DRIFT", attention: ["R10A3_REPAIR_APPROVAL_DRIFT"] });
          const taskDef = repairTaskDef(condition), candidate = buildRemediationTaskCandidate({ projection, episodeId: episode.episodeId, findingIds: [...episode.findingIds].sort(), taskDef });
          if (candidate.taskId !== challenge.taskId || candidate.taskDef.metadata.taskDefHash !== challenge.taskDefHash || candidate.taskDef.metadata.subjectHash !== challenge.subjectHash) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_DRIFT", attention: ["R10A3_REPAIR_APPROVAL_DRIFT"] });
          const issuer = typeof runtimeHost?.issueRepairCapability === "function" ? runtimeHost.issueRepairCapability : issueRepairCapability;
          const capability = issuer({ projection, challengeId: challenge.challengeId, taskDef, now });
          const plan = validateRemediationTask({ projection, episodeId: episode.episodeId, findingIds: [...episode.findingIds].sort(), taskDef, capability, consumedAt: now });
          const events = plan.events.map(({ type, data }) => makeEvent(type, data, goalId, "goal-runtime.v1"));
          const expected = events.reduce((candidate, event) => applyEvent(candidate, event), projection);
          try { appendEventBatchFn(root, events, projection.version); }
          catch (cause) {
            const recovered = loadProjectionFn(root, goalId);
            if (!isDeepStrictEqual(recovered, expected)) {
              const nonce = Buffer.isBuffer(capability.nonce) ? capability.nonce.toString("utf8") : String(capability.nonce);
              throw new Error(String(cause?.message || "R10A3_REPAIR_MATERIALIZATION_FAILED").split(nonce).join("[redacted]"));
            }
          }
          return JSON.stringify({ goalId, status: "R10A3_REPAIR_MATERIALIZED" });
        }
        if (approved.length > 1) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_ATTENTION", attention: ["R10A3_REPAIR_APPROVAL_AMBIGUOUS"] });
        // Local convergence is a Host-derived semantic step before R9 only
        // while the runtime is active. Suspension and every other state leave
        // recovery priority solely to R9.
        if (projection.runtimeState === "active" && !projection.suspension) {
          // Keep dependent stale conditions for a later status so their durable
          // predecessor fact, rather than an incidental ID order, establishes
          // the causal cascade.
          const conditionGraph = evaluateConditionGraph({ projection, worldSnapshot: world });
          const staleCandidates = [...projection.conditions.entries()]
            .filter(([conditionId, condition]) => condition.status === "satisfied"
              && conditionGraph.conditions.get(conditionId)?.status === "stale"
              && ![...projection.observationRuns.values()].some((run) => run.conditionId === conditionId && run.cycle >= 1 && run.phase !== "released"))
            .map(([conditionId, condition]) => ({ conditionId, condition, reason: conditionGraph.conditions.get(conditionId).reason }));
          const selectedInvalidation = staleCandidates
            .filter(({ condition }) => !condition.definition.depends_on?.some((edge) => edge.kind === "condition"
              && projection.conditions.get(edge.id)?.status === "satisfied"
              && conditionGraph.conditions.get(edge.id)?.status === "stale"))
            .sort((left, right) => left.conditionId.localeCompare(right.conditionId))[0];
          if (selectedInvalidation) {
            const event = makeEvent("condition.evidence_invalidated", {
              conditionId: selectedInvalidation.conditionId,
              reason: selectedInvalidation.reason,
            }, goalId, "goal-runtime.v1");
            const expected = applyEvent(projection, event);
            try { appendEventFn(root, event, projection.version); }
            catch (cause) {
              const recovered = loadProjectionFn(root, goalId);
              if (!isDeepStrictEqual(recovered, expected)) throw cause;
            }
            return JSON.stringify({ goalId, status: "R10_LOCAL_CONVERGENCE_INVALIDATED" });
          }
        }
        const inventory = activeObservationInventory(projection);
        if (!inventory) return JSON.stringify({ goalId, runtimeState: projection.runtimeState, readiness: projection.readiness, status: "R10A3_OBSERVATION_HOST_ATTENTION", attention: ["R10A3_OBSERVATION_HOST_ATTENTION"], progressLedger: projection.progressLedger });
        // R9 is the sole authority for this status call.  In particular, do not
        // inspect or mutate an Episode until the frontier selected that Episode.
        const taskActions = new Map([...projection.tasks.keys()].map((taskId) => [taskId, taskActionState(projection, taskId)]));
        const frontier = actionableFrontier({ projection, worldSnapshot: world, taskActions, observationInventory: inventory });
        let selected = nextObligationAction(frontier);
        // Task action state is the R9 authority even if an unrelated runtime
        // inventory is unavailable to the obligation-policy frontier.
        if (!selected) {
          const task = [...projection.tasks.entries()].map(([taskId]) => ({ taskId, action: taskActionState(projection, taskId).requiredNextAction }))
            .find(({ action }) => action && ["goal_dispatch", "goal_settle", "goal_integrate", "goal_accept", "goal_amend"].includes(action.tool));
          if (task) selected = { tool: task.action.tool, params: { task_id: task.taskId, ...task.action.params } };
          else {
            const finalStore = loadFinalizationProjection(root, goalId);
            const finalCandidate = buildObligationFinalizationManifest({ projection: finalStore.projection, storeProjection: finalStore, worldSnapshot: world, conditionValidity: evaluateConditionGraph({ projection: finalStore.projection, worldSnapshot: world }).conditions, resourceInventory: world.resources });
            if (finalCandidate.complete) selected = { tool: "goal_finalize", params: {} };
          }
        }
        if (selected?.tool === "repair_episode") {
          const episode = projection.repairEpisodes.get(selected.params.episode_id);
          const condition = projection.conditions.get(episode?.conditionId)?.definition;
          if (episode?.status === "reverifying") {
            if (!observationHostAvailable() || !condition) return JSON.stringify({ goalId, runtimeState: projection.runtimeState, status: "R10A3_OBSERVATION_HOST_ATTENTION", attention: ["R10A3_OBSERVATION_HOST_ATTENTION"], progressLedger: projection.progressLedger });
            const cycle = [...projection.observationRuns.values()].filter(run => run.conditionId === episode.conditionId && Number.isSafeInteger(run.cycle) && run.cycle >= 1).reduce((max, run) => Math.max(max, run.cycle), 0) + 1;
            const services = observationServices(goalId, cwd, root, world);
            const requested = requestObservation({ projection, conditionId: episode.conditionId, cycle, worldSnapshot: world, services });
            const requestedProjection = applyEvent(projection, makeEvent(requested.event.type, requested.event.data, goalId, "goal-runtime.v1"));
            const link = planRepairObservationLink({ projection: requestedProjection, episodeId: episode.episodeId, runId: requested.event.data.runId });
            const events = [makeEvent(requested.event.type, requested.event.data, goalId, "goal-runtime.v1"), ...link.events.map(({ type, data }) => makeEvent(type, data, goalId, "goal-runtime.v1"))];
            try { appendEventBatchFn(root, events, projection.version); }
            catch (cause) {
              const recovered = loadProjectionFn(root, goalId), runId = requested.event.data.runId;
              if (recovered?.observationRuns.get(runId)?.phase !== "requested" || !recovered.repairEpisodes.get(episode.episodeId)?.ownedRunIds?.includes(runId)) throw cause;
            }
            const current = loadProjectionFn(root, goalId);
            return JSON.stringify({ goalId, runtimeState: current.runtimeState, readiness: current.readiness, progressLedger: current.progressLedger });
          }
          if (episode?.status === "active" && condition?.remediation?.policy === "user-approved") {
            const taskDef = repairTaskDef(condition), candidate = buildRemediationTaskCandidate({ projection, episodeId: episode.episodeId, findingIds: [...episode.findingIds].sort(), taskDef });
            const existing = [...projection.repairChallenges.values()].find((challenge) => challenge.phase === "created" && challenge.action === "authorize_task" && challenge.episodeId === episode.episodeId && challenge.sessionId === sessionId);
            if (existing) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_REQUIRED", challenge: publicRepairChallenge(existing) });
            const requestedAt = repairNow();
            if (requestedAt === null) return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_CLOCK_INVALID", attention: ["R10A3_REPAIR_APPROVAL_CLOCK_INVALID"] });
            const challenge = createRepairChallenge({ projection, episodeId: episode.episodeId, action: "authorize_task", sessionId, requestedAt, expiresAt: requestedAt + 10 * 60 * 1000, baseHead: world.repo.head, subjectHash: candidate.taskDef.metadata.subjectHash, taskId: candidate.taskId, taskDefHash: candidate.taskDef.metadata.taskDefHash, taskDef });
            const event = makeEvent(challenge.events[0].type, challenge.events[0].data, goalId, "goal-runtime.v1");
            try { appendEventFn(root, event, projection.version); }
            catch (cause) {
              const expected = applyEvent(projection, event).repairChallenges.get(challenge.challengeId);
              const recovered = loadProjectionFn(root, goalId)?.repairChallenges.get(challenge.challengeId);
              if (!isDeepStrictEqual(recovered, expected)) throw cause;
            }
            return JSON.stringify({ goalId, status: "R10A3_REPAIR_APPROVAL_REQUIRED", challenge: publicRepairChallenge(loadProjectionFn(root, goalId).repairChallenges.get(challenge.challengeId)) });
          }
          if (episode?.status === "active" && condition?.remediation?.policy === "autonomous") {
            const taskDef = repairTaskDef(condition);
            const plan = validateRemediationTask({ projection, episodeId: episode.episodeId, findingIds: [...episode.findingIds], taskDef });
            const events = plan.events.map(({ type, data }) => makeGoalEvent(type, data, goalId, projection));
            try { appendEventBatchFn(root, events, projection.version); }
            catch (cause) {
              const recovered = loadProjectionFn(root, goalId);
              if (!recovered?.repairEpisodes.get(episode.episodeId)?.remediationTaskIds?.includes(plan.taskId)) throw cause;
            }
            const current = loadProjectionFn(root, goalId);
            return JSON.stringify({ goalId, runtimeState: current.runtimeState, status: "R10A3_REPAIR_MATERIALIZED" });
          }
        }
        if (selected && ["request_observation", "observation_start", "observation_recover", "record_observation", "release_observation"].includes(selected.tool)) {
          const outcome = await activeObservationStep({ projection, goalId, cwd, root, world, selected });
          const current = loadProjectionFn(root, goalId);
          return JSON.stringify({ goalId, runtimeState: current.runtimeState, readiness: current.readiness, ...(outcome.attention ? { status: outcome.attention[0], attention: outcome.attention } : {}), blocking: frontier.blocking, progressLedger: current.progressLedger });
        }
        if (selected?.tool === "goal_finalize" || projection.finalReview?.status === "started") {
          const storeProjection = loadFinalizationProjection(root, goalId);
          const manifest = buildObligationFinalizationManifest({ projection: storeProjection.projection, storeProjection, worldSnapshot: world, conditionValidity: evaluateConditionGraph({ projection: storeProjection.projection, worldSnapshot: world }).conditions, resourceInventory: world.resources });
          if (!manifest.complete || typeof finalReviewProvider !== "function") return JSON.stringify({ goalId, runtimeState: projection.runtimeState, readiness: projection.readiness, status: "R11_FINALIZATION_REQUIRED", blocking: frontier.blocking, attention: frontier.attention, progressLedger: projection.progressLedger });
          const pair = finalApprovalPair(goalId, sessionId, manifest, ctx);
          if (pair?.choice === "reject") { persistMetadata(finalIntentType, finalIntent(manifest, sessionId)); return JSON.stringify({ goalId, runtimeState: projection.runtimeState, readiness: projection.readiness, status: "APPROVAL_REQUIRED", machineAction: null }); }
          if (pair?.choice === "approve") {
            const machineAction = { tool: "goal_finalize", params: { goal_id: goalId, approval_entry_id: pair.message.id } };
            const offer = issueActionOffer(projection, machineAction, sessionId);
            projection = appendEventFn(root, makeGoalEvent("goal.action_offered", offer, goalId, projection), projection.version);
            return JSON.stringify({ goalId, status: "APPROVAL_REQUIRED", machineAction, action_token: offer.token });
          }
          const pending = ctx.sessionManager?.getBranch?.()?.filter((entry) => exactFinalIntent(entry, goalId, sessionId) && entry.data.manifestHash === manifest.manifestHash && entry.data.stateHash === manifest.stateHash && entry.data.worldHash === manifest.worldHash && entry.data.head === manifest.head) || [];
          if (!pending.length) persistMetadata(finalIntentType, finalIntent(manifest, sessionId));
          return JSON.stringify({ goalId, status: "APPROVAL_REQUIRED", machineAction: null });
        }
        const fullSuspensionClosure = projection.suspension?.resourcesQuarantined
          && projection.suspension.terminalProofRefs?.length === projection.suspension.affectedRunIds?.length
          && projection.suspension.workspaceClosureProofRefs?.length === projection.suspension.affectedTaskIds?.length
          && projection.suspension.resourceClosureProofRefs?.length === projection.suspension.affectedRunIds?.length;
        if (selected && ["goal_dispatch", "goal_settle", "goal_integrate", "goal_accept", "goal_amend"].includes(selected.tool)
          && !(selected.tool === "goal_amend" && selected.params.operation === "resume_runtime" && (!fullSuspensionClosure || projection.pendingHumanDecision))) {
          const machineAction = { tool: selected.tool, params: { goal_id: goalId, ...selected.params } };
          const offer = issueActionOffer(projection, machineAction, sessionId);
          appendEventFn(root, makeGoalEvent("goal.action_offered", offer, goalId, projection), projection.version);
          return JSON.stringify({ goalId, runtimeState: projection.runtimeState, readiness: projection.readiness, machineAction, action_token: offer.token, attention: frontier.attention, blocking: frontier.blocking, progressLedger: projection.progressLedger });
        }
        return JSON.stringify({ goalId, runtimeState: projection.runtimeState, readiness: projection.readiness, attention: frontier.attention, blocking: frontier.blocking, progressLedger: projection.progressLedger });
      }
      if (!enforceActionTokens) return statusResponse(projection, cwd, root);
      if (projection.sessionBindings?.some((binding) => binding.sessionId === sessionId && binding.state === "detached")) {
        return statusResponse(projection, cwd, root);
      }
      const metadata = metadataState(projection, sessionId);
      const transfer = [...transferChallenges.values()].find((record) => record.challenge?.goalId === goalId && record.challenge?.toSessionId === sessionId);
      const transferState = transfer ? transferChallengeState(transfer, projection, sessionId, cwd) : null;
      let orphanDecision = null;
      let orphanAction = null;
      for (const [taskId] of projection.tasks) {
        const attempt = nextDispatchAttempt(projection, taskId);
        if (attempt === null) continue;
        const inventory = inspectOrphanedExecutorWorkspace({ goalId, taskId, attempt, originRoot: cwd, stateRoot: root });
        if (inventory.kind === "none") continue;
        if (inventory.kind !== "verified") { orphanDecision = { status: "REINSPECTION_REQUIRED", goalId, taskId, attempt }; break; }
        const record = orphanRecord(goalId, taskId, attempt, sessionId, inventory);
        const challenge = record.challenge;
        if (record.decision && !record.stale && !record.consumed && record.decision.choice && challenge.inventoryHash === stableHash(inventory)) {
          orphanDecision = { status: "DECIDED", goalId, taskId, attempt, challenge_id: challenge.id, inventory: challenge.inventory, inventory_hash: challenge.inventoryHash, choice: record.decision.choice };
          orphanAction = { tool: "goal_integrate", params: { goal_id: goalId, task_id: taskId, action: record.decision.choice } };
        } else orphanDecision = { status: "AWAITING_USER_DECISION", goalId, taskId, attempt, challenge_id: challenge.id, inventory: challenge.inventory, inventory_hash: challenge.inventoryHash, choices: ["discard", "preserve"] };
        break;
      }
      const machineAction = transferState === "APPROVED" && workspaceReleased(projection)
        ? { tool: "goal_amend", params: { goal_id: goalId, operation: "transfer_session", challenge_id: transfer.challenge.id, reason: transfer.challenge.reason } }
        : metadata?.status === "APPROVED"
          ? { tool: "goal_amend", params: { goal_id: goalId, operation: "update_goal", challenge_id: metadata.record.challenge.id } }
          : metadata?.status === "AWAITING_USER_DECISION" || metadata?.status === "REPROPOSE_REQUIRED"
            ? null
            : orphanAction || machineActionForProjection(projection, cwd, root);
      let actionToken = null;
      if (machineAction) {
        const offer = issueActionOffer(projection, machineAction, sessionId);
        projection = appendEventFn(root, makeGoalEvent("goal.action_offered", offer, goalId, projection), projection.version);
        actionToken = offer.token;
      }
      const response = statusResponse(projection, cwd, root, { machineAction, actionToken });
      if (recoveryLatch?.state === "active" || recoveryLatch?.goalId) {
        const clearedLatch = { state: "cleared", goalId, epoch: projection.epoch };
        pi.appendEntry?.("goal-engine-recovery-latch", clearedLatch);
        recoveryLatch = clearedLatch;
      }
      if (!metadata && !orphanDecision) return response;
      const parsed = JSON.parse(response);
      if (metadata) parsed.metadataDecision = { status: metadata.status };
      if (orphanDecision) parsed.orphanDecision = orphanDecision;
      return JSON.stringify(parsed, null, 2);
    },
  });

  registerGoalTool(pi, {
    name: "goal_dispatch",
    description: "当 goal_status 显示 task 的 requiredNextAction 为 goal_dispatch/runnable 且无未释放 workspace 时使用；原样交付 typed subagent contract。不要自行拼 prompt 或重复派 active task。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        task_id: { type: "string" },
        timeout_ms: { type: "integer", description: "executor 超时（默认 30min）" },
        action_token: { type: "string" },
      },
      required: ["task_id", "action_token"],
    },
    async handler(params, ctx) {
      const { cwd, root, storage } = executionScopeFor(ctx, { operation: "mutate", goalId: params.goal_id });
      const goalId = resolveGoalId(params.goal_id, root, ctx);
      if (!goalId) throw new Error("No active goal");
      let projection = loadProjectionFn(root, goalId);
      projection = consumeOfferedAction(projection, params, "goal_dispatch", goalId, ctx, root);
      const task = projection.tasks.get(params.task_id);
      if (!task) throw new Error(`unknown task: ${params.task_id}`);

      if (task.status !== "pending") {
        throw new Error(`task is not runnable (not pending): ${task.status}`);
      }
      const unmetDeps = task.deps.filter((dep) => projection.tasks.get(dep)?.status !== "accepted");
      if (unmetDeps.length > 0) {
        throw new Error(`task is not runnable: dependency not accepted (${unmetDeps.join(", ")})`);
      }
      const candidateAttempt = nextDispatchAttempt(projection, params.task_id);
      if (candidateAttempt === null) {
        throw new Error("existing workspace must be disposed, discarded, and released before redispatch");
      }

      assertRepositoryPreflight(cwd, {
        operation: "goal_dispatch",
        requiredNextAction: { tool: "goal_dispatch", params: { goal_id: goalId, task_id: params.task_id } },
        stateStorage: storage,
      });
      try {
        validateProjectionForDispatch(projection, cwd);
      } catch (error) {
        const remediation = "inspect the authoritative projection with goal_status; then prepare a complete goal_amend (including reason and update payload) before retrying goal_dispatch";
        throw preflightError("INVALID_TASK_CONTRACT", error.message, remediation, { tool: "goal_status", params: { goal_id: goalId } });
      }

      const attempt = candidateAttempt;
      assertNoOrphanedExecutorWorkspace(goalId, params.task_id, attempt, cwd, root);
      const baseCommit = gitHead(cwd);
      const lease = allocateExecutorWorkspace({
        goalId,
        taskId: params.task_id,
        attempt,
        originRoot: cwd,
        stateRoot: root,
        baseCommit,
      });

      let contract;
      try {
        contract = compileTaskContract(projection, params.task_id, lease.path, {
          timeoutMs: params.timeout_ms || 30 * 60 * 1000,
        });
      } catch (err) {
        try {
          releaseExecutorWorkspace(lease, { disposition: "failed-cleanup", expectedExecutorHead: lease.baseCommit });
        } catch (cleanupErr) {
          throw new Error(`${err.message}; workspace cleanup also failed: ${cleanupErr.message}`, { cause: err });
        }
        throw err;
      }

      const event = makeGoalEvent("task.dispatched", {
        taskId: params.task_id,
        contractHash: contract.hash,
        workspace: {
          attempt,
          path: lease.path,
          branch: lease.branch,
          baseCommit,
          originRef: lease.originRef,
        },
      }, goalId, projection);
      try {
        appendEventFn(root, event, projection.version);
      } catch (err) {
        const outcome = classifyDispatchAppendFailure(
          loadProjectionFn, root, goalId, params.task_id, projection, attempt, contract, lease,
        );
        if (outcome === "committed") {
          activeLeases.set(leaseKey(cwd, goalId, params.task_id), lease);
        } else if (outcome === "not_committed") {
          try {
            releaseExecutorWorkspace(lease, { disposition: "failed-cleanup", expectedExecutorHead: lease.baseCommit });
          } catch (cleanupErr) {
            throw new Error(`${err.message}; workspace cleanup also failed: ${cleanupErr.message}`, { cause: err });
          }
          throw err;
        } else {
          try {
            markExecutorWorkspaceCleanupDebt(lease, "dispatch event append outcome is ambiguous; retain workspace for recovery");
          } catch (cleanupError) {
            throw new Error(`${err.message}; managed cleanup debt could not be persisted: ${cleanupError.message}`, { cause: err });
          }
          throw ambiguousDispatchCommitError(goalId, params.task_id, attempt, err);
        }
      }

      activeLeases.set(leaseKey(cwd, goalId, params.task_id), lease);

      const transport = enforceActionTokens ? splitDispatchEnvelope(contract) : { contract, contractHash: contract.hash };
      return JSON.stringify({
        status: "dispatched",
        task_id: params.task_id,
        contract: transport.contract,
        ...(enforceActionTokens ? { contract_hash: transport.contractHash } : {}),
        workspace: { attempt, path: lease.path, branch: lease.branch, baseCommit: lease.baseCommit, originRef: lease.originRef },
      });
    },

  });

  registerGoalTool(pi, {
    name: "goal_settle",
    description: "当 executor 已终止且有真实结果或工件时使用；记录结果，succeeded 必须有 evidence。不要在运行中 settle、编造证据或把命令字符串当 artifact。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        task_id: { type: "string" },
        outcome: { type: "string", enum: ["succeeded", "failed", "blocked"] },
        evidence: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["diff", "file", "test_output", "screenshot", "log", "external_review"] },
            ref: { type: "string", description: "diff/log 引用" },
            path: { type: "string", description: "文件/报告路径" },
          },
          required: ["type"],
        },
        evidence_source: { type: "string", enum: ["self_produced", "pre_existing", "external"] },
        subagent_evidence: { type: "object" },
        main_verification: { type: "object" },
        next_action: { type: "string", description: "下一步具体动作（≥20字符，禁止模糊词）" },
        reason: { type: "string", description: "blocked 时的原因" },
        action_token: { type: "string" },
      },
      required: ["task_id", "outcome", "next_action", "action_token"],
    },
    async handler(params, ctx) {
      const { cwd, root } = executionScopeFor(ctx, { operation: "mutate", goalId: params.goal_id });
      const goalId = resolveGoalId(params.goal_id, root, ctx);
      if (!goalId) throw new Error("No active goal");
      let projection = loadProjectionFn(root, goalId);
      projection = consumeOfferedAction(projection, params, "goal_settle", goalId, ctx, root);

      const settlementData = {
        taskId: params.task_id,
        outcome: params.outcome,
        evidence: params.evidence || null,
        evidenceSource: params.evidence_source || "self_produced",
        nextAction: params.next_action,
        reason: params.reason || null,
      };
      const task = projection.tasks.get(params.task_id);
      if (params.outcome === "succeeded") validateNextAction(params.next_action);
      if (projection.eventSchemaVersion === PLANNED_SCHEMA_VERSION && task) {
        let proof = null;
        try { proof = await inspectExecutorProofFn(task.executorBinding?.runId); } catch { /* mapped to a stable missing-proof boundary below */ }
        settlementData.executorProof = assertExecutorSettlementProof({ task, proof });
      }
      // Validate semantic reducer errors before touching Git. A non-empty sentinel
      // exercises strict settlement binding without claiming persisted Git identity.
      if (params.outcome === "succeeded") {
        settlementData.attempt = task?.workspace?.attempt ?? 1;
        settlementData.executorHead = "candidate-settlement-validation";
      }
      if (projection.eventSchemaVersion !== PLANNED_SCHEMA_VERSION) {
        try { applyEvent(projection, makeGoalEvent("task.settled", settlementData, goalId, projection)); }
        catch (error) {
          if (params.outcome === "succeeded" && task?.status === "dispatched" && /workspace is required/i.test(error.message)) throw workspaceMutationError(error, { tool: "goal_status", params: { goal_id: goalId } });
          throw error;
        }
      }
      if (params.outcome === "succeeded") {
        if (!task) throw new Error(`unknown task: ${params.task_id}`);
        const retry = { tool: "goal_status", params: { goal_id: goalId } };
        const remediation = "return to the same Executor worktree, create an authorized commit and make it clean, then retry goal_settle";
        let lease;
        let inspection;
        try {
          lease = resolveLease(task, goalId, params.task_id, cwd, root);
          inspection = inspectExecutorWorkspaceFn(lease);
        } catch (error) {
          throw workspaceMutationError(error, retry);
        }
        if (!inspection.descendant) {
          throw preflightError("EXECUTOR_COMMIT_RANGE_INVALID", `workspace=${lease.path}; descendant=false`, remediation, retry);
        }
        if (inspection.aheadCount === 0) {
          throw preflightError("EXECUTOR_COMMIT_REQUIRED", `workspace=${lease.path}; aheadCount=0`, remediation, retry);
        }
        if (!inspection.treeChanged) {
          throw preflightError("EXECUTOR_COMMIT_RANGE_EMPTY", `workspace=${lease.path}; aheadCount=${inspection.aheadCount}; treeChanged=false`, remediation, retry);
        }
        if (!inspection.clean) {
          throw preflightError("EXECUTOR_WORKSPACE_DIRTY", `workspace=${lease.path}; dirtyFiles=${inspection.dirtyFiles.join(",")}; untrackedFiles=${inspection.untrackedFiles.join(",")}`, remediation, retry);
        }
        try {
          assertWorkspaceChangesWithinPaths(inspection, task.writePaths);
        } catch (error) {
          throw preflightError("EXECUTOR_WRITE_PATH_VIOLATION", `workspace=${lease.path}; changedFiles=${inspection.changedFiles.join(",")}; ${error.message}`, remediation, retry);
        }
        let confirmedInspection;
        try {
          confirmedInspection = inspectExecutorWorkspaceFn(lease);
        } catch (error) {
          if (isInspectionInternalHeadDrift(error)) {
            throw settlementIdentityError("EXECUTOR_SETTLEMENT_HEAD_MISMATCH", `workspace=${lease.path}; inspection=${error.message}`, retry, "return to the same Executor worktree, verify the same Executor worktree HEAD and cleanliness, then retry goal_settle");
          }
          throw workspaceMutationError(error, retry);
        }
        if (!inspectionSnapshotsMatch(inspection, confirmedInspection)) {
          throw settlementIdentityError("EXECUTOR_SETTLEMENT_HEAD_MISMATCH", `workspace=${lease.path}; firstHead=${inspection.headCommit}; observedHead=${confirmedInspection.headCommit}; firstClean=${inspection.clean}; observedClean=${confirmedInspection.clean}`, retry, "return to the same Executor worktree, verify the same Executor worktree HEAD and cleanliness, then retry goal_settle");
        }
        settlementData.attempt = lease.attempt;
        settlementData.executorHead = confirmedInspection.headCommit;
        if (projection.eventSchemaVersion === PLANNED_SCHEMA_VERSION) {
          const identity = { goalId, taskId: params.task_id, runId: task.executorBinding.runId, attempt: lease.attempt, contractHash: task.contractHash, head: confirmedInspection.headCommit };
          const criteria = task.acceptance.criteria.map((criterion) => criterion.id);
          const subagent = readChildSettlementEvidence(task, params.subagent_evidence, identity, criteria);
          const main = normalizeSettlementEvidence(params.main_verification, { expectedIdentity: identity, expectedCriteria: criteria, outcome: "succeeded" });
          assertIndependentSettlementEvidence(subagent, main);
          const subagentFingerprint = fingerprintSettlementEvidence(subagent, { expectedIdentity: identity, expectedCriteria: criteria, outcome: "succeeded" });
          const mainFingerprint = fingerprintSettlementEvidence(main, { expectedIdentity: identity, expectedCriteria: criteria, outcome: "succeeded" });
          const content = `${JSON.stringify({ main, mainSessionId: settlementData.executorProof.rootSessionId, schemaVersion: "goal-engine.settlement-evidence.v1", subagent }, null, 2)}\n`;
          const sha256 = createHash("sha256").update(content).digest("hex");
          settlementData.settlementEvidence = { schemaVersion: "goal-engine.settlement-evidence.v1", path: `acceptance-evidence/sha256/${sha256}.yaml`, sha256, subagentFingerprint, mainFingerprint, subagent, main, mainSessionId: settlementData.executorProof.rootSessionId };
          settlementData._artifact = { sha256, content };
        }
      }
      const { _artifact, ...eventData } = settlementData;
      const plannedEventData = projection.eventSchemaVersion === PLANNED_SCHEMA_VERSION && params.outcome === "succeeded"
        ? (({ taskId, outcome, attempt, executorHead, executorProof, settlementEvidence }) => ({ taskId, outcome, attempt, executorHead, executorProof, settlementEvidence }))(eventData)
        : eventData;
      const settleEvent = makeGoalEvent("task.settled", plannedEventData, goalId, projection);
      const cpEvent = makeGoalEvent("goal.checkpoint", { nextAction: params.next_action }, goalId, projection);
      projection = _artifact ? appendEventBatchWithSettlementEvidence(root, [settleEvent, cpEvent], projection.version, _artifact) : appendEventBatchFn(root, [settleEvent, cpEvent], projection.version);

      turnsSinceSettle = 0;

      return JSON.stringify({
        status: params.outcome,
        task_id: params.task_id,
        runnable: runnableFrontier(projection),
        progress: goalProgress(projection),
      });
    },
  });

  registerGoalTool(pi, {
    name: "goal_accept",
    description: "当 task succeeded、机械验收通过且 workspace 已 integrated+released 时，或重试同一验收确认时使用；验收 task 并可完成 goal。不要只凭 executor completed 声明。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        task_id: { type: "string" },
        action_token: { type: "string" },
      },
      required: ["task_id", "action_token"],
    },
    async handler(params, ctx) {
      const { root } = executionScopeFor(ctx, { operation: "mutate", goalId: params.goal_id });
      // Terminal goals are deliberately addressable only by explicit identity.
      if (!params.goal_id) {
        const activeGoalId = resolveGoalId(null, root, ctx);
        if (!activeGoalId) throw new Error("No active goal");
        params = { ...params, goal_id: activeGoalId };
      }
      const goalId = params.goal_id;
      let projection = loadProjectionFn(root, goalId);
      if (projection?.goalId !== goalId) throw ambiguousAcceptCommitError(goalId, params.task_id);
      projection = consumeOfferedAction(projection, params, "goal_accept", goalId, ctx, root);
      let task = projection.tasks.get(params.task_id);
      if (!task) throw new Error(`unknown task: ${params.task_id}`);

      const respond = (current, verdict = null) => JSON.stringify({
        status: "accepted", task_id: params.task_id,
        goal_complete: generationCapabilities(current.eventSchemaVersion).completion === "goal-finalize"
          ? false
          : current.lifecycle === "completed" || goalProgress(current).accepted === goalProgress(current).total,
        ...(verdict ? { completion_verdict: verdict } : {}), progress: goalProgress(current),
      });
      const reloadAfterFailure = (cause, committed) => {
        let recovered;
        try { recovered = loadProjectionFn(root, goalId); }
        catch { throw ambiguousAcceptCommitError(goalId, params.task_id, cause); }
        if (recovered?.goalId !== goalId || !recovered.tasks?.has(params.task_id)) {
          throw ambiguousAcceptCommitError(goalId, params.task_id, cause);
        }
        if (committed(recovered)) return recovered;
        if (recovered.version === projection.version) throw cause;
        throw ambiguousAcceptCommitError(goalId, params.task_id, cause);
      };

      if (projection.lifecycle === "completed") {
        // The persisted terminal verdict is historical authority: evidence classification
        // may evolve after this projection was completed.
        const verdict = projection.completionVerdict;
        if (task.status !== "accepted" || !["COMPLETE", "DONE_WITHOUT_EXTERNAL_VERIFICATION"].includes(verdict)) {
          throw ambiguousAcceptCommitError(goalId, params.task_id);
        }
        return respond(projection, verdict);
      }
      if (projection.lifecycle !== "active") throw new Error(`goal is not active: ${projection.lifecycle}`);

      if (task.status === "succeeded") {
        const acceptEvent = makeGoalEvent("task.accepted", { taskId: params.task_id, workspaceAttempt: task.workspace?.attempt }, goalId, projection);
        const afterAccept = applyEvent(projection, acceptEvent);
        const runtimeFinalize = generationCapabilities(projection.eventSchemaVersion).completion === "goal-finalize";
        const transitionPlans = runtimeFinalize
          ? [...afterAccept.repairEpisodes.values()]
            .filter((episode) => episode.status === "waiting_for_tasks" && episode.remediationTaskIds.includes(params.task_id))
            .map((episode) => ({
              episodeId: episode.episodeId,
              events: repairEpisodeTransition({ projection: afterAccept, episodeId: episode.episodeId, event: { type: "task.accepted", taskId: params.task_id } }).events,
            }))
          : [];
        const transitions = transitionPlans
          .flatMap((plan) => plan.events)
          .map(({ type, data }) => makeGoalEvent(type, data, goalId, afterAccept));
        try {
          projection = runtimeFinalize
            ? appendEventBatchFn(root, [acceptEvent, ...transitions], projection.version)
            : goalProgress(afterAccept).accepted === goalProgress(afterAccept).total
              ? appendEventBatchFn(root, [acceptEvent, makeGoalEvent("goal.completed", { verdict: completionVerdictFor(afterAccept) }, goalId, projection)], projection.version)
              : appendEventFn(root, acceptEvent, projection.version);
        } catch (cause) {
          projection = reloadAfterFailure(cause, (recovered) => recovered.tasks.get(params.task_id)?.status === "accepted"
            && transitionPlans.filter((plan) => plan.events.length > 0)
              .every((plan) => recovered.repairEpisodes.get(plan.episodeId)?.status === "reverifying"));
        }
        task = projection.tasks.get(params.task_id);
      } else if (task.status !== "accepted") {
        throw new Error(`task is not succeeded or accepted: ${params.task_id} (${task.status})`);
      }

      const progress = goalProgress(projection);
      if (generationCapabilities(projection.eventSchemaVersion).completion === "goal-finalize") return respond(projection);
      if (progress.accepted !== progress.total) return respond(projection);
      if (projection.lifecycle === "completed") return respond(projection, projection.completionVerdict);
      const verdict = completionVerdictFor(projection);
      try {
        projection = appendEventFn(root, makeGoalEvent("goal.completed", { verdict }, goalId, projection), projection.version);
      } catch (cause) {
        projection = reloadAfterFailure(cause, (recovered) => recovered.lifecycle === "completed"
          && recovered.tasks.get(params.task_id)?.status === "accepted"
          && recovered.completionVerdict === verdict);
      }
      if (projection.lifecycle !== "completed" || projection.completionVerdict !== verdict) {
        throw ambiguousAcceptCommitError(goalId, params.task_id);
      }
      return respond(projection, verdict);
    },
  });

  registerGoalTool(pi, {
    name: "goal_finalize",
    description: "终局工具 ABI 已冻结；R1 中所有现有 generation 均在任何评审、事件或资源副作用前拒绝，R11 才接通 runtime 终审。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        action_token: { type: "string" },
        approval_entry_id: { type: "string" },
      },
      required: ["action_token", "approval_entry_id"],
      additionalProperties: false,
    },
    async handler(params, ctx) {
      const { root } = executionScopeFor(ctx, { operation: "read", goalId: params.goal_id });
      const goalId = resolveGoalId(params.goal_id, root, ctx);
      let projection = goalId ? loadProjectionFn(root, goalId) : null;
      if (!projection || projection.eventSchemaVersion !== "goal-runtime.v1") return finalizeGoal(projection);
      if (typeof finalReviewProvider !== "function") throw new Error("FINAL_REVIEW_PROVIDER_UNAVAILABLE");
      if (!exactPlainObject(params, ["goal_id", "action_token", "approval_entry_id"])) throw new Error("invalid goal_finalize parameters");
      const sessionId = sessionIdentity(ctx);
      const offer = projection.actionOffer;
      if (!offer || offer.tool !== "goal_finalize" || offer.sessionId !== sessionId || offer.params?.goal_id !== goalId || offer.params?.approval_entry_id !== params.approval_entry_id) throw new Error("invalid finalization offer");
      let consumed = offer.consumed === true;
      if (!consumed) {
        const receipt = verifyAndConsumeActionOffer(projection, { token: params.action_token, tool: "goal_finalize", params: offer.params, sessionId });
        projection = appendEventFn(root, makeGoalEvent("goal.action_consumed", receipt, goalId, projection), projection.version);
        consumed = true;
      } else if (params.action_token !== offer.token) throw new Error("invalid finalization token");
      const world = runtimeHost?.captureCurrentWorld?.({ cwd: ctx.cwd });
      if (!world?.safe) throw new Error("FINALIZATION_WORLD_UNAVAILABLE");
      const baseVersion = offer.projectionVersion - 1;
      const base = loadFinalizationProjection(root, goalId, { version: baseVersion });
      const manifest = buildObligationFinalizationManifest({ projection: base.projection, storeProjection: base, worldSnapshot: world, conditionValidity: evaluateConditionGraph({ projection: base.projection, worldSnapshot: world }).conditions, resourceInventory: world.resources });
      const approval = { entryId: params.approval_entry_id, sessionId, source: "user" };
      let review = projection.finalReview;
      if (!review) {
        const pair = finalApprovalPair(goalId, sessionId, manifest, ctx);
        if (!pair || pair.choice !== "approve" || pair.message.id !== params.approval_entry_id || !manifest.complete) throw new Error("invalid final review approval");
        const reviewId = `review-${canonicalHash({ goalId, manifestHash: manifest.manifestHash, stateHash: manifest.stateHash, worldHash: manifest.worldHash, head: manifest.head, approval })}`;
        const started = makeEvent("goal.final_review_started", { reviewId, manifestHash: manifest.manifestHash, stateHash: manifest.stateHash, worldHash: manifest.worldHash, head: manifest.head, approval }, goalId, "goal-runtime.v1");
        projection = appendEventFn(root, started, projection.version); review = projection.finalReview;
      }
      const reviewStore = createFinalReviewFileStore({ stateRoot: root });
      const result = await runRecoverableFinalReview({ manifest, approval, provider: finalReviewProvider, reviewStore });
      if (result.status === "failed") throw Object.assign(new Error("FINAL_REVIEW_PROVIDER_FAILED"), { code: "FINAL_REVIEW_PROVIDER_FAILED" });
      const current = loadProjectionFn(root, goalId);
      const freshWorld = runtimeHost?.captureCurrentWorld?.({ cwd: ctx.cwd });
      let freshManifest = null;
      if (freshWorld?.safe) {
        const freshBase = loadFinalizationProjection(root, goalId, { version: baseVersion });
        freshManifest = buildObligationFinalizationManifest({ projection: freshBase.projection, storeProjection: freshBase, worldSnapshot: freshWorld, conditionValidity: evaluateConditionGraph({ projection: freshBase.projection, worldSnapshot: freshWorld }).conditions, resourceInventory: freshWorld.resources });
      }
      const sameManifest = freshManifest?.complete === true
        && ["manifestHash", "stateHash", "worldHash", "head"].every((field) => freshManifest[field] === manifest[field]);
      const sameReview = result.reviewId === current.finalReview?.reviewId
        && ["manifestHash", "stateHash", "worldHash", "head"].every((field) => current.finalReview?.[field] === manifest[field])
        && current.finalReview?.approval?.entryId === approval.entryId
        && current.finalReview?.approval?.sessionId === approval.sessionId;
      const stale = current.version !== projection.version || !sameManifest || !sameReview;
      const recorded = makeEvent("goal.final_review_recorded", { reviewId: result.reviewId, resultHash: result.resultHash, severity: result.severity, status: stale && ["none", "minor"].includes(result.severity) ? "stale" : result.status }, goalId, "goal-runtime.v1");
      if (stale || ["important", "critical"].includes(result.severity)) { appendEventFn(root, recorded, current.version); return { status: stale ? "stale" : "changes_required" }; }
      const completed = makeEvent("goal.completed", { verdict: "COMPLETE", reviewId: result.reviewId, manifestHash: current.finalReview.manifestHash, stateHash: current.finalReview.stateHash, worldHash: current.finalReview.worldHash, head: current.finalReview.head, resultHash: result.resultHash }, goalId, "goal-runtime.v1");
      try { appendEventBatchFn(root, [recorded, completed], current.version); } catch (error) { const recovered = loadProjectionFn(root, goalId); if (recovered?.lifecycle !== "completed") throw error; }
      return { status: "completed" };
    },
  });

  registerGoalTool(pi, {
    name: "goal_amend",
    description: "当人类明确改范围/DAG，或 blocked/preserved 需调整计划时使用；只改安全 pending task。不要用于正常推进或绕过门禁。",
    parameters: goalAmendSchema,
    prepareInExecute: enforceActionTokens,
    prepareArguments(args) {
      const prepared = !args || typeof args !== "object" || args.operation !== undefined ? args : { ...args, operation: "patch_active" };
      validateSchema(goalAmendSchema, prepared);
      return prepared;
    },
    async handler(params, ctx) {
      const { cwd, root } = executionScopeFor(ctx, { operation: "mutate", goalId: params.goal_id });
      const transferOperation = params.operation === "propose_transfer_session" || params.operation === "transfer_session";
      // Transfer is the sole unowned exception: it always requires an explicit ID,
      // and never grants normal projection authority to the target session.
      const goalId = transferOperation ? params.goal_id : resolveGoalId(params.goal_id, root, ctx);
      if (!goalId) throw new Error("No active goal");
      let projection = loadProjectionFn(root, goalId);
      if (!projection || (!transferOperation && !ownedBySession(projection, sessionIdentity(ctx)))) throw new Error("No active goal");
      if (params.operation === "propose_transfer_session") {
        const inventory = listCwdGoals(loadAllProjections(root), sessionIdentity(ctx));
        const item = inventory.find((candidate) => candidate.goalId === goalId);
        if (!item) throw new Error("transfer requires a visible goal");
        if (item.transferBlockedReason) throw new Error(`transfer blocked: ${item.transferBlockedReason}`);
        const challenge = buildTransferChallenge({ projection, toSessionId: sessionIdentity(ctx), reason: params.reason, cwd });
        persistMetadata("goal-engine-session-transfer-challenge", challenge);
        transferChallenges.set(challenge.id, { challenge });
        return JSON.stringify({ status: "TRANSFER_PENDING", challenge_id: challenge.id });
      }
      if (params.operation === "propose_update_goal") {
        const baseMetadata = { objective: projection.objective, scope: projection.scope, nonGoals: projection.nonGoals, dod: projection.dod };
        const targetMetadata = { ...baseMetadata, ...params.changes, ...(params.changes.non_goals !== undefined ? { nonGoals: params.changes.non_goals } : {}) };
        delete targetMetadata.non_goals;
        const challenge = { id: crypto.randomUUID(), kind: "goal_metadata_approval", goalId, sessionId: sessionIdentity(ctx), requestedAt: new Date().toISOString(), baseVersion: projection.version, reason: params.reason, baseMetadata, targetMetadata, proposalHash: hashGoalMetadataProposal(targetMetadata), choices: ["approve", "reject"], proposalPresented: true };
        persistMetadata("goal-engine-metadata-challenge", challenge);
        metadataChallenges.set(challenge.id, { challenge });
        const publicMetadata = (metadata) => ({ objective: metadata.objective, scope: metadata.scope, non_goals: metadata.nonGoals, dod: metadata.dod });
        return JSON.stringify({ status: "METADATA_PROPOSAL_PENDING", challenge_id: challenge.id, reason: challenge.reason, base_metadata: publicMetadata(baseMetadata), target_metadata: publicMetadata(targetMetadata), proposal_hash: challenge.proposalHash, choices: challenge.choices });
      }
      const currentSessionId = sessionIdentity(ctx);
      if (params.operation === "resume_runtime") {
        const closure = projection.suspension;
        const closed = closure?.resourcesQuarantined
          && closure.terminalProofRefs?.length === closure.affectedRunIds?.length
          && closure.workspaceClosureProofRefs?.length === closure.affectedTaskIds?.length
          && closure.resourceClosureProofRefs?.length === closure.affectedRunIds?.length;
        if (projection.eventSchemaVersion !== "goal-runtime.v1" || projection.runtimeState !== "suspended" || !closed || projection.pendingHumanDecision) {
          throw new Error("resume_runtime requires a fully closed suspended runtime without a pending decision");
        }
        const offer = projection.actionOffer;
        if (!offer) throw new Error("goal_status must issue an action offer before goal_amend");
        const boundParams = { goal_id: goalId, operation: "resume_runtime" };
        const consumed = verifyAndConsumeActionOffer(projection, { token: params.action_token, tool: "goal_amend", params: boundParams, sessionId: currentSessionId });
        const events = [
          makeGoalEvent("goal.action_consumed", consumed, goalId, projection),
          makeEvent("goal.runtime_resumed", { suspensionId: closure.suspensionId, closureHash: suspensionClosureHash(closure) }, goalId, "goal-runtime.v1"),
        ];
        const expected = events.reduce((candidate, next) => applyEvent(candidate, next), projection);
        try { projection = appendEventBatchFn(root, events, projection.version); }
        catch (cause) {
          const recovered = loadProjectionFn(root, goalId);
          if (!isDeepStrictEqual(recovered, expected)) throw cause;
          projection = recovered;
        }
        return JSON.stringify({ goalId, status: "RUNTIME_RESUMED" });
      }
      if (params.operation === "propose_execution_change") {
        const closure = projection.suspension;
        if (projection.eventSchemaVersion !== "goal-runtime.v1" || projection.runtimeState !== "suspended" || !closure?.resourcesQuarantined
          || closure.terminalProofRefs?.length !== closure.affectedRunIds?.length || closure.workspaceClosureProofRefs?.length !== closure.affectedTaskIds?.length
          || closure.resourceClosureProofRefs?.length !== closure.affectedRunIds?.length || (projection.pendingHumanDecision && projection.pendingHumanDecision.phase !== "rejected")) throw new Error("execution amendment requires a fully closed suspended runtime without a pending proposal");
        let proposalWorld;
        try { proposalWorld = runtimeHost.captureCurrentWorld({ cwd }); } catch { proposalWorld = null; }
        if (!proposalWorld?.safe || !proposalWorld.repo || !/^[a-f0-9]{40}$/.test(proposalWorld.repo.head || "") || proposalWorld.repo.trackedDirty?.length || proposalWorld.repo.untracked?.length || proposalWorld.repo.sequencer) throw new Error("execution amendment proposal requires a safe clean Host CurrentWorld");
        const updates = params.changes?.update_tasks;
        if (!Array.isArray(updates) || updates.length === 0 || new Set(updates.map((entry) => entry.id)).size !== updates.length) throw new Error("execution amendment update_tasks must be non-empty and unique");
        const source = {
          objective: projection.objective, scope: projection.scope, non_goals: projection.nonGoals, dod: projection.dod,
          execution: { schema: "goal-runtime.v1", tasks: [...projection.tasks].map(([id, task]) => ({ id, description: task.description, deps: task.deps, writePaths: task.writePaths, acceptance: task.acceptance, workflow: task.workflow })), conditions: [...projection.conditions.values()].map((condition) => condition.definition), write_policy: { allowed_paths: projection.writePolicy.allowedPaths }, budgets: projection.convergenceBudget },
        };
        for (const update of updates) {
          const index = source.execution.tasks.findIndex((task) => task.id === update.id);
          if (index < 0) throw new Error("unknown task in execution amendment");
          const { id, ...change } = update;
          source.execution.tasks[index] = { ...source.execution.tasks[index], ...change };
        }
        let target;
        try { target = normalizeRuntimeGoalInit(source, runtimeHost?.registries); } catch (error) { throw new Error(`invalid execution amendment: ${error.message}`); }
        for (const update of updates) {
          const task = projection.tasks.get(update.id);
          const targetTask = target.execution.tasks.find((entry) => entry.id === update.id);
          if (task?.status === "accepted" && canonicalHash(task.acceptance) !== canonicalHash(targetTask?.acceptance)) {
            throw new Error("accepted Task acceptance cannot change in an execution amendment");
          }
        }
        const changes = { update_tasks: structuredClone(updates) };
        const material = { goalId, proposalId: `execution-amendment-${crypto.randomUUID()}`, changes, changesHash: canonicalHash(changes), targetExecutionContract: target, targetContractHash: hashRuntimeExecutionContract(target), baseHead: proposalWorld.repo.head, ownerSessionId: currentSessionId, oldRevision: projection.executionRevision, newRevision: projection.executionRevision + 1 };
        const event = makeEvent("execution.amendment_proposed", { ...material, proposalHash: canonicalHash(material) }, goalId, "goal-runtime.v1");
        const updated = appendEventFn(root, event, projection.version);
        return JSON.stringify({ goalId, status: "R10B_AMENDMENT_PROPOSED", proposalId: material.proposalId });
      }
      const metadataBeforeConsume = params.operation === "update_goal" ? metadataState(projection, currentSessionId) : null;
      if (params.operation === "transfer_session") {
        const record = transferChallenges.get(params.challenge_id);
        const targetHasActiveGoal = loadAllProjections(root).some((candidate) => candidate.goalId !== goalId && candidate.lifecycle === "active" && ownerSessionId(candidate) === currentSessionId);
        if (!record?.challenge || targetHasActiveGoal || transferChallengeState(record, projection, currentSessionId, cwd) !== "APPROVED" || !workspaceReleased(projection)) throw new Error(targetHasActiveGoal ? "transfer blocked: TARGET_SESSION_HAS_ACTIVE_GOAL" : "transfer challenge is missing, stale, or unsafe");
        const offer = projection.actionOffer;
        if (!offer) throw new Error("goal_status must issue an action offer before goal_amend");
        const supplied = { goal_id: goalId, operation: params.operation, challenge_id: params.challenge_id, reason: params.reason };
        const boundParams = Object.fromEntries(Object.keys(offer.params).map((key) => [key, supplied[key]]));
        const consumed = verifyAndConsumeActionOffer(projection, { token: params.action_token, tool: "goal_amend", params: boundParams, sessionId: currentSessionId });
        const consumedEvent = makeGoalEvent("goal.action_consumed", consumed, goalId, projection);
        const transferEvent = makeGoalEvent("goal.session_transferred", { fromSessionId: record.challenge.fromOwnerSessionId, toSessionId: currentSessionId, challengeId: record.challenge.id, reason: params.reason, ownershipRevision: projection.ownershipRevision + 1 }, goalId, projection);
        const updated = appendEventBatchFn(root, [consumedEvent, transferEvent], projection.version);
        persistMetadata("goal-engine-session-transfer-consumed", { challenge_id: record.challenge.id });
        transferChallenges.set(record.challenge.id, { ...record, consumed: true });
        return statusResponse(updated, cwd, root);
      }
      if (params.operation === "detach_session") {
        if (params.session_id && params.session_id !== currentSessionId) throw new Error("detach_session may only target the current session");
        if (!projection.sessionBindings?.some((binding) => binding.sessionId === currentSessionId && binding.state === "watching")) {
          throw new Error("detach_session requires a watching binding for the current session");
        }
        const offer = projection.actionOffer;
        if (!offer) throw new Error("goal_status must issue an action offer before goal_amend");
        projection = consumeOfferedAction(projection, { ...params, ...offer.params }, offer.tool, goalId, ctx, root);
      } else {
        projection = consumeOfferedAction(projection, params, "goal_amend", goalId, ctx, root);
      }
      if (params.operation === "update_goal") {
        const state = metadataBeforeConsume;
        if (state?.status !== "APPROVED" || state.record.challenge.id !== params.challenge_id) throw new Error("metadata challenge approval is missing, stale, consumed, or mismatched");
        const { challenge, decision } = state.record;
        const event = makeGoalEvent("goal.contract_amended", { proposalHash: challenge.proposalHash, approval: { entryId: decision.id, sessionId: decision.sessionId, source: decision.source }, changes: challenge.targetMetadata }, goalId, projection);
        const updated = appendEventFn(root, event, projection.version);
        persistMetadata("goal-engine-metadata-consumed", { id: challenge.id });
        metadataChallenges.set(challenge.id, { ...state.record, consumed: true });
        return statusResponse(updated, cwd, root);
      }

      const addTasks = {};
      if (params.add_tasks) {
        for (const t of params.add_tasks) {
          addTasks[t.id] = { description: t.description, deps: t.deps || [], writePaths: t.writePaths, acceptance: t.acceptance, workflow: t.workflow || "tdd" };
        }
      }

      const amendmentEvent = () => makeGoalEvent("goal.amended", {
        reason: params.reason,
        addTasks: Object.keys(addTasks).length > 0 ? addTasks : undefined,
        removeTasks: params.remove_tasks || undefined,
        updateTasks: params.update_tasks || undefined,
      }, goalId, projection);
      const resolutionEvents = () => (params.resolve_discoveries || []).map((resolution) => makeGoalEvent("goal.discovery_resolved", {
        id: resolution.id,
        disposition: resolution.disposition,
        ...(resolution.task_id ? { taskId: resolution.task_id } : {}),
        reason: resolution.reason,
      }, goalId, projection));
      const applyAndAppendSequence = (events) => {
        let candidate = projection;
        try {
          for (const candidateEvent of events) candidate = applyEvent(candidate, candidateEvent);
          validateTaskDefinitions([...candidate.tasks.keys()], taskDefsFromProjection(candidate), {
            cwd,
            realpathCwd: realpathSync(cwd),
            planned: candidate.eventSchemaVersion === PLANNED_SCHEMA_VERSION,
          });
          assertPendingTaskContractsCompile(candidate, cwd);
        } catch (error) {
          throw initError("INVALID_GOAL_CONTRACT", error.message, "correct the typed amendment operation and retry goal_amend after goal_status");
        }
        return events.length === 1
          ? appendEventFn(root, events[0], projection.version)
          : appendEventBatchFn(root, events, projection.version);
      };

      if (params.operation === "triage") {
        if (!params.resolve_discoveries?.length) throw new Error("triage requires resolve_discoveries");
        return statusResponse(applyAndAppendSequence(resolutionEvents()), cwd, root);
      }
      if (params.operation === "reopen_completed") {
        if (params.basis?.epoch !== projection.epoch) throw new Error("reopen basis epoch does not match projection");
        if (!params.resolve_discoveries?.length || Object.keys(addTasks).length === 0) throw new Error("reopen_completed requires discoveries and add_tasks");
        const observationIds = params.basis?.discovery_ids || params.resolve_discoveries.map((resolution) => resolution.id);
        const events = [
          ...resolutionEvents(),
          makeGoalEvent("goal.reopened", { reason: params.reason, observationIds }, goalId, projection),
          amendmentEvent(),
        ];
        return statusResponse(applyAndAppendSequence(events), cwd, root);
      }
      if (params.operation === "detach_session") {
        const event = makeGoalEvent("goal.session_detached", {
          sessionId: params.session_id || sessionIdentity(ctx), reason: params.reason,
        }, goalId, projection);
        return statusResponse(applyAndAppendSequence([event]), cwd, root);
      }
      if (params.operation === "resolve_blocked") {
        const taskId = params.blocked_task_id;
        if (!taskId || !params.blocked_resolution) throw new Error("resolve_blocked requires blocked_task_id and blocked_resolution");
        const events = [makeGoalEvent("task.block_resolved", {
          taskId, resolution: params.blocked_resolution,
          ...(params.replacement_task_id ? { replacementTaskId: params.replacement_task_id } : {}),
          reason: params.reason,
        }, goalId, projection)];
        const hasAmendmentPayload = Object.keys(addTasks).length > 0
          || (params.remove_tasks?.length || 0) > 0
          || Object.keys(params.update_tasks || {}).length > 0;
        if (params.blocked_resolution === "supersede" && projection.eventSchemaVersion !== PLANNED_SCHEMA_VERSION) {
          const source = projection.tasks.get(taskId);
          const replacement = addTasks[params.replacement_task_id];
          if (replacement) {
            if (source?.status !== "blocked" || !Array.isArray(source.acceptance?.commands)) {
              throw initError("INVALID_GOAL_CONTRACT", "legacy supersede source acceptance.commands must be an array", "correct the blocked legacy task contract and retry goal_amend after goal_status");
            }
            addTasks[params.replacement_task_id] = {
              ...replacement,
              acceptance: {
                ...replacement.acceptance,
                criteria: replacement.acceptance.criteria.map((criterion) => JSON.stringify(criterion)),
                commands: [...source.acceptance.commands],
              },
            };
          }
        }
        if (params.blocked_resolution === "supersede" || hasAmendmentPayload) events.push(amendmentEvent());
        return statusResponse(applyAndAppendSequence(events), cwd, root);
      }
      if (!params.operation && enforceActionTokens) throw new Error("goal_amend operation is required");
      if (params.operation && params.operation !== "patch_active") throw new Error(`unsupported goal_amend operation: ${params.operation}`);

      const event = amendmentEvent();
      try {
        const candidate = applyEvent(projection, event);
        validateTaskDefinitions([...candidate.tasks.keys()], taskDefsFromProjection(candidate), {
          cwd,
          realpathCwd: realpathSync(cwd),
          planned: candidate.eventSchemaVersion === PLANNED_SCHEMA_VERSION,
        });
        assertPendingTaskContractsCompile(candidate, cwd);
      } catch (error) {
        throw initError("INVALID_GOAL_CONTRACT", error.message, "correct derived task, goal metadata, or requirements limits, then retry goal_amend");
      }

      const affectedTaskIds = [...new Set([
        ...(params.remove_tasks || []),
        ...Object.keys(params.update_tasks || {}),
      ])].filter((taskId) => projection.tasks.has(taskId));
      for (const taskId of affectedTaskIds) {
        const attempt = nextDispatchAttempt(projection, taskId);
        if (attempt !== null) assertNoOrphanedExecutorWorkspace(goalId, taskId, attempt, cwd, root);
      }

      const updated = appendEventFn(root, event, projection.version);
      return statusResponse(updated, cwd, root);
    },
  });

  registerGoalTool(pi, {
    name: "goal_integrate",
    description: "当已 settle 或 status 报告 verified orphan 时使用；正常 workspace 可 integrate/discard/preserve，orphan 仅 discard/preserve。不要 integrate orphan 或手工清资源。",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        task_id: { type: "string" },
        action: { type: "string", enum: ["integrate", "discard", "preserve"], description: "integrate=合回主 worktree, discard=丢弃并清理, preserve=保留 worktree 不合回" },
        strategy: { type: "string", enum: ["cherry-pick", "merge"], description: "合回策略（默认 cherry-pick）" },
        action_token: { type: "string" },
        challenge_id: { type: "string" },
      },
      required: ["task_id", "action", "action_token"],
    },
    async handler(params, ctx) {
      const { cwd, root } = executionScopeFor(ctx, { operation: "mutate", goalId: params.goal_id });
      const goalId = resolveGoalId(params.goal_id, root, ctx);
      if (!goalId) throw new Error("No active goal");

      let projection = loadProjectionFn(root, goalId);
      const taskId = params.task_id;
      // The orphan gate is checked before consuming an offer or touching workspace state.
      const pendingAttempt = nextDispatchAttempt(projection, taskId);
      let orphanAuthorization = null;
      if (enforceActionTokens && pendingAttempt !== null) {
        const inventory = inspectOrphanedExecutorWorkspace({ goalId, taskId, attempt: pendingAttempt, originRoot: cwd, stateRoot: root });
        if (inventory.kind === "verified") {
          const sessionId = sessionIdentity(ctx);
          const eligible = [...orphanChallenges.values()].filter((record) => record.challenge
            && !record.stale && !record.consumed
            && record.challenge.sessionId === sessionId
            && record.challenge.goalId === goalId
            && record.challenge.taskId === taskId
            && record.challenge.attempt === pendingAttempt
            && record.challenge.inventoryHash === stableHash(inventory)
            && record.decision?.choice === params.action);
          const record = params.challenge_id ? orphanChallenges.get(params.challenge_id) : eligible.length === 1 ? eligible[0] : null;
          if (!record || !eligible.includes(record)) throw new Error("orphan challenge authorization/action token is required");
          orphanAuthorization = record;
        }
      }
      projection = consumeOfferedAction(projection, params, "goal_integrate", goalId, ctx, root);
      let task = projection.tasks.get(taskId);
      if (!task) throw new Error(`unknown task: ${taskId}`);

      const action = params.action;
      const key = leaseKey(cwd, goalId, taskId);
      let taskWorkspace = task.workspace;

      // A pending task without a projection workspace may still own the exact
      // next-attempt workspace after an interrupted dispatch append. Recover
      // only a verified snapshot; the supplied callback is a scheduling
      // barrier, never a source of recovery facts.
      const candidateAttempt = nextDispatchAttempt(projection, taskId);
      if (candidateAttempt !== null) {
        const inspectOrphan = () => inspectOrphanedExecutorWorkspace({
          goalId, taskId, attempt: candidateAttempt, originRoot: cwd, stateRoot: root,
        }, { inspectExecutorWorkspaceFn: inspectOrphanedExecutorWorkspaceBarrier || inspectExecutorWorkspaceFn });
        const firstInventory = inspectOrphan();
        if (firstInventory.kind !== "none") {
          const unverified = (inventory) => {
            const actionState = orphanWorkspaceActionState(taskId, inventory);
            throw orphanRecoveryError(
              "ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED",
              { taskId, candidate: { attempt: candidateAttempt }, resources: inventory.resources },
              "inspect the authoritative recovery state with goal_status before any workspace action",
              { tool: "goal_status", params: { goal_id: goalId } },
              actionState.blockingReason,
            );
          };
          if (firstInventory.kind !== "verified") unverified(firstInventory);
          if (action === "integrate") {
            const actionState = orphanWorkspaceActionState(taskId, firstInventory);
            throw orphanRecoveryError(
              "ORPHANED_WORKSPACE_NOT_SETTLED",
              { taskId, candidate: { attempt: candidateAttempt }, resources: firstInventory.resources },
              "inspect the authoritative recovery state with goal_status before any workspace action",
              null,
              {
                code: "ORPHANED_WORKSPACE_NOT_SETTLED",
                requiresHumanDecision: true,
                choices: actionState.blockingReason.choices,
              },
            );
          }
          betweenOrphanInventoriesBarrier?.(firstInventory.lease);
          const secondInventory = inspectOrphan();
          if (secondInventory.kind !== "verified" && secondInventory.observed === "executor workspace identity changed during inspection") {
            unverified(secondInventory);
          }
          if (secondInventory.kind !== "verified" || !isDeepStrictEqual(firstInventory, secondInventory)) {
            throw orphanRecoveryError(
              "ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED",
              { taskId, candidate: { attempt: candidateAttempt }, resources: secondInventory.resources },
              "inspect the authoritative recovery state with goal_status before any workspace action",
              { tool: "goal_status", params: { goal_id: goalId } },
              {
                code: "ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED",
                resources: secondInventory.resources,
                observed: "executor workspace identity changed between recovery inventories",
              },
            );
          }
          const recoveryEvent = makeGoalEvent("task.workspace_orphan_recovered", {
            taskId,
            attempt: candidateAttempt,
            workspace: {
              attempt: firstInventory.lease.attempt,
              path: firstInventory.lease.path,
              branch: firstInventory.lease.branch,
              baseCommit: firstInventory.lease.baseCommit,
              originRef: firstInventory.lease.originRef,
            },
            executorHead: firstInventory.executorHead,
            reason: "verified exact orphan executor workspace recovery",
          }, goalId, projection);
          appendEventFn(root, recoveryEvent, projection.version);
          projection = loadProjectionFn(root, goalId);
          const recoveredTask = projection.tasks.get(taskId);
          if (!recoveredTask) throw new Error(`unknown task: ${taskId}`);
          task = recoveredTask;
          taskWorkspace = recoveredTask.workspace;
        }
      }
      if (!taskWorkspace || !taskWorkspace.phase) {
        throw new Error("workspace is not initialized for disposition");
      }

      const formatDispositionResponse = (dispositionWorkspace) => {
        if (action === "integrate") {
          return {
            action: "integrated",
            released: dispositionWorkspace.released,
            strategy: dispositionWorkspace.strategy || params.strategy || DEFAULT_DISPOSITION_STRATEGY,
            newHead: dispositionWorkspace.originHead || gitHead(cwd),
          };
        }
        if (action === "discard") {
          return {
            action: "discarded",
            released: dispositionWorkspace.released,
          };
        }

        return {
          action: "preserved",
          released: dispositionWorkspace.released,
          path: dispositionWorkspace.path,
          branch: dispositionWorkspace.branch,
        };
      };

      if (taskWorkspace.phase === "disposed"
        && taskWorkspace.disposition === "preserved"
        && action === "discard") {
        // A preserved workspace is historically disposed, but explicit discard is
        // a separate, durable release operation.  Inventory first so a missing
        // lease can be synthesized only after all destructive resources are gone.
        const retry = { tool: "goal_status", params: { goal_id: goalId } };
        const expectedLease = workspaceLeaseIdentityFromProjection(taskWorkspace, goalId, taskId, cwd, root);
        let resources;
        try {
          resources = inspectExecutorWorkspaceResources(expectedLease);
        } catch (error) {
          throw workspaceMutationError(error, retry);
        }
        const allResourcesPresent = resources.workspaceExists && resources.branchExists && resources.leaseExists;
        // A managed release intentionally retains its branch after removing the
        // path, registration, and Goal lease; that branch alone is not cleanup debt.
        const noResourcesPresent = !resources.workspaceExists && !resources.leaseExists;
        if (!allResourcesPresent && !noResourcesPresent) {
          if (!resources.leaseExists) {
            throw workspaceMutationError(new Error("Executor workspace persisted lease not found"), retry);
          }
          throw workspaceMutationError(new Error("preserved workspace resource inventory is partial or unknown"), retry);
        }

        if (taskWorkspace.preservedResourcesReleased === true) {
          if (!noResourcesPresent) {
            throw workspaceMutationError(new Error("preserved release is durable but workspace resources remain"), retry);
          }
          activeLeases.delete(key);
          return JSON.stringify({ action: "discarded", released: true });
        }

        if (allResourcesPresent) {
          let lease;
          let firstInspection;
          let confirmedInspection;
          try {
            // Do not permit the recovery lease fallback while any resource exists.
            lease = resolveLease(task, goalId, taskId, cwd, root, { allowSynthetic: false });
            if (currentOriginRef(cwd) !== taskWorkspace.originRef) {
              throw new Error(`workspace identity origin ref mismatch (expected ${taskWorkspace.originRef})`);
            }
            firstInspection = inspectExecutorWorkspaceFn(lease);
            confirmedInspection = inspectExecutorWorkspaceFn(lease);
          } catch (error) {
            if (isInspectionInternalHeadDrift(error)) {
              throw workspaceMutationError(new Error(`workspace identity inspection drift: ${error.message}`), retry);
            }
            throw workspaceMutationError(error, retry);
          }
          if (!inspectionSnapshotsMatch(firstInspection, confirmedInspection)
            || firstInspection.headCommit !== taskWorkspace.executorHead
            || confirmedInspection.headCommit !== taskWorkspace.executorHead) {
            throw workspaceMutationError(new Error(`workspace identity inspection mismatch: expectedHead=${taskWorkspace.executorHead}; firstHead=${firstInspection.headCommit}; secondHead=${confirmedInspection.headCommit}`), retry);
          }
          try {
            releaseExecutorWorkspace(lease, {
              disposition: "discarded-cleanup",
              expectedExecutorHead: taskWorkspace.executorHead,
              requireClean: true,
              beforeDestructiveCleanupFn: beforePreservedWorkspaceCleanupBarrier,
            });
            resources = inspectExecutorWorkspaceResources(lease);
          } catch (error) {
            throw workspaceMutationError(error, retry);
          }
          if (workspaceResourcesRemain(lease, resources)) {
            throw workspaceMutationError(new Error("failed to release preserved workspace resources"), retry);
          }
        }

        // With no resources, a retry may use projection identity only; the event
        // records the completed cleanup and is deliberately appended afterwards.
        const releaseEvent = makeGoalEvent("task.workspace_preservation_released", {
          taskId,
          attempt: taskWorkspace.attempt,
          executorHead: taskWorkspace.executorHead,
          released: true,
        }, goalId, projection);
        projection = appendEventFn(root, releaseEvent, projection.version);
        activeLeases.delete(key);
        return JSON.stringify({ action: "discarded", released: true });
      }

      if (taskWorkspace.phase === "disposed") {
        const expectedDisposition = { integrate: "integrated", discard: "discarded", preserve: "preserved" };
        if (taskWorkspace.disposition !== expectedDisposition[action]) {
          throw new Error(`workspace action mismatch (expected ${taskWorkspace.disposition}, got ${action})`);
        }

        const strategy = params.strategy || taskWorkspace.strategy || DEFAULT_DISPOSITION_STRATEGY;
        if (params.strategy !== undefined && taskWorkspace.strategy !== undefined && strategy !== taskWorkspace.strategy) {
          throw new Error(`workspace strategy mismatch (expected ${taskWorkspace.strategy}, got ${strategy})`);
        }

        const terminalLease = resolveLease(task, goalId, taskId, cwd, root, { allowSynthetic: true });
        if (currentOriginRef(cwd) !== taskWorkspace.originRef) {
          throw new Error(`Origin ref mismatch (expected ${taskWorkspace.originRef})`);
        }
        const resources = inspectExecutorWorkspaceResources(terminalLease);

        if (action === "preserve") {
          if (!(resources.workspaceExists && resources.branchExists && resources.leaseExists)) {
            throw new Error("preserve disposition requires workspace, branch, and lease to remain available");
          }
        } else if (workspaceResourcesRemain(terminalLease, resources)) {
          throw new Error("disposed workspace still has resources; manual recovery required");
        }

        activeLeases.delete(key);
        return JSON.stringify(formatDispositionResponse(taskWorkspace));
      }

      if (taskWorkspace.legacyOriginRef || !taskWorkspace.originRef) {
        throw new Error("legacy/manual recovery required: workspace disposition has no originRef");
      }
      let lease;
      let activeInspection;
      // Active mutations must classify lease/inspection failures before any origin
      // HEAD read, event append, or cleanup side effect.
      try {
        lease = resolveLease(task, goalId, taskId, cwd, root, { allowSynthetic: taskWorkspace.phase !== "active" });
        activeInspection = taskWorkspace.phase === "active" ? inspectExecutorWorkspaceFn(lease) : null;
      } catch (error) {
        if (taskWorkspace.phase === "active") {
          throw workspaceMutationError(error, { tool: "goal_status", params: { goal_id: goalId } });
        }
        throw error;
      }
      // This guard deliberately precedes every recovery probe, event append, HEAD
      // read, and cleanup action. Patch equivalence on another ref is not consent.
      if (taskWorkspace.phase === "active" && task.status === "succeeded") {
        const settlement = task.settlement;
        const retry = { tool: "goal_status", params: { goal_id: goalId } };
        if (!settlement) {
          throw settlementIdentityError("EXECUTOR_SETTLEMENT_IDENTITY_MISSING", `workspace=${lease.path}; settlement=missing`, retry);
        }
        if (settlement.attempt !== taskWorkspace.attempt || settlement.attempt !== lease.attempt || settlement.executorHead !== activeInspection.headCommit) {
          throw settlementIdentityError("EXECUTOR_SETTLEMENT_HEAD_MISMATCH", `workspace=${lease.path}; settlementAttempt=${settlement.attempt}; leaseAttempt=${lease.attempt}; settlementHead=${settlement.executorHead}; observedHead=${activeInspection.headCommit}`, retry);
        }
      }
      if (taskWorkspace.phase === "active") {
        const retry = { tool: "goal_status", params: { goal_id: goalId } };
        let confirmedInspection;
        try {
          confirmedInspection = inspectExecutorWorkspaceFn(lease);
        } catch (error) {
          if (isInspectionInternalHeadDrift(error)) {
            throw settlementIdentityError("EXECUTOR_SETTLEMENT_HEAD_MISMATCH", `workspace=${lease.path}; inspection=${error.message}`, retry);
          }
          throw workspaceMutationError(error, retry);
        }
        if (!inspectionSnapshotsMatch(activeInspection, confirmedInspection)) {
          if (task.status === "succeeded") {
            throw settlementIdentityError("EXECUTOR_SETTLEMENT_HEAD_MISMATCH", `workspace=${lease.path}; firstHead=${activeInspection.headCommit}; observedHead=${confirmedInspection.headCommit}; firstClean=${activeInspection.clean}; observedClean=${confirmedInspection.clean}`, retry);
          }
          throw workspaceMutationError(new Error(`workspace identity changed during inspection: firstHead=${activeInspection.headCommit}; observedHead=${confirmedInspection.headCommit}`), retry);
        }
        activeInspection = confirmedInspection;
      }
      if (currentOriginRef(cwd) !== taskWorkspace.originRef) {
        throw new Error(`Origin ref mismatch (expected ${taskWorkspace.originRef})`);
      }

      const ensureApplied = () => {
        const currentTask = projection.tasks.get(taskId);
        const currentWorkspace = currentTask.workspace;

        if (action === "preserve") {
          const resources = inspectExecutorWorkspaceResources(lease);
          if (!(resources.workspaceExists && resources.branchExists && resources.leaseExists)) {
            throw new Error("preserve disposition requires workspace, branch, and lease to remain available");
          }
          releaseExecutorWorkspace(lease, { disposition: "preserved", expectedExecutorHead: currentWorkspace.executorHead });
          const disposedEvent = makeGoalEvent("task.workspace_disposed", {
            taskId,
            attempt: currentWorkspace.attempt,
            action: currentWorkspace.requestedAction,
            released: false,
          }, goalId, projection);
          projection = appendEventFn(root, disposedEvent, projection.version);
          return false;
        }

        const resourcesBefore = inspectExecutorWorkspaceResources(lease);
        if (workspaceResourcesRemain(lease, resourcesBefore)) {
          releaseExecutorWorkspace(
            lease,
            {
              disposition: currentWorkspace.requestedAction === "integrate" ? "integrated-cleanup" : "discarded-cleanup",
              expectedExecutorHead: currentWorkspace.executorHead,
            },
          );
        }

        const resourcesAfter = inspectExecutorWorkspaceResources(lease);
        if (workspaceResourcesRemain(lease, resourcesAfter)) {
          throw new Error("failed to release workspace resources after disposal");
        }

        // A released fact is durable evidence of an already-completed cleanup.
        const disposedEvent = makeGoalEvent("task.workspace_disposed", {
          taskId,
          attempt: currentWorkspace.attempt,
          action: currentWorkspace.requestedAction,
          released: true,
        }, goalId, projection);
        projection = appendEventFn(root, disposedEvent, projection.version);
        return true;
      };

      if (taskWorkspace.phase === "active") {
        if (currentOriginRef(cwd) !== lease.originRef) {
          throw new Error(`Origin ref mismatch (expected ${lease.originRef})`);
        }
        let inspection = activeInspection;
        if (action === "integrate") {
          if (!inspection.hasCommits) {
            throw new Error("No commits to integrate");
          }
          if (!inspection.clean) {
            throw new Error("Workspace must be clean before integration");
          }
          assertWorkspaceChangesWithinPaths(inspection, task.writePaths);
        }

        const strategy = params.strategy || DEFAULT_DISPOSITION_STRATEGY;
        const executorHead = inspection.headCommit;
        const originBaseline = action === "integrate"
          ? inspectOriginIntegrationBaseline(lease, { originRef: lease.originRef })
          : { currentHead: gitHead(cwd) };

        const startedEvent = makeGoalEvent("task.workspace_disposition_started", {
          taskId,
          attempt: taskWorkspace.attempt,
          requestedAction: action,
          strategy,
          executorHead,
          originHeadBefore: originBaseline.currentHead,
          originRef: lease.originRef,
        }, goalId, projection);
        projection = appendEventFn(root, startedEvent, projection.version);

        const nextTask = projection.tasks.get(taskId);
        if (action === "integrate" && !isExecutorWorkspaceIntegrated(lease, { strategy, executorHead: nextTask.workspace.executorHead })) {
          integrateExecutorWorkspace(lease, { strategy, executorHead: nextTask.workspace.executorHead, originRef: nextTask.workspace.originRef, originHeadBefore: nextTask.workspace.originHeadBefore });
        }

        const appliedEvent = makeGoalEvent("task.workspace_disposition_applied", {
          taskId,
          attempt: nextTask.workspace.attempt,
          action,
          strategy,
          executorHead: nextTask.workspace.executorHead,
          originHead: gitHead(cwd),
        }, goalId, projection);
        projection = appendEventFn(root, appliedEvent, projection.version);
      } else if (taskWorkspace.phase === "disposing") {
        if (taskWorkspace.requestedAction !== action) {
          throw new Error(`workspace action mismatch (expected ${taskWorkspace.requestedAction}, got ${action})`);
        }

        const strategy = params.strategy || taskWorkspace.strategy || DEFAULT_DISPOSITION_STRATEGY;
        if (strategy !== taskWorkspace.strategy) {
          throw new Error(`workspace strategy mismatch (expected ${taskWorkspace.strategy}, got ${strategy})`);
        }

        let disposingWorkspace = taskWorkspace;
        if (action === "integrate" && !isExecutorWorkspaceIntegrated(lease, { strategy, executorHead: disposingWorkspace.executorHead })) {
          const originBaseline = inspectOriginIntegrationBaseline(lease, {
            originRef: disposingWorkspace.originRef,
            originHeadBefore: disposingWorkspace.originHeadBefore,
            allowForwardAdvance: true,
          });
          if (originBaseline.rebased) {
            const rebasedEvent = makeGoalEvent("task.workspace_disposition_rebased", {
              taskId,
              attempt: disposingWorkspace.attempt,
              previousOriginHeadBefore: disposingWorkspace.originHeadBefore,
              originHeadBefore: originBaseline.currentHead,
              originRef: disposingWorkspace.originRef,
              reason: "clean-forward-origin-advance",
            }, goalId, projection);
            projection = appendEventFn(root, rebasedEvent, projection.version);
            disposingWorkspace = projection.tasks.get(taskId).workspace;
          }
          integrateExecutorWorkspace(lease, { strategy, executorHead: disposingWorkspace.executorHead, originRef: disposingWorkspace.originRef, originHeadBefore: disposingWorkspace.originHeadBefore });
        }

        const appliedEvent = makeGoalEvent("task.workspace_disposition_applied", {
          taskId,
          attempt: disposingWorkspace.attempt,
          action,
          strategy,
          executorHead: disposingWorkspace.executorHead,
          originHead: gitHead(cwd),
        }, goalId, projection);
        projection = appendEventFn(root, appliedEvent, projection.version);
      } else if (taskWorkspace.phase === "applied") {
        if (taskWorkspace.requestedAction !== action) {
          throw new Error(`workspace action mismatch (expected ${taskWorkspace.requestedAction}, got ${action})`);
        }

        const strategy = params.strategy || taskWorkspace.strategy || DEFAULT_DISPOSITION_STRATEGY;
        if (params.strategy !== undefined && taskWorkspace.strategy !== undefined && strategy !== taskWorkspace.strategy) {
          throw new Error(`workspace strategy mismatch (expected ${taskWorkspace.strategy}, got ${strategy})`);
        }
      } else {
        throw new Error("workspace must be in active, disposing, or applied phase");
      }

      const released = ensureApplied();
      activeLeases.delete(key);

      const finalWorkspace = projection.tasks.get(taskId).workspace;
      finalWorkspace.released = released;
      if (orphanAuthorization && finalWorkspace.phase === "disposed") {
        const consumed = { challenge_id: orphanAuthorization.challenge.id, receipt_id: orphanAuthorization.decision.id, action };
        persistMetadata("goal-engine-orphan-disposition-consumed", consumed);
        orphanChallenges.set(orphanAuthorization.challenge.id, { ...orphanAuthorization, consumed: true });
      }
      return JSON.stringify(formatDispositionResponse(finalWorkspace));
    },

  });

  const loadAllProjections = (root) => listGoalIdsFn(root).map((goalId) => loadProjectionFn(root, goalId)).filter(Boolean);

  const ownedRuntimeProjection = (root, sessionId, state) => {
    const candidates = loadAllProjections(root).filter((projection) => projection.eventSchemaVersion === "goal-runtime.v1"
      && projection.lifecycle === "active" && projection.runtimeState === state && ownedBySession(projection, sessionId));
    return candidates.length === 1 ? candidates[0] : null;
  };
  const ownedBoundTaskIds = (projection) => [...projection.tasks.entries()]
    .filter(([, task]) => task.executorBinding && ["dispatched", "running", "settling"].includes(task.status))
    .map(([taskId]) => taskId).sort();
  const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const ownedProof = (response, runId) => {
    if (!exact(response, ["state", "proof"]) || response.state !== "observed" || !response.proof || response.proof.runId !== runId) return null;
    const { runId: proofRunId, ...terminal } = response.proof;
    try { parseProcessTerminal(terminal); } catch { return null; }
    return { runId: proofRunId, proofHash: canonicalHash(response.proof), state: "observed" };
  };
  const appendSuspensionClosure = (root, projection, closure) => {
    const event = makeEvent("goal.runtime_suspended", closure, projection.goalId, "goal-runtime.v1");
    const expected = applyEvent(projection, event);
    try { return appendEventFn(root, event, projection.version); }
    catch (error) {
      const recovered = loadProjectionFn(root, projection.goalId);
      if (!isDeepStrictEqual(recovered, expected)) throw error;
      return recovered;
    }

  };
  const closeSuspendedRuntime = async (ctx, initial) => {
    const { root } = executionScopeFor(ctx);
    let projection = initial;
    if (projection.runtimeState !== "suspended" || projection.suspension?.resourcesQuarantined) return;
    const suspension = projection.suspension;
    const terminalRefs = [...(suspension.terminalProofRefs || [])];
    const workspaceRefs = [...(suspension.workspaceClosureProofRefs || [])];
    const resourceRefs = [...(suspension.resourceClosureProofRefs || [])];
    const has = (refs, key, value) => refs.some((ref) => ref[key] === value);
    for (const taskId of suspension.affectedTaskIds) {
      const task = projection.tasks.get(taskId), binding = task?.executorBinding;
      if (!task || !binding) continue;
      if (!has(terminalRefs, "runId", binding.runId)) {
        projection = loadProjectionFn(root, projection.goalId);
        const request = deriveOwnedExecutorStopRequest({ projection, taskId });
        let response;
        try { response = await runtimeHost?.stopOwnedRun?.({ runId: request.runId, asyncDir: request.asyncDir, sessionId: request.sessionId }); } catch { response = null; }
        const proof = ownedProof(response, binding.runId);
        if (!proof) continue;
        terminalRefs.push(proof);
      }
      if (!has(workspaceRefs, "taskId", taskId)) {
        projection = loadProjectionFn(root, projection.goalId);
        const request = { stateRoot: root, goalId: projection.goalId, taskId, attempt: task.attempts, runId: binding.runId, leaseId: binding.workspaceLeaseId, workspacePath: task.workspace.path, headAtDispatch: binding.headAtDispatch, baseHead: projection.runtimeBaseHead, executionRevision: projection.executionRevision, contractHash: projection.executionContractHash, sessionId: sessionIdentity(ctx) };
        let response; try { response = await runtimeHost?.quarantineWorkspace?.(request); } catch { response = null; }
        if (exact(response, ["taskId", "attempt", "proofHash", "state", "disposition"]) && response.taskId === taskId && response.attempt === task.attempts && hash(response.proofHash) && response.state === "quarantined" && response.disposition === "preserved") workspaceRefs.push(response);
      }
      if (!has(resourceRefs, "ownerId", binding.runId)) {
        projection = loadProjectionFn(root, projection.goalId);
        const request = { stateRoot: root, goalId: projection.goalId, ownerKind: "executor", ownerId: binding.runId, taskId, attempt: task.attempts, leaseId: binding.workspaceLeaseId, executionRevision: projection.executionRevision, contractHash: projection.executionContractHash, sessionId: sessionIdentity(ctx) };
        let response; try { response = await runtimeHost?.quarantineResource?.(request); } catch { response = null; }
        if (exact(response, ["ownerId", "proofHash", "state", "debt"]) && response.ownerId === binding.runId && hash(response.proofHash) && response.state === "quarantined" && response.debt === true) resourceRefs.push(response);
      }
    }
    for (const run of projection.observationRuns.values()) {
      if (!suspension.affectedRunIds.includes(run.runId) || has(terminalRefs, "runId", run.runId) || !["process_bound"].includes(run.phase) || !hash(run.processIdentityHash)) continue;
      projection = loadProjectionFn(root, projection.goalId);
      const request = { stateRoot: root, goalId: projection.goalId, runId: run.runId, conditionId: run.conditionId, allocationId: run.allocationId, processIdentityHash: run.processIdentityHash, executionRevision: projection.executionRevision, executionContractHash: projection.executionContractHash, baseHead: projection.runtimeBaseHead };
      let response; try { response = await runtimeHost?.stopManagedValidation?.(request); } catch { response = null; }
      if (exact(response, ["state", "terminalProofHash", "resourceProofHash", "resourceState", "debt"]) && response.state === "observed" && hash(response.terminalProofHash) && hash(response.resourceProofHash) && response.resourceState === "quarantined" && response.debt === true) {
        terminalRefs.push({ runId: run.runId, proofHash: response.terminalProofHash, state: "observed" });
        resourceRefs.push({ ownerId: run.runId, proofHash: response.resourceProofHash, state: "quarantined", debt: true });
      }
    }
    const closure = { ...suspension, terminalProofRefs: terminalRefs.sort((a, b) => a.runId.localeCompare(b.runId)), workspaceClosureProofRefs: workspaceRefs.sort((a, b) => a.taskId.localeCompare(b.taskId)), resourceClosureProofRefs: resourceRefs.sort((a, b) => a.ownerId.localeCompare(b.ownerId)) };
    const complete = closure.terminalProofRefs.length === closure.affectedRunIds.length && closure.workspaceClosureProofRefs.length === closure.affectedTaskIds.length && closure.resourceClosureProofRefs.length === closure.affectedRunIds.length;
    if (complete && (!suspension.resourcesQuarantined || terminalRefs.length !== (suspension.terminalProofRefs || []).length || workspaceRefs.length !== (suspension.workspaceClosureProofRefs || []).length || resourceRefs.length !== (suspension.resourceClosureProofRefs || []).length)) appendSuspensionClosure(root, projection, { ...closure, resourcesQuarantined: complete });
  };
  const suspendOwnedRuntime = async (ctx, reason) => {
    const { root } = executionScopeFor(ctx); const sessionId = sessionIdentity(ctx);
    const projection = ownedRuntimeProjection(root, sessionId, "active"); if (!projection) return false;
    const taskIds = ownedBoundTaskIds(projection);
    const observationRuns = [...projection.observationRuns.values()].filter((run) => !["terminal", "recorded", "released"].includes(run.phase));
    const runIds = [...taskIds.map((taskId) => projection.tasks.get(taskId).executorBinding.runId), ...observationRuns.map((run) => run.runId)].sort();
    const plan = buildSuspensionPlan({ projection, reason, affectedIds: { taskIds, runIds } });
    const event = makeEvent(plan.events[0].type, plan.events[0].data, projection.goalId, "goal-runtime.v1");
    const expected = applyEvent(projection, event); let suspended;
    try { suspended = appendEventFn(root, event, projection.version); } catch (error) { const recovered = loadProjectionFn(root, projection.goalId); if (!isDeepStrictEqual(recovered, expected)) throw error; suspended = recovered; }
    await closeSuspendedRuntime(ctx, suspended); return true;
  };
  const retrySuspendedOwnedStop = async (ctx, projection) => { await closeSuspendedRuntime(ctx, projection); };

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return { action: "continue" };
    if (!event.images?.length && event.streamingBehavior === undefined && ["approve", "reject"].includes(event.text)) {
      try {
        const { root } = executionScopeFor(ctx), sessionId = sessionIdentity(ctx);
        const owned = loadAllProjections(root).filter((projection) => projection.eventSchemaVersion === "goal-runtime.v1" && projection.runtimeState === "active" && ownedBySession(projection, sessionId));
        if (owned.length === 1 && ctx.sessionManager?.getBranch?.()?.some((entry) => exactFinalIntent(entry, owned[0].goalId, sessionId))) return { action: "continue" };
      } catch { /* Ordinary suspension remains fail-closed. */ }
    }
    const suspensionReason = !event.images?.length && event.streamingBehavior === "steer" ? "interactive_steer"
      : !event.images?.length && event.streamingBehavior === "followUp" ? "follow_up" : null;
    if (suspensionReason) {
      await suspendOwnedRuntime(ctx, suspensionReason);
      return { action: "continue" };
    }
    if (!event.images?.length && event.streamingBehavior === undefined) {
      let repairApprovalPending = false, activeOwner = false;
      try {
        const { root } = executionScopeFor(ctx), sessionId = sessionIdentity(ctx);
        const owned = loadAllProjections(root).filter((projection) => projection.eventSchemaVersion === "goal-runtime.v1" && projection.runtimeState === "active" && ownedBySession(projection, sessionId));
        activeOwner = owned.length === 1;
        repairApprovalPending = owned.some((projection) => [...projection.repairChallenges.values()].some((challenge) => challenge.phase === "created" && challenge.action === "authorize_task" && challenge.sessionId === sessionId));
      } catch { /* normal suspension remains the safe fallback */ }
      if (activeOwner && !repairApprovalPending && await suspendOwnedRuntime(ctx, "execution_amendment")) return { action: "continue" };
    }
    pendingInput = { text: event.text, source: event.source };
    let hookSessionId;
    try { hookSessionId = sessionIdentity(ctx); } catch { return { action: "continue" }; }

    try {
      const orphan = [...orphanChallenges.values()].filter((record) => !record.decision && !record.stale && !record.consumed && record.challenge?.sessionId === hookSessionId).at(-1);
      if (orphan) {
        const occurredAt = new Date(Math.max(Date.now(), Date.parse(orphan.challenge.requestedAt) + 1)).toISOString();
        const receipt = recordHumanChoice({ inputEvent: { role: "user", source: event.source, sessionId: hookSessionId, occurredAt, text: event.text, id: event.entryId || crypto.randomUUID() }, challenge: orphan.challenge, sessionId: hookSessionId });
        const decision = { id: crypto.randomUUID(), ...receipt };
        persistMetadata("goal-engine-orphan-disposition-decision", { challenge_id: orphan.challenge.id, receipt_id: decision.id, choice: decision.choice, sessionId: decision.sessionId, source: decision.source, user_entry_id: decision.userEntryId });
        orphanChallenges.set(orphan.challenge.id, { ...orphan, decision });
        return { action: "continue" };
      }
    } catch { /* input for another challenge or ambiguous input never creates an orphan receipt */ }

    try {
      const record = [...transferChallenges.values()].filter((candidate) => !candidate.decision && !candidate.rejected && !candidate.consumed && candidate.challenge?.toSessionId === hookSessionId).at(-1);
      if (record) {
        const occurredAt = new Date(Math.max(Date.now(), Date.parse(record.challenge.requestedAt) + 1)).toISOString();
        const receipt = recordHumanChoice({ inputEvent: { role: "user", source: event.source, sessionId: hookSessionId, occurredAt, text: event.text, id: event.entryId || crypto.randomUUID() }, challenge: { ...record.challenge, sessionId: hookSessionId }, sessionId: hookSessionId });
        const decision = { id: crypto.randomUUID(), ...receipt };
        persistMetadata("goal-engine-session-transfer-decision", { id: record.challenge.id, ...decision });
        transferChallenges.set(record.challenge.id, { ...record, decision, ...(decision.choice === "reject" ? { rejected: true } : {}) });
        if (decision.choice === "reject") persistMetadata("goal-engine-session-transfer-rejected", { challenge_id: record.challenge.id });
        return { action: "continue" };
      }
    } catch { /* only the challenge target's exact real-user input is durable */ }

    try {
      const { root } = executionScopeFor(ctx);
      const amendments = loadAllProjections(root).filter((projection) => projection.eventSchemaVersion === "goal-runtime.v1" && projection.lifecycle === "active" && projection.runtimeState === "suspended" && ownedBySession(projection, hookSessionId) && projection.pendingHumanDecision?.phase === "proposed");
      if (amendments.length === 1 && event.streamingBehavior === undefined && !event.images?.length && ["approve", "reject"].includes(event.text)) {
        const proposal = amendments[0].pendingHumanDecision;
        persistMetadata("goal-engine-execution-amendment-intent", { protocol: "goal-engine-execution-amendment-intent.v1", proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, goalId: proposal.goalId, ownerSessionId: proposal.ownerSessionId, choice: event.text, source: event.source });
        return { action: "continue" };
      }
    } catch { /* only a unique suspended owner proposal can receive an amendment intent */ }

    try {
      const { root } = executionScopeFor(ctx);
      const owned = loadAllProjections(root).filter((projection) => projection.eventSchemaVersion === "goal-runtime.v1" && projection.lifecycle === "active" && ownedBySession(projection, hookSessionId));
      const challenges = owned.flatMap((projection) => [...projection.repairChallenges.values()].filter((challenge) => challenge.phase === "created" && challenge.action === "authorize_task" && challenge.sessionId === hookSessionId).map((challenge) => ({ projection, challenge })));
      if (challenges.length === 1 && event.streamingBehavior === undefined && !event.images?.length && ["approve", "reject"].includes(event.text)) {
        const { challenge } = challenges[0];
        const intent = { protocol: "goal-engine-repair-approval-intent.v1", challengeId: challenge.challengeId, challengeHash: challenge.challengeHash, goalId: challenge.goalId, executionRevision: challenge.executionRevision, executionContractHash: challenge.executionContractHash, baseHead: challenge.baseHead, episodeId: challenge.episodeId, conditionId: challenge.conditionId, findingIds: [...challenge.findingIds], subjectHash: challenge.subjectHash, taskId: challenge.taskId, taskDefHash: challenge.taskDefHash, sessionId: challenge.sessionId, choice: event.text, source: event.source };
        persistMetadata("goal-engine-repair-approval-intent", intent);
        return { action: "continue" };
      }
    } catch { /* only the unique owner challenge can receive a repair intent */ }

    try {
      const record = [...runtimeChallenges.values()].filter((candidate) => !candidate.invalid && !candidate.decision && !candidate.consumed && candidate.challenge?.sessionId === hookSessionId).at(-1);
      if (record && event.streamingBehavior === undefined && !event.images?.length && ["approve", "reject"].includes(event.text)) {
        const challenge = record.challenge;
        const intent = { protocol: "goal-engine-runtime-approval-intent.v1", challengeId: challenge.id, goalId: challenge.goalId, proposalId: challenge.proposalId, contractHash: challenge.contractHash, baseHead: challenge.baseHead, sessionId: challenge.sessionId, choice: event.text, source: event.source, proposalHash: challenge.proposalHash };
        persistMetadata("goal-engine-runtime-approval-intent", intent);
        return { action: "continue" };
      }
    } catch { /* Pi appends the real user message only after this hook returns */ }

    try {
      const candidates = [...metadataChallenges.values()].filter((record) => !record.decision && !record.rejected && !record.consumed);
      const record = candidates.at(-1);
      let sessionId = event.sessionId || record?.challenge?.sessionId;
      try { sessionId = sessionIdentity(ctx); } catch { /* Pi input hooks do not expose context on every transport */ }
      if (record && record.challenge.sessionId === sessionId) {
        const occurredAt = new Date(Math.max(Date.now(), Date.parse(record.challenge.requestedAt) + 1)).toISOString();
        const inputEvent = { role: "user", source: event.source, sessionId, occurredAt, text: event.text, id: event.entryId || crypto.randomUUID() };
        const choice = recordHumanChoice({ inputEvent, challenge: record.challenge, sessionId });
        const decision = { id: crypto.randomUUID(), ...choice, sessionId, source: event.source };
        persistMetadata("goal-engine-metadata-decision", { id: record.challenge.id, receiptId: decision.id, challengeId: record.challenge.id, choice: decision.choice, proposalHash: decision.proposalHash, sessionId: decision.sessionId, source: decision.source });
        metadataChallenges.set(record.challenge.id, { ...record, decision });
        if (decision.choice === "reject") {
          try { persistMetadata("goal-engine-metadata-rejected", { id: record.challenge.id }); } catch { /* durable decision receipt is terminal audit authority */ }
          metadataChallenges.set(record.challenge.id, { ...metadataChallenges.get(record.challenge.id), rejected: true });
        }
        return { action: "continue" };
      }
    } catch { /* input for another challenge or ambiguous input never creates a metadata receipt */ }
    try {
      const { cwd, root } = executionScopeFor(ctx); const sessionId = hookSessionId;
      const projection = loadAllProjections(root).find((candidate) => candidate.eventSchemaVersion === "goal-runtime.v1" && candidate.lifecycle === "active" && ownedBySession(candidate, sessionId));
      if (projection && !runtimeIntentGates.has(`${projection.goalId}:${sessionId}`)) {
        const gate = { goalId: projection.goalId, sessionId, source: event.source };
        // Set the in-memory latch first: metadata failure must never reopen business actions.
        runtimeIntentGates.set(`${projection.goalId}:${sessionId}`, { ...gate, kind: "pending" });
        try { persistMetadata("goal-engine-runtime-intent-pending", gate); }
        catch { recoveryLatch = { goalId: projection.goalId, sessionId, state: "active" }; }
      }
    } catch { recoveryLatch = { goalId: "unknown", sessionId: hookSessionId, state: "active" }; }
    return { action: "continue" };
  });

  pi.on("agent_start", (_event, ctx) => {
    const signal = ctx?.signal;
    if (!signal || abortSignals.has(signal)) return;
    abortSignals.add(signal);
    signal.addEventListener("abort", () => {
      void suspendOwnedRuntime(ctx, "abort").catch(() => {});
    }, { once: true });
  });

  pi.on("session_start", (_event, ctx) => {
    restoreMetadata(ctx);
    const entries = ctx.sessionManager?.getEntries?.() || [];
    const latch = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === "goal-engine-recovery-latch");
    recoveryLatch = latch?.data?.state === "active" ? latch.data : null;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    try {
      const { cwd, root } = executionScopeFor(ctx);
      const projections = loadAllProjections(root);
      if (recoveryLatch) return { message: { customType: "goal-engine-recovery", content: `Goal recovery latch is active for ${recoveryLatch.goalId}. Call goal_status before mutation.`, display: true } };
      if (projections.length === 0) return undefined;
      const sessionId = sessionIdentity(ctx);
      if ([...runtimeIntentGates.values()].some((gate) => gate.sessionId === sessionId)) return { message: { customType: "goal-engine-recovery", content: "R10B_SUSPENSION_REQUIRED", display: true } };
      const selected = selectContinuityCandidate({ projections, cwd, paths: [], sessionId });
      if (selected.status === "ambiguous") {
        activateRecoveryLatch("ambiguous", `ambiguous candidates: ${selected.goalIds.join(", ")}`);
        return { message: { customType: "goal-engine-recovery", content: `Goal candidates are ambiguous: ${selected.goalIds.join(", ")}. Call goal_status with an explicit goal_id.`, display: true } };
      }
      if (selected.status !== "selected") return undefined;
      let projection = projections.find((candidate) => candidate.goalId === selected.goalId);
      if (pendingInput && projection.lifecycle === "completed" && projection.sessionBindings.some((binding) => binding.sessionId === sessionId && binding.state === "watching")) {
        const discovery = buildDiscovery({ userText: pendingInput.text, userEntryId: pendingInput.entryId || ctx.sessionManager?.getLeafId?.() || crypto.randomUUID(), paths: [], sessionId, source: "user_intent" });
        if (!projection.continuity.observations[discovery.id]) projection = appendEventFn(root, makeGoalEvent("goal.discovery_recorded", discovery, projection.goalId, projection), projection.version);
      }
      pendingInput = null;
      return { message: { customType: "goal-engine-recovery", content: formatRecoveryInjection(projection), display: true } };
    } catch (error) {
      activateRecoveryLatch(null, error);
      return { message: { customType: "goal-engine-recovery", content: "Goal recovery failed; call goal_status before mutation.", display: true } };
    }
  });

  pi.on("tool_call", (event, ctx) => {
    const writeTools = new Set(["write", "edit", "subagent", "bash"]);
    if (!writeTools.has(event.toolName)) return undefined;
    let cwd, root;
    try { ({ cwd, root } = executionScopeFor(ctx)); }
    catch (error) {
      activateRecoveryLatch(null, error);
      return { block: true, reason: "Goal recovery failed; call goal_status before mutation" };
    }
    const paths = event.toolName === "write" || event.toolName === "edit"
      ? [event.input?.path].filter(Boolean)
      : event.toolName === "subagent"
        ? (event.input?.boundaries?.writePaths || [])
        : [];
    let projections, selected;
    try {
      projections = loadAllProjections(root);
      selected = selectContinuityCandidate({ projections, cwd, paths, sessionId: sessionIdentity(ctx) });
    } catch (error) {
      activateRecoveryLatch(null, error);
      return { block: true, reason: "Goal recovery failed; call goal_status before mutation" };
    }
    if (selected.status === "ambiguous") {
      activateRecoveryLatch("ambiguous", `ambiguous candidates: ${selected.goalIds.join(", ")}`);
      return { block: true, reason: "Goal candidates are ambiguous; call goal_status with an explicit goal_id before mutation" };
    }
    if (selected.status !== "selected") return recoveryLatch ? { block: true, reason: "Goal recovery is required: call goal_status before mutation" } : undefined;
    const projection = projections.find((candidate) => candidate.goalId === selected.goalId);
    if (projection.eventSchemaVersion === "goal-runtime.v1" && runtimeIntentGates.has(`${projection.goalId}:${sessionIdentity(ctx)}`)) return { block: true, reason: "R10B_SUSPENSION_REQUIRED" };
    const hasDebt = Object.values(projection.continuity?.observations || {}).some((observation) => observation.status === "untriaged");
    if (recoveryLatch || hasDebt) {
      return { block: true, reason: `Goal ${projection.goalId} has unresolved continuity debt; call goal_status then goal_amend before this mutation` };
    }
    return undefined;
  });

  pi.on("session_before_compact", (event, ctx) => {
    let cwd, root, projections, selected;
    try {
      ({ cwd, root } = executionScopeFor(ctx));
      projections = loadAllProjections(root);
      const fileOps = event.preparation?.fileOps;
      const modifiedFiles = [...new Set([...(fileOps?.written || []), ...(fileOps?.edited || [])])].sort();
      selected = selectContinuityCandidate({ projections, cwd, paths: modifiedFiles, sessionId: sessionIdentity(ctx) });
      event = { ...event, _goalEngineModifiedFiles: modifiedFiles };
    } catch (error) {
      activateRecoveryLatch(null, error);
      return { cancel: true };
    }
    if (recoveryLatch) return { cancel: true };
    if (selected.status === "ambiguous") {
      activateRecoveryLatch("ambiguous", `ambiguous candidates: ${selected.goalIds.join(", ")}`);
      return { cancel: true };
    }
    if (selected.status !== "selected") return undefined;
    const projection = projections.find((candidate) => candidate.goalId === selected.goalId);
    const checkpoint = buildContinuityCheckpoint({
      projection,
      sessionId: sessionIdentity(ctx),
      reason: event.reason,
      modifiedFiles: event._goalEngineModifiedFiles,
      userEntryId: ctx.sessionManager?.getLeafId?.() || undefined,
    });
    try {
      appendEventFn(root, makeGoalEvent("goal.continuity_checkpointed", checkpoint, projection.goalId, projection), projection.version);
      return undefined;
    } catch (error) {
      activateRecoveryLatch(projection.goalId, error);
      return { cancel: true };
    }
  });

  // --- tool_result hook: checkpoint reminder ---
  pi.on("tool_result", (event, ctx) => {
    let cwd, root;
    try { ({ cwd, root } = executionScopeFor(ctx)); } catch { return undefined; }
    if (event.isError) return undefined;
    if (["goal_settle", "goal_status", "goal_init", "goal_dispatch", "goal_accept", "goal_amend", "goal_integrate"].includes(event.toolName)) return undefined;

    let activeGoals;
    try { activeGoals = listGoalsFn(root); } catch { return undefined; }
    if (activeGoals.length === 0) return undefined;

    turnsSinceSettle++;
    if (turnsSinceSettle < CHECKPOINT_REMINDER_THRESHOLD) return undefined;

    let projection;
    try { projection = loadProjectionFn(root, enforceActionTokens
      ? activeGoals.find((id) => ownedBySession(loadProjectionFn(root, id), sessionIdentity(ctx)))
      : activeGoals[0]); } catch { return undefined; }
    if (!projection || projection.lifecycle !== "active" || (enforceActionTokens && !ownedBySession(projection, sessionIdentity(ctx)))) return undefined;

    const reminder = `\n\n⚠️ [goal-engine] 活跃 goal "${projection.goalId}" 已 ${turnsSinceSettle} 轮未 settle。当前 runnable: [${runnableFrontier(projection).join(", ")}]。请推进任务或调用 goal_settle 更新状态。`;
    const content = (event.content || []).map((part, i) => {
      if (i === 0 && part?.type === "text") return { ...part, text: part.text + reminder };
      return part;
    });
    return { content, details: event.details, isError: false };
  });
}
