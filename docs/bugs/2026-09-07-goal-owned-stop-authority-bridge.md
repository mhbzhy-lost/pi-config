# Goal owned-stop authority bridge 断点

## 现象

production public suspension 会经 `production-runtime-host.ts` 的 `stopOwnedRun` 调用 registry 的 `stopRootBrokerGoalOwnedRun`，再到 `RootBrokerServer.stopGoalOwnedRun` 与其 `validGoalOwnedAuthority` 校验。Host 的 public stop 合同是严格 13 字段：`goalId/taskId/attempt/runId/asyncDir/workspacePath/leaseId/sessionId/baseHead/headAtDispatch/executionRevision/contractHash/agent`。

此前 `suspension.ts` 的 `deriveOwnedRunStopRequest` 仍把 `expectedCriteria` 和 `agentProfile` 放进请求，且 Broker 的 `validGoalOwnedAuthority` 也要求这两个 caller 字段。因此第一个偏离点是 Host 的 exact 13-field gate：合法 runtime 的请求会在任何 stop 副作用前被拒绝；绕开 Host 时又会在 Broker 的 15-field validator 被拒绝。这是 production 可达路径，而不是仅测试 facade。

## RED 证据

`node --test test/root-subagent-broker-r10b-suspension.integration.mjs`（修复前）显示：Store-derived request 实际含 `expectedCriteria/agentProfile`，与预期 13 字段不相等；将合法 13 字段请求直接交给 Broker 则报 `Goal owned stop identity mismatch`，且未调用 upstream stop。

## 根因与修复边界

`expectedCriteria` 和 `agentProfile` 属于已注册、deep-frozen `RunAuthorization` 及 coordinator 持久化的 immutable Goal binding authority，不是 public caller authority。Broker 应只接受 Host 的精确 13 字段 identity，然后从自身已注册 authorization 和安全的 Goal binding sidecar 读取并交叉核对这两个字段；任何 run/session/goal/task/attempt/contract/workspace/lease/head/executionRevision 不一致、未注册、facade-only 或 conflict 都 fail closed，且不停止进程。不得从 caller、started event、status、日志或 sidecar 缺失字段推断，也不得按 agent 名称授权。
