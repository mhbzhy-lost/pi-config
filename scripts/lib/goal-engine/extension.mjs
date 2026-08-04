import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { validateDAG, runnableFrontier, goalProgress, taskActionState } from "./graph.mjs";
import { appendEvent, loadProjection, listGoals } from "./store.mjs";
import { compileTaskContract } from "./dispatch.mjs";
import {
  allocateExecutorWorkspace,
  loadExecutorWorkspaceLease,
  inspectExecutorWorkspace,
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


function completionVerdictFor(projection) {
  const allEvidence = [...projection.tasks.values()].flatMap((task) => task.evidence);
  return allEvidence.some((evidence) => evidence.source !== "self_produced")
    ? "COMPLETE"
    : "DONE_WITHOUT_EXTERNAL_VERIFICATION";
}

function ambiguousAcceptCommitError(goalId, taskId, cause) {
  return Object.assign(new Error(`ambiguous accept commit for goal ${goalId}, task ${taskId}`), {
    code: "AMBIGUOUS_ACCEPT_COMMIT",
    cause,
  });
}

function statusResponse(projection) {
  const progress = goalProgress(projection);
  const runnable = runnableFrontier(projection);
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
      const actionState = taskActionState(projection, id);
      return [id, {
        description: t.description,
        status: t.status,
        deps: t.deps,
        writePaths: t.writePaths,
        acceptance: t.acceptance,
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
  const activeLeases = new Map();
  let turnsSinceSettle = 0;

  const resolveGoalId = (goalId, root) => {
    if (goalId) return goalId;
    const active = listGoalsFn(root);
    if (active.length === 0) return null;
    if (active.length > 1) throw new Error(`Multiple active goals: ${active.join(", ")}. Specify goal_id.`);
    return active[0];
  };

  const resolveWorkspaceLease = (task, goalId, taskId, cwd, root) => {
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
    } else {
      lease = {
        ...expected,
        ownerToken: "restored",
        createdAt: new Date().toISOString(),
      };
    }

    return lease;
  };

  const resolveLease = (task, goalId, taskId, cwd, root) => {
    const key = leaseKey(cwd, goalId, taskId);
    const expected = workspaceLeaseIdentityFromProjection(task.workspace, goalId, taskId, cwd, root);
    const cached = activeLeases.get(key);
    if (cached) {
      assertLeaseIdentity(cached, expected, "cached");
    }
    const lease = resolveWorkspaceLease(task, goalId, taskId, cwd, root);
    activeLeases.set(key, lease);
    return lease;
  };

  registerGoalTool(pi, {
    name: "goal_init",
    description: "创建长任务 goal。将目标结构化为 task DAG（含 writePaths、acceptance、workflow），持久化到 .state/goal-engine/。用于 24h+ 跨多次 compaction 的任务。主 agent 作为 coordinator 驱动执行。",
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
      const goalId = slugify(params.objective);
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
      validateDAG(new Map(Object.entries(taskDefs).map(([k, v]) => [k, { deps: v.deps }])));

      const event = makeEvent("goal.created", {
        objective: params.objective,
        scope: params.scope || [],
        nonGoals: params.non_goals || [],
        dod: params.dod || [],
        tasks: taskIds,
        taskDefs,
      }, goalId);
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
    description: "获取当前活跃 goal 的完整恢复上下文。compact 后必须首先调用。返回：objective、task 状态、可执行前沿、next_action、进度、每个 task 的 writePaths 和 acceptance。",
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
        return statusResponse(projection);
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },
  });

  registerGoalTool(pi, {
    name: "goal_dispatch",
    description: "为 task 分配独立 git worktree，编译 dispatch-ir.v1 契约（execution.cwd 指向 worktree），标记为 dispatched。返回的 contract 直接传给 subagent tool 派发 executor。",
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

      if (task.workspace && !(task.workspace.phase === "disposed" && task.workspace.disposition === "discarded" && task.workspace.released === true)) {
        throw new Error("existing workspace must be disposed, discarded, and released before redispatch");
      }

      const frontier = runnableFrontier(projection);
      if (!frontier.includes(params.task_id)) {
        if (task.status !== "pending") {
          throw new Error(`task is not runnable (not pending): ${task.status}`);
        }
        const unmetDeps = task.deps.filter((dep) => projection.tasks.get(dep)?.status !== "accepted");
        throw new Error(`task is not runnable: dependency not accepted (${unmetDeps.join(", ")})`);
      }

      const attempt = task.attempts + 1;
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
    description: "记录 executor 执行结果。succeeded 必须附带 evidence（artifact 引用，非命令字符串）。failed 将 task 重置为 pending（可重试）。同时记录 checkpoint。",
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

      const settleEvent = makeEvent("task.settled", {
        taskId: params.task_id,
        outcome: params.outcome,
        evidence: params.evidence || null,
        evidenceSource: params.evidence_source || "self_produced",
        nextAction: params.next_action,
        reason: params.reason || null,
      }, goalId);
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
    description: "验收一个 succeeded 的 task。如果所有 task 都 accepted，自动触发 goal 完成并返回 completion_verdict。",
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

      const verdictFor = (current) => completionVerdictFor(current);
      if (projection.lifecycle === "completed") {
        const verdict = verdictFor(projection);
        if (task.status !== "accepted" || projection.completionVerdict !== verdict) {
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
      const verdict = verdictFor(projection);
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
    description: "修改 goal 的 task DAG（增删改 task）。需要 reason（≥10字符）。仅可修改没有 workspace 或已 discarded 且 released 的 pending task。用于人类介入调整方向。新增 task 必须含 writePaths 和 acceptance。",
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
            properties: { description: { type: "string" }, deps: { type: "array", items: { type: "string" } }, writePaths: { type: "array", items: { type: "string" } }, acceptance: { type: "object" } },
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
      const updated = appendEventFn(root, event, projection.version);
      return statusResponse(updated);
    },
  });

  registerGoalTool(pi, {
    name: "goal_integrate",
    description: "将 executor worktree 的成果合回主 worktree（cherry-pick 或 merge），或丢弃。在 goal_accept 之前调用。合回后自动释放 worktree。",
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
      const task = projection.tasks.get(taskId);
      if (!task) throw new Error(`unknown task: ${taskId}`);

      const action = params.action;
      const key = leaseKey(cwd, goalId, taskId);
      const taskWorkspace = task.workspace;
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

      if (taskWorkspace.phase === "disposed") {
        const expectedDisposition = { integrate: "integrated", discard: "discarded", preserve: "preserved" };
        if (taskWorkspace.disposition !== expectedDisposition[action]) {
          throw new Error(`workspace action mismatch (expected ${taskWorkspace.disposition}, got ${action})`);
        }

        const strategy = params.strategy || taskWorkspace.strategy || DEFAULT_DISPOSITION_STRATEGY;
        if (params.strategy !== undefined && taskWorkspace.strategy !== undefined && strategy !== taskWorkspace.strategy) {
          throw new Error(`workspace strategy mismatch (expected ${taskWorkspace.strategy}, got ${strategy})`);
        }

        const terminalLease = resolveLease(task, goalId, taskId, cwd, root);
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
      const lease = resolveLease(task, goalId, taskId, cwd, root);
      // This guard deliberately precedes every recovery probe, event append, HEAD
      // read, and cleanup action. Patch equivalence on another ref is not consent.
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
        let inspection;
        if (action === "integrate") {
          inspection = inspectExecutorWorkspace(lease);
          if (!inspection.hasCommits) {
            throw new Error("No commits to integrate");
          }
          if (!inspection.clean) {
            throw new Error("Workspace must be clean before integration");
          }
          assertWorkspaceChangesWithinPaths(inspection, task.writePaths);
        }

        const strategy = params.strategy || DEFAULT_DISPOSITION_STRATEGY;
        const executorHead = action === "integrate"
          ? inspection.headCommit
          : gitHead(lease.path);

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
