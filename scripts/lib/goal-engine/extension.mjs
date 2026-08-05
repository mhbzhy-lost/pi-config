import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { validateDAG, runnableFrontier, goalProgress, taskActionState, nextDispatchAttempt, orphanWorkspaceActionState } from "./graph.mjs";
import { appendEvent, loadProjection, listGoals } from "./store.mjs";
import { compileTaskContract, assertPendingTaskContractsCompile } from "./dispatch.mjs";
import { applyEvent, createProjection } from "./events.mjs";
import { completionVerdictFor } from "./evidence.mjs";
import { validateTaskDefinitions } from "./task-definition.mjs";
import {
  allocateExecutorWorkspace,
  loadExecutorWorkspaceLease,
  inspectExecutorWorkspace,
  inspectOrphanedExecutorWorkspace,
  inspectExecutorWorkspaceResources,
  assertWorkspaceChangesWithinPaths,
  isExecutorWorkspaceIntegrated,
  integrateExecutorWorkspace,
  releaseExecutorWorkspace,
} from "./workspace.mjs";

const STATE_ROOT_REL = ".state/goal-engine";
const GOAL_ID_RE = /[^a-zA-Z0-9._-]+/g;
const CHECKPOINT_REMINDER_THRESHOLD = 5;
const DEFAULT_EVENT_VERSION = "goal-engine.event.v2";
const DEFAULT_DISPOSITION_STRATEGY = "cherry-pick";

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

function assertRepositoryPreflight(cwd, { operation, requiredNextAction }) {
  const retry = `repair Git and retry ${operation}`;
  const realpathRemediation = requiredNextAction ? retry : "repair filesystem access and retry goal_init";
  const physicalCwd = realpathForPreflight(cwd, `cwd realpath could not be read: ${cwd}`, realpathRemediation, requiredNextAction);
  const topLevel = gitOutput(cwd, ["rev-parse", "--show-toplevel"], "GIT_INFRASTRUCTURE_ERROR", "Git worktree top-level could not be read", retry, [], requiredNextAction);
  if (realpathForPreflight(topLevel, `Git top-level realpath could not be read: ${topLevel}`, realpathRemediation, requiredNextAction) !== physicalCwd) throw preflightError("UNSAFE_GIT_CWD", `cwd=${physicalCwd}, topLevel=${topLevel}`, `run ${operation} from the repository top-level`, requiredNextAction);
  gitOutput(cwd, ["rev-parse", "--verify", "HEAD"], "INVALID_GIT_HEAD", "HEAD is unborn or invalid", `create a commit on an attached branch before ${operation}`, [], requiredNextAction);
  const ref = gitOutput(cwd, ["symbolic-ref", "--quiet", "HEAD"], "DETACHED_GIT_HEAD", "HEAD is detached", `checkout an attached branch before ${operation}`, [1], requiredNextAction);
  if (!ref) throw preflightError("DETACHED_GIT_HEAD", "HEAD is detached", `checkout an attached branch before ${operation}`, requiredNextAction);
  const tracked = gitOutput(cwd, ["ls-files", "--", STATE_ROOT_REL], "GIT_INFRASTRUCTURE_ERROR", "could not inspect tracked state entries", retry, [], requiredNextAction);
  if (tracked) throw preflightError("STATE_TRACKED", `tracked entries: ${tracked}`, `remove .state/goal-engine from the Git index before retrying ${operation}`, requiredNextAction);
  const ignored = gitOutput(cwd, ["check-ignore", "-q", ".state/goal-engine/"], "GIT_INFRASTRUCTURE_ERROR", "could not inspect .state/goal-engine ignore rule", "repair Git ignore configuration", [1], requiredNextAction);
  if (ignored === null) throw preflightError("STATE_NOT_IGNORED", ".state/goal-engine/ is not ignored", `add .state/goal-engine/ to .gitignore before retrying ${operation}`, requiredNextAction);
}

function assertInitPreflight(cwd, root) {
  assertRepositoryPreflight(cwd, { operation: "goal_init" });
}

function validateProjectionForDispatch(projection, cwd) {
  validateTaskDefinitions([...projection.tasks.keys()], taskDefsFromProjection(projection), { cwd, realpathCwd: realpathSync(cwd) });
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
  const { handler, ...publicDefinition } = definition;
  if (typeof handler !== "function") throw new Error(`Goal tool ${definition.name} is missing its domain handler`);
  pi.registerTool({
    ...publicDefinition,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await handler(params, ctx));
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

function makeEvent(type, data, goalId, schemaVersion = DEFAULT_EVENT_VERSION) {
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

function statusResponse(projection, cwd, root) {
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
        workspace: t.workspace ? { ...t.workspace } : null,
        allowedActions: actionState.allowedActions,
        requiredNextAction: actionState.requiredNextAction,
        blockingReason: actionState.blockingReason,
      }];
    })),
  }, null, 2);
}

export function createGoalEngineExtension(pi, options = {}) {
  const store = options.store || {};
  const appendEventFn = options.appendEvent || store.appendEvent || appendEvent;
  const loadProjectionFn = store.loadProjection || loadProjection;
  const listGoalsFn = store.listGoals || listGoals;
  const inspectExecutorWorkspaceFn = options.inspectExecutorWorkspace || inspectExecutorWorkspace;
  const beforePreservedWorkspaceCleanupBarrier = options.beforePreservedWorkspaceCleanupBarrier;
  const inspectOrphanedExecutorWorkspaceBarrier = options.inspectOrphanedExecutorWorkspaceBarrier;
  const betweenOrphanInventoriesBarrier = options.betweenOrphanInventoriesBarrier;
  const activeLeases = new Map();
  let turnsSinceSettle = 0;

  const resolveGoalId = (goalId, root) => {
    if (goalId) return goalId;
    const active = listGoalsFn(root);
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
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              description: { type: "string" },
              deps: { type: "array", items: { type: "string" } },
              writePaths: { type: "array", items: { type: "string" }, description: "允许写入的路径" },
              acceptance: {
                type: "object",
                properties: {
                  criteria: { type: "array", items: { type: "string" } },
                  commands: { type: "array", items: { type: "string" }, description: "验证命令" },
                },
                required: ["criteria", "commands"],
              },
              workflow: { type: "string", enum: ["tdd", "existing-tests", "docs-only"] },
            },
            required: ["id", "description", "writePaths", "acceptance"],
          },
          description: "任务 DAG（含依赖、写入范围、验收标准）",
        },
      },
      required: ["objective", "tasks"],
    },
    async handler(params, ctx) {
      const { cwd, root } = executionScope(ctx);
      assertInitPreflight(cwd, root);
      const activeGoals = listGoalsFn(root);
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
        goalId = slugify(params.objective);
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
        validateTaskDefinitions(taskIds, taskDefs, { cwd, realpathCwd: realpathSync(cwd) });
      } catch (error) {
        throw initError("INVALID_TASK_CONTRACT", error.message, "correct task commands and writePaths, then retry goal_init");
      }

      const event = makeEvent("goal.created", {
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
      appendEventFn(root, event, 0);

      const projection = loadProjectionFn(root, goalId);
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
    parameters: {
      type: "object",
      properties: { goal_id: { type: "string" } },
      required: [],
    },
    async handler(params, ctx) {
      const { cwd, root } = executionScope(ctx);
      try {
        const goalId = resolveGoalId(params.goal_id, root);
        if (!goalId) return "NO_ACTIVE_GOAL";
        const projection = loadProjectionFn(root, goalId);
        if (!projection) return "NO_ACTIVE_GOAL";
        return statusResponse(projection, cwd, root);
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
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
      },
      required: ["task_id"],
    },
    async handler(params, ctx) {
      const { cwd, root } = executionScope(ctx);
      const goalId = resolveGoalId(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");
      const projection = loadProjectionFn(root, goalId);
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
          releaseExecutorWorkspace(lease, { disposition: "failed-cleanup" });
        } catch (cleanupErr) {
          throw new Error(`${err.message}; workspace cleanup also failed: ${cleanupErr.message}`, { cause: err });
        }
        throw err;
      }

      const event = makeEvent("task.dispatched", {
        taskId: params.task_id,
        contractHash: contract.hash,
        workspace: {
          attempt,
          path: lease.path,
          branch: lease.branch,
          baseCommit,
          originRef: lease.originRef,
        },
      }, goalId);
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
            releaseExecutorWorkspace(lease, { disposition: "failed-cleanup" });
          } catch (cleanupErr) {
            throw new Error(`${err.message}; workspace cleanup also failed: ${cleanupErr.message}`, { cause: err });
          }
          throw err;
        } else {
          throw ambiguousDispatchCommitError(goalId, params.task_id, attempt, err);
        }
      }

      activeLeases.set(leaseKey(cwd, goalId, params.task_id), lease);

      return JSON.stringify({
        status: "dispatched",
        task_id: params.task_id,
        contract,
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
      },
      required: ["task_id", "outcome", "next_action"],
    },
    async handler(params, ctx) {
      const { cwd, root } = executionScope(ctx);
      const goalId = resolveGoalId(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");
      let projection = loadProjectionFn(root, goalId);

      const settlementData = {
        taskId: params.task_id,
        outcome: params.outcome,
        evidence: params.evidence || null,
        evidenceSource: params.evidence_source || "self_produced",
        nextAction: params.next_action,
        reason: params.reason || null,
      };
      const task = projection.tasks.get(params.task_id);
      // Validate semantic reducer errors before touching Git. A non-empty sentinel
      // exercises strict v2 settlement binding without claiming persisted identity.
      if (params.outcome === "succeeded") {
        settlementData.attempt = task?.workspace?.attempt ?? 1;
        settlementData.executorHead = "candidate-settlement-validation";
      }
      let candidate;
      try {
        candidate = applyEvent(projection, makeEvent("task.settled", settlementData, goalId));
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
      const settleEvent = makeEvent("task.settled", settlementData, goalId);
      projection = appendEventFn(root, settleEvent, projection.version);

      const cpEvent = makeEvent("goal.checkpoint", { nextAction: params.next_action }, goalId);
      projection = appendEventFn(root, cpEvent, projection.version);

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
      },
      required: ["task_id"],
    },
    async handler(params, ctx) {
      const { root } = executionScope(ctx);
      // Terminal goals are deliberately addressable only by explicit identity.
      if (!params.goal_id) {
        const activeGoalId = resolveGoalId(null, root);
        if (!activeGoalId) throw new Error("No active goal");
        params = { ...params, goal_id: activeGoalId };
      }
      const goalId = params.goal_id;
      let projection = loadProjectionFn(root, goalId);
      if (projection?.goalId !== goalId) throw ambiguousAcceptCommitError(goalId, params.task_id);
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
        const acceptEvent = makeEvent("task.accepted", { taskId: params.task_id, workspaceAttempt: task.workspace?.attempt }, goalId);
        try { projection = appendEventFn(root, acceptEvent, projection.version); }
        catch (cause) {
          projection = reloadAfterFailure(cause, (recovered) => recovered.tasks.get(params.task_id)?.status === "accepted");
        }
        task = projection.tasks.get(params.task_id);
      } else if (task.status !== "accepted") {
        throw new Error(`task is not succeeded or accepted: ${params.task_id} (${task.status})`);
      }

      const progress = goalProgress(projection);
      if (progress.accepted !== progress.total) return respond(projection);
      const verdict = completionVerdictFor(projection);
      try {
        projection = appendEventFn(root, makeEvent("goal.completed", { verdict }, goalId), projection.version);
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
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        reason: { type: "string", description: "修改原因（≥10字符）" },
        add_tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" }, description: { type: "string" },
              deps: { type: "array", items: { type: "string" } },
              writePaths: { type: "array", items: { type: "string" } },
              acceptance: { type: "object", properties: { criteria: { type: "array", items: { type: "string" } }, commands: { type: "array", items: { type: "string" } } }, required: ["criteria", "commands"] },
              workflow: { type: "string", enum: ["tdd", "existing-tests", "docs-only"] },
            },
            required: ["id", "description", "writePaths", "acceptance"],
          },
        },
        remove_tasks: { type: "array", items: { type: "string" } },
        update_tasks: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { description: { type: "string" }, deps: { type: "array", items: { type: "string" } }, writePaths: { type: "array", items: { type: "string" } }, acceptance: { type: "object" }, workflow: { type: "string", enum: ["tdd", "existing-tests", "docs-only"] } },
          },
        },
      },
      required: ["reason"],
    },
    async handler(params, ctx) {
      const { cwd, root } = executionScope(ctx);
      const goalId = resolveGoalId(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");
      const projection = loadProjectionFn(root, goalId);

      const addTasks = {};
      if (params.add_tasks) {
        for (const t of params.add_tasks) {
          addTasks[t.id] = { description: t.description, deps: t.deps || [], writePaths: t.writePaths, acceptance: t.acceptance, workflow: t.workflow || "tdd" };
        }
      }

      const event = makeEvent("goal.amended", {
        reason: params.reason,
        addTasks: Object.keys(addTasks).length > 0 ? addTasks : undefined,
        removeTasks: params.remove_tasks || undefined,
        updateTasks: params.update_tasks || undefined,
      }, goalId);
      try {
        const candidate = applyEvent(projection, event);
        validateTaskDefinitions([...candidate.tasks.keys()], taskDefsFromProjection(candidate), { cwd, realpathCwd: realpathSync(cwd) });
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
      },
      required: ["task_id", "action"],
    },
    async handler(params, ctx) {
      const { cwd, root } = executionScope(ctx);
      const goalId = resolveGoalId(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");

      let projection = loadProjectionFn(root, goalId);
      const taskId = params.task_id;
      let task = projection.tasks.get(taskId);
      if (!task) throw new Error(`unknown task: ${taskId}`);

      const action = params.action;
      const key = leaseKey(cwd, goalId, taskId);
      let taskWorkspace = task.workspace;

      // A pending task without a projection workspace may still own the exact
      // next-attempt workspace after an interrupted dispatch append. Recover
      // only a verified snapshot; the supplied callback is a scheduling
      // barrier, never a source of recovery facts.
      const candidateAttempt = task.status === "pending" && !taskWorkspace
        ? nextDispatchAttempt(projection, taskId)
        : null;
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
          const recoveryEvent = makeEvent("task.workspace_orphan_recovered", {
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
          }, goalId);
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
        const resourceValues = [resources.workspaceExists, resources.branchExists, resources.leaseExists];
        const allResourcesPresent = resourceValues.every((value) => value === true);
        const noResourcesPresent = resourceValues.every((value) => value === false);
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
          if (resources.workspaceExists || resources.branchExists || resources.leaseExists) {
            throw workspaceMutationError(new Error("failed to release preserved workspace resources"), retry);
          }
        }

        // With no resources, a retry may use projection identity only; the event
        // records the completed cleanup and is deliberately appended afterwards.
        const releaseEvent = makeEvent("task.workspace_preservation_released", {
          taskId,
          attempt: taskWorkspace.attempt,
          executorHead: taskWorkspace.executorHead,
          released: true,
        }, goalId);
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
        } else if (resources.workspaceExists || resources.branchExists || resources.leaseExists) {
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
          const disposedEvent = makeEvent("task.workspace_disposed", {
            taskId,
            attempt: currentWorkspace.attempt,
            action: currentWorkspace.requestedAction,
            released: false,
          }, goalId);
          projection = appendEventFn(root, disposedEvent, projection.version);
          return false;
        }

        const resourcesBefore = inspectExecutorWorkspaceResources(lease);
        if (resourcesBefore.workspaceExists || resourcesBefore.branchExists || resourcesBefore.leaseExists) {
          releaseExecutorWorkspace(
            lease,
            {
              disposition: currentWorkspace.requestedAction === "integrate" ? "integrated-cleanup" : "discarded-cleanup",
            },
          );
        }

        const resourcesAfter = inspectExecutorWorkspaceResources(lease);
        if (resourcesAfter.workspaceExists || resourcesAfter.branchExists || resourcesAfter.leaseExists) {
          throw new Error("failed to release workspace resources after disposal");
        }

        // A released fact is durable evidence of an already-completed cleanup.
        const disposedEvent = makeEvent("task.workspace_disposed", {
          taskId,
          attempt: currentWorkspace.attempt,
          action: currentWorkspace.requestedAction,
          released: true,
        }, goalId);
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

        const startedEvent = makeEvent("task.workspace_disposition_started", {
          taskId,
          attempt: taskWorkspace.attempt,
          requestedAction: action,
          strategy,
          executorHead,
          originHeadBefore: gitHead(cwd),
          originRef: lease.originRef,
        }, goalId);
        projection = appendEventFn(root, startedEvent, projection.version);

        const nextTask = projection.tasks.get(taskId);
        if (action === "integrate" && !isExecutorWorkspaceIntegrated(lease, { strategy, executorHead: nextTask.workspace.executorHead })) {
          integrateExecutorWorkspace(lease, { strategy, executorHead: nextTask.workspace.executorHead, originRef: nextTask.workspace.originRef, originHeadBefore: nextTask.workspace.originHeadBefore });
        }

        const appliedEvent = makeEvent("task.workspace_disposition_applied", {
          taskId,
          attempt: nextTask.workspace.attempt,
          action,
          strategy,
          executorHead: nextTask.workspace.executorHead,
          originHead: gitHead(cwd),
        }, goalId);
        projection = appendEventFn(root, appliedEvent, projection.version);
      } else if (taskWorkspace.phase === "disposing") {
        if (taskWorkspace.requestedAction !== action) {
          throw new Error(`workspace action mismatch (expected ${taskWorkspace.requestedAction}, got ${action})`);
        }

        const strategy = params.strategy || taskWorkspace.strategy || DEFAULT_DISPOSITION_STRATEGY;
        if (strategy !== taskWorkspace.strategy) {
          throw new Error(`workspace strategy mismatch (expected ${taskWorkspace.strategy}, got ${strategy})`);
        }

        if (action === "integrate" && !isExecutorWorkspaceIntegrated(lease, { strategy, executorHead: taskWorkspace.executorHead })) {
          integrateExecutorWorkspace(lease, { strategy, executorHead: taskWorkspace.executorHead, originRef: taskWorkspace.originRef, originHeadBefore: taskWorkspace.originHeadBefore });
        }

        const appliedEvent = makeEvent("task.workspace_disposition_applied", {
          taskId,
          attempt: taskWorkspace.attempt,
          action,
          strategy,
          executorHead: taskWorkspace.executorHead,
          originHead: gitHead(cwd),
        }, goalId);
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
      return JSON.stringify(formatDispositionResponse(finalWorkspace));
    },

  });

  // --- tool_result hook: checkpoint reminder ---
  pi.on("tool_result", (event, ctx) => {
    let root;
    try { ({ root } = executionScope(ctx)); } catch { return undefined; }
    if (event.isError) return undefined;
    if (["goal_settle", "goal_status", "goal_init", "goal_dispatch", "goal_accept", "goal_amend", "goal_integrate"].includes(event.toolName)) return undefined;

    let activeGoals;
    try { activeGoals = listGoalsFn(root); } catch { return undefined; }
    if (activeGoals.length === 0) return undefined;

    turnsSinceSettle++;
    if (turnsSinceSettle < CHECKPOINT_REMINDER_THRESHOLD) return undefined;

    let projection;
    try { projection = loadProjectionFn(root, activeGoals[0]); } catch { return undefined; }
    if (!projection || projection.lifecycle !== "active") return undefined;

    const reminder = `\n\n⚠️ [goal-engine] 活跃 goal "${projection.goalId}" 已 ${turnsSinceSettle} 轮未 settle。当前 runnable: [${runnableFrontier(projection).join(", ")}]。请推进任务或调用 goal_settle 更新状态。`;
    const content = (event.content || []).map((part, i) => {
      if (i === 0 && part?.type === "text") return { ...part, text: part.text + reminder };
      return part;
    });
    return { content, details: event.details, isError: false };
  });
}
