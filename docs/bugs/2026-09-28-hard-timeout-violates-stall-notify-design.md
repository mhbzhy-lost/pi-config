# 30 分钟硬超时违背生命周期计划的 stall-notify-decide 设计

## 状态

- 分类：产品决策变更（用户明确取消超时限制）
- 当前状态：已确认产品方向，待 TDD 实施移除
- 发现日期：2026-09-28
- 影响范围：所有 public coding dispatch 的执行超时
- 用户决策：直接取消超时限制，同时抛弃续租语义，不实现 stall-notify-decide 机制

## 摘要

用户审查后做出产品决策：subagent 不设执行超时。运行直到自然完成、主 Agent 显式 stop、或 Host 进程退出。原 30 分钟硬杀机制（`HOST_CODING_TIMEOUT_MS → runner timeoutRunner`）连同续租/stall 通知方案一并废弃。

## 修复范围

1. `codingWorkflowSpawnParams` 不再把 `ir.execution.timeoutMs` 传给 `buildWorkflowSpawn` 的顶层 `timeoutMs` 和 child 的 `timeoutMs`（两处都要删）。
2. `preparePublicCodingDispatch` 停止注入 `HOST_CODING_TIMEOUT_MS`——`execution.timeoutMs` 不再是必填字段。
3. child prompt 不再显示 `Timeout: xxx ms` 行。
4. 既有测试中断言 `leaf.timeoutMs === 30 * 60_000` 的地方需要同步更新。
5. `childStartTimeoutMs`（120s 启动超时）保留不变——它是独立的启动保护，不是执行超时。

## 当前调用链

```text
extension.ts:43  HOST_CODING_TIMEOUT_MS = 30 * 60_000
→ preparePublicCodingDispatch(input, { timeoutMs: HOST_CODING_TIMEOUT_MS })
→ ir.execution.timeoutMs = 1800000
→ codingWorkflowSpawnParams → buildWorkflowSpawn({ timeoutMs })
→ workflowScript: runs.run(key, { async: true, timeoutMs: 1800000 })
→ async-execution.ts:1263  deadlineAt = Date.now() + timeoutMs
→ runner config deadlineAt
→ subagent-runner.ts:3930  setTimeout(timeoutRunner, remainingMs)
→ 30 分钟后 timeoutRunner():
    标记所有步骤 failed
    timedOut = true
    timeoutAbortController.abort()
    timeoutNestedAsyncDescendants()    ← 杀嵌套
    timeoutActiveChildren()            ← 杀子进程
    （无通知主 Agent，无决策窗口）
```

## 计划规定的正确语义

`subagent-lifecycle-overall.md` 冻结的三层：

1. **heartbeat authority lease**（`heartbeatLeaseMs:60_000`, `heartbeatRenewMs:15_000`）：证明 Host authority 仍有效，持续续租
2. **progress stall detector**（`progressStallMs:1_200_000` = 20 分钟）：观察 progress 事件/时间，排除 active tool execution/合法等待后判定 stall → 进入 `stalled-suspected` → **仅通知主 Agent**
3. **主 Agent 决策**：收到 stalled 通知后，主 Agent 显式 `reply`/`steer`/`continue`（续签 `continueLeaseMs:600_000` = 10 分钟）/`stop`

> "heartbeat renew 不开新 turn、不 spawn、不代表 progress"
> "progress stall 不撤销 authority"
> "进入 stalled-suspected 后仅通知主 Agent，并继续 heartbeat renew"

## TDD 修复边界

### 修复方向

`HOST_CODING_TIMEOUT_MS` 的语义从"硬杀 deadline"改为"stall 检测周期"：

- **到期后不杀 run**：不标记 failed、不 abort、不杀子进程
- **到期后通知主 Agent**：向 root session 发送 attention/stalled 通知（复用现有 supervisor attention 通道或 custom message）
- **heartbeat 继续续租**：Host 活着就不断
- **主 Agent 可决策**：`continue`（续签新窗口）/ `steer` / `stop` / 不操作（默认超时后再提醒）
- **真正的硬停**只发生在 authority lease expiry（Host 崩溃后 child 自行退出）或主 Agent 显式 `stop`

### 实现边界

这是一个涉及 extension.ts（timeout 语义）、root-broker-server（通知通道）、subagent-runner（runner 侧超时消费）的跨模块变更。需要单独编写实现计划，不在此 bug 记录中展开。

### 验收

- 到期后 run 不被杀，状态变为 `stalled-suspected`
- 主 Agent 收到通知
- heartbeat lease 继续续租
- 主 Agent `continue` 后 run 恢复执行
- 主 Agent `stop` 后 run 正常终止
- Host 崩溃后 child 按 `expiresAt` 自行退出
