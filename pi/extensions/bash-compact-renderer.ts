import { createBashTool, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  createCompactBashRendering,
  createCompactBashTool,
} from "../../scripts/lib/bash-compact-renderer.mjs";

export default function bashCompactRenderer(pi: ExtensionAPI) {
  const rendering = createCompactBashRendering({ Text, keyHint, truncateToWidth, visibleWidth });
  pi.registerTool(createCompactBashTool({
    createBashTool,
    initialCwd: process.cwd(),
    rendering,
  }));
}
