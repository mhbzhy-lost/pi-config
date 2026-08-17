# 重启后隔离运行时验收

- 日期：2026-08-17
- 基线：`main` 的 `41a0fa1`；开始前工作树干净。本报告不复用中止任务的结果。
- Pi：真实本机 `pi 0.84.2`。
- 结论：**未通过**。隔离临时 XDG 环境触发 Scheduler 启动期生产缺陷，产生 `extension_error`；因此不能宣称真实 Pi 全扩展 RPC 或持久会话 TUI 恢复验收通过。未修改生产代码。

## 隔离方式与安全边界

每次探针均在系统临时目录新建唯一根目录，且只在持有该根目录路径的探针 `finally` 中以 Node `fs.rm({recursive:true, force:true})` 清理。临时根中分别创建 workspace、HOME、`PI_CODING_AGENT_DIR`、sessionDir、`XDG_STATE_HOME`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME` 和 `TMPDIR`。

- 临时 Pi settings 是 `pi/settings.json` 的安全副本；确认 Goal 默认关闭，两个 npm package 的 `extensions`、`skills`、`prompts`、`themes` 都是 `[]`；没有网络安装。
- 仅链接公开仓库的 `scripts`、`pi/extensions`、`pi/npm`（已安装代码）及 `skill-overrides`；临时 HOME 只将后者链接为 `~/.agents/skills`，没有链接真实 `~/.agents`。
- 临时 workspace 创建唯一 `isolated-fixture` Skill。
- 子进程使用白名单环境（`PATH`、临时 HOME/TMP/XDG/PI 目录、`PI_OFFLINE=1`、`LANG`、`TERM`）；未传递 API key，未读取、复制或输出 `auth.json`、cookie 或任何真实认证资料。
- 未运行 raw git worktree 生命周期命令、Goal 测试或任何 Scheduler 创建任务；没有派发真实 subagent。

## 隔离真实 Pi RPC 矩阵

向真实 Pi 的离线 RPC 持久 session 发送 `get_commands` 与 `get_state`，进程正常退出，两个 RPC 均成功响应。Skill 发现实际包含 10 个托管 Skill 加唯一 fixture，合计 11 个、无重复：`browser-auth-session`、`exa-search`、`external-llm-review`、`git-commit-convention`、`playwright`、`subagent-dispatch`、`test-driven-development`、`using-goal-engine`、`writing-plans`、`writing-skills`、`isolated-fixture`。

但 session_start 同时产生以下失败（临时路径已脱敏）：

```
extension_error: task-scheduler.ts / session_start
scheduler data directory parent must be a real directory
```

最小复现：在 macOS 系统临时目录下设置 `XDG_STATE_HOME=<临时根>/xdg-state`，全扩展真实 Pi 0.84.2 离线 RPC 启动。`repositoryDataDir()` 的 `checkDirectoryChain()` 会将系统的 `/var` 符号链接父级拒绝；临时目录实际位于该链下。结果是 Scheduler 尚未创建任务即在 `session_start` 报错。影响是符合本任务隔离要求的临时 XDG 环境无法满足“无 extension_error”，且无法在真实 Pi 会话中继续验证 Scheduler 数据目录权限/边界。

这是生产缺陷的最小复现和影响记录，按约定未修复；应由后续 TDD 任务在不放宽叶目录防链接保护的前提下处理系统临时目录的规范化父路径。

`get_state` 的 Pi 0.84.2 RPC 响应不枚举工具。工具面以真实 Pi SDK/Jiti 加载的单元矩阵和全量测试作等价证据：存在 `subagent`，以及 `scheduler_list/get/create/delete`；上游 `scheduler_update`、run-now 与 `/cron` 均被拦截；Goal 默认关闭且不暴露 `goal_*`。未调用 create/delete，因此没有 Scheduler 任务或真实状态写入。

## renderer 与恢复

真实 SDK/Jiti 逐项调用 `renderSubagentCall`：`status`、`steer`、`interrupt`、`stop`、`workspace_status`、`workspace_disposition`、未知 action、缺省 action 均返回有 `render(width)` 的 Pi Component，`render(80)` 不抛错。spawn 精确渲染为：

```
subagent starting executor: 隔离验收
```

没有前导 `* `。

已构造隔离持久 session，并以 `script` pseudo-terminal 启动恢复尝试；该 TUI 探针有 120 秒硬超时，但 `script` 未在控制字符输入后退出，最终由超时终止。由于同一 Scheduler `session_start` extension_error，不能把此降级为成功的 TUI 恢复证据；也未观察到 `Cannot read properties of undefined (reading 'render')`。作为等价渲染证据，全量测试中的真实 `SessionManager`/native conversation renderer 覆盖通过，但 PTY 恢复仍需在 Scheduler 缺陷修复后重跑。

## 命令与结果

| 命令 | 结果 |
|---|---|
| `git rev-parse --short HEAD && git status --short` | 通过：`41a0fa1`，开始时干净 |
| `npm test` | 通过：620/620，约 20.4 秒 |
| `PI_REAL_BIN=$(command -v pi) npm run test:integration` | 通过：2/2；真实 Pi RPC Skill 验证通过 |
| `npm run doctor` | 通过（退出 0）：Pi Skill allowlist 与 Root broker ready；仅报告既有 preserved/dirty/unmanaged worktree 警告，未清理 |
| `PI_REAL_BIN=$(command -v pi) npm run test:subagents` | 首次失败：继承 `PI_SUBAGENT_CHILD`，保护性拒绝顶层运行时；未作代码改动 |
| `env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD -u PI_SUBAGENT_PARENT_SESSION -u PI_SUBAGENT_RUN_ID -u PI_SUBAGENT_ORCHESTRATOR_SESSION_ID -u PI_ROOT_SUBAGENT_BROKER_ENABLED PI_REAL_BIN=$(command -v pi) npm run test:subagents` | 通过：3/3，约 6.7 秒；确定性测试 child，不是实际工作派发 |
| 隔离全扩展离线 RPC（`get_commands`、`get_state`） | 失败：RPC 响应正常、Skill 11/11 无重复，但 Scheduler session_start `extension_error` |
| 隔离 PTY `script` 恢复尝试 | 降级/失败：120 秒硬超时，且受同一 Scheduler extension_error 阻断 |
| 真实 SDK/Jiti renderer 枚举探针 | 通过：8/8 action Component 可渲染；spawn 文案精确 |

## 结论与剩余风险

非 Goal、非 worktree 的回归测试、真实 Pi 版本/Skill 基础面、subagent renderer 和确定性子运行时启动均通过。阻断项仅为 Scheduler 对系统临时目录符号链接父级的错误拒绝；在该缺陷修复并重跑隔离 RPC 与 PTY 之前，不能接受全扩展隔离验收。报告未包含敏感信息或用户名化临时绝对路径。
