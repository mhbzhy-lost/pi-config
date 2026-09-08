# Pi Session Owner 运维说明

人工启动 Pi 必须经过仓库的 `scripts/pi-shell.zsh` 中的 `pi()`，它会调用 launcher 并加载 session owner extension。直接执行 Pi 二进制、SDK Host、RPC、JSON 或 print 模式没有 wrapper owner ID，不登记 owner，也不提供会话切换保护；这是明确的 unsupported 边界。

## 启动矩阵

普通 `pi` 始终创建独立新会话，同一工作目录中的旧会话不会阻断它。`pi -c` 在同一个 registry 临界区解析当前 canonical cwd 的 recent：热路径只枚举 sessionDir 的 `.jsonl`、按真实文件 mtime 排序，并有界读取首个 JSONL header；不会加载完整 Pi package。Pi 的真实文件 mtime 排序优先于 JSONL message 的 `modified` 字段：recent 可用时 launcher 固定为精确 `--session <path>`；仅该 exact recent 已处于 active 或 pending 时阻断。路径、JSONL header 的 session ID 与 header cwd 必须可验证；header cwd 不能验证为当前 canonical cwd 时，保守地不继续该 recent。

`pi -r` 在 picker 出现前创建全局 `selecting` reservation。它存在期间，其他 `-r`、`-c`、`--session` 和 `--session-id` reuse 请求都会被阻断；请启动普通 `pi`，然后在已有窗口中使用 `/resume`。`--session` 接受完整路径或唯一完整 ID；prefix 有歧义时 fail closed。`--session-id` 与 `--fork` 的可解析活动 source session 都会阻断，无法无歧义解析时 fail closed。`--no-session`、print、JSON、RPC 不登记 interactive owner。

## 运行期与恢复

`session_start` 把 pending/selecting 提交为 active。运行中的 `/resume` 仅检查其他 live owner，并在冲突或 registry 故障时取消，不修改当前记录。这个人工低频路径不是跨进程 CAS：两个操作者同时确认同一空闲目标是已接受的运行期风险。

`/new`、`/resume`、`/fork` 与 import replacement 的 shutdown 会先将当前记录标记为 `transitioning`，随后由新的 `session_start` 提交。若 replacement 创建失败，记录保留为 `transitioning`，应退出该 Pi 进程后重新启动；reload 使用 v1 record schema 并保持 owner，`quit` 只释放当前进程自己的 record。异常退出后，下一次 registry scan 只会在 record PID 明确为 `ESRCH` 时清理；PID 仍存在、`EPERM` 或身份不可判断均保守阻断。

显示名称 rename 不改变 JSONL 文件 identity，因此不影响 owner。JSONL 文件的 rename、delete、replace 不由本机制保护。subagent child 和 fanout child 使用独立 session，不登记 owner；dispatch/working trace 只能帮助诊断 subagent 状态，不能解决或恢复 session owner。共享 `.guard` 若陈旧或损坏仍须人工确认后恢复，系统不会自动删除它。

真实 PTY 回归覆盖跨 wrapper 的 active recent、free recent 精确续接、picker selecting、`--no-extensions` 强制注入，以及 SIGKILL 后仅清理 ESRCH owner record。fresh install 回归还会在临时 HOME、ZDOTDIR、agentDir、sessionDir 与 registry 中 source 新生成的 `.zshrc`，经 wrapper 调用正式 Pi `--version` 并验证 `0.84.4`；该调用不使用模型或 session 网络。每个场景使用隔离 session 目录和 registry 状态、实际 JSONL fixture 或 Expect UI 输出作为就绪屏障；测试不以伪 Pi 或时间等待模拟这些竞争条件。
