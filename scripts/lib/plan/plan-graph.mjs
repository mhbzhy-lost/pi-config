function visit(task, byId, visiting, visited) {
  if (visiting.has(task.id)) throw new Error(`dependency cycle at ${task.id}`);
  if (visited.has(task.id)) return;
  visiting.add(task.id);
  for (const dep of task.deps) visit(byId.get(dep), byId, visiting, visited);
  visiting.delete(task.id);
  visited.add(task.id);
}

export function createPlanGraph(plan) {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const visited = new Set();
  for (const task of plan.tasks) visit(task, byId, new Set(), visited);
  return { tasks: plan.tasks, byId };
}

export function nextRunnableTask(projection) {
  for (const task of projection.graph.tasks) {
    if (projection.tasks.get(task.id)?.status !== "pending") continue;
    if (task.deps.every((dep) => projection.tasks.get(dep)?.status === "accepted")) return task;
  }
  return undefined;
}
