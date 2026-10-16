# Scheduler adapter membrane contract

**文档性质：** 当前实现的架构合同，不是待实施计划。四工具门禁、create/delete 免 UI 确认和触发消息的固定路由提示已经实现；不得重新派发为未完成工作。2026-10-13 审查只校正文档事实，不授权修改执行语义、Store、Lock 或真实任务。

**会话准入前提（2026-10-13）：** scheduler 不负责决定两个 Pi 是否可以同时打开同一 session。受控 `scripts/pi-shell.zsh`/`src/session-owner/` 路径必须先完成 session ownership；同一受控路径的第二个 Pi 被拒绝后，scheduler 才会收到 `session_start`。本合同不把该前置门禁扩展为上游 SDK、直接物理 CLI 或人为同进程共享 EventBus 的全局保证，也不把 session owner 的局部保护写成上游已实现。

Adapter 只调用精确安装的上游 default factory；不实现 Store、Lock、timer、occurrence 或调度状态机。

- 每次 `session_start` 在上游 handler 前 canonicalize `ctx.cwd`。`dataDir` 惰性计算时向上识别真实 Git 工作区边界：普通仓库的 `.git` 目录和 managed worktree 的 `.git` 文件均为边界；真实仓库以 canonical 工作区根作为 hash identity，非 Git cwd 以 canonical cwd 作为 identity，但不将其作为外置存储排除边界。XDG state-home 以上可在创建前经最近既有祖先的 canonical containment 验证后使用平台祖先别名（例如 macOS 系统路径别名），但 XDG state-home 自身、`pi-task-scheduler` 父目录及 hash leaf 均不得是 symlink。创建后再次验证 canonical dataDir 位于 canonical state-home 内，且真实仓库的 dataDir 位于工作区外。
- 上游只收到冻结的 `Object.create(null)` facade：`on`（仅 `session_start`、`session_shutdown`）、受控 `registerTool`、丢弃 `registerCommand`、受控 `sendUserMessage`。其余能力不存在。
- create/delete 不再要求 UI 确认（经用户授权取消，由 agent 直接控制，不设 annotations 替代门）。create 的持久化 prompt 在入库前仍做大小、secret、injection、Unicode 扫描；create/delete 的上游结果原样透传，删除失败以 "Task not found" 文本或异常可观察呈现，不伪报成功。`scheduler_update`、`scheduler_run_now` 工具与 `/cron` 命令仍被拦截丢弃，不扩大授权面。
- scheduler 触发经 facade `sendUserMessage` 转交时，在该执行边界恰好追加一次固定来源/自清理提示：交付文本为「不可信来源标记 + 原始持久化 prompt + 固定边界行 + scheduler runtime 注入的 trusted routing context（固定中文文案）」。持久化 `task.prompt` 原样转交，不被改写、不写回注入文案，重复触发不重复累积。注入文案为非强 tick 绑定：不携带、不推断当前触发消息对应的 task id，指导 agent 先用 `scheduler_list`/`scheduler_get` 核实（含已禁用任务），只有清理目标在授权范围内唯一确定时才用查询回执中的完整 task id 调用 `scheduler_delete`；同 prompt、并发触发、compact/摘要丢弃、输出截断或缺项、查询/删除出错等歧义场景一律保留任务并如实报告。
- 消息转交扫描实际转交的完整 prompt；list/get 扫描上游实际返回的 text blocks，而非遍历 store 中所有持久化字符串。上游 list 已将 prompt 截为摘要，因此不能以 list 扫描证明未返回部分也已检查。create 准入扫描与受控 get 的扫描是不同入口；create/delete 的上游结果原样透传，不套用 list/get 包装。
- list/get 的既有模型侧安全包装拒绝非 text block、任何已定义的 `details`、超限输入及扫描失败，不是接受后清空 `details`。输入扫描累计上限为 1MiB，输出追加固定不可信来源标记，并跨 blocks 限制为 50KiB/2000 行，超出追加明确的 truncated 标记。该包装在模型收到结果前发生，是现有有界输出合同，不是 TUI 折叠；本次审查不改变它，也不能为了新增 footer 反解析截断结果或顺手取消安全门禁。

## 展示与安全边界

- ANSI/control 清理、标签缩短、换行、图标、折叠和宽度预算属于 renderer-only 显示投影，不修改任务、工具原始结果或模型消息。不得把显示精简需求作为改变上述执行安全包装的理由。
- 现有 footer 的 48 字符标签来自原始上游 list 的只读显示投影，不是任务身份。后续统一后台活动 source 应获取完整元数据，按稳定 task id 定位；不能从 `⏱ label +N` 或带来源标记且可能截断的模型输出恢复对象。
- 新 observer 需要单独冻结字段校验、显示安全处理和受控详情合同；详情只能经现有受控 get，不直接读取任务文件。字段读取成功只表示当前 scheduler 实例的观察成功，不保证共享 store 的跨 Host 最新状态。

## 当前观察能力与已知缺口

- initial refresh 和既有 30 秒 timer 使用当前实例的上游 list；上游返回 id/name/type/schedule/enabled/lastStatus/nextRunAt/runCount 等元数据，足够建立显示 source。enabled 是计划启用，不代表模型正在执行；lastStatus 成功是 runner 投递结果，不证明业务成功。当前没有实时执行状态观察合同，不能虚构“正在投递”。
- list summary 在任务尚无 lastStatus 时返回正常值 `pending`；这不应被 observer 当作坏数据。typed record 应保留 pending（等待触发），与 success/error/running 区分；running 只是该次查询观察，不构成实时 runningTaskIds 保证。
- create/delete 的 wrapper 会调用 refresh，但当前 refresh 要求工具 ctx 与保存的 session_start ctx 是同一个对象。Pi 1.0.4 的公开 runner 为工具创建 fresh context，因此不能宣称正常工具调用后已经即时刷新。修复时须核对 manager/session/epoch，而非简单删掉世代门禁；具体实现与验证归统一后台活动计划的 scheduler source 单元。
- `src/task-scheduler/store.ts` 不存在，store 注入已撤回。共享 store 的 D1–D3 与锁问题仍暂停，记录见 `docs/bugs/2026-10-13-scheduler-store-adapter.md`、`docs/bugs/2026-10-13-scheduler-store-concurrency.md`。普通单 Host 观察不必等待该修复；若要求跨 Host 最新状态，才产生另案真实依赖。

## 可重建的事实来源

- `src/task-scheduler/adapter.ts`：facade、扫描/输出包装、routing context 与现有 refresh。
- `src/session-owner/{registry,lifecycle,extension}.ts` 与 `scripts/pi-shell.zsh`：受控 interactive 启动/切换的 session ownership 前置边界；该边界不覆盖 direct SDK/非 interactive 模式。
- `pi/npm/node_modules/@amaster.ai/pi-task-scheduler/dist/extension.js`、`dist/tools.js`、`dist/stores.js`：锁定版本 0.1.9 的配置、list/get 字段及实例缓存。
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`：锁定 Pi 1.0.4 的 context 创建事实。
- `/tmp` 报告仅为历史补充证据，不作为新执行的唯一输入；本合同不是并发存储修复授权。
