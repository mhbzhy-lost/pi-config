import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlanCapsuleExtension } from "../../../scripts/lib/plan/plan-capsule-extension.mjs";
import { createPlanRunnerDependencies } from "../../../scripts/lib/plan/plan-runner-dependencies.mjs";
import { createPiSubagentsExecutionBackend } from "../../../scripts/lib/plan/pi-subagents-execution-backend.mjs";
import { createSubagentsRpcClient } from "../../../scripts/lib/subagents-rpc-client.mjs";

const methods = ["ping", "spawn", "status", "interrupt", "stop"];

export default function planHarnessRunner(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD || process.env.PI_SUBAGENT_FANOUT_CHILD) {
    throw new Error("Harness Plan Runner must be standalone");
  }
  const facts: unknown[] = [];
  const rpc = createSubagentsRpcClient(pi.events, { timeoutMs: 10_000 });
  const backend = createPiSubagentsExecutionBackend({ rpc, events: pi.events, emitFact: (fact: unknown) => facts.push(fact) });
  const deps = createPlanRunnerDependencies({
    pi,
    originRoot: process.env.PI_PLAN_ORIGIN_ROOT,
    stateRoot: process.env.PI_PLAN_STATE_ROOT,
    executionBackend: backend,
    takeExecutionFacts: () => facts.splice(0),
    audit: async () => ({ findings: [] }),
    externalReview: async () => ({ available: true, findings: [] }),
  });
  createPlanCapsuleExtension(pi, {
    ...deps,
    async assertRuntimeCapabilities() {
      await backend.assertCapabilities({ rpcVersion: 1, methods });
    },
    disposeExecutionBackend() { backend.dispose(); },
  });
}
