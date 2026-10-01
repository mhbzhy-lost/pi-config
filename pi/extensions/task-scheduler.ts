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
    let phase = "recoverySource";
    void Promise.resolve().then(() => bridge.recoverySource!()).then((outcome) => {
      phase = "consumeRecoveryOutcome";
      const result = consumeRecoveryOutcome(outcome);
      phase = "onRecoveryOutcome";
      bridge.onRecoveryOutcome?.(result);
    }).catch((error) => {
      try {
        console.error(`[task-scheduler recovery] ${phase} failed`, error);
      } catch (diagnosticError) {
        process.emitWarning(new AggregateError([error, diagnosticError], `task-scheduler recovery diagnostic failed (${phase})`, { cause: error }));
      }
    });
  }
}
