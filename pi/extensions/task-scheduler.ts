// Project entry point for the thin, in-process upstream scheduler membrane.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTaskSchedulerAdapter from "../../scripts/lib/task-scheduler/adapter.mjs";

export default function taskSchedulerExtension(pi: ExtensionAPI): void {
  registerTaskSchedulerAdapter(pi);
}
