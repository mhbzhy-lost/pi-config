# `preserve_integration_debt` 的 reason 字段被 Root Broker 协议拒绝

## 状态

- 分类：预期 production 数据未被正确处理
- 当前状态：已完成源码归因，待 TDD RED/GREEN
- 发现日期：2026-09-28
- 影响范围：managed coding worktree 的 preserve/recovery 路径
- 当前未执行 live mutation、未修改 production、未运行真实 Pi

## 摘要

managed worktree 的 child integration lifecycle 在需要 preserve 时，会通过 Root Broker 调用 `preserve_integration_debt` 并携带合法的 `reason`。Root Broker 的 `coordinatorParams()` 没有为该 operation 声明参数分支，落入要求空对象的默认分支，因此在请求到达 coordinator 前以 unknown field 拒绝 `reason`。

上层 preserve 路径会吞掉该异常，可能造成本地 lifecycle 已停止，但 durable queue/workspace 仍停留在 active 或 queued，破坏 preserve/recovery 的终态收敛。

## 生产调用链与首个偏离点

```text
合法 execution.worktree=true coding dispatch
  -> child-extensions/integration-queue.ts
  -> coordinator.preserveIntegrationDebt(binding, reason)
  -> Root Broker client coordinatorRequest(
       "preserve_integration_debt", { reason }
     )
  -> root-broker-protocol.ts coordinatorParams()
  -> exactObject(input, "params.input", [])  # 首个偏离点
  -> unknown field reason
```

具体入口：

1. `packages/pi-subagents-enhanced/child-extensions/integration-queue.ts`
   - broker-backed coordinator 将 `preserveIntegrationDebt` 映射为 `preserve_integration_debt`。
   - preserve 调用发送 `{ reason }`。
   - legacy completion guard 的 preserve 也会发送 `{ reason }`。
2. `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
   - `coordinatorParams()` 对 `preserve_integration_debt` 没有专用分支。
   - 该 operation 落入 `exactObject(input, "params.input", [])`。
3. `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
   - 存在合法的 `preserveIntegrationDebt(binding, reason)` 接收路径，但当前请求在 Root Broker protocol 层即被拒绝，无法到达此处。
4. `packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts`
   - preserve 对 coordinator 异常执行 catch；异常不会向上形成持久化 preserve 结果。

## 身份、事件与资源顺序

- 入口：真实 managed coding child 的 `agent_end`、activation-gate failure 或 shutdown/recovery 分支。
- 权威身份：Root Broker grant、trusted child run binding、workspace lease、queue item owner scope。
- 合法资源事实：workspace 已由 Host 分配并绑定到 child run，queue item 可由 coordinator 根据 binding 定位。
- 事件顺序：child lifecycle 决定 preserve → Root Broker protocol 校验 request → coordinator preserve 应持久化 queue/workspace 状态。
- 首个偏离点：protocol validator 的 input shape 比 production caller 和 coordinator server contract 更严格，拒绝自身 production 生成的 `reason` 字段。

这不是手工拼接 projection、绕过 public 入口、非法时间顺序或缺字段 fixture；属于合法 production caller 产生的数据未被公共 typed protocol 正确处理。

## 可观察影响

当 Root Broker-backed preserve 请求携带 `reason` 时：

- coordinator server 的 preserve handler 不会被调用；
- `child-integration-lifecycle.ts` 的本地 lifecycle 可被标记为 terminal；
- durable queue/workspace 可能继续保持 active/queued；
- 失败原因可能只存在于被吞掉的异常中，不能把本地 terminal 状态当作 durable preserve proof。

当前尚未运行真实 Pi 来量化现场影响，也没有修改 live workspace、queue 或 proof outbox。

## TDD 修复边界

### RED

在 `test/root-subagent-broker-protocol.test.mjs` 增加一个最小断言：

```js
parseBrokerRequest({
  method: "coordinator.request",
  params: {
    operation: "preserve_integration_debt",
    input: { reason: "rpc-rejected" },
  },
});
```

在当前源码下，断言应以 `BrokerProtocolError` 失败，且失败原因对应 unknown field `reason`。必须确认这是具体断言失败，不接受 module-not-found、TypeError 或 typecheck 失败作为 RED。

### GREEN

只在 `root-broker-protocol.ts` 为 `preserve_integration_debt` 增加与 production caller/server 一致的参数分支，允许并校验 `reason`；不增加 fallback、宽松未知字段、重试探针或吞错兼容。

随后补充最小 coordinator-level assertion，证明 request 能穿过 Root Broker protocol 并到达 preserve handler；不触碰 live state。

### 验收

- focused protocol test：RED 后 GREEN；
- 相关 Root Broker/coordinator focused suite；
- `npm run typecheck:subagents-enhanced`；
- `git diff --check`；
- protected path 基线无命中后才允许 coding 节点修改；
- 不运行 attention lane，不连接旧 host，不读取或修改 `var/workspaces`。

## 当前阻塞

代码节点开工前的仓库 protected-path 检查命中预存的 `pi/settings.json` dirty。根据 `pi/AGENTS.md`，在该门禁未解除或用户明确给出处理决定前，不修改 production/test；不得读取其内容、回滚、覆盖、stash、reset 或 clean。

另：`PI_REAL_BIN` 当前未设置，因此真实 `worktree:true` Host E2E 只能在环境可用后执行，不能伪造通过。
