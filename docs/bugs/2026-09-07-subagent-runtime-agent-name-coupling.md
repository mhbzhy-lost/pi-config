# Subagent runtime 中的 agent 名称授权耦合

## 问题

当前 production runtime 将 `executor` 同时当作可编辑的 agent profile 名称和 privileged coding/Goal authority 的判定依据。前者是 discovery 与展示身份，后者必须来自可信 Host 的调用结构和已验证的 Goal ticket。只改名或在 frontmatter 中新增字段都不能构成授权。

## 已确认的授权调用链

1. typed 调用在 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` 的 `CODING_SCHEMA.agent` 固定为 `executor`，所以 `dispatch-ir.v1` 的 coding 结构被名称限制。
2. 同一文件的 `GENERIC_SCHEMA.agent.not` 排除 `executor`，并由 `CODING_AGENTS` 相关分流将名称作为 generic/coding 控制流条件。
3. typed spawn 进入 Root Broker facade；`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts` 的 `startedFacts` 只接受 `event.agent === "executor"`，并给结果写入 `role: "executor"`。
4. `RootBrokerServer.observeStarted` 经 `ensureExecutorOwner` 从上述 started facts 建立 principal、写 grant，并使 child 可以订阅 root。这意味着仅一个异步 started event 的 profile 名称能够导致 privileged grant。
5. Goal dispatch 的 `src/goal-engine/dispatch.ts` 中 `compileTaskContract` 无条件生成 `agent: "executor"`；`src/goal-engine/executor-binding.ts` 随后创建和核验 executor-only binding ticket。
6. Goal binding authority 由 `src/goal-engine/suspension.ts` 产生 `agent: "executor"`，Root Broker 侧 `validGoalOwnedAuthority` 再要求该字段等于 `executor`。完成时 `src/goal-engine/executor-binding.ts` 的 proof 校验要求 `schemaVersion: "root-broker.executor-proof.v1"` 与 `ownership.role === "executor"`。

该链路使 dispatch codec/schema、Root Broker started facts/grant、Goal dispatch/binding 以及 proof verification 都可由 production 中的具体名称决定授权或所有权。Task 1 只建立 Host-owned `RunAuthorization` 纯合同，后续任务才会逐段替换调用链。

## 非授权术语

以下现有 `executor` 出现不作为本问题的授权入口，也不应为了本任务进行命名重构：

- TUI、footer、compact rendering 和测试 fixture 中用于显示 agent 名称的文字。
- `executorHead` 等 workspace/Git 领域字段，表示执行 workspace 的 Git HEAD，不选择 agent 或授予 capability。
- legacy event/proof、历史 replay 以及兼容输入中的 `task.executor_bound`、`role: "executor"`；后续只允许在集中 legacy adapter 中读取和归一化，不能由新 writer 继续生成。

## 修复边界与回归条件

### T8 真实持久化 Host 发现的 identity 回归

数据来源是隔离 Pi 0.84.4 Host 的合法 public typed standalone 调用，不是手工拼接的事件：`subagent` → `executeCoding` → workflow `runs.run` → upstream `subagent:async-started` → `codingRunAuthorization`。模型可用性修正为 fixture 已注册的 `fake/deterministic` 后，首个偏离点是 `assertObservedLifecycleSession` 抛出 `RUN_AUTHORIZATION_SESSION_MISMATCH`。

`resolveRootSessionId` 返回 Host 逻辑 `getSessionId()`；upstream `resolveCurrentSessionId` 返回 `getSessionFile() ?? getSessionId()`。持久化会话的 lifecycle identity 是绝对 session-file 路径，与逻辑 root identity 不同且均合法。此前将两者强制相等、把 lifecycle identity 限制为 SAFE_ID，是预期 production 数据未被正确处理，不能通过 `--no-session` 或将测试路径改成逻辑 ID 掩盖。

修复要求保留 observed lifecycle 原值，并在独立 codec 中接受 safe logical ID 或无控制字符、规范化且有长度上限的绝对路径；授权与 terminal 继续 exact 核对 lifecycle。Root Broker 只将 binding.sessionId 与自身 lifecycleSessionId 核对；grant 路径和 workspace owner 仍使用独立 rootSessionId，不从 session 路径派生权限。回归覆盖真实持久化 Host、lifecycle drift、root authority drift，以及控制字符和相对伪路径拒绝。Goal 功能验证不在本次范围。

新合同的 `kind` 只能由可信 Host 的结构分支决定：`dispatch-ir.v1` 是 `coding`，generic 结构是 `generic`。`agentProfile` 仅是受校验的 binding identity，使用与后续 dispatch profile 相同的公开 profile domain：trim 后非空、不得包含 C0/C1 control character 或 NUL、最多 256 UTF-8 bytes；它不是 run/session/Goal path identity 的 160-character `SAFE_ID`，不以具体名称选择 capability。`createRunAuthorization` 拒绝调用者注入 capability，固定矩阵为 generic `[]`、standalone coding `["root.subscribe"]`、Goal coding `["acceptance.submit", "root.subscribe"]`，且 generic 携带任何 Goal authority 必须 fail closed。Goal authority 必须 exact，并包含 ticket、Goal/task/attempt、contract/workspace、revision 和 non-empty expected criteria 的全部绑定字段。
