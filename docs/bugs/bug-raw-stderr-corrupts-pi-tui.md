# Bug：裸 stderr 输出破坏 Pi TUI 布局

## 1. 现象

Pi 交互模式运行期间，extension 或其依赖调用 `console.error`、`console.warn` 或 `process.stderr.write` 时，文本会偶发出现在 editor/footer 附近。文本不属于聊天消息、通知或 footer 状态，但会插入当前终端画面并破坏底部布局。

## 2. 影响

任何运行在 Pi 主进程中的 extension 都可以绕过 TUI 渲染管线直接修改终端。错误文本可能残留、覆盖 footer，或在下一次差量重绘时造成错位；同时用户无法区分结构化消息与内部诊断输出。

## 3. 稳定复现

1. 以交互模式启动 Pi，使 TUI 完成首次绘制。
2. 从任一 extension 的异步回调执行 `console.error("probe")`。
3. Node 将文本写入 `process.stderr`；终端在 TUI 当前硬件光标位置显示该文本。
4. 本次现场由 `pi-subagents@0.37.0` 的 async grouped-result intercom ACK 超时触发，文案为 `Subagent async grouped result intercom delivery was not acknowledged ...`。

## 4. 证据

`pi-subagents/src/runs/background/result-watcher.ts` 在 intercom delivery 500ms 内未收到 ACK 时直接调用 `console.error`，随后才继续普通 completion notification。Pi TUI 的 `ProcessTerminal.write()` 使用 `process.stdout.write` 做 ANSI 差量绘制；交互模式没有调用 `core/output-guard.takeOverStdout()`，也没有接管 `process.stderr.write`。当前自定义 footer 只通过 `ctx.ui.setFooter()` 返回自己的组件，没有读取或渲染这条文案。

最小运行验证显示：没有 `subagent:result-intercom-delivery` ACK 时 delivery 在超时后返回 `false`，模拟 ACK 时返回 `true`。仓库扩展和 runtime 中没有对应 ACK producer，因此现场告警符合该分支；其最终显示位置则由裸 stderr 与 TUI 共用终端光标导致。

## 5. 根因

Pi 交互模式缺少“结构化 UI 输出”和“进程裸 stderr”之间的输出边界。Extension 与 Pi Core 运行在同一 Node.js 进程，`console.error` 最终直接调用 `process.stderr.write`；stderr 不经过 TUI 组件树、消息事件或重绘调度，却与 TUI stdout 指向同一个终端，所以会在任意时刻破坏当前布局。

## 6. 修复与验证策略

在本仓库新增仅对 `ctx.mode === "tui"` 生效的 `InteractiveStderrGuard`。TUI 会话活跃时接管 `process.stderr.write`，把裸输出写入严格限制大小的轮转诊断日志；日志目录固定为 `0700`、文件固定为 `0600`，并通过 `.gitignore` 排除运行产物。结构化消息、工具错误和 `ctx.ui.notify` 保持原行为。Guard 在 reload、session shutdown 和 uncaught exception 打印前恢复原始 writer，并用进程级稳定状态避免 reload 后多层包装或旧 cleanup 恢复新 owner。

先以失败测试固定五项契约：裸 stderr 不触达原始终端、callback 语义保留、restore 后恢复、reload owner 隔离、uncaught exception 在后续 crash handler 打印前恢复。再以独立 RED/GREEN 周期覆盖日志轮转、单条超限、owner-only 权限、文件系统失败和 extension mode/lifecycle，最后运行聚焦测试、extension reload 边界测试和全量测试。

## 7. 验证结果

Guard、日志和 extension 生命周期共 10 项聚焦测试通过；真实 `process.stderr` 探针确认 `console.error` 只进入 sink，extension 加载与 reload 边界测试通过，`git diff --check` 通过。最终全量测试 `961/961` 通过。External review 的三个 provider 分别因超时、缺少 key 和模型下架不可用，人工审查补充并验证了单条日志严格上限与 owner-only 权限。
