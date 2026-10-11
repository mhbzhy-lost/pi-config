// Pi 自动发现入口：只绑定 Host 公开 UI/lifecycle，实现在 src/async-progress。
// 工厂不启动任何 watch/timer；普通进度唯一出口是 ctx.ui.setStatus 的
// "async-progress" 聚合 key，不 sendMessage、不 appendEntry、不添加模型消息。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ASYNC_PROGRESS_STATUS_KEY,
  createAsyncProgressController,
} from "../../src/async-progress/index.ts";

export default function asyncProgressWatcher(pi: ExtensionAPI) {
  const controller = createAsyncProgressController();

  // 每次 session_start（含 reload/new/resume/fork）先幂等清理前一代资源再绑定。
  // 进度是 TUI-only status 投影：非 TUI 模式（RPC 的 setStatus 会发出
  // extension_ui_request，非 no-op）不绑定 watch/timer/bus，仅幂等清掉前一代
  // （含 TUI 切 RPC 的会话切换），不新增 fallback。
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") {
      controller.cleanup();
      return;
    }
    controller.bind({
      ui: {
        setStatus: (text) => {
          ctx.ui.setStatus(ASYNC_PROGRESS_STATUS_KEY, text);
        },
      },
      subscribe: (handlers) => [
        // pi.events.on 返回 unsubscribe，由 controller 在 cleanup 中调用
        pi.events.on("subagent:async-started", (event) => handlers.onAsyncStarted(event)),
        pi.events.on("subagent:async-complete", (event) => handlers.onAsyncComplete(event)),
      ],
    });
  });

  // shutdown 幂等调用同一 cleanup；不删除其他领域既有 shutdown 债务
  pi.on("session_shutdown", () => {
    controller.cleanup();
  });
}
