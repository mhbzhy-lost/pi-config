import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { compileCodingDispatchIR } from "../subagent-dispatch/ir.ts";

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function compile(input, cwd) {
  try {
    return compileCodingDispatchIR(input, { cwd });
  } catch (error) {
    throw new Error(`Executor dispatch contract required: ${error instanceof Error ? error.message : "invalid contract"}`);
  }
}

export function createPlanExecutorToolBoundary() {
  const authorized = new Map();
  const authorizedToolCallIds = new Map();

  return {
    authorize(input, { projection, toolCallId } = {}) {
      required(typeof toolCallId === "string" && toolCallId.trim(), "Executor dispatch toolCallId is required");
      const originRoot = projection?.workspace?.originRoot;
      required(typeof originRoot === "string" && originRoot, "Executor dispatch requested workspace is unavailable");
      const compiled = compile(input, originRoot);

      required(!["validated", "blocked", "cancelled", "interrupted"].includes(projection.lifecycle), `Plan is terminal/cancelled: ${projection.lifecycle}`);
      required(projection.revision?.irVersion === "plan-ir.v3", "current revision identity mismatch");
      const candidates = [...(projection.attempts instanceof Map ? projection.attempts.entries() : [])]
        .filter(([, attempt]) => attempt?.status === "dispatch-requested" && attempt.taskId === compiled.taskId)
        .map(([attemptId, attempt]) => ({ attemptId, attempt }));
      required(candidates.length > 0, "requested dispatch unavailable or missing");
      required(candidates.length === 1, "multiple/ambiguous requested dispatches");

      const { attemptId, attempt } = candidates[0];
      const revisionHashes = projection.revision.taskHashes?.[compiled.taskId];
      required(
        attempt.planIrHash === projection.revision.irHash
          && attempt.taskHash === revisionHashes?.effective
          && attempt.schedulingHash === revisionHashes?.scheduling,
        "current revision identity mismatch",
      );
      required(typeof attempt.dispatchId === "string" && attempt.dispatchId
        && typeof attempt.baseCommit === "string" && attempt.baseCommit
        && typeof attempt.tool?.output === "string" && attempt.tool.output
        && Array.isArray(attempt.tool.dependencyReceipts), "requested dispatch identity mismatch");
      required(
        attempt.workspace?.path === compiled.execution.cwd
          && compiled.execution.cwd === attempt.tool.cwd,
        "workspace identity mismatch",
      );
      required(attempt.tool.agent === compiled.agent && attempt.tool.timeoutMs === compiled.execution.timeoutMs, "contract identity mismatch");

      const stored = compile(attempt.tool.contract, originRoot);
      required(stored.hash === attempt.toolHash && stored.hash === compiled.hash, "contract hash mismatch");
      required(isDeepStrictEqual(input, attempt.tool.contract), "exact contract identity mismatch");
      const contextHash = sha256({
        planIrHash: attempt.planIrHash,
        taskHash: attempt.taskHash,
        schedulingHash: attempt.schedulingHash,
        attemptId,
        baseCommit: attempt.baseCommit,
        output: attempt.tool.output,
        dependencyReceipts: attempt.tool.dependencyReceipts,
      });
      required(attempt.dispatchContextHash === contextHash, "dispatch context identity mismatch");

      const key = `${attempt.dispatchId}:${compiled.hash}`;
      required(!authorized.has(key), "Executor dispatch already authorized (replay)");
      required(!authorizedToolCallIds.has(toolCallId), "Executor dispatch toolCallId already authorized (duplicate)");
      const authorization = { attemptId, dispatchId: attempt.dispatchId, contractHash: compiled.hash, toolCallId, state: "executing" };
      authorized.set(key, authorization);
      authorizedToolCallIds.set(toolCallId, authorization);
      return authorization;
    },
  };
}
