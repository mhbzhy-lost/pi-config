import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { validateDAG, runnableFrontier, goalProgress } from "./graph.mjs";
import { appendEvent, loadProjection, listGoals } from "./store.mjs";
import { compileTaskContract } from "./dispatch.mjs";
import { allocateExecutorWorkspace, loadExecutorWorkspaceLease, inspectExecutorWorkspace, integrateExecutorWorkspace, releaseExecutorWorkspace } from "./workspace.mjs";

const STATE_ROOT_REL = ".state/goal-engine";
const GOAL_ID_RE = /[^a-zA-Z0-9._-]+/g;
const CHECKPOINT_REMINDER_THRESHOLD = 5;

function stateRoot(cwd) {
  return join(cwd, STATE_ROOT_REL);
}

function slugify(raw) {
  const slug = raw.toLowerCase().replace(GOAL_ID_RE, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 80);
  if (!slug) throw new Error("objective must produce a non-empty goal id");
  return slug;
}

function makeEvent(type, data, goalId) {
  return {
    schemaVersion: "goal-engine.event.v1",
    eventId: crypto.randomUUID(),
    goalId,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

function resolveGoal(goalId, root) {
  if (goalId) return goalId;
  const active = listGoals(root);
  if (active.length === 0) return null;
  if (active.length > 1) throw new Error(`Multiple active goals: ${active.join(", ")}. Specify goal_id.`);
  return active[0];
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
    tasks: Object.fromEntries([...projection.tasks].map(([id, t]) => [id, {
      description: t.description, status: t.status, deps: t.deps,
      writePaths: t.writePaths, acceptance: t.acceptance,
      evidence_count: t.evidence.length, attempts: t.attempts,
      contractHash: t.contractHash,
    }])),
  }, null, 2);
}

export function createGoalEngineExtension(pi) {
  const cwd = pi.cwd || process.cwd();
  const root = stateRoot(cwd);
  let turnsSinceSettle = 0;
  const activeLeases = new Map();

  pi.registerTool({
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
    async handler(params) {
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
      appendEvent(root, event, 0);

      const projection = loadProjection(root, goalId);
      return JSON.stringify({
        goalId,
        lifecycle: "active",
        runnable: runnableFrontier(projection),
        total_tasks: taskIds.length,
      });
    },
  });

  pi.registerTool({
    name: "goal_status",
    description: "获取当前活跃 goal 的完整恢复上下文。compact 后必须首先调用。返回：objective、task 状态、可执行前沿、next_action、进度、每个 task 的 writePaths 和 acceptance。",
    parameters: {
      type: "object",
      properties: { goal_id: { type: "string" } },
      required: [],
    },
    async handler(params) {
      try {
        const goalId = resolveGoal(params.goal_id, root);
        if (!goalId) return "NO_ACTIVE_GOAL";
        const projection = loadProjection(root, goalId);
        if (!projection) return "NO_ACTIVE_GOAL";
        return statusResponse(projection);
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },
  });

  pi.registerTool({
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
    async handler(params) {
      const goalId = resolveGoal(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");
      const projection = loadProjection(root, goalId);
      const task = projection.tasks.get(params.task_id);
      if (!task) throw new Error(`unknown task: ${params.task_id}`);

      const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
      const lease = allocateExecutorWorkspace({
        goalId,
        taskId: params.task_id,
        attempt: task.attempts + 1,
        originRoot: cwd,
        stateRoot: root,
        baseCommit,
      });

      const contract = compileTaskContract(projection, params.task_id, lease.path, {
        timeoutMs: params.timeout_ms || 30 * 60 * 1000,
      });

      const event = makeEvent("task.dispatched", { taskId: params.task_id, contractHash: contract.hash }, goalId);
      appendEvent(root, event, projection.version);

      activeLeases.set(params.task_id, lease);

      return JSON.stringify({
        status: "dispatched",
        task_id: params.task_id,
        contract,
        workspace: { path: lease.path, branch: lease.branch, baseCommit: lease.baseCommit },
      });
    },
  });

  pi.registerTool({
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
    async handler(params) {
      const goalId = resolveGoal(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");
      let projection = loadProjection(root, goalId);

      const settleEvent = makeEvent("task.settled", {
        taskId: params.task_id,
        outcome: params.outcome,
        evidence: params.evidence || null,
        evidenceSource: params.evidence_source || "self_produced",
        nextAction: params.next_action,
        reason: params.reason || null,
      }, goalId);
      projection = appendEvent(root, settleEvent, projection.version);

      const cpEvent = makeEvent("goal.checkpoint", { nextAction: params.next_action }, goalId);
      projection = appendEvent(root, cpEvent, projection.version);

      turnsSinceSettle = 0;

      return JSON.stringify({
        status: params.outcome,
        task_id: params.task_id,
        runnable: runnableFrontier(projection),
        progress: goalProgress(projection),
      });
    },
  });

  pi.registerTool({
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
    async handler(params) {
      const goalId = resolveGoal(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");
      let projection = loadProjection(root, goalId);

      const acceptEvent = makeEvent("task.accepted", { taskId: params.task_id }, goalId);
      projection = appendEvent(root, acceptEvent, projection.version);

      const progress = goalProgress(projection);
      const allAccepted = progress.accepted === progress.total;

      let completionVerdict = null;
      if (allAccepted) {
        const allEvidence = [...projection.tasks.values()].flatMap((t) => t.evidence);
        const hasExternal = allEvidence.some((e) => e.source !== "self_produced");
        completionVerdict = hasExternal ? "COMPLETE" : "DONE_WITHOUT_EXTERNAL_VERIFICATION";

        const completeEvent = makeEvent("goal.completed", { verdict: completionVerdict }, goalId);
        projection = appendEvent(root, completeEvent, projection.version);
      }

      return JSON.stringify({
        status: "accepted",
        task_id: params.task_id,
        goal_complete: allAccepted,
        ...(completionVerdict ? { completion_verdict: completionVerdict } : {}),
        progress: goalProgress(projection),
      });
    },
  });

  pi.registerTool({
    name: "goal_amend",
    description: "修改 goal 的 task DAG（增删改 task）。需要 reason（≥10字符）。不能删除已 accepted 的 task。用于人类介入调整方向。新增 task 必须含 writePaths 和 acceptance。",
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
    async handler(params) {
      const goalId = resolveGoal(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");
      const projection = loadProjection(root, goalId);

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
      const updated = appendEvent(root, event, projection.version);
      return statusResponse(updated);
    },
  });

  pi.registerTool({
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
    async handler(params) {
      const goalId = resolveGoal(params.goal_id, root);
      if (!goalId) throw new Error("No active goal");

      const projection = loadProjection(root, goalId);
      const task = projection.tasks.get(params.task_id);
      if (!task) throw new Error(`unknown task: ${params.task_id}`);

      const lease = activeLeases.get(params.task_id) ?? loadExecutorWorkspaceLease({
        goalId,
        taskId: params.task_id,
        attempt: task.attempts,
        stateRoot: root,
      });
      activeLeases.set(params.task_id, lease);

      if (params.action === "preserve") {
        releaseExecutorWorkspace(lease, { disposition: "preserved" });
        activeLeases.delete(params.task_id);
        return JSON.stringify({ action: "preserved", path: lease.path, branch: lease.branch });
      }

      if (params.action === "discard") {
        releaseExecutorWorkspace(lease, { disposition: "discarded-cleanup" });
        activeLeases.delete(params.task_id);
        return JSON.stringify({ action: "discarded", released: true });
      }

      const inspection = inspectExecutorWorkspace(lease);
      if (!inspection.hasCommits) {
        releaseExecutorWorkspace(lease, { disposition: "integrated-cleanup" });
        activeLeases.delete(params.task_id);
        return JSON.stringify({ action: "integrated", note: "no commits to integrate", released: true });
      }

      const result = integrateExecutorWorkspace(lease, { strategy: params.strategy || "cherry-pick" });
      releaseExecutorWorkspace(lease, { disposition: "integrated-cleanup" });
      activeLeases.delete(params.task_id);

      return JSON.stringify({
        action: "integrated",
        strategy: result.strategy,
        newHead: result.newHead,
        released: true,
      });
    },
  });

  // --- tool_result hook: checkpoint reminder ---
  pi.on("tool_result", (event) => {
    if (event.isError) return undefined;
    if (["goal_settle", "goal_status", "goal_init", "goal_dispatch", "goal_accept", "goal_amend", "goal_integrate"].includes(event.toolName)) return undefined;

    let activeGoals;
    try { activeGoals = listGoals(root); } catch { return undefined; }
    if (activeGoals.length === 0) return undefined;

    turnsSinceSettle++;
    if (turnsSinceSettle < CHECKPOINT_REMINDER_THRESHOLD) return undefined;

    let projection;
    try { projection = loadProjection(root, activeGoals[0]); } catch { return undefined; }
    if (!projection || projection.lifecycle !== "active") return undefined;

    const reminder = `\n\n⚠️ [goal-engine] 活跃 goal "${projection.goalId}" 已 ${turnsSinceSettle} 轮未 settle。当前 runnable: [${runnableFrontier(projection).join(", ")}]。请推进任务或调用 goal_settle 更新状态。`;
    const content = (event.content || []).map((part, i) => {
      if (i === 0 && part?.type === "text") return { ...part, text: part.text + reminder };
      return part;
    });
    return { content, details: event.details, isError: false };
  });
}
