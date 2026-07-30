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

function cloneContract(contract) {
  return JSON.parse(JSON.stringify(contract));
}

function exactResolverInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = Reflect.ownKeys(input).sort((left, right) => String(left).localeCompare(String(right)));
  return keys.length === 3 && keys[0] === "contract" && keys[1] === "contractHash" && keys[2] === "toolCallId";
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
      const authorization = {
        attemptId,
        dispatchId: attempt.dispatchId,
        contractHash: compiled.hash,
        toolCallId,
        state: "executing",
        contract: cloneContract(input),
        executionRequest: Object.freeze({
          dispatchId: attempt.dispatchId,
          attemptId,
          agent: attempt.tool.agent,
          task: attempt.tool.task,
          cwd: attempt.tool.cwd,
          output: attempt.tool.output,
          timeoutMs: attempt.tool.timeoutMs,
        }),
      };
      authorized.set(key, authorization);
      authorizedToolCallIds.set(toolCallId, authorization);
      return { attemptId, dispatchId: attempt.dispatchId, contractHash: compiled.hash, toolCallId, state: "executing" };
    },
    resolveCodingSpawnIdentity(input) {
      required(exactResolverInput(input), "Executor spawn identity requires exact toolCallId, contract, and contractHash");
      required(typeof input.toolCallId === "string" && input.toolCallId.trim(), "Executor spawn identity toolCallId is required");
      const authorization = authorizedToolCallIds.get(input.toolCallId);
      required(authorization, "Executor spawn identity toolCallId is not authorized");
      required(authorization.state === "executing", "Executor spawn identity already resolved (one-shot replay)");
      required(isDeepStrictEqual(input.contract, authorization.contract), "Executor spawn identity exact contract mismatch");
      required(input.contractHash === authorization.contractHash, "Executor spawn identity contract hash mismatch");
      authorization.state = "identity-resolved";
      return Object.freeze({ requestId: authorization.dispatchId, spawnKey: authorization.dispatchId });
    },
    executionRequestForToolCall(toolCallId) {
      required(typeof toolCallId === "string" && toolCallId.trim(), "Executor execution request toolCallId is required");
      const authorization = authorizedToolCallIds.get(toolCallId);
      required(authorization, "Executor execution request toolCallId is not authorized");
      required(authorization.state === "identity-resolved", "Executor execution request requires resolved spawn identity");
      return authorization.executionRequest;
    },
  };
}
