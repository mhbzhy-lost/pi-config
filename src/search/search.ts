import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchTool } from "./search-tool.ts";

export default function searchExtension(pi: ExtensionAPI): void {
  pi.registerTool(searchTool);
}
