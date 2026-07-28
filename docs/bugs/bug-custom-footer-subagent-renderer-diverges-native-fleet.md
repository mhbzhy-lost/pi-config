# Bug：自定义 Footer 的 Subagent 渲染偏离原生 Fleet 语义

## 1. 现象

自定义 footer 在 subagent 运行时显示 `subagents: plan-reviewer`。固定 `subagents:` 前缀占用宽度；若直接添加圆点，又会把 `pi-subagents` 原生 persistent FleetView 的 `⏺/◯` 选择光标误用为普通状态标记。活动 async run 期间执行 `/reload`，该行还会提前消失。

## 2. 影响

footer 的被动摘要与原生 Fleet 的交互语义混杂，用户无法判断圆点是否可操作。固定前缀挤占窄终端空间。reload 后摘要与真实 child 生命周期不一致，旧 extension runtime 注册的 lifecycle listener 也没有显式注销。

## 3. 稳定复现

1. 派发一个后台 `plan-reviewer`。
2. footer 第二行左侧显示 `subagents: plan-reviewer`。
3. 在 child 尚未完成时执行 `/reload`。
4. `session_shutdown` 清空实例内 background Map；新实例只监听未来事件，而 `pi-subagents` 恢复活动 run 时不会重新发送 `subagent:async-started`，因此摘要不会恢复。
5. 原生 inspector 只能通过硬编码的 `Ctrl+Alt+F` 打开，当前配置没有更简短的入口。

## 4. 证据

`pi/extensions/custom-footer.ts` 的 `label()` 固定拼接 `subagents:`，状态只保存在 extension 实例 Map 中。`pi-subagents` 的 `restoreActiveJobs()` 只恢复内部 `state.asyncJobs`，不发 async-started 事件。0.37.0 start payload 使用 `id`，completion payload补充正式 `runId`，当前 footer 两处采用相反字段优先级。上游 `fleet-status.ts` 把 `⏺/◯` 定义为选择光标；`fleet.ts` inspector 使用 `›` 选择项、`●` 表示 running。`slash-commands.ts` 将 inspector 入口硬编码为 `Key.ctrlAlt("f")`。

Pi 的 terminal input listener 支持返回替换后的 raw data；`matchesKey("\x1bo", Key.alt("o"))` 和 `matchesKey("\x1b\x06", Key.ctrlAlt("f"))` 均已验证为 true，因此 tracked extension 可把 `Alt+O` 转发给原生快捷键 handler，无需修改 `node_modules` 或复制 inspector。

## 5. 根因

上一轮修复让 custom footer 自己维护活动 agent 摘要，但没有明确“被动渲染”和“原生 Fleet 交互”的所有权边界。结果是渲染文案、selection glyph、reload 生命周期和 inspector 入口被混在同一讨论中。`pi-subagents` 当前也没有公开 API 可把 persistent FleetView 的 renderer/selection state 挂载进自定义 footer。

## 6. 修复与验证策略

采用兼容优先边界：footer 只被动显示活动 agent 名称，例如 `plan-reviewer` 或 `executor, reviewer`，删除 `subagents:`，不显示 `main`，也不渲染 `⏺/◯/●`。`fleetView` 与 `asyncWidget` 保持关闭，避免恢复原多行冲突；child 浏览完全交给原生 child-only inspector，保留其方向键、transcript、刷新和 `Esc` 返回行为。

tracked extension 把 `Alt+O` raw input 转换为原生 `Ctrl+Alt+F` 序列，并消费物理 `Ctrl+Alt+F`，实现快捷键替换而不调用 inspector 私有 API。Pi 无法区分左右 Alt；当前 iTerm2 可将 Right Option 配为 `Esc+`、Left Option 保持 Normal，以获得物理上的右 Alt+O。

渲染状态仍需最小生命周期加固：用 `Symbol.for(...)` store 仅跨同进程 reload 保留 background run，foreground 随 runtime 清理；start/complete 统一 `runId ?? id`；shutdown 注销 event bus 和 terminal input listener。先以真实 TypeScript extension 测试固定无前缀摘要、按键转发、并发清理和 reload，再执行 footer、reload 边界与真实 SDK reload 验证。

## 7. 验证结果

footer、真实 extension、reload 边界、紧凑工具和 Todo 共 40 项聚焦测试通过。测试确认 `Alt+O` raw input 被改写为原生 `Ctrl+Alt+F` 序列、物理旧快捷键被消费、其他输入不受影响；并发同名 run、正式 `runId` 和同进程 reload 均保持摘要正确，shutdown 会注销 event bus 与 terminal input listener。

`pi-subagents` 自身 `loadConfig()` 实际返回 `fleetView: false`、`asyncWidget: false`。在 `~/mega-aone-service` 使用当前完整配置调用与 TUI `/reload` 相同的 `session.reload()` 耗时 139ms，extension errors 为 0。真实 iTerm2 右 Option+O 和原生 inspector 可视验收等待当前交互会话 reload 后执行。
