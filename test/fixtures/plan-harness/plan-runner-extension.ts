import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlanCapsuleExtension } from "../../../scripts/lib/plan/plan-capsule-extension.mjs";
import { createPlanRunnerDependencies } from "../../../scripts/lib/plan/plan-runner-dependencies.mjs";
import { createPlanRevisionStore } from "../../../scripts/lib/plan/plan-revision-store.mjs";
import { createPiSubagentsExecutionBackend } from "../../../scripts/lib/plan/pi-subagents-execution-backend.mjs";
import { createSubagentsRpcClient } from "../../../scripts/lib/subagents-rpc-client.mjs";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const methods = ["ping", "spawn", "status", "interrupt", "stop"];

export default function planHarnessRunner(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD || process.env.PI_SUBAGENT_FANOUT_CHILD) {
    throw new Error("Harness Plan Runner must be standalone");
  }
  const facts: unknown[] = [];
  const rpc = createSubagentsRpcClient(pi.events, { timeoutMs: 10_000 });
  const backend = createPiSubagentsExecutionBackend({ rpc, events: pi.events, emitFact: (fact: unknown) => facts.push(fact) });
  const barrier = process.env.PI_PLAN_HARNESS_SUPERSEDE_BARRIER;
  const realRevisionStore = createPlanRevisionStore({ stateRoot: process.env.PI_PLAN_STATE_ROOT! });
  const revisionStore = barrier ? Object.freeze({
    ...Object.fromEntries(Object.entries(realRevisionStore).map(([name, value]) => [name, typeof value === "function" ? value.bind(realRevisionStore) : value])),
    // Pause after durable plan.amended and before the current-revision pointer write.
    async writeCurrent(prepared: Parameters<typeof realRevisionStore.writeCurrent>[0]) {
      if (prepared?.revision === 2) {
        mkdirSync(barrier, { recursive: true });
        writeFileSync(`${barrier}/entered`, "entered\n");
        while (!existsSync(`${barrier}/release`)) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return realRevisionStore.writeCurrent(prepared);
    },
  }) : realRevisionStore;
  const deps = createPlanRunnerDependencies({
    pi,
    originRoot: process.env.PI_PLAN_ORIGIN_ROOT,
    stateRoot: process.env.PI_PLAN_STATE_ROOT,
    executionBackend: backend,
    revisionStore,
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
