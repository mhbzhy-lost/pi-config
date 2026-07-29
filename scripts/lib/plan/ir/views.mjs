import { assertPlanIRV3, deepFreeze } from "./schema.mjs";

function taskFor(ir, taskId) {
  assertPlanIRV3(ir);
  const task = ir.nodes.find((node) => node.id === taskId);
  if (!task) throw new Error(`unknown IR task: ${taskId}`);
  return task;
}

export function selectLegacySchedulingView(ir) {
  if (!ir || !["plan-ir.v1", "plan-ir.v2"].includes(ir.version)) throw new Error("invalid legacy Plan IR");
  return deepFreeze({
    resourceCapacities: ir.version === "plan-ir.v2" ? { ...ir.resourceCapacities } : {},
    nodes: ir.nodes.map((node) => ({
      id: node.id,
      deps: [...node.deps],
      allowedPaths: [...(node.allowedPaths ?? node.files ?? [])],
      resources: [...(node.resources ?? [])].map((resource) => ({ ...resource })),
      agent: node.agent,
    })),
  });
}

export function selectSchedulingView(ir) {
  if (ir?.version !== "plan-ir.v3") return selectLegacySchedulingView(ir);
  assertPlanIRV3(ir);
  return deepFreeze({
    resourceCapacities: { ...ir.resourceCapacities },
    nodes: ir.nodes.map((node) => ({
      id: node.id,
      deps: node.dependencies.map(({ taskId }) => taskId),
      allowedPaths: [...node.allowedPaths],
      resources: node.resources.map((resource) => ({ ...resource })),
      agent: node.execution.agent,
    })),
  });
}

export function selectExecutionView(ir, taskId) {
  const task = taskFor(ir, taskId);
  return deepFreeze({ plan: { title: ir.title, instructions: ir.instructions, executionPolicy: ir.executionPolicy }, task });
}

export function selectVerificationView(ir, taskId) {
  const task = taskFor(ir, taskId);
  return deepFreeze({ commands: ir.verification.commands, requiredGates: ir.verification.requiredGates, acceptance: task.acceptance });
}
