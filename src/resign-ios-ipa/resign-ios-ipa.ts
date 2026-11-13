import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resignIpaTool } from "./resign-ios-ipa-tool.ts";

export default function resignIpaExtension(pi: ExtensionAPI): void {
  pi.registerTool(resignIpaTool);
}
