# Scheduler adapter membrane contract

Adapter 只调用精确安装的上游 default factory；不实现 Store、Lock、timer、occurrence 或调度状态机。

- 每次 `session_start` 在上游 handler 前 canonicalize `ctx.cwd`。注入配置的 `dataDir` getter 仅在该窗口惰性计算，并使用仓库外的 0700 目录；XDG state-home 以上可在创建前经最近既有祖先的 canonical containment 验证后使用平台祖先别名（例如 macOS 系统路径别名），但 XDG state-home 自身、`pi-task-scheduler` 父目录及 hash leaf 均不得是 symlink。创建后再次验证 canonical dataDir 位于 canonical state-home 内且在仓库外。
- 上游只收到冻结的 `Object.create(null)` facade：`on`（仅 `session_start`、`session_shutdown`）、受控 `registerTool`、丢弃 `registerCommand`、受控 `sendUserMessage`。其余能力不存在。
- create/delete 都要求 UI 三参数确认。create 摘要包含 type、schedule、enabled、清理限长 name、prompt 字节数和短 hash，绝不显示 prompt 或 description。
- 所有持久化字符串在消息转交和 list/get 输出前重新进行大小、secret、injection、Unicode 扫描。允许的 tool 输出仅为 text；带固定不可信来源标记，跨项截断至 50KB/2000 行并清空 details。
