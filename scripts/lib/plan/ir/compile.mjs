import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sortedRecord(record = {}) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export function pathsOverlap(left, right) {
  const prefix = (value) => value.endsWith("/**") ? value.slice(0, -3).replace(/\/$/, "") : null;
  if (left === right) return true;
  const leftPrefix = prefix(left);
  const rightPrefix = prefix(right);
  if (leftPrefix !== null && (right === leftPrefix || right.startsWith(`${leftPrefix}/`))) return true;
  if (rightPrefix !== null && (left === rightPrefix || left.startsWith(`${rightPrefix}/`))) return true;
  return leftPrefix !== null && rightPrefix !== null
    && (leftPrefix.startsWith(`${rightPrefix}/`) || rightPrefix.startsWith(`${leftPrefix}/`));
}

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

function hasDependencyPath(fromId, targetId, byId, memo) {
  const key = `${fromId}->${targetId}`;
  if (memo.has(key)) return memo.get(key);
  const node = byId.get(fromId);
  const result = node.deps.includes(targetId)
    || node.deps.some((dep) => hasDependencyPath(dep, targetId, byId, memo));
  memo.set(key, result);
  return result;
}

function assertNoConcurrentOwnershipConflicts(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map();
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex++) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      if (hasDependencyPath(left.id, right.id, byId, memo) || hasDependencyPath(right.id, left.id, byId, memo)) continue;
      for (const leftPath of left.allowedPaths) {
        for (const rightPath of right.allowedPaths) {
          if (!pathsOverlap(leftPath, rightPath)) continue;
          const detail = `${left.id}:${leftPath} <-> ${right.id}:${rightPath}`;
          throw Object.assign(new Error(`Concurrent path ownership conflict: ${detail}`), {
            code: "PATH_OWNERSHIP_CONFLICT",
            detail,
          });
        }
      }
    }
  }
}

function compileV1(plan, sorted) {
  const nodes = sorted.map((task) => ({
    id: task.id,
    title: task.title,
    deps: [...task.deps],
    files: [...task.files],
    agent: "executor",
  }));
  const edges = plan.tasks.flatMap((task) => task.deps.map((dep) => ({ from: dep, to: task.id })));
  return Object.freeze({
    version: "plan-ir.v1",
    nodes: Object.freeze(nodes.map((node) => Object.freeze(node))),
    edges: Object.freeze(edges.map((edge) => Object.freeze(edge))),
    hash: undefined,
    nodeFingerprints: undefined,
    declaredDeps: undefined,
  });
}

function compileV2(plan, sorted) {
  const nodes = sorted.map((task) => ({
    id: task.id,
    title: task.title,
    deps: [...task.deps],
    allowedPaths: [...task.allowedPaths],
    resources: [...task.resources]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map((resource) => ({ id: resource.id, mode: resource.mode })),
    agent: "executor",
  }));
  assertNoConcurrentOwnershipConflicts(nodes);
  const edges = plan.tasks.flatMap((task) => task.deps.map((dep) => ({ from: dep, to: task.id })));
  const resourceCapacities = sortedRecord(plan.resourceCapacities);
  const canonicalNodes = nodes.map((node) => ({
    ...node,
    deps: [...node.deps],
    allowedPaths: [...node.allowedPaths],
    resources: node.resources.map((resource) => ({ ...resource })),
  }));
  const canonicalEdges = edges.map((edge) => ({ ...edge }));
  const nodeFingerprints = Object.fromEntries(nodes.map((node) => [
    node.id,
    sha256({
      id: node.id,
      deps: node.deps,
      allowedPaths: node.allowedPaths,
      resources: node.resources,
      agent: node.agent,
    }),
  ]));
  const hash = sha256({
    version: "plan-ir.v2",
    resourceCapacities,
    nodes: canonicalNodes,
    edges: canonicalEdges,
  });
  const frozenNodes = nodes.map((node) => Object.freeze({
    ...node,
    deps: Object.freeze([...node.deps]),
    allowedPaths: Object.freeze([...node.allowedPaths]),
    resources: Object.freeze(node.resources.map((resource) => Object.freeze({ ...resource }))),
  }));
  return Object.freeze({
    version: "plan-ir.v2",
    resourceCapacities: Object.freeze({ ...resourceCapacities }),
    nodes: Object.freeze(frozenNodes),
    edges: Object.freeze(edges.map((edge) => Object.freeze({ ...edge }))),
    hash,
    nodeFingerprints: Object.freeze({ ...nodeFingerprints }),
  });
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
  return plan.schemaVersion === "pi-plan.v2" ? compileV2(plan, sorted) : compileV1(plan, sorted);
}
