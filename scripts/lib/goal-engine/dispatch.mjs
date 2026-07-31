import { compileCodingDispatchIR } from "./dispatch-ir.mjs";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

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

  const input = {
    version: "dispatch-ir.v1",
    taskId: `${projection.goalId}.${taskId}`,
    title: `${taskId}: ${task.description.slice(0, 80)}`,
    agent: "executor",
    risk: "normal",
    objective: task.description,
    workflow: { mode: task.workflow || "tdd" },
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

function buildCompletedContext(projection, currentTaskId) {
  const facts = [];
  for (const [taskId, task] of projection.tasks) {
    if (taskId === currentTaskId) continue;
    if (task.status === "accepted") {
      facts.push(`Completed task ${taskId}: ${task.description}`);
      for (const ev of task.evidence) {
        if (ev.ref) facts.push(`Evidence for ${taskId}: ${ev.type} @ ${ev.ref}`);
        if (ev.path) facts.push(`Evidence for ${taskId}: ${ev.type} @ ${ev.path}`);
      }
    }
  }
  return facts;
}

function buildRelevantFiles(projection, currentTaskId) {
  const files = [];
  for (const [taskId, task] of projection.tasks) {
    if (taskId === currentTaskId) continue;
    if (task.status === "accepted") files.push(...task.writePaths);
  }
  return [...new Set(files)];
}
