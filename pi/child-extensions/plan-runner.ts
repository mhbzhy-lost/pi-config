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

export default async function planRunner(pi: ExtensionAPI) {
  const rootOwned = installRootOwnedSubagent(pi);
  installRootSessionOwnerLifecycle(pi);

  const executionFacts: unknown[] = [];
  const rpc = rootOwned.rpc;
  try {
    const roots = await bootstrapRuntimeRoots(rpc);
    await rootOwned.startLifecycleSubscription();
    const boundary = createPlanExecutorToolBoundary();
    const executionBackend = createPiSubagentsExecutionBackend({
      rpc,
      events: pi.events,
      emitFact: (fact: unknown) => executionFacts.push(fact),
    });
    const deps = createPlanRunnerDependencies({
      pi,
      ...roots,
      executionBackend,
      takeExecutionFacts: () => executionFacts.splice(0),
      externalReview: createExternalReviewAdapter(),
    });

    createPlanCapsuleExtension(pi, {
      ...deps,
      authorizeExecutorDispatch(input: unknown, context: unknown) {
        return boundary.authorize(input, context);
      },
      async assertRuntimeCapabilities() {
        ensurePlanRuntimeTools(pi, REQUIRED_RUNTIME_TOOLS);
        await executionBackend.assertCapabilities({ rpcVersion: 1, methods: REQUIRED_RPC_METHODS });
      },
      disposeExecutionBackend() {
        executionBackend.dispose();
      },
    });
  } catch (error) {
    rootOwned.dispose();
    throw error;
  }
}
