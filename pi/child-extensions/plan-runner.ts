import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlanCapsuleExtension } from "../../scripts/lib/plan/plan-capsule-extension.mjs";
import { createPlanRunnerDependencies } from "../../scripts/lib/plan/plan-runner-dependencies.mjs";
import { ensurePlanRuntimeTools } from "../../scripts/lib/plan/plan-runtime-tools.mjs";
import { createPiSubagentsExecutionBackend } from "../../scripts/lib/plan/pi-subagents-execution-backend.mjs";
import { createExternalReviewAdapter } from "../../scripts/lib/plan/external-review-adapter.mjs";
import { createSubagentsRpcClient } from "../../scripts/lib/subagents-rpc-client.mjs";

const REQUIRED_RUNTIME_TOOLS = ["subagent_wait", "subagent_supervisor"];
const REQUIRED_RPC_METHODS = ["ping", "spawn", "status", "interrupt", "stop"];

export default function planRunner(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD || process.env.PI_SUBAGENT_FANOUT_CHILD) {
    throw new Error("Standalone Plan Runner refuses child or fanout-child mode.");
  }

  const executionFacts: unknown[] = [];
  const rpc = createSubagentsRpcClient(pi.events);
  const executionBackend = createPiSubagentsExecutionBackend({
    rpc,
    events: pi.events,
    emitFact: (fact: unknown) => executionFacts.push(fact),
  });
  const deps = createPlanRunnerDependencies({
    pi,
    originRoot: process.env.PI_PLAN_ORIGIN_ROOT,
    stateRoot: process.env.PI_PLAN_STATE_ROOT,
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
