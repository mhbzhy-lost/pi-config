// 薄 Host 入口（统一执行计划 F2a/F6 / footer 子计划 T2a/T6a）。
// 本入口只承担两件事：
// 1. 绑定公开 SDK/TUI 依赖（SDK getMarkdownTheme、pi-tui 显示/输入工具）并注入
//    package 内 createFooterRuntime；
// 2. 注册唯一 Alt+O 快捷键（SDK 无 shortcut unregister，故 handler 按当代闭包委托
//    runtime 当前视图：F6 挂载统一 presenter 时为 view.openDetails()，否则为
//    package 自有 standalone browser）。
// 实际 footer 职责（roster、500ms reconcile、native/trusted 渲染回退、Alt+O overlay、
// editor/draft 恢复、唯一 setFooter 安装，以及 F6 的统一后台活动 owner/bus 握手）
// 全部在 src/tui/footer-runtime.ts；本入口不得持有领域状态、不得直接调用 setFooter、
// 不得注册第二个 Alt+O，也不 re-export 运行时实现。
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createFooterRuntime } from "../src/tui/footer-runtime.ts";

export default function customFooter(pi: ExtensionAPI) {
  const runtime = createFooterRuntime(pi, {
    getMarkdownTheme,
    tui: { Key, isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth },
  });
  pi.registerShortcut(Key.alt("o"), {
    description: "Open subagent browser",
    handler: (shortcutCtx) => runtime.openBrowser(shortcutCtx),
  });
}
