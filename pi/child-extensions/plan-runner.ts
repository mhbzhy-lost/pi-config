import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlanCapsuleExtension } from "../../scripts/lib/plan/plan-capsule-extension.mjs";
import { createPlanRunnerDependencies } from "../../scripts/lib/plan/plan-runner-dependencies.mjs";
import { createPlanExecutorToolBoundary } from "../../scripts/lib/plan/plan-executor-tool-boundary.mjs";
import { ensurePlanRuntimeTools } from "../../scripts/lib/plan/plan-runtime-tools.mjs";
import { createPiSubagentsExecutionBackend } from "../../scripts/lib/plan/pi-subagents-execution-backend.mjs";
import { createExternalReviewAdapter } from "../../scripts/lib/plan/external-review-adapter.mjs";
import { installRootOwnedSubagent } from "./root-owned-subagent.ts";
import { installRootSessionOwnerLifecycle } from "./root-session-owner.ts";

const REQUIRED_RUNTIME_TOOLS: string[] = [];
const REQUIRED_RPC_METHODS = ["ping", "spawn", "spawn.lookup", "status", "interrupt", "stop"];
const GRANT_RETRY_MS = 25;
const GRANT_TIMEOUT_MS = 5_000;

export type PlanRunnerDependenciesFactoryInput = Parameters<typeof createPlanRunnerDependencies>[0] & {
  pi: ExtensionAPI;
  originRoot: string;
  stateRoot: string;
  executionBackend: ReturnType<typeof createPiSubagentsExecutionBackend>;
  takeExecutionFacts: () => unknown[];
  externalReview: ReturnType<typeof createExternalReviewAdapter>;
};

export type PlanRunnerDependenciesFactory = (input: PlanRunnerDependenciesFactoryInput) => ReturnType<typeof createPlanRunnerDependencies>;

function runtimeRoots(data: unknown) {
  const runtime = (data as { planRuntime?: unknown })?.planRuntime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)
    || Object.keys(runtime).length !== 2 || !Object.hasOwn(runtime, "originRoot") || !Object.hasOwn(runtime, "stateRoot")) {
    throw new Error("Root broker plan runtime is invalid");
  }
  const { originRoot, stateRoot } = runtime as Record<string, unknown>;
  if (typeof originRoot !== "string" || !originRoot || !path.isAbsolute(originRoot)
    || typeof stateRoot !== "string" || !stateRoot || !path.isAbsolute(stateRoot)) {
    throw new Error("Root broker plan runtime is invalid");
  }
  return { originRoot, stateRoot };
}

export async function bootstrapRuntimeRoots(rpc: { ping(): Promise<unknown> }, { sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)), clock = () => Date.now(), timeoutMs = GRANT_TIMEOUT_MS, retryMs = GRANT_RETRY_MS } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(retryMs) || retryMs <= 0) {
    throw new Error("Root broker retry timing must be positive safe integers");
  }
  const deadline = clock() + timeoutMs;
  for (;;) {
    try {
      return runtimeRoots(await rpc.ping());
    } catch (error: any) {
      if (error?.code !== "GRANT_NOT_READY" || clock() >= deadline) throw error;
      await sleep(retryMs);
    }
  }
}

export async function installPlanRunner(
  pi: ExtensionAPI,
  { createDependencies = createPlanRunnerDependencies as PlanRunnerDependenciesFactory } = {},
) {
  const boundary = createPlanExecutorToolBoundary();
  let executionBackend: ReturnType<typeof createPiSubagentsExecutionBackend> | undefined;
  let assertExecutionRuntime: (() => Promise<void>) | undefined;
  let recordSupervisorRequest: ((message: unknown, options: { ctx: unknown }) => Promise<unknown>) | undefined;
  const executionDispatchError = (code: string, message: string) => Object.assign(new Error(message), { code });
  const rootOwned = installRootOwnedSubagent(pi, {
    async recordSupervisorRequest(message: unknown, options: { ctx: unknown }) {
      if (!recordSupervisorRequest) throw new Error("Plan Supervisor recorder is not initialized");
      await recordSupervisorRequest(message, options);
    },
    async resolveCodingSpawnIdentity(input: unknown) {
      if (!executionBackend || !assertExecutionRuntime) throw executionDispatchError("EXECUTION_DISPATCH_INVALID", "Execution backend is not initialized");
      await assertExecutionRuntime();
      const identity = boundary.resolveCodingSpawnIdentity(input);
      const request = boundary.executionRequestForToolCall((input as { toolCallId?: unknown })?.toolCallId as string);
      await executionBackend.recoverDispatch(request);
      const lookup = await rootOwned.rpc.lookupSpawn?.({ spawnKey: identity.spawnKey });
      const state = (lookup as { state?: unknown })?.state;
      if (state === "uncertain") throw executionDispatchError("EXECUTION_DISPATCH_UNCERTAIN", "Durable dispatch lookup is uncertain");
      if (!new Set(["not-started", "cleaned", "spawning", "spawned"]).has(state as string)) {
        throw executionDispatchError("EXECUTION_DISPATCH_INVALID", "Durable dispatch lookup is invalid");
      }
      return identity;
    },
  });
  installRootSessionOwnerLifecycle(pi);

  const executionFacts: unknown[] = [];
  const rpc = rootOwned.rpc;
  try {
    const roots = await bootstrapRuntimeRoots(rpc);
    executionBackend = createPiSubagentsExecutionBackend({
      rpc,
      events: pi.events,
      emitFact: (fact: unknown) => executionFacts.push(fact),
    });
    assertExecutionRuntime = async () => {
      ensurePlanRuntimeTools(pi, REQUIRED_RUNTIME_TOOLS);
      await executionBackend!.assertCapabilities({ rpcVersion: 1, methods: REQUIRED_RPC_METHODS });
    };
    const deps = createDependencies({
      pi,
      ...roots,
      executionBackend,
      takeExecutionFacts: () => executionFacts.splice(0),
      externalReview: createExternalReviewAdapter(),
    });
    recordSupervisorRequest = (message, options) => deps.recordSupervisorRequest(message, options);

    async function resolveExecutorDispatchResult(event: any, { ctx }: { ctx: unknown }) {
      const parsed = boundary.resolveExecutorToolResult(event);
      if (parsed.status === "completed" || parsed.status === "uncertain") return parsed;
      if (parsed.status === "not-started") return boundary.releaseExecutorToolCall(event.toolCallId, "not-started");
      const request = boundary.executionRequestForToolCall(event.toolCallId);
      const bind = async (binding: { runId: string; asyncDir: string }) => {
        const runtimeBinding = await executionBackend!.bindDispatch({
          dispatchId: request.dispatchId,
          attemptId: request.attemptId,
          ...binding,
        });
        await deps.bindExecutorDispatch({
          attemptId: request.attemptId,
          taskId: event.input.taskId,
          dispatchId: request.dispatchId,
          binding: runtimeBinding,
        }, { ctx });
        return boundary.completeExecutorToolCall(event.toolCallId);
      };
      if (parsed.status === "spawned") return bind(parsed.binding);

      const lookup = await rpc.lookupSpawn?.({ spawnKey: request.dispatchId });
      const state = lookup?.state;
      if (state === "spawned") {
        const binding = lookup?.binding;
        if (!binding || typeof binding.runId !== "string" || !binding.runId.trim()
          || typeof binding.asyncDir !== "string" || !binding.asyncDir.trim()) {
          boundary.fenceExecutorToolCall(event.toolCallId);
          throw executionDispatchError("EXECUTION_DISPATCH_INVALID", "Durable dispatch lookup binding is invalid");
        }
        return bind({ runId: binding.runId, asyncDir: binding.asyncDir });
      }
      if (state === "not-started" || state === "cleaned") {
        await executionBackend!.abandonDispatch({ dispatchId: request.dispatchId, attemptId: request.attemptId });
        return boundary.releaseExecutorToolCall(event.toolCallId, state);
      }
      boundary.fenceExecutorToolCall(event.toolCallId);
      return { status: "uncertain" };
    }

    createPlanCapsuleExtension(pi, {
      ...deps,
      requestCallerFollowUp(params: Record<string, unknown>) {
        return rpc.callerFollowUp(params);
      },
      authorizeExecutorDispatch(input: unknown, context: unknown) {
        return boundary.authorize(input, context);
      },
      resolveExecutorDispatchResult,
      async assertRuntimeCapabilities() {
        await assertExecutionRuntime!();
      },
      async prepareExecutionLifecycle({ ctx }: { ctx: unknown }) {
        await deps.recoverExecutionState({ ctx });
        await rootOwned.startLifecycleSubscription(ctx);
      },
      disposeExecutionBackend() {
        executionBackend?.dispose();
      },
    });
  } catch (error) {
    rootOwned.dispose();
    throw error;
  }
}

export default function planRunner(pi: ExtensionAPI) {
  return installPlanRunner(pi);
}
