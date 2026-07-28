import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function defaultGit(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function defaultDiffSha(cwd, baseCommit, headCommit) {
  const { stdout } = await execFile("git", ["diff", "--binary", `${baseCommit}..${headCommit}`], { cwd, encoding: "utf8" });
  return createHash("sha256").update(stdout).digest("hex");
}

export function hashValidatedAttempt(attempt) {
  return createHash("sha256").update(JSON.stringify({
    planId: attempt.planId,
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
    resultCommit: attempt.resultCommit,
    diffSha256: attempt.diffSha256,
    changedPaths: [...(attempt.changedPaths ?? [])].sort(),
    deps: [...(attempt.deps ?? [])],
  })).digest("hex");
}

function validAttempt(attempt) {
  return attempt && ["planId", "taskId", "attemptId", "resultCommit", "diffSha256", "validationHash"]
    .every((field) => typeof attempt[field] === "string" && attempt[field]);
}

export function createIntegrationQueue({
  accumulator,
  integrationOwnerToken,
  nodeOrder,
  append = () => {},
  releaseResources = async () => {},
  releaseWorkspace = async () => {},
  isPlanActive = () => true,
  git = defaultGit,
  diffSha = defaultDiffSha,
  integratedTaskIds = [],
} = {}) {
  if (typeof accumulator !== "string" || !accumulator || typeof integrationOwnerToken !== "string" || !integrationOwnerToken) {
    throw new Error("accumulator and integration owner token are required");
  }
  if (!Array.isArray(nodeOrder) || nodeOrder.length === 0 || new Set(nodeOrder).size !== nodeOrder.length) {
    throw new Error("Integration queue node order is invalid");
  }
  const order = new Map(nodeOrder.map((taskId, index) => [taskId, index]));
  const pending = new Map();
  const integrated = new Set(integratedTaskIds);
  let blockedReason = null;

  function emit(type, data) {
    return append(type, data);
  }

  function enqueue(attempt) {
    if (blockedReason) throw new Error(`Integration queue is blocked: ${blockedReason}`);
    if (!validAttempt(attempt) || !order.has(attempt.taskId)) throw new Error("Validated Attempt is invalid");
    if (hashValidatedAttempt(attempt) !== attempt.validationHash) throw new Error("Validated Attempt validation hash does not match");
    if (pending.has(attempt.attemptId) || [...pending.values()].some((item) => item.taskId === attempt.taskId)
      || integrated.has(attempt.taskId)) {
      throw new Error(`Duplicate integration enqueue: ${attempt.attemptId}`);
    }
    const missing = (attempt.deps ?? []).filter((taskId) => !integrated.has(taskId));
    if (missing.length > 0) throw new Error(`Attempt dependencies are not integrated: ${missing.join(", ")}`);
    pending.set(attempt.attemptId, Object.freeze({ ...attempt, deps: Object.freeze([...(attempt.deps ?? [])]) }));
    return attempt.attemptId;
  }

  async function block(reason, data = {}) {
    blockedReason = reason;
    await emit("plan.blocked", { reason, ...data });
    return { state: "blocked", reason, integrated: [] };
  }

  async function finishIntegration(attempt, previousHead, newHead, completed) {
    await emit("integration.finished", {
      attemptId: attempt.attemptId,
      taskId: attempt.taskId,
      previousHead,
      newHead,
    });
    integrated.add(attempt.taskId);
    pending.delete(attempt.attemptId);
    completed.push({ taskId: attempt.taskId, attemptId: attempt.attemptId, previousHead, newHead });
    await releaseResources(attempt.attemptId);
    try {
      await releaseWorkspace(attempt);
      return null;
    } catch (error) {
      return block("workspace_cleanup_failed", {
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function drain({ expectedHead, ownerToken } = {}) {
    if (ownerToken !== integrationOwnerToken) throw new Error("Integration owner token does not match");
    if (blockedReason) throw new Error(`Integration queue is blocked: ${blockedReason}`);
    if (!isPlanActive()) return { state: "cancelled", integrated: [] };
    const actualHead = await git(accumulator, "rev-parse", "HEAD");
    const completed = [];
    let currentHead = actualHead;

    if (actualHead !== expectedHead) {
      const candidate = nodeOrder
        .filter((taskId) => !integrated.has(taskId))
        .map((taskId) => [...pending.values()].find((attempt) => attempt.taskId === taskId))
        .find(Boolean);
      const requested = candidate?.integration;
      if (requested?.status !== "requested" || requested.expectedHead !== expectedHead) {
        return block("stale_accumulator_head", { expectedHead, actualHead });
      }
      let parentCommit = null;
      try { parentCommit = await git(accumulator, "rev-parse", `${actualHead}^`); } catch {}
      const observedDiffSha = parentCommit === expectedHead ? await diffSha(accumulator, expectedHead, actualHead) : null;
      if (parentCommit !== expectedHead || observedDiffSha !== candidate.diffSha256
        || requested.resultCommit !== candidate.resultCommit || requested.diffSha256 !== candidate.diffSha256) {
        return block("integration_recovery_ambiguous", {
          attemptId: candidate.attemptId,
          expectedHead,
          actualHead,
        });
      }
      const recoveryBlock = await finishIntegration(candidate, expectedHead, actualHead, completed);
      if (recoveryBlock) return { ...recoveryBlock, integrated: completed };
    }

    for (const taskId of nodeOrder) {
      if (integrated.has(taskId)) continue;
      const attempt = [...pending.values()].find((candidate) => candidate.taskId === taskId);
      if (!attempt) break;
      if (!isPlanActive()) return { state: "cancelled", integrated: completed };
      const missing = attempt.deps.filter((dependency) => !integrated.has(dependency));
      if (missing.length > 0) break;

      const requested = attempt.integration;
      if (requested?.status === "requested") {
        if (requested.expectedHead !== currentHead || requested.resultCommit !== attempt.resultCommit
          || requested.diffSha256 !== attempt.diffSha256) {
          return block("integration_recovery_ambiguous", { attemptId: attempt.attemptId, expectedHead: currentHead, actualHead: currentHead });
        }
      } else {
        await emit("integration.requested", {
          attemptId: attempt.attemptId,
          taskId: attempt.taskId,
          expectedHead: currentHead,
          resultCommit: attempt.resultCommit,
          diffSha256: attempt.diffSha256,
        });
      }
      try {
        await git(accumulator, "cherry-pick", attempt.resultCommit);
      } catch (error) {
        try {
          await git(accumulator, "cherry-pick", "--abort");
        } catch {
          // The HEAD check below remains authoritative when Git did not create cherry-pick state.
        }
        const recoveredHead = await git(accumulator, "rev-parse", "HEAD");
        if (recoveredHead !== currentHead) {
          return block("integration_abort_head_mismatch", { attemptId: attempt.attemptId, expectedHead: currentHead, actualHead: recoveredHead });
        }
        return block("integration_conflict", { attemptId: attempt.attemptId, taskId: attempt.taskId });
      }
      const newHead = await git(accumulator, "rev-parse", "HEAD");
      const cleanupBlock = await finishIntegration(attempt, currentHead, newHead, completed);
      if (cleanupBlock) return { ...cleanupBlock, integrated: completed };
      currentHead = newHead;
    }
    return { state: completed.length > 0 ? "integrated" : "waiting", integrated: completed, headCommit: currentHead };
  }

  return Object.freeze({ enqueue, drain });
}
