import { createBashToolDefinition, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

const PI_BIN_DIR = fileURLToPath(new URL("../bin", import.meta.url));
import { createBashCwdExtension } from "../../src/bash-cwd/index.ts";
import { createBashAsyncCompleteRenderer, createBashAsyncExtension, registerBashAsyncActivitySource } from "../../src/bash-async/index.ts";

function getBashOptions(ctx?: { cwd: string; isProjectTrusted?: () => boolean }) {
  if (!ctx) return {};
  const projectTrusted = ctx.isProjectTrusted?.() === true;
  const settings = SettingsManager.create(ctx.cwd, undefined, {
    projectTrusted,
  });
  return {
    commandPrefix: settings.getShellCommandPrefix(),
    shellPath: settings.getShellPath(),
    // Only Pi's shell-tool children see these adapters; the user's global PATH is unchanged.
    spawnHook: (spawnContext) => ({
      ...spawnContext,
      env: {
        ...spawnContext.env,
        PATH: `${PI_BIN_DIR}:${spawnContext.env.PATH ?? ""}`,
      },
    }),
  };
}

export default function bashCwd(pi: ExtensionAPI) {
  const options = {
    workspaceRoot: process.cwd(),
    createBashToolDefinition,
    getBashOptions,
  };
  createBashCwdExtension(pi, options);
  const bashAsyncController = createBashAsyncExtension(pi, options);
  let unregisterActivitySource: (() => void) | undefined;
  pi.on("session_start", () => {
    unregisterActivitySource?.();
    unregisterActivitySource = registerBashAsyncActivitySource(pi, bashAsyncController);
  });
  pi.on("session_shutdown", () => {
    unregisterActivitySource?.();
    unregisterActivitySource = undefined;
  });
  // 完成回执为 feature-owned 显示投影：Host 入口只负责绑定与 TUI 能力注入，
  // 不改 raw payload、发送出口或 completion details 合同。
  pi.registerMessageRenderer("bash-async-complete", createBashAsyncCompleteRenderer({ Text, truncateToWidth }));
  // 同Host TUI publisher：把 bash_async 只读 source 接入统一后台活动 footer。
  // 握手逻辑归 feature（src/bash-async）；入口只做 Host 绑定与公开 TUI 能力注入，
  // 不abort任务、不改cancel/shutdown/compaction原语义。
}
