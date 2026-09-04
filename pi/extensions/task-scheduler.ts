// Project entry point for the thin, in-process upstream scheduler membrane.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTaskSchedulerAdapter from "../../src/task-scheduler/adapter.ts";

export default function taskSchedulerExtension(pi: ExtensionAPI): void {
  registerTaskSchedulerAdapter(pi);
}
