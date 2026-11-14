import { SkillInvocationMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, sliceByColumn, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createCompactToolRendererResolver, installCompactSkillRenderer } from "./index.ts";

export default function compactTools(pi: ExtensionAPI) {
  pi.registerToolRenderer(createCompactToolRendererResolver({
    Text,
    Container,
    visibleWidth,
    sliceByColumn,
    truncateToWidth,
  }));
  pi.on("session_start", (_event, ctx) => {
    // Skill 专用外壳仍依赖既有 private patch，由领域内唯一实现以 Symbol 去重。
    installCompactSkillRenderer({ SkillInvocationMessageComponent, Text, Markdown, theme: ctx.ui.theme });
  });
}
