import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlanRunnerDependencies } from "../../../scripts/lib/plan/plan-runner-dependencies.mjs";
import { createPlanRevisionStore } from "../../../scripts/lib/plan/plan-revision-store.mjs";
import { installPlanRunner } from "../../../pi/child-extensions/plan-runner.ts";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

export default async function planHarnessRunner(pi: ExtensionAPI) {
  const barrier = process.env.PI_PLAN_HARNESS_SUPERSEDE_BARRIER;
  return await installPlanRunner(pi, { createDependencies(input) {
    const realRevisionStore = createPlanRevisionStore({ stateRoot: input.stateRoot });
    const revisionStore = barrier ? Object.freeze({
      ...Object.fromEntries(Object.entries(realRevisionStore).map(([name, value]) => [name, typeof value === "function" ? value.bind(realRevisionStore) : value])),
      // Pause after durable plan.amended and before the current-revision pointer write.
      async writeCurrent(prepared: Parameters<typeof realRevisionStore.writeCurrent>[0]) {
        if (prepared?.revision === 2) {
          mkdirSync(barrier, { recursive: true });
          try {
            mkdirSync(`${barrier}/claimed`);
            writeFileSync(`${barrier}/entered`, `entered ${process.env.PI_SUBAGENT_RUN_ID ?? "unknown"}\n`);
            while (!existsSync(`${barrier}/release`)) await new Promise((resolve) => setTimeout(resolve, 20));
          } catch (error: any) {
            if (error?.code !== "EEXIST") throw error;
          }
        }
        return realRevisionStore.writeCurrent(prepared);
      },
    }) : realRevisionStore;
    return createPlanRunnerDependencies({
      ...input,
      revisionStore,
      audit: async () => ({ findings: [] }),
      externalReview: async () => ({ available: true, findings: [] }),
    });
  }});
}
