import { applyEvent, createProjection } from "./plan-events.mjs";
import { createPlanGraph, nextRunnableTask } from "./plan-graph.mjs";

export function createPlanCoordinator({ plan, entries, append, id = () => crypto.randomUUID(), now = () => new Date().toISOString(), nestedResults = () => [], readStatus = () => undefined }) {
  if (!Array.isArray(entries) || typeof append !== "function") throw new Error("entries and append are required");
  const graph = createPlanGraph(plan);
  let projection = replay(entries);
  let expectedIntent = undefined;
  let intentConsumed = false;

  function appendEvent(type, data) {
    const entry = {
      schemaVersion: "pi-plan-event.v1",
      eventId: id(),
      planId: projection.planId,
      occurredAt: now(),
      type,
      data,
    };
    const nextProjection = applyEvent(projection, entry);
    append(entry);
    projection = nextProjection;
    return entry;
  }

  function authorizeNext() {
    if (pendingAttempt()) throw new Error("an attempt is already active");
    const task = nextRunnableTask({ ...projection, graph });
    if (!task) throw new Error("no runnable task");
    if (attemptsForTask(task.id).some((attempt) => attempt.status === "succeeded")) {
      throw new Error(`task is awaiting review: ${task.id}`);
    }
    const attemptId = nextAttemptId(projection, task.id);
    const tool = {
      agent: task.agent ?? "executor",
      task: buildExecutionPrompt(plan, task, projection),
      cwd: projection.workspace.worktree,
      context: "fresh",
      async: true,
      clarify: false,
    };
    appendEvent("attempt.dispatch-requested", { attemptId, taskId: task.id, tool });
    expectedIntent = { attemptId, taskId: task.id, tool };
    intentConsumed = false;
    return { attemptId, tool };
  }

  function authorizeNestedSubagent(tool) {
    if (!expectedIntent) throw new Error("no dispatch intent");
    if (intentConsumed) throw new Error("dispatch intent already consumed");
    if (!sameTool(tool, expectedIntent.tool)) throw new Error("nested subagent call does not match dispatch intent");
    intentConsumed = true;
    return true;
  }

  function bindNestedResult(result, attempt = expectedIntent ?? requestedAttempt()) {
    if (!attempt) throw new Error("no dispatch intent to bind");
    const normalizedResult = result?.result ?? result;
    const details = normalizedResult?.details;
    if (!details || typeof details.runId !== "string" || details.runId === "") throw new Error("structured details.runId is required");
    const first = Array.isArray(details.results) ? details.results[0] : undefined;
    appendEvent("attempt.bound", {
      attemptId: attempt.attemptId,
      taskId: attempt.taskId,
      runId: details.runId,
      asyncDir: typeof details.asyncDir === "string" ? details.asyncDir : null,
      sessionFile: typeof first?.sessionFile === "string" ? first.sessionFile : null,
    });
    expectedIntent = undefined;
    intentConsumed = false;
    return { attemptId: attempt.attemptId, terminalOutcome: foregroundOutcome(details) };
  }

  function settleBoundAttempt(outcome) {
    const attempt = activeAttempt();
    if (!attempt || attempt.status !== "active") throw new Error("no bound active attempt");
    appendEvent("attempt.settled", { attemptId: attempt.attemptId, outcome });
  }

  function acceptReviewedTask(taskId) {
    const task = projection.tasks.get(taskId);
    if (!task || task.status !== "pending") throw new Error("task is not pending");
    if (!attemptsForTask(taskId).some((attempt) => attempt.status === "succeeded")) {
      throw new Error("task has no successful settled attempt");
    }
    appendEvent("task.accepted", { taskId });
  }

  function recover() {
    const requested = requestedAttempt();
    let persistedResult;
    let boundOutcome;
    if (requested) {
      persistedResult = findPersistedResult(requested);
      if (!persistedResult) {
        appendEvent("plan.blocked", { reason: "dispatch_uncertain" });
        return { state: "blocked", projection };
      }
      boundOutcome = bindNestedResult(persistedResult, requested).terminalOutcome;
    }
    const bound = activeAttempt();
    const status = bound?.asyncDir ? readStatus(bound.asyncDir) : undefined;
    const outcome = boundOutcome ?? terminalOutcome(runtimeState(status));
    if (outcome) settleBoundAttempt(outcome);
    return { state: "recovered", projection };
  }

  function attemptsForTask(taskId) {
    return [...projection.attempts.entries()]
      .filter(([, attempt]) => attempt.taskId === taskId)
      .map(([attemptId, attempt]) => ({ attemptId, ...attempt }));
  }

  function attemptWithStatus(statuses) {
    for (const [attemptId, attempt] of projection.attempts) {
      if (statuses.includes(attempt.status)) return { attemptId, ...attempt };
    }
    return undefined;
  }

  function pendingAttempt() {
    return attemptWithStatus(["dispatch-requested", "active"]);
  }

  function requestedAttempt() {
    return attemptWithStatus(["dispatch-requested"]);
  }

  function activeAttempt() {
    return attemptWithStatus(["active"]);
  }

  function findPersistedResult(attempt) {
    return nestedResults().find((candidate) => {
      if (candidate?.attemptId !== undefined && candidate.attemptId !== attempt.attemptId) return false;
      if (candidate?.tool !== undefined && !sameTool(candidate.tool, attempt.tool)) return false;
      const result = candidate?.result ?? candidate;
      return typeof result?.details?.runId === "string" && result.details.runId !== "";
    });
  }

  return { coordinator: { authorizeNext, authorizeNestedSubagent, bindNestedResult, settleBoundAttempt, acceptReviewedTask, recover } };
}

function replay(entries) {
  let projection = createProjection();
  for (const entry of entries) projection = applyEvent(projection, entry);
  return projection;
}

function buildExecutionPrompt(_plan, task) {
  return `Execute plan task ${task.id}.`;
}

function sameTool(left, right) {
  return ["agent", "task", "cwd", "context", "async", "clarify"].every((field) => left?.[field] === right[field]);
}

function terminalOutcome(state) {
  if (state === "complete") return "succeeded";
  if (state === "failed") return "failed";
  if (state === "paused") return "interrupted";
  return undefined;
}

function runtimeState(status) {
  if (status?.status?.kind === "stable") return status.status.value?.state;
  return status?.state;
}

function foregroundOutcome(details) {
  if (typeof details?.asyncDir === "string") return undefined;
  const result = Array.isArray(details?.results) ? details.results[0] : undefined;
  if (typeof result?.exitCode !== "number") return undefined;
  return result.exitCode === 0 ? "succeeded" : "failed";
}

function nextAttemptId(projection, taskId) {
  const sequence = [...projection.attempts.values()].filter((attempt) => attempt.taskId === taskId).length + 1;
  return `attempt-${projection.planId}-${taskId}-${sequence}`;
}
