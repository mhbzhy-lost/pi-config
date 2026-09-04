import { generationCapabilities } from "./generation-capabilities.ts";

export function validateDAG(tasks) {
  for (const [taskId, task] of tasks) {
    for (const dep of task.deps) {
      if (!tasks.has(dep)) throw new Error(`unknown dep: ${taskId} depends on ${dep}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(taskId) {
    if (visiting.has(taskId)) throw new Error(`dependency cycle at ${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dep of tasks.get(taskId).deps) visit(dep);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const taskId of tasks.keys()) visit(taskId);
}

export function nextDispatchAttempt(projection, taskId) {
  const task = projection?.tasks?.get(taskId);
  if (projection?.lifecycle !== "active" || task?.status !== "pending") return null;
  return workspaceReleasedForRetry(task.workspace) ? task.attempts + 1 : null;
}

export function runnableFrontier(projection, { blockedTaskIds = new Set() } = {}) {
  if (projection.lifecycle !== "active") return [];
  const frontier = [];
  for (const [taskId, task] of projection.tasks) {
    if (blockedTaskIds.has(taskId) || task.status !== "pending") continue;
    if (!workspaceReleasedForRetry(task.workspace)) continue;
    const depsReady = task.deps.every((dep) => projection.tasks.get(dep)?.status === "accepted");
    if (depsReady) frontier.push(taskId);
  }
  return frontier;
}

export function goalProgress(projection) {
  let accepted = 0, dispatched = 0, succeeded = 0, pending = 0, blocked = 0;
  for (const [, task] of projection.tasks) {
    if (task.status === "accepted") accepted++;
    else if (task.status === "dispatched" || task.status === "dispatch_requested") dispatched++;
    else if (task.status === "succeeded") succeeded++;
    else if (task.status === "pending") pending++;
    else if (task.status === "blocked") blocked++;
  }
  return { total: projection.tasks.size, accepted, dispatched, succeeded, pending, blocked };
}

function noAction(blockingReason = null) {
  return {
    allowedActions: [],
    requiredNextAction: null,
    blockingReason,
  };
}

function actionState(tool, taskId, params, reason, blockingReason = null) {
  return {
    allowedActions: [...new Set([tool])],
    requiredNextAction: { tool, params: { task_id: taskId, ...params }, reason },
    blockingReason,
  };
}

function workspaceReleasedForRetry(workspace) {
  return !workspace || (workspace.phase === "disposed" && ((workspace.disposition === "discarded" && workspace.released === true)
    || (workspace.disposition === "preserved" && workspace.preservedResourcesReleased === true)));
}

function dependencyBlockingReason(task, projection) {
  const blockedDeps = task.deps.filter((depId) => projection.tasks.get(depId)?.status !== "accepted");
  if (blockedDeps.length === 0) return null;
  return `task dependencies are not accepted: ${blockedDeps.join(", ")}`;
}

export function orphanWorkspaceActionState(taskId, inventory) {
  if (inventory?.kind === "verified") {
    return {
      allowedActions: ["goal_integrate"],
      requiredNextAction: null,
      blockingReason: {
        code: "ORPHANED_EXECUTOR_WORKSPACE",
        requiresHumanDecision: true,
        choices: [
          { tool: "goal_integrate", params: { task_id: taskId, action: "discard" } },
          { tool: "goal_integrate", params: { task_id: taskId, action: "preserve" } },
        ],
      },
    };
  }
  const blockingReason = {
    code: "ORPHANED_WORKSPACE_IDENTITY_UNVERIFIED",
    resources: inventory?.resources || { workspaceExists: null, branchExists: null, leaseExists: null },
  };
  if (inventory?.observed !== undefined) blockingReason.observed = inventory.observed;
  if (inventory?.error !== undefined) blockingReason.error = inventory.error;
  return { allowedActions: [], requiredNextAction: null, blockingReason };
}

export function taskActionState(projection, taskId) {
  const task = projection?.tasks?.get(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);

  if (projection.lifecycle !== "active") return noAction();
  if (task.status === "accepted") {
    if (generationCapabilities(projection.eventSchemaVersion ?? projection.runtimeGeneration ?? "planned.v1").completion !== "accept-auto") return noAction();
    const allAccepted = [...projection.tasks.values()].every((candidate) => candidate.status === "accepted");
    const firstTaskId = projection.tasks.keys().next().value;
    return allAccepted && taskId === firstTaskId
      ? actionState("goal_accept", taskId, {}, "All tasks are accepted; finalize the goal")
      : noAction();
  }

  const workspace = task.workspace;
  if (workspace?.phase === "disposing" || workspace?.phase === "applied") {
    const requestedAction = workspace.requestedAction;
    const strategy = workspace.strategy;
    if (typeof requestedAction === "string" && requestedAction.length > 0 && typeof strategy === "string" && strategy.length > 0) {
      return actionState("goal_integrate", taskId, { action: requestedAction, strategy }, "Workspace disposition is pending; continue integration step");
    }
    return noAction("workspace disposition is missing required action or strategy");
  }

  if (workspace?.phase === "disposed" && workspace.disposition === "preserved" && workspace.preservedResourcesReleased !== true) {
    return actionState("goal_integrate", taskId, { action: "discard" }, "Preserved workspace must be explicitly released before retrying");
  }

  switch (task.status) {
    case "dispatch_requested":
      return actionState("goal_dispatch", taskId, {}, "Workspace request is durable; return the exact source contract for subagent retry");
    case "dispatched":
      return actionState("goal_settle", taskId, {}, "Task has been dispatched and requires settlement");

    case "succeeded":
      if (!workspace) {
        return actionState("goal_amend", taskId, {}, "Legacy succeeded task has no trusted workspace information");
      }
      if (workspace.phase === "active") {
        return actionState("goal_integrate", taskId, { action: "integrate" }, "Succeeded task workspace is still active");
      }
      if (workspace.phase === "disposed" && workspace.disposition === "integrated" && workspace.released === true) {
        return actionState("goal_accept", taskId, {}, "Workspace integrated and released, task can be accepted");
      }
      return noAction();

    case "pending": {
      if (workspace?.phase === "active") {
        if (task.lastSettledOutcome === "failed" || task.lastSettledOutcome === "blocked") {
          return actionState("goal_integrate", taskId, { action: "discard" }, "Settlement failed/blocked; discard active workspace before retrying");
        }
        return noAction();
      }

      if (!workspaceReleasedForRetry(workspace)) {
        return noAction(`workspace is not redispatchable and blocks dispatch: phase=${workspace.phase}, disposition=${workspace.disposition}, released=${workspace.released}`);
      }

      const blockingReason = dependencyBlockingReason(task, projection);
      if (blockingReason) return noAction(blockingReason);
      return actionState("goal_dispatch", taskId, {}, "All dependencies are accepted and task is ready to dispatch");
    }

    case "blocked":
      if (workspace?.phase === "active") {
        return actionState("goal_integrate", taskId, { action: "discard" }, "Blocked task has active workspace; discard to continue safely");
      }
      return actionState("goal_amend", taskId, {}, "Blocked task requires an explicit goal amendment");

    default:
      return noAction();
  }
}
