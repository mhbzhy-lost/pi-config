const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitingAttempts(status) {
  return status?.tasks?.flatMap((task) => (task.attempts ?? [])
    .filter((attempt) => attempt.status === "waiting-attention")
    .map((attempt) => ({ ...attempt, taskId: task.taskId }))) ?? [];
}

export async function driveHarnessAttention({
  handles,
  expectedPerPlan,
  readStatuses,
  readRunners,
  onPending,
  timeoutMs = 45_000,
  pollIntervalMs = 50,
}) {
  const deadline = Date.now() + timeoutMs;
  const pending = handles.map(() => []);
  const requestPlans = new Map();
  let statuses = [];
  let runners = [];

  while (Date.now() < deadline) {
    statuses = await readStatuses();
    for (const [planIndex, status] of statuses.entries()) {
      const waiting = waitingAttempts(status);
      if (waiting.length > expectedPerPlan) throw new Error(`Attention polling observed too many pending Attempts for plan ${planIndex}: ${JSON.stringify(status)}`);
      for (const attempt of waiting) {
        const requestId = attempt.attention?.requestId;
        if (!requestId) throw new Error(`Waiting Attention is missing requestId for plan ${planIndex}`);
        const identity = { planIndex, taskId: attempt.taskId, attemptId: attempt.attemptId, runId: attempt.runId, projectionVersion: attempt.attention?.projectionVersion };
        const prior = requestPlans.get(requestId);
        if (prior) {
          if (prior.planIndex !== identity.planIndex || prior.taskId !== identity.taskId || prior.attemptId !== identity.attemptId || prior.runId !== identity.runId || prior.projectionVersion !== identity.projectionVersion) {
            throw new Error(`Attention request identity conflict for ${requestId}`);
          }
          continue;
        }
        if (pending[planIndex].length >= expectedPerPlan) throw new Error(`Attention polling observed too many unique pending Attempts for plan ${planIndex}`);
        requestPlans.set(requestId, identity);
        pending[planIndex].push(attempt);
        await onPending({ planIndex, handle: handles[planIndex], attempt });
      }
    }
    if (pending.every((entries) => entries.length === expectedPerPlan)) return { pending };
    runners = await readRunners();
    if (runners.some((runner) => ["failed", "stopped"].includes(runner?.state))) {
      throw new Error(`Plan Runner stopped before Attention: ${JSON.stringify({ statuses, runners })}`);
    }
    await sleep(pollIntervalMs);
  }
  runners = await readRunners();
  throw new Error(`Attention polling timed out: ${JSON.stringify({ statuses, runners, pending })}`);
}
