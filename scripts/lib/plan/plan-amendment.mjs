const OPEN_ATTEMPT_STATUSES = new Set(["workspace-allocated", "dispatch-requested", "active", "waiting-attention", "validated"]);
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
    if (!OPEN_ATTEMPT_STATUSES.has(attempt.status)) continue;
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
    .filter(([, attempt]) => OPEN_ATTEMPT_STATUSES.has(attempt.status)
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
