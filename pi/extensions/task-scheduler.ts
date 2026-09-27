// Project entry point for the thin, in-process upstream scheduler membrane.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTaskSchedulerAdapter, { consumeRecoveryOutcome, type SchedulerRecoveryOutcome } from "../../src/task-scheduler/adapter.ts";

/** Public runtime bridge: the scheduler never imports recovery implementation or storage. */
export type SchedulerRecoveryBridge = {
  recoverySource?: () => SchedulerRecoveryOutcome | Promise<SchedulerRecoveryOutcome>;
  onRecoveryOutcome?: (result: ReturnType<typeof consumeRecoveryOutcome>) => void;
};

export default function taskSchedulerExtension(pi: ExtensionAPI, bridge: SchedulerRecoveryBridge = {}): void {
  registerTaskSchedulerAdapter(pi);
  if (typeof bridge.recoverySource === "function") {
    void Promise.resolve(bridge.recoverySource()).then((outcome) => {
      const result = consumeRecoveryOutcome(outcome);
      bridge.onRecoveryOutcome?.(result);
    }).catch(() => undefined);
  }
}
