export function runnableFrontier(ir, completedSet, activeSet = new Set()) {
  return ir.nodes.filter(node =>
    !completedSet.has(node.id) &&
    !activeSet.has(node.id) &&
    node.deps.every(dep => completedSet.has(dep))
  );
}
