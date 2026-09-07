# Subagent workspace terminal proof adapter 投影缺失

## 现象与真实现场

真实 managed workspace `dc8d05e1-5f97-49e8-b301-3a04ec6ef27c` 当前仍为 `active`；关联 child `97e93d38-c01c-4917-b118-215a4cd98279` 的 process terminal 已被 Root Broker 观测为 `observed`。但是调用 `workspace_status` 时返回 `MANAGED_WORKSPACE_TERMINAL: terminal proof is invalid`，因此无法从 typed status 获得 clean terminal workspace 的 `discard` disposition。

本任务不 reload 当前 Root Host，也不处置该 workspace。修复加载后，仍需由主 agent 重新调用 typed `workspace_status`，核对 observed proof 与 action token，再通过 typed disposition 处置。

## Production 来源与调用链

该异常属于“预期 production 数据未被正确处理”，不是测试构造的不可达状态：

1. child 的合法 official terminal event 被 `RootBrokerServer.observeTerminal` 接收并绑定到已注册 facade run。
2. `RootBrokerServer.inspectFacadeTerminalProof(runId)` 返回 rich snapshot，精确形状为 `{runId,state,proofHash,proof,conflict}`。
3. package Host 入口 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` 创建 managed workspace service，并由其 `terminalProofProvider` 查询该 broker snapshot。
4. provider 当前把 rich snapshot 原样返回给 `packages/pi-subagents-enhanced/src/workspace/service.ts`。
5. workspace service 的 `proofValue` 只接受 exact keys `{state,conflict,proofHash}`，因此 rich snapshot 的额外 `runId` 与 `proof` 被正确拒绝，错误码为 `MANAGED_WORKSPACE_TERMINAL`。

首个偏离点是 package runtime 的 `terminalProofProvider` adapter 边界：broker rich facade snapshot 与 workspace strict proof codec 是两个不同契约，但入口没有执行投影。

## 精确 RED

使用真实 broker 可产生的等价 snapshot `{runId,state,proofHash,proof,conflict}`，证明旧 runtime adapter 会把 rich 对象交给 strict workspace codec 并导致 status 失败。不手工添加 broker 不会产生的字段，也不放宽 workspace service 的 exact-key validator。

覆盖以下边界：无 run、无 snapshot 或 pending snapshot 投影为 `{state:"pending"}`；合法 observed 与 conflict snapshot 只投影 `{state:"observed",conflict,proofHash}`；malformed observed 必须 fail closed，不能伪造合法 observed proof。

## 最小修复

在 package runtime 入口抽取小型纯 adapter，并让 production `terminalProofProvider` 调用它。保持 Root Broker rich snapshot、workspace strict codec、resolver、IR、Skill 与 TUI 不变。

## Reload 后处置

当前 workspace `dc8d05e1-5f97-49e8-b301-3a04ec6ef27c` 保持 active。主 agent 在 reload 修复后的 Host 后，应通过 typed `workspace_status` 重新读取 proof 和允许的 dispositions；确认 workspace clean 且 terminal observed 后，再使用该 status 签发的 action token 执行 typed disposition。不得绕过 workspace service 或直接运行 worktree mutation。
