import { SkillInvocationMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, sliceByColumn, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createCompactToolRendererResolver, installCompactSkillRenderer } from "./index.ts";

export default function compactTools(pi: ExtensionAPI) {
  const structuredContentByCall = new Map<string, unknown>();
  pi.registerToolRenderer(createCompactToolRendererResolver({
    Text,
    Container,
    visibleWidth,
    sliceByColumn,
    truncateToWidth,
    getStructuredContent: (toolCallId) => structuredContentByCall.get(toolCallId),
  }));
  pi.on("tool_execution_end", (event) => {
    const result = event.result as { structuredContent?: unknown } | undefined;
    if (result && Object.prototype.hasOwnProperty.call(result, "structuredContent")) {
      structuredContentByCall.set(event.toolCallId, result.structuredContent);
    } else {
      structuredContentByCall.delete(event.toolCallId);
    }
  });
  pi.on("session_start", (_event, ctx) => {
    structuredContentByCall.clear();
    // Skill 专用外壳仍依赖既有 private patch，由领域内唯一实现以 Symbol 去重。
    installCompactSkillRenderer({ SkillInvocationMessageComponent, Text, Markdown, theme: ctx.ui.theme });
  });
  pi.on("session_shutdown", () => structuredContentByCall.clear());
}
