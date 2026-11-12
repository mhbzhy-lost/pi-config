import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTuiRuntime } from "./index.ts";

export default function customFooter(pi: ExtensionAPI): void {
  createTuiRuntime(pi);
}
