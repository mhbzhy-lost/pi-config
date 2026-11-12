import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolTimingExtension } from "./index.ts";

export default function toolTiming(pi: ExtensionAPI): void {
  createToolTimingExtension(pi);
}
