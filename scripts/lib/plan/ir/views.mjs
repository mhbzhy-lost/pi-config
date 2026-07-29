import { assertPlanIRV3 } from "./schema.mjs";

function taskFor(ir, taskId) {
  assertPlanIRV3(ir);
  const task = ir.nodes.find((node) => node.id === taskId);
  if (!task) throw new Error(`unknown IR task: ${taskId}`);
  return task;
}

export function selectSchedulingView(ir) {
  assertPlanIRV3(ir);
  return {
    resourceCapacities: ir.resourceCapacities,
    nodes: ir.nodes.map((node) => ({
      id: node.id,
      deps: node.dependencies.map(({ taskId }) => taskId),
      allowedPaths: node.allowedPaths,
      resources: node.resources,
      agent: node.execution.agent,
    })),
  };
}

export function selectExecutionView(ir, taskId) {
  const task = taskFor(ir, taskId);
  return { plan: { title: ir.title, instructions: ir.instructions, executionPolicy: ir.executionPolicy }, task };
}

export function selectVerificationView(ir, taskId) {
  const task = taskFor(ir, taskId);
  return { commands: ir.verification.commands, requiredGates: ir.verification.requiredGates, acceptance: task.acceptance };
}
