# 异步 Bash 工具

## 目的与入口

`bash_async` 在当前 Pi 进程内后台调用官方公开 `createBashToolDefinition().execute()`，立即返回接受回执；完成后通过 `pi.sendMessage(..., {deliverAs: 'followUp', triggerTurn: true})` 向当前会话投递一次 completion。

- Host 入口：`pi/extensions/bash-cwd.ts`。
- 异步实现：`src/bash-async/index.ts`、`controller.ts`、`contracts.ts`。
- cwd 公共入口：`src/bash-cwd/index.ts`；同步 `bash` 与异步任务复用相同 cwd/options 解析，不反向 import Host 入口。
- shell 安全门禁：`src/security-gates/extension.ts` 对 `bash`、`bash_async` 调同一策略。

无需新依赖、daemon、独立 Pi 子会话、MCP、scheduler 或 subagent 内部队列。此工具是执行层扩展，不是可搬迁的独立 skill。

## 使用场景

适合：测试套件、类型检查、产物构建、打包、含网络请求等不需立即消费结果的长耗时命令。启动后主会话应继续无写冲突的工作，不 sleep、不轮询等待。网络与业务操作仍须原任务授权，不因使用后台工具而扩大权限。

短查询、后续操作立即依赖输出、或必须在当前 tool call 内闭合的操作继续用同步 `bash`。长服务、daemon、`nohup` 和命令自行脱离进程组不属于有限后台 job 的支持范围。

输入与原 Bash 一致，另保留仓库的 `cwd` 参数：

```json
{"command":"npm test","cwd":"/明确工作目录","timeout":600}
```

`timeout` 单位为秒；缺省没有额外默认上限，与原生 Bash 一致。仅支持长生命周期 **TUI/RPC**；print/json 在准备执行前拒绝，原生 executor 零调用。异步工具为 `model-only`，不把已返回父工具的 nested-call 生命周期误用于后台工作。

## 接受与完成回执

launch 返回 `kind: bash-async-launch`、`jobId`、原始 `toolCallId`、session/generation/branchEpoch、命令、cwd 和接受时间。它不是 PID、spawn ACK 或命令成功证明。真正结果是 `bash-async-complete` custom message，不是第二条 `tool_result`。

完成消息的模型可见 content 是独立的关联元数据前缀 + 原生 content blocks；details 保留原生 content/details/structuredContent/isError 或原始异常 name/message。原生超时/取消异常中的累计输出保留，不从用户输出中的“timeout/aborted”等词猜失败类型。后台不调用已结束 launch 的 onUpdate。

| outcome | 依据 |
|---|---|
| succeeded | 原生成功返回 |
| failed | 原生 `isError` 或非零 exit code |
| timed-out | 受控 backend 实际抛 `timeout:<秒数>`，原生保持其错误文本 |
| aborted | job AbortSignal 已触发或 backend 实际 abort |
| spawn-error | backend 明确 ENOENT/EACCES/ENOEXEC |
| execution-error | 无法证明是上述类别的其他原生异常；不伪造 exitCode |

原生 stdout/stderr、2000 行/50KiB tail、超限完整临时输出路径、structured output 的 1MiB截断及标记均由官方实现处理。本 feature 不添加展示性截断、不变更同步 Bash outputSchema；async launch 不继承原生 terminal outputSchema/renderer。输出文件按原生生命周期保留，不自动删掉用户需要的日志。

命令和原生输出仍可能包含敏感信息，与同步 Bash 一样必须在调用前避免 credential-bearing 命令。工具不保证自动识别、脱敏任意 stdout；不得为“界面精简”改写原始结果。已有 shell gate 也不是通用凭据沙箱或全命令解析器。

## 队列与隔离边界

每个 job 仅一次 terminal transition、一次发送尝试、一个 completion 出口。Host 在 streaming 时负责 followUp，在 idle 时自动启动 turn；不存在 feature 的发送后 retry 或持久重放。

- 内存诊断快照最多保留64个终态；不是持久账本。
- details 中 `completionDelivery: attempted` 表示这条消息是一次发送尝试。controller 调用未抛异常后在本地记 `accepted`；`sendMessage` 返回 void，**不代表 Host 已消费、持久化或最终成功唤醒**。
- 同 session/runtime/branch 的 guard 通过才发送；已失效context或不明独立operation抑制为 `suppressed-*`；发送同步抛错记 `delivery-error`，不自动重发。
- Host `clear_queue` 可清除已经提交的 custom followUp，公开接口没有消费ACK；清除后允许零条被消费，不自动复活。
- 崩溃、退出、reload、分支切换及已排队消息的后续清除均没有 durable exactly-once 保证。不能撤回已交给Host的回执。
- 后台不等于隔离，同cwd并发构建/测试可能争用文件，调用者负责写路径和资源协调。

## 取消与生命周期

`/bash-async-cancel <jobId>` 取消本会话一个job，`/bash-async-cancel all` 取消本controller所有active jobs；等待原生Promise收束，不宣称撤销已发生副作用。

- launch所属AbortSignal会转给job；后续新turn的Esc不会天然取消全部旧job，使用显式取消命令。
- `session_shutdown`（quit/reload/new/resume/fork）：先关闭delivery/失效generation，再abort并等待原生清理。被拒的switch/fork不触发shutdown，不误取消。
- `session_before_tree`：保守失效branch并取消旧jobs，**即使其他handler之后拒绝tree也不恢复旧job**；不等待只有成功导航才有的session_tree，不让controller永久暂停。
- 独立compaction（无active turn signal）开始时保守取消；普通active run中的自动compaction由Host路由，不自动清理旧job。
- 裸 `AgentSession.dispose()` 本身不发session_shutdown；SDK宿主须执行runtime生命周期关闭。旧context失效后完成也不投递，但不能靠这个guard替代进程清理。
- timeout/cancel/teardown使用原生AbortSignal/进程树清理；用户自行setsid/nohup的逃逸进程、Windows taskkill的best effort不保证完全收回。

## 安全与验收

`bash_async` 的外层调用经过Host工具pipeline和现有shell gate；后台直接复用native definition，不伪装为detach nested tool。terminal custom message不经过任意第三方tool_result hook，不能声称异步终态与同步tool_result拥有完全相同的hook路径。

原生 commandPrefix/spawnHook 在gate后变换命令的既有边界未在此重写；不扩大子代理tool ceiling，不修改settings或自动安装新组件。

```bash
npm run typecheck:root
node --test test/bash-cwd-policy.test.mjs test/bash-cwd-extension.test.mjs test/security-gates-extension.test.mjs test/bash-async.test.mjs
node --test test/bash-async-runtime.integration.mjs
git diff --check
```

验收只使用临时cwd、in-memory settings/session/credential接口、合成provider与短本地shell。barrier证明native未完成时launch已返回且主会话可继续；真实Host证明busy/idle消费、单次completion、clearQueue允许丢弃、精确错误/输出、旧代取消与隔离。测试不调用真实provider、网络、scheduler或用户认证数据。
