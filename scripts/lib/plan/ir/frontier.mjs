import { createResourceClaimSet, selectAuthorizedFrontier } from "../resource-locks.mjs";

const COMPLETED_TASK_STATUSES = new Set(["accepted", "integrated"]);
const TERMINAL_BLOCKED_TASK_STATUSES = new Set(["cancelled", "failed"]);

export function runnableFrontier(ir, completedSet, activeSet = new Set()) {
  return ir.nodes.filter(node =>
    !completedSet.has(node.id) &&
    !activeSet.has(node.id) &&
    node.deps.every(dep => completedSet.has(dep))
  );
}

function activeAttempts(projection) {
  return [...(projection.attempts?.entries?.() ?? [])]
    .map(([attemptId, attempt]) => ({ attemptId, ...attempt }))
    .filter((attempt) =>
    attempt.workspaceReleased !== true
      && !["cancelled", "failed", "integrated"].includes(attempt.status)
  );
}

export function authorizedFrontier(ir, projection) {
  if (!ir || !Array.isArray(ir.nodes) || !ir.resourceCapacities) {
    throw Object.assign(new Error("Unsupported scheduling view"), { code: "UNSUPPORTED_AUTHORIZATION_IR" });
  }
  const tasks = projection.tasks ?? new Map();
  const completed = new Set();
  const excluded = new Set();
  for (const node of ir.nodes) {
    const status = tasks.get(node.id)?.status;
    if (COMPLETED_TASK_STATUSES.has(status)) completed.add(node.id);
    if (TERMINAL_BLOCKED_TASK_STATUSES.has(status)) excluded.add(node.id);
  }

  const attempts = activeAttempts(projection);
  const claimSet = createResourceClaimSet({ capacities: ir.resourceCapacities });
  for (const attempt of attempts) {
    const node = ir.nodes.find((candidate) => candidate.id === attempt.taskId);
    if (!node) {
      throw Object.assign(new Error(`Active attempt references unknown task: ${attempt.taskId}`), {
        code: "UNKNOWN_ACTIVE_ATTEMPT_TASK",
        detail: attempt.taskId,
      });
    }
    claimSet.acquire(node, attempt.attemptId);
    excluded.add(node.id);
  }

  const runnable = runnableFrontier(ir, completed, excluded);
  const authorized = selectAuthorizedFrontier(runnable.map((node) => ({
    ...node,
    planOrder: ir.nodes.indexOf(node),
  })), {
    capacities: ir.resourceCapacities,
    claims: claimSet.snapshot(),
  }).map(({ planOrder: _planOrder, ...node }) => ir.nodes.find((candidate) => candidate.id === node.id));
  if (authorized.length > 0 || attempts.length > 0) return authorized;

  const remainingTaskIds = ir.nodes
    .filter((node) => !completed.has(node.id) && !excluded.has(node.id))
    .map((node) => node.id);
  if (remainingTaskIds.length === 0) return [];
  return Object.freeze({
    code: "PLAN_AUTHORIZATION_DEADLOCK",
    remainingTaskIds: Object.freeze(remainingTaskIds),
    reason: runnable.length === 0
      ? "dependencies cannot reach an integrated state"
      : "declared resources cannot be authorized",
  });
}
