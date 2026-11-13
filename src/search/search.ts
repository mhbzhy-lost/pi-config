import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchTool } from "./search-tool.ts";
import { createSearchRenderer } from "./renderer.ts";

export default function searchExtension(pi: ExtensionAPI): void {
  pi.registerToolRenderer(createSearchRenderer());
  pi.registerTool(searchTool);
}
