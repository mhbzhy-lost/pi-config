import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTuiRuntime } from "../../src/tui-lite/index.ts";

export default function customFooter(pi: ExtensionAPI): void {
  createTuiRuntime(pi);
}
