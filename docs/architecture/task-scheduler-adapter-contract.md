# Scheduler adapter membrane contract

Adapter 只调用精确安装的上游 default factory；不实现 Store、Lock、timer、occurrence 或调度状态机。

- 每次 `session_start` 在上游 handler 前 canonicalize `ctx.cwd`。`dataDir` 惰性计算时向上识别真实 Git 工作区边界：普通仓库的 `.git` 目录和 managed worktree 的 `.git` 文件均为边界；真实仓库以 canonical 工作区根作为 hash identity，非 Git cwd 以 canonical cwd 作为 identity，但不将其作为外置存储排除边界。XDG state-home 以上可在创建前经最近既有祖先的 canonical containment 验证后使用平台祖先别名（例如 macOS 系统路径别名），但 XDG state-home 自身、`pi-task-scheduler` 父目录及 hash leaf 均不得是 symlink。创建后再次验证 canonical dataDir 位于 canonical state-home 内，且真实仓库的 dataDir 位于工作区外。
- 上游只收到冻结的 `Object.create(null)` facade：`on`（仅 `session_start`、`session_shutdown`）、受控 `registerTool`、丢弃 `registerCommand`、受控 `sendUserMessage`。其余能力不存在。
- create/delete 都要求 UI 三参数确认。create 摘要包含 type、schedule、enabled、清理限长 name、prompt 字节数和短 hash，绝不显示 prompt 或 description。
- 所有持久化字符串在消息转交和 list/get 输出前重新进行大小、secret、injection、Unicode 扫描。允许的 tool 输出仅为 text；带固定不可信来源标记，跨项截断至 50KB/2000 行并清空 details。
