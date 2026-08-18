# Scheduler 状态目录别名修复后隔离复验

- 日期：2026-08-17
- 基线：`main` 的 `8e9ca0c`
- Pi：真实本机 `pi 0.84.2`
- 结论：**通过**。修复前报告 `docs/reviews/2026-08-17-post-restart-isolated-runtime-verification.md` 中的 Scheduler `extension_error` 已消失；真实 RPC、SDK 工具面和持久会话 TUI 恢复均通过。

## 隔离与安全边界

复验在全新系统临时根中分别创建 workspace、HOME、`PI_CODING_AGENT_DIR`、sessionDir、Goal 目录和 XDG state/config/cache 目录。每次探针只清理由自身创建并持有明确路径的临时根。

- 临时 Pi 配置只链接仓库公开的扩展、已安装依赖、Agent 定义和 `skill-overrides`。
- 未复制、读取或输出真实 `auth.json`、API key、cookie 或其他认证资料；子进程只收到白名单环境和不可用的测试占位 key。Pi 在临时 agentDir 中按自身启动流程初始化了临时 auth 文件，但探针未读取其内容，临时根随后被删除。
- `pi-subagents` 与 `pi-task-scheduler` 的 package resources 继续全部为 `[]`；未发生网络安装。
- Goal 默认关闭；未运行 Goal/Worktree integration、未派发真实 Subagent、未创建 Scheduler 任务。
- 临时 workspace 仅增加唯一 `isolated-fixture` Skill。

## macOS 状态目录与真实 RPC

系统返回的临时路径使用 `/var/...`，其 canonical 路径位于 `/private/var/...`，因此本次实际覆盖了导致原缺陷的 `/var -> /private/var` 祖先别名。

真实 Pi 离线 RPC 在临时 workspace 中执行 `get_commands` 与 `get_state`：

- 进程正常退出，状态码为 0；
- 没有 `extension_error`、扩展加载失败或 renderer TypeError；
- 两个 RPC 响应均成功；
- 发现 10 个 managed Skills 加 `isolated-fixture`，共 11 项且无重复；
- Scheduler 只创建一个 64 位十六进制仓库 hash 目录；
- canonical dataDir 位于 canonical XDG state-home 内、位于仓库外，权限为 `0700`。

这证明 `8e9ca0c` 允许 state-home 以上的平台祖先别名，同时仍将状态限制在 canonical XDG 边界内。

## SDK 工具面

真实 Pi SDK/ResourceLoader 绑定当前完整扩展后，没有 lifecycle error。

存在的项目工具：

- `subagent`
- `scheduler_list`
- `scheduler_get`
- `scheduler_create`
- `scheduler_delete`

不存在的工具：

- `scheduler_update`
- `scheduler_run`
- `scheduler_run_now`
- `cron`
- 全部 `goal_*` 工具

探针只检查定义，没有调用会派发工作或产生任务状态的工具。

## 持久会话 TUI 恢复

探针通过真实 `SessionManager` 创建包含 `subagent` `status` tool call/result 的持久 session，再用 Python PTY 启动真实 Pi regular TUI：

- 首屏产生 14,226 字节终端输出；
- 能观察到恢复会话文本；
- 启动 4 秒后发送两次受控 Ctrl-C；
- Pi 自行正常退出，wait status 为 0，没有强制终止；
- stderr 为空；
- 未出现 `Cannot read properties of undefined (reading 'render')`；
- 未出现 `extension_error` 或扩展加载失败。

因此 `1d0dcf2` 的空 Component 修复在真实持久会话恢复路径上得到验证，且 Scheduler 不再阻断该路径。

## 回归矩阵

| 验证 | 结果 |
|---|---|
| 全新隔离真实 Pi RPC | 通过；无 `extension_error`，Skills 11/11 |
| macOS `/var` 祖先别名 dataDir | 通过；canonical containment、仓库外、`0700` |
| 真实 SDK 工具面 | 通过；仅项目允许的 Subagent/Scheduler 工具 |
| 持久 session PTY 恢复 | 通过；正常退出，无 renderer/extension 错误 |
| `npm test` | 通过：620/620 |
| `PI_REAL_BIN=$(command -v pi) npm run test:integration` | 通过：2/2 |
| 脱敏顶层环境 `npm run test:subagents` | 通过：3/3 |
| `npm run doctor` | 退出 0；Skill allowlist 与 Root broker ready |

Doctor 仍报告既有 preserved、dirty、unmanaged 及 identity-mismatch worktree 警告；本任务未运行生命周期测试，也未对这些目录做任何清理。

## 最终结论

修复前唯一阻断项已经关闭。本轮未发现新的生产缺陷：真实 Pi 在 macOS 系统临时路径别名下可以加载完整项目扩展，Scheduler 数据目录满足边界和权限要求，控制调用持久会话可以完成真实 TUI 恢复并正常退出。
