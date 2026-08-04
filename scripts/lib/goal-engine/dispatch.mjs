import { compileCodingDispatchIR } from "./dispatch-ir.mjs";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function assertPendingTaskContractsCompile(projection, cwd) {
  for (const [taskId, task] of projection.tasks) {
    if (task.status === "pending") compileTaskContract(projection, taskId, cwd);
  }
}

export function compileTaskContract(projection, taskId, cwd, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const task = projection.tasks.get(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.status !== "pending") throw new Error(`task is not pending: ${taskId} (${task.status})`);

  const knownFacts = [
    `Goal: ${projection.objective}`,
    `Scope: ${projection.scope.join(", ") || "unrestricted"}`,
    ...buildCompletedContext(projection, taskId),
  ];

  const decisions = [
    ...projection.nonGoals.map((ng) => `Non-goal: ${ng}`),
  ];

  const relevantFiles = buildRelevantFiles(projection, taskId);

  const workflowMode = task.workflow || "tdd";
  const workflow = workflowMode === "docs-only"
    ? { mode: workflowMode, reason: "Documentation-only task produces a review or report artifact." }
    : workflowMode === "existing-tests"
      ? { mode: workflowMode, reason: "Task uses the Goal contract's existing acceptance test suite without inventing new tests." }
      : { mode: workflowMode };

  const input = {
    version: "dispatch-ir.v1",
    taskId: `${projection.goalId}.${taskId}`,
    title: `${taskId}: ${task.description.slice(0, 80)}`,
    agent: "executor",
    risk: "normal",
    objective: task.description,
    workflow,
    requirements: [
      task.description,
      ...task.acceptance.criteria,
      ...projection.dod.map((d) => `Goal DoD: ${d}`),
    ],
    context: { knownFacts, decisions, relevantFiles },
    boundaries: {
      writePaths: task.writePaths,
      excludedWork: projection.nonGoals,
      forbiddenActions: ["Do not modify files outside declared writePaths", "Do not amend goal contract or state files"],
    },
    acceptance: {
      criteria: task.acceptance.criteria,
      commands: task.acceptance.commands,
    },
    execution: { cwd, timeoutMs },
  };

  return compileCodingDispatchIR(input, { cwd });
}

function boundedOptional(items, limit = 32) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    if (result.length === limit) break;
    if (typeof item !== "string" || Buffer.byteLength(item, "utf8") > 4096 || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function buildCompletedContext(projection, currentTaskId) {
  const facts = [];
  for (const [taskId, task] of projection.tasks) {
    if (taskId === currentTaskId || task.status !== "accepted") continue;
    facts.push(`Completed task ${taskId}: ${task.description}`);
    for (const ev of task.evidence) {
      if (ev.ref) facts.push(`Evidence for ${taskId}: ${ev.type} @ ${ev.ref}`);
      if (ev.path) facts.push(`Evidence for ${taskId}: ${ev.type} @ ${ev.path}`);
    }
  }
  // Goal and Scope occupy two required knownFacts slots; optional history may not crowd them out.
  return boundedOptional(facts, 30);
}

function buildRelevantFiles(projection, currentTaskId) {
  const files = [];
  for (const [taskId, task] of projection.tasks) {
    if (taskId === currentTaskId || task.status !== "accepted") continue;
    files.push(...task.writePaths);
  }
  return boundedOptional(files);
}
