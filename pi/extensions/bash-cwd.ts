import { createBashToolDefinition, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { createBashCwdExtension } from "../../src/bash-cwd/index.ts";
import { createBashAsyncActivityPublisher, createBashAsyncCompleteRenderer, createBashAsyncExtension } from "../../src/bash-async/index.ts";

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
  const controller = createBashAsyncExtension(pi, options);
  // 完成回执为 feature-owned 显示投影：Host 入口只负责绑定与 TUI 能力注入，
  // 不改 raw payload、发送出口或 completion details 合同。
  pi.registerMessageRenderer("bash-async-complete", createBashAsyncCompleteRenderer({ Text, truncateToWidth }));
  // 同Host TUI publisher：把 bash_async 只读 source 接入统一后台活动 footer。
  // 握手逻辑归 feature（src/bash-async）；入口只做 Host 绑定与公开 TUI 能力注入，
  // 不abort任务、不改cancel/shutdown/compaction原语义。
  const publisher = createBashAsyncActivityPublisher(controller, { Text }, {
    on: (channel, handler) => pi.events.on(channel, handler),
    emit: (channel, data) => pi.events.emit(channel, data),
  });
  pi.on("session_start", async (_event, ctx) => {
    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      return; // 缺session身份：不发布source，也不向bash命令链路报告失败
    }
    if (!sessionId) return; // 同F0合同：缺sessionId拒绝，不猜测scope
    publisher.onSessionStart({ mode: ctx.mode, sessionManager: ctx.sessionManager, sessionId });
  });
  pi.on("session_shutdown", async () => { publisher.onSessionShutdown(); });
}
