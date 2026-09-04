import { createBashToolDefinition, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createBashCwdExtension } from "../../src/bash-cwd/extension.ts";
import { createCompactToolRenderers } from "../../src/compact-tools/renderer.ts";

function getBashOptions(ctx: { cwd?: string; isProjectTrusted?: () => boolean } = {}) {
  const settings = SettingsManager.create(ctx.cwd || process.cwd(), undefined, {
    projectTrusted: ctx.isProjectTrusted?.() ?? true,
  });
  return {
    commandPrefix: settings.getShellCommandPrefix(),
    shellPath: settings.getShellPath(),
  };
}

export default function bashCwd(pi: ExtensionAPI) {
  const renderer = createCompactToolRenderers({
    Text,
    Container,
    visibleWidth,
    sliceByColumn,
    truncateToWidth,
  }).bash;

  createBashCwdExtension({
    registerTool(definition: any) {
      pi.registerTool({
        ...definition,
        renderShell: "self",
        renderCall: renderer.renderCall,
        renderResult: renderer.renderResult,
      });
    },
  }, {
    workspaceRoot: process.cwd(),
    createBashToolDefinition,
    getBashOptions,
  });
}
