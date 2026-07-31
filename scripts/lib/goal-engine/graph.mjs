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

export function runnableFrontier(projection) {
  const frontier = [];
  for (const [taskId, task] of projection.tasks) {
    if (task.status !== "pending") continue;
    const depsReady = task.deps.every((dep) => projection.tasks.get(dep)?.status === "accepted");
    if (depsReady) frontier.push(taskId);
  }
  return frontier;
}

export function goalProgress(projection) {
  let accepted = 0, dispatched = 0, succeeded = 0, pending = 0, blocked = 0;
  for (const [, task] of projection.tasks) {
    if (task.status === "accepted") accepted++;
    else if (task.status === "dispatched") dispatched++;
    else if (task.status === "succeeded") succeeded++;
    else if (task.status === "pending") pending++;
    else if (task.status === "blocked") blocked++;
  }
  return { total: projection.tasks.size, accepted, dispatched, succeeded, pending, blocked };
}
