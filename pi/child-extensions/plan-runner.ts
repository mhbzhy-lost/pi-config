import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlanCapsuleExtension } from "../../scripts/lib/plan/plan-capsule-extension.mjs";
import { createPlanRunnerDependencies } from "../../scripts/lib/plan/plan-runner-dependencies.mjs";
import { ensurePlanRuntimeTools } from "../../scripts/lib/plan/plan-runtime-tools.mjs";
import { createPiSubagentsExecutionBackend } from "../../scripts/lib/plan/pi-subagents-execution-backend.mjs";
import { createExternalReviewAdapter } from "../../scripts/lib/plan/external-review-adapter.mjs";
import { installRootOwnedSubagent } from "./root-owned-subagent.ts";
import { installRootSessionOwnerLifecycle } from "./root-session-owner.ts";

const REQUIRED_RUNTIME_TOOLS: string[] = [];
const REQUIRED_RPC_METHODS = ["ping", "spawn", "status", "interrupt", "stop"];
const GRANT_RETRY_MS = 25;
const GRANT_TIMEOUT_MS = 5_000;

function runtimeRoots(data: unknown) {
  const runtime = (data as { planRuntime?: unknown })?.planRuntime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)
    || Object.keys(runtime).length !== 2 || !Object.hasOwn(runtime, "originRoot") || !Object.hasOwn(runtime, "stateRoot")) {
    throw new Error("Root broker plan runtime is invalid");
  }
  const { originRoot, stateRoot } = runtime as Record<string, unknown>;
  if (typeof originRoot !== "string" || !originRoot || !originRoot.startsWith("/")
    || typeof stateRoot !== "string" || !stateRoot || !stateRoot.startsWith("/")) {
    throw new Error("Root broker plan runtime is invalid");
  }
  return { originRoot, stateRoot };
}

async function bootstrapRuntimeRoots(rpc: { ping(): Promise<unknown> }, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const deadline = Date.now() + GRANT_TIMEOUT_MS;
  for (;;) {
    try {
      return runtimeRoots(await rpc.ping());
    } catch (error: any) {
      if (error?.code !== "GRANT_NOT_READY" || Date.now() >= deadline) throw error;
      await sleep(GRANT_RETRY_MS);
    }
  }
}

export default async function planRunner(pi: ExtensionAPI) {
  const rootOwned = installRootOwnedSubagent(pi);
  installRootSessionOwnerLifecycle(pi);

  const executionFacts: unknown[] = [];
  const rpc = rootOwned.rpc;
  const roots = await bootstrapRuntimeRoots(rpc);
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
    async assertRuntimeCapabilities() {
      ensurePlanRuntimeTools(pi, REQUIRED_RUNTIME_TOOLS);
      await executionBackend.assertCapabilities({ rpcVersion: 1, methods: REQUIRED_RPC_METHODS });
    },
    disposeExecutionBackend() {
      executionBackend.dispose();
    },
  });
}
