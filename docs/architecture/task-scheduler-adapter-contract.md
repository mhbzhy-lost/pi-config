# Scheduler adapter membrane contract

Adapter 只调用精确安装的上游 default factory；不实现 Store、Lock、timer、occurrence 或调度状态机。

- 每次 `session_start` 在上游 handler 前 canonicalize `ctx.cwd`。`dataDir` 惰性计算时向上识别真实 Git 工作区边界：普通仓库的 `.git` 目录和 managed worktree 的 `.git` 文件均为边界；真实仓库以 canonical 工作区根作为 hash identity，非 Git cwd 以 canonical cwd 作为 identity，但不将其作为外置存储排除边界。XDG state-home 以上可在创建前经最近既有祖先的 canonical containment 验证后使用平台祖先别名（例如 macOS 系统路径别名），但 XDG state-home 自身、`pi-task-scheduler` 父目录及 hash leaf 均不得是 symlink。创建后再次验证 canonical dataDir 位于 canonical state-home 内，且真实仓库的 dataDir 位于工作区外。
- 上游只收到冻结的 `Object.create(null)` facade：`on`（仅 `session_start`、`session_shutdown`）、受控 `registerTool`、丢弃 `registerCommand`、受控 `sendUserMessage`。其余能力不存在。
- create/delete 不再要求 UI 确认（经用户授权取消，由 agent 直接控制，不设 annotations 替代门）。create 的持久化 prompt 在入库前仍做大小、secret、injection、Unicode 扫描；create/delete 的上游结果原样透传，删除失败以 "Task not found" 文本或异常可观察呈现，不伪报成功。`scheduler_update`、`scheduler_run_now` 工具与 `/cron` 命令仍被拦截丢弃，不扩大授权面。
- scheduler 触发经 facade `sendUserMessage` 转交时，在该执行边界恰好追加一次固定来源/自清理提示：交付文本为「不可信来源标记 + 原始持久化 prompt + 固定边界行 + scheduler runtime 注入的 trusted routing context（固定中文文案）」。持久化 `task.prompt` 原样转交，不被改写、不写回注入文案，重复触发不重复累积。注入文案为非强 tick 绑定：不携带、不推断当前触发消息对应的 task id，指导 agent 先用 `scheduler_list`/`scheduler_get` 核实（含已禁用任务），只有清理目标在授权范围内唯一确定时才用查询回执中的完整 task id 调用 `scheduler_delete`；同 prompt、并发触发、compact/摘要丢弃、输出截断或缺项、查询/删除出错等歧义场景一律保留任务并如实报告。
- 所有持久化字符串在消息转交和 list/get 输出前重新进行大小、secret、injection、Unicode 扫描。允许的 tool 输出仅为 text；带固定不可信来源标记，跨项截断至 50KB/2000 行并清空 details。
