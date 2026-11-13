import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { browserTool } from "./browser-tool.ts";

export default function browserExtension(pi: ExtensionAPI): void {
  pi.registerTool(browserTool);
}
