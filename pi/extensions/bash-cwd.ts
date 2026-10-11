import { createBashToolDefinition, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashCwdExtension } from "../../src/bash-cwd/extension.ts";

function getBashOptions(ctx?: { cwd: string; isProjectTrusted?: () => boolean }) {
  if (!ctx) return {};
  const projectTrusted = ctx.isProjectTrusted?.() === true;
  const settings = SettingsManager.create(ctx.cwd, undefined, {
    projectTrusted,
  });
  return {
    commandPrefix: settings.getShellCommandPrefix(),
    shellPath: settings.getShellPath(),
  };
}

export default function bashCwd(pi: ExtensionAPI) {
  createBashCwdExtension(pi, {
    workspaceRoot: process.cwd(),
    createBashToolDefinition,
    getBashOptions,
  });
}
