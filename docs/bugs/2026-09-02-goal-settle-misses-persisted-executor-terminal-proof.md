# Goal settle 漏读已持久化 Executor 终态证明

## 现象与数据来源

生产 `goal_dispatch` 创建 typed subagent 后得到 runId `767c74f3-f6de-43d3-9848-b3c42f4ae615`；Root Broker 已保存该 Executor binding。该 run 的官方异步目录中 `status.json` 为 `complete`，`process-terminal.json` 为 `observed`，runner `exitCode=0`，实际模型是 `openai-codex/gpt-5.6-terra:medium`。但 `goal_status` 已正确发出 `goal_settle` machineAction，连续两次 settle 仍返回 `EXECUTOR_TERMINAL_PROOF_MISSING`。

数据的权威顺序是：Goal ledger 中的不可变 `task.executor_bound`（runId、asyncDir、任务/尝试/合同身份）绑定到 Root Broker 的已登记 Executor ownership；该 ownership 绑定的异步目录里的官方 `process-terminal.json` 是终态事实。`status.json` 只用于确认运行时目录/身份一致性，**不是** terminal proof；日志文本、调用方传入 evidence、模型自报结果也绝不能升级为终态证明。

## 入口、顺序与首个偏离点

实际入口是 public `goal_dispatch` → typed `subagent` coding spawn → `subagent:async-started` → RootBrokerServer `observeStarted`/Goal binding authority 持久化 → 异步 runner 写 `status.json` 与 `process-terminal.json` → `goal_status` → `goal_settle` → Goal Engine `inspectExecutorProofFn` → registry → `RootBrokerServer.inspectExecutorProof`。

资源与事件的正常顺序是：先分配并租赁 Executor workspace，再取得 spawn/runId 和 asyncDir，随后持久化 Store 派生的 binding authority；runner 结束后先写官方 terminal sidecar，Extension ctx 仍有效时才可能投递 process-terminal 内存事件。旧 Extension ctx 已失效时该事件允许被吞掉，因而 sidecar 是正常生产产物，不是异常 fallback。

首个偏离点在 `inspectExecutorProof`：它同步只读 `terminalProofs` 内存 Map。`pollTerminalArtifact` 已能读取并严格校验落盘证明，却只被 stop/drain 调用。因此内存事件丢失后，settle 没有走到官方 sidecar，即使绑定、status 和 observed terminal 都完整，仍被错误分类为 missing。

## 修复门禁与 production 可达性

修复保留同步快照 API 兼容性，新增明确异步恢复边界给 `goal_settle` 使用。恢复只针对已登记、已绑定的 Executor run 的 asyncDir：该目录和 broker ownership 已严格锚定 runId/sessionId/asyncDir/agent/pid；原生 `process-terminal.json` 本身只含 runId 与终态字段，不能虚构其没有的 session/path/agent/pid。恢复读取安全的官方 sidecar，严格核对其中 runId、通过 `parseProcessTerminal`，且仅接受 `state=observed`；冲突仍标记冲突。缺失、格式错误、非 observed、身份冲突或不匹配一律 fail closed，继续得到现有拒绝结果。不会从普通 status、日志或 caller evidence 构造 proof。

这条路径 production 可达：真实异步 runner 的 terminal event 依赖可失效 Extension ctx，而 sidecar 是 runner 正常落盘；同时 `goal_settle` handler 已 await 其 proof reader，故异步协调边界不会改变 tool schema 或调用时序。

## Unified workspace settlement attempt 丢失

远端迁移到统一 managed workspace 后，另一个 production 可达偏离由现有集成测试正确 RED 捕获：public `goal_init` → `goal_status` action offer → `goal_dispatch` → typed subagent → `workspaceService.ensureAllocated` → `task.workspace_allocated` → `goal_settle` 全部经合法入口完成，权威 workspace 是 `publicManagedWorkspaceReceipt` 校验后的 `managed-workspace.v1` receipt。其 attempt 位于不可变 owner 身份 `workspace.owner.attempt`；Extension 又从 `workspaceService.status()` 返回的同一权威 receipt 读取 `snapshot.receipt.owner.attempt`，并将其作为 `task.settled.data.attempt=1`。

首个偏离点在 `src/goal-engine/events.ts` 的 `taskSettled`：它已经验证 `data.attempt` 为正整数、调用 `requireWorkspace(task, data.attempt)` 核对当前 workspace 身份，却在持久化 settlement 时改读 legacy `workspace.attempt`。统一 receipt 不包含该顶层字段，因而正常生成的 settlement 被写成 `attempt: undefined`。这不是手工 projection、非法顺序或过期字段 mock；测试使用真实 typed workspace service 创建 receipt、真实 Store event 顺序和合法 Executor settlement evidence，分类为“预期 production 数据未被正确处理”。RED 表现为期望 settlement attempt `1`、实际为 `undefined`。最小修复只持久化已经通过 reducer 校验的 `data.attempt`，不新增兼容分支或 fallback。
