# Pi Session Owner 运维说明

人工启动 Pi 必须经过仓库的 `scripts/pi-shell.zsh` 中的 `pi()`，它会调用 launcher 并加载 session owner extension。直接执行 Pi 二进制、SDK Host、RPC、JSON 或 print 模式没有 wrapper owner ID，不登记 owner，也不提供会话切换保护；这是明确的 unsupported 边界。同理，直接调用 SDK 的 `AgentSessionRuntime.switchSession()/newSession()/fork()/importFromJsonl()`（即绕过 wrapper 的 direct SDK 入口）不会登记 owner，也不受本文任何事务保护。

本文的运行期事务语义以现场物理 SDK `@earendil-works/pi-coding-agent@1.0.4` 的公开事件与源码顺序为准（`session_before_switch` → `SessionManager.open` → `session_shutdown` → 新 runtime `session_start`），冻结记录见 `docs/plans/records/2026-10-13-session-switch-contract.md`。

## 启动矩阵

普通 `pi` 始终创建独立新会话，同一工作目录中的旧会话不会阻断它。`pi -c` 在同一个 registry 临界区解析当前 canonical cwd 的 recent：热路径只枚举 sessionDir 的 `.jsonl`、按真实文件 mtime 排序，并有界读取首个 JSONL header；不会加载完整 Pi package。Pi 的真实文件 mtime 排序优先于 JSONL message 的 `modified` 字段：recent 可用时 launcher 固定为精确 `--session <path>`；仅该 exact recent 已处于 active 或 pending 时阻断。路径、JSONL header 的 session ID 与 header cwd 必须可验证；header cwd 不能验证为当前 canonical cwd 时，保守地不继续该 recent。

`pi -r` 在 picker 出现前创建全局 `selecting` reservation。它存在期间，其他 `-r`、`-c`、`--session` 和 `--session-id` reuse 请求都会被阻断；请启动普通 `pi`，然后在已有窗口中使用 `/resume`。`--session` 接受完整路径或唯一完整 ID；prefix 有歧义时 fail closed。`--session-id` 与 `--fork` 的可解析活动 source session 都会阻断，无法无歧义解析时 fail closed。`--no-session`、print、JSON、RPC 不登记 interactive owner。

## 运行期切换事务

`session_start` 通过 registry 的 `commitSwitchTarget` 在单个 guard 内完成校验与发布，不再使用 list→update：`startup` 沿用 launcher 的 pending/selecting/`--session-id`/`--fork` 可启动规则，`reload` 只做「source === target === 当前 record 身份且仍 active」的原子验证，`resume` 必须携带 before 阶段取得的 reservation nonce，`new`/`fork` 在 teardown 之后用真实新身份提交。

运行中的 `/resume` 是受控事务，不再是「只检查、不修改记录」的宽松路径：

1. `session_before_switch(reason=resume, targetSessionFile)` 先按 SDK 的路径规则解算目标（展开 `~`、解码 `file://`、相对路径按真实 `process.cwd()` 解算），再用公开的有界 header reader（16KiB 预算、首个 LF 截止）验证目标是既存 regular file，且首行是 `type:"session"` 且带非空 `id` 与可 canonicalize 为既存目录的 `cwd`。验证通过才调用 `reserveSwitchTarget`，在同一条 record 上保留原 source、追加 target `pendingSessionFile` 与 `phase:"reserved"` receipt。这一步发生在 `SessionManager.open` 与旧 session teardown 之前。
2. 目标身份不可验证（不存在、空文件、非法 JSON、缺 `id`/`cwd`、首行达到 16KiB 上限仍无 LF、header cwd 无法验证、读取或权限失败）一律显式 `{cancel:true}`，通知「无法验证目标会话身份」，不猜测 ID、不调用 `SessionManager.open` 探测、不读取会话正文，也不会误称被别的窗口占用。
3. 另一 owner 已占用目标或当前 source 时通知「另一个 Pi 窗口」；自身仍有未完成 pending 时通知「存在未完成的切换」。两类文案不混用。
4. `session_shutdown(reason=resume)` 只把 state 改为 `transitioning`，source、target pending 与 reservation 原样保留；若事件带 destination，只做规范化核对，不构成提前 claim。
5. 新 runtime 的 `session_start(reason=resume, previousSessionFile)` 从持久 record 重建 plain token（事件本身不携带 nonce），由 `commitSwitchTarget` 在同一 guard 内重新校验 nonce、source、target 与 `transitioning` 状态，然后原子地把顶层身份换成 target、清 pending、发布 `phase:"committed"` receipt。旧 source 的释放与 target 的生效只在这一次发布中同时发生。

`/new`、`/fork` 与 tree 操作没有前置目标身份：`session_before_switch(reason=new)` 与 `session_before_fork` 只核验当前 source 仍 active、身份三字段精确匹配、没有未完成的 pending、且没有其他 live record 占用当前 source，不做任何新目标 claim；真实新 ID 由 teardown 之后的 `session_start` 原子提交。

SDK 不公开切换结果 hook，因此更晚的 before handler 取消、`SessionManager.open` 失败、`createRuntime`/rebind/bindExtensions 失败都不会触发自动 rollback，也**不存在**旧 session 的自动恢复承诺：

- before 阶段已 reserve 但切换被更晚 handler 取消或 open 失败：record 保留 active source + pending target。恢复动作只有「重试同一目标（原路径/ID/cwd 仍可信）」或退出该 Pi 进程后从受控 launcher 重启。
- teardown 之后 create/bind 失败：record 保留 `transitioning` source + pending target，只能退出该进程后重启；不允许另一进程擅自删除仍存活 PID 的 record。
- `session_start` 提交被拒（含 cwdOverride 使真实 ctx 身份与保留 target 不一致）：不修改 record，通知具体原因并请求 `ctx.shutdown()`。`session_start` 返回 `{cancel:true}` 不是 SDK 支持的全局取消，不能当作已回滚。
- `abortSwitchTarget` 只供明确知道 teardown 尚未发生的调用方或隔离测试使用；没有任何事件路径会自动调用它，也不存在后台超时解锁。

## 受控范围与已知边界

- cwdOverride 不是 `session_before_switch` 的字段，无法在 before 阶段预验证。若某个合法 override 让新 ctx 的 cwd 与保留 target 的 cwd 不同，commit 会以 `target-mismatch` fail closed 并请求有序 shutdown，不会把 header cwd 改写成 source cwd 伪装成已验证。
- 外部 import（`importFromJsonl` 的输入不在 sessionDir 内）在 before 时点 destination 尚未创建，上游也没有公开输入路径、header 或可信身份，因此这条子路径记录为 `blocked-upstream`：显式取消、不读取未公开的 inputPath、不 copy/初始化/猜 ID；上游早先的 `mkdir sessionDir` 不保证回退。输入本身已经在 sessionDir 内时按普通 resume 处理。
- Pi 只在首条 user/assistant 消息时创建会话文件，因此 record 中的 `sessionFile` 可能是尚未落盘时的 resolve 形式；lifecycle 对同一物理路径接受 resolve 与 realpath 两种形式，其他路径一律拒绝。若会话目录本身位于符号链接之下（例如 macOS 的 `/tmp`、`/var`），registry 的严格三字段比较可能在文件落盘后与 record 中的既有值不同，此时按 fail closed 处理，需要退出后由受控 launcher 重新登记。
- 显示名称 rename 不改变 JSONL 文件 identity，因此不影响 owner。JSONL 文件的 rename、delete、replace、copy、hardlink、NFS 与跨机器共享不由本机制保护；guard 保护的是 registry，不是文件系统内容锁。
- subagent child 和 fanout child 使用独立 session，不登记 owner；dispatch/working trace 只能帮助诊断 subagent 状态，不能解决或恢复 session owner。

## 退出、异常与恢复

`/new`、`/resume`、`/fork` 与 import replacement 的 shutdown 会先把当前记录标记为 `transitioning`，随后由新的 `session_start` 提交；若 replacement 创建失败，记录保留为 `transitioning`，应退出该 Pi 进程后重新启动。reload 先失效旧 ctx（旧 extension runner 被 invalidate），但 owner 记录仍由本进程持有：reload 不释放记录、不清 pending、不改 source，同 ID 的重新绑定（新 runner、新 ctx，甚至另一个 manager 实例）复用同一条 record 并只做原子验证；而另一个进程以同 cwd + session ID 登记仍按冲突处理，不会因为 ID 相同就共享归属。`quit` 只释放当前进程自己的 record（ownerId + pid 双重匹配），绝不释放另一个 owner，即使 PID 相同。

异常退出后，下一次 registry scan 只会在 record PID 明确为 `ESRCH` 时清理；PID 仍存在、`EPERM`、record 畸形或身份不可判断均保守阻断，不做预防性兼容。共享 `.guard` 若陈旧或损坏仍须人工确认后恢复，系统不会自动删除它。

## 回归覆盖

真实 PTY 回归覆盖跨 wrapper 的 active recent、free recent 精确续接、picker selecting、`--no-extensions` 强制注入，以及 SIGKILL 后仅清理 ESRCH owner record。fresh install 回归还会在临时 HOME、ZDOTDIR、agentDir、sessionDir 与 registry 中 source 新生成的 `.zshrc`，经 wrapper 调用正式 Pi `--version`，并与运行时探测到的官方二进制版本比对（期望值不在本文硬编码）；该调用不使用模型或 session 网络。每个场景使用隔离 session 目录和 registry 状态、实际 JSONL fixture 或 Expect UI 输出作为就绪屏障；测试不以伪 Pi 或时间等待模拟这些竞争条件。
