import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { hashGoalMetadataProposal, recordHumanChoice } from "./human-decision.mjs";
import { buildTransferChallenge, listCwdGoals, ownerSessionId, transferChallengeState, workspaceReleased } from "./session-transfer.mjs";
import { validateDAG, runnableFrontier, goalProgress, taskActionState, nextDispatchAttempt, orphanWorkspaceActionState } from "./graph.mjs";
import { appendEvent, appendEventBatch, loadProjection, listGoals, listGoalIds } from "./store.mjs";
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
import { applyEvent, createProjection, PLANNED_SCHEMA_VERSION, schemaVersionForMutation } from "./events.mjs";
import { completionVerdictFor } from "./evidence.mjs";
import {
  assertExecutorBindingTicketCurrent,
  assertExecutorSettlementProof,
  executorBoundEventData,
  prepareExecutorBindingTicket,
} from "./executor-binding.mjs";
import { bindGoalExecutorCoordinator, inspectRootBrokerExecutorProof } from "../subagent-dispatch/root-broker-registry.ts";
import { validateTaskDefinitions } from "./task-definition.mjs";
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
    if (!schema.anyOf.some((branch) => { try { validateSchema(branch, value, path); return true; } catch { return false; } })) throw new Error(`${path} schema invalid operation or challenge shape`);
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
  const metadataChallenges = new Map();
  const orphanChallenges = new Map();
  const transferChallenges = new Map();
  const persistMetadata = (type, data) => {
    if (typeof pi.appendEntry !== "function") throw new Error(`Cannot persist ${type}: pi.appendEntry is unavailable`);
    pi.appendEntry(type, data);
  };
  const restoreMetadata = (ctx) => {
    metadataChallenges.clear(); orphanChallenges.clear(); transferChallenges.clear();
    for (const entry of ctx.sessionManager?.getEntries?.() || []) {
      if (entry.type !== "custom") continue;
      const data = entry.data;
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
    const supplied = { goal_id: goalId, task_id: params.task_id ?? params.blocked_task_id, action: params.action, strategy: params.strategy, operation: params.operation, challenge_id: params.challenge_id };
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
        tasks: {
          type: "array",
          items: taskSchema,
          description: "任务 DAG（含依赖、写入范围、验收标准）",
        },
      },
      required: ["objective", "tasks"],
    },
    async handler(params, ctx) {
      const { cwd, root, storage, stateScope } = executionScopeFor(ctx, { operation: "init" });
      assertInitPreflight(cwd, storage);
      if (storage === "global") ensureGoalStateIdentity(stateScope);
      const sessionId = sessionIdentity(ctx);
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
        return JSON.stringify({ challenge_id: record.challenge.id, status: transferChallengeState(record, loadProjectionFn(root, record.challenge.goalId), sessionId, cwd) });
      }
      const goalId = resolveGoalId(params.goal_id, root, ctx);
      if (!goalId) return "NO_ACTIVE_GOAL";
      let projection = loadProjectionFn(root, goalId);
      if (!projection) return "NO_ACTIVE_GOAL";
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
      let candidate;
      try {
        candidate = applyEvent(projection, makeGoalEvent("task.settled", settlementData, goalId, projection));
      } catch (error) {
        if (params.outcome === "succeeded" && task?.status === "dispatched" && /workspace is required/i.test(error.message)) {
          throw workspaceMutationError(error, { tool: "goal_status", params: { goal_id: goalId } });
        }
        throw error;
      }
      if (params.outcome === "succeeded") {
        void candidate;
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
      }
      const settleEvent = makeGoalEvent("task.settled", settlementData, goalId, projection);
      const cpEvent = makeGoalEvent("goal.checkpoint", { nextAction: params.next_action }, goalId, projection);
      projection = appendEventBatchFn(root, [settleEvent, cpEvent], projection.version);

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
        goal_complete: current.lifecycle === "completed" || goalProgress(current).accepted === goalProgress(current).total,
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
        try {
          const afterAccept = applyEvent(projection, acceptEvent);
          projection = goalProgress(afterAccept).accepted === goalProgress(afterAccept).total
            ? appendEventBatchFn(root, [acceptEvent, makeGoalEvent("goal.completed", { verdict: completionVerdictFor(afterAccept) }, goalId, projection)], projection.version)
            : appendEventFn(root, acceptEvent, projection.version);
        } catch (cause) {
          projection = reloadAfterFailure(cause, (recovered) => recovered.tasks.get(params.task_id)?.status === "accepted");
        }
        task = projection.tasks.get(params.task_id);
      } else if (task.status !== "accepted") {
        throw new Error(`task is not succeeded or accepted: ${params.task_id} (${task.status})`);
      }

      const progress = goalProgress(projection);
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
      const goalId = resolveGoalId(params.goal_id, root, ctx);
      if (!goalId) throw new Error("No active goal");
      let projection = loadProjectionFn(root, goalId);
      if (params.operation === "propose_transfer_session") {
        if (!listCwdGoals(loadAllProjections(root), sessionIdentity(ctx)).some((item) => item.goalId === goalId)) throw new Error("transfer requires a visible goal");
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
      const metadataBeforeConsume = params.operation === "update_goal" ? metadataState(projection, currentSessionId) : null;
      if (params.operation === "transfer_session") {
        const record = transferChallenges.get(params.challenge_id);
        if (!record?.challenge || transferChallengeState(record, projection, currentSessionId, cwd) !== "APPROVED" || !workspaceReleased(projection)) throw new Error("transfer challenge is missing, stale, or unsafe");
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

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return { action: "continue" };
    pendingInput = { text: event.text, source: event.source, entryId: event.entryId || null };
    let hookSessionId;
    try { hookSessionId = sessionIdentity(ctx); } catch { hookSessionId = event.sessionId; }

    try {
      const orphan = [...orphanChallenges.values()].filter((record) => !record.decision && !record.stale && !record.consumed && record.challenge?.sessionId === hookSessionId).at(-1);
      if (orphan) {
        const occurredAt = new Date(Math.max(Date.now(), Date.parse(orphan.challenge.requestedAt) + 1)).toISOString();
        const receipt = recordHumanChoice({ inputEvent: { role: "user", source: event.source, sessionId: hookSessionId, occurredAt, text: event.text, id: event.entryId || crypto.randomUUID() }, challenge: orphan.challenge, sessionId: hookSessionId });
        const decision = { id: crypto.randomUUID(), ...receipt };
        persistMetadata("goal-engine-orphan-disposition-decision", { challenge_id: orphan.challenge.id, receipt_id: decision.id, choice: decision.choice, sessionId: decision.sessionId, source: decision.source, user_entry_id: decision.userEntryId });
        orphanChallenges.set(orphan.challenge.id, { ...orphan, decision });
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
      }
    } catch { /* only the challenge target's exact real-user input is durable */ }

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
      }
    } catch { /* input for another challenge or ambiguous input never creates a metadata receipt */ }
    return { action: "continue" };
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

  pi.on("session_compact", (_event, ctx) => {
    const { cwd, root } = executionScopeFor(ctx);
    const projections = loadAllProjections(root);
    const selected = selectContinuityCandidate({ projections, cwd, paths: [], sessionId: sessionIdentity(ctx) });
    if (selected.status !== "selected") return undefined;
    const projection = projections.find((candidate) => candidate.goalId === selected.goalId);
    pi.sendMessage?.({ customType: "goal-engine-recovery", content: formatRecoveryInjection(projection), display: true }, { deliverAs: "nextTurn" });
    return undefined;
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
