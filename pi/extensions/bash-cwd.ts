import { createBashToolDefinition, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { createBashCwdExtension } from "../../src/bash-cwd/index.ts";
import { createBashAsyncExtension, createBashAsyncCompleteRenderer } from "../../src/bash-async/index.ts";

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
  const options = {
    workspaceRoot: process.cwd(),
    createBashToolDefinition,
    getBashOptions,
  };
  createBashCwdExtension(pi, options);
  createBashAsyncExtension(pi, options);
  // 完成回执为 feature-owned 显示投影：Host 入口只负责绑定与 TUI 能力注入，
  // 不改 raw payload、发送出口或 completion details 合同。
  pi.registerMessageRenderer("bash-async-complete", createBashAsyncCompleteRenderer({ Text, truncateToWidth }));
}
