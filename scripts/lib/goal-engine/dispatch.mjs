import { compileCodingDispatchIR } from "./dispatch-ir.mjs";
import { MAX_CONTRACT_ARRAY_ITEMS, MAX_CONTRACT_STRING_BYTES } from "./contract-limits.mjs";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// Reducers need a stable absolute value only to validate derived IR; command origin
// policy belongs to the ExtensionContext boundary, not event replay.
export const DISPATCH_VALIDATION_SENTINEL = "/goal-engine-dispatch-validation";

export function assertPendingTaskContractsCompile(projection, cwd) {
  for (const [taskId, task] of projection.tasks) {
    if (task.status === "pending") compileTaskContract(projection, taskId, cwd);
  }
}

export function compileTaskContract(projection, taskId, cwd, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const task = projection.tasks.get(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.status !== "pending") throw new Error(`task is not pending: ${taskId} (${task.status})`);

  const completed = buildCompletedContext(projection, taskId);
  const relevant = buildRelevantFiles(projection, taskId);
  const knownFacts = [
    `Goal: ${projection.objective}`,
    `Scope: ${projection.scope.join(", ") || "unrestricted"}`,
    ...completed.items,
    ...(completed.omitted || relevant.omitted ? [`Context omitted: facts=${completed.omitted}; files=${relevant.omitted}`] : []),
  ];

  const decisions = [
    ...projection.nonGoals.map((ng) => `Non-goal: ${ng}`),
  ];

  const relevantFiles = relevant.items;

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
      "Before reporting completed, create at least one clean commit containing only approved writePaths; if no commit is warranted, return NEEDS_CONTEXT instead of completed.",
      ...task.acceptance.criteria.map(encodeCriterion),
      ...projection.dod.map((d) => `Goal DoD: ${d}`),
    ],
    context: { knownFacts, decisions, relevantFiles },
    boundaries: {
      writePaths: task.writePaths,
      excludedWork: projection.nonGoals,
      forbiddenActions: ["Do not modify files outside declared writePaths", "Do not amend goal contract or state files"],
    },
    // Legacy projection commands are retained for replay and Goal-level acceptance,
    // but the criteria-only Subagent transport must never receive them.
    acceptance: { criteria: task.acceptance.criteria.map(encodeCriterion) },
    execution: { cwd, timeoutMs },
  };

  return compileCodingDispatchIR(input, { cwd });
}

export function encodeCriterion(criterion) {
  // Legacy projections retain their historical string criteria only during replay.
  if (typeof criterion === "string") return criterion;
  const { id, statement, evidenceKinds } = criterion;
  // JSON is unambiguous and its fixed key order makes this transport stable.
  return JSON.stringify({ id, statement, evidenceKinds: [...evidenceKinds] });
}

function boundedOptional(items, limit = MAX_CONTRACT_ARRAY_ITEMS) {
  const result = [];
  const seen = new Set();
  let omitted = 0;
  for (const item of items) {
    if (typeof item !== "string" || Buffer.byteLength(item, "utf8") > MAX_CONTRACT_STRING_BYTES || seen.has(item) || result.length >= limit) {
      omitted++;
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return { items: result, omitted };
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
  // Goal and Scope are mandatory; reserve one slot for an omission summary.
  return boundedOptional(facts, MAX_CONTRACT_ARRAY_ITEMS - 3);
}

function buildRelevantFiles(projection, currentTaskId) {
  const files = [];
  for (const [taskId, task] of projection.tasks) {
    if (taskId === currentTaskId || task.status !== "accepted") continue;
    files.push(...task.writePaths);
  }
  return boundedOptional(files);
}
