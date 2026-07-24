import { createHash } from "node:crypto";

function topoSort(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const visiting = new Set();
  const visited = new Set();
  const sorted = [];

  function visit(id) {
    if (visiting.has(id)) {
      throw Object.assign(new Error(`Dependency cycle detected at ${id}`), { code: "CYCLE_DETECTED", detail: id });
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const node = byId.get(id);
    for (const dep of node.deps) {
      if (!byId.has(dep)) {
        throw Object.assign(new Error(`Unknown dependency ${dep} in ${id}`), { code: "DANGLING_DEP", detail: `${id} -> ${dep}` });
      }
      visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(node);
  }

  for (const node of nodes) visit(node.id);
  return sorted;
}

export function compilePlanToIR(plan) {
  const ids = new Set();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      throw Object.assign(new Error(`Duplicate task id: ${task.id}`), { code: "DUPLICATE_ID", detail: task.id });
    }
    ids.add(task.id);
  }

  const sorted = topoSort(plan.tasks);

  const nodes = sorted.map(task => ({
    id: task.id,
    title: task.title,
    deps: [...task.deps],
    files: [...task.files],
    agent: "executor",
  }));

  const edges = [];
  for (const task of plan.tasks) {
    for (const dep of task.deps) {
      edges.push({ from: dep, to: task.id });
    }
  }

  const ir = {
    version: "plan-ir.v1",
    nodes: Object.freeze(nodes.map(n => Object.freeze(n))),
    edges: Object.freeze(edges.map(e => Object.freeze(e))),
    hash: undefined,
    nodeFingerprints: undefined,
    declaredDeps: undefined,
  };

  return Object.freeze(ir);
}
