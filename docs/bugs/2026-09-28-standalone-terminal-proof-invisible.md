# Root Broker 终态证明对 standalone run 永远不可见

## 状态

- 分类：预期 production 数据未被正确处理
- 当前状态：已完成根因定位，待 TDD RED/GREEN
- 发现日期：2026-09-28（真实 `worktree:true` Host E2E 首个偏离点）
- 影响范围：所有 standalone coding/generic managed worktree child 的终态证明、workspace release、proof 链
- 关联历史：大量历史 proof debt 的 `terminal-unobserved`、旧 A4 managed worktree 长期阻塞

## 摘要

`RootBrokerServer.executorProofSnapshot()` 用 `run.authorization.goal` 作为 terminal proof 可见性的门禁。standalone（非 Goal）coding/generic dispatch 的 `authorization.goal` 永远为 `null`，因此 `inspectExecutionProof()` 对 standalone run 返回的 `terminal` 永远为 `null`——即使 broker 已接受 `subagent:process-terminal` 事件并将 proof 存入 `terminalProofs`。

下游 `projectManagedWorkspaceTerminalProof()` 看到 `snapshot.terminal === null` 就返回 `{state: "pending"}`，导致 workspace 永远带 `terminal-unobserved` 阻塞原因，无法进入 discard/release 处置。

## 证据链（真实 Host E2E 诊断）

真实 `PI_REAL_BIN=/opt/homebrew/bin/pi`（0.85.1）Host 上的 `worktree:true` coding child：

```text
1. child 完成（complete / success: true）
2. process-terminal.json 写入 asyncDir，state: observed，runId 匹配
3. subagent:process-terminal 事件在 Host 事件总线上发射（时间戳在 async-complete 之前）
4. broker 的 observeTerminal 接收事件；acceptTerminalProof 的身份校验全部通过
   （事件不含 sessionId/pid/asyncDir/agent，undefined 跳过；runId 匹配；
    parseProcessTerminal 通过；state === "observed"）
5. 但 inspectExecutionProof 返回 terminal: null
```

首个偏离点在 `executorProofSnapshot`：

```ts
const authorized = run.identityState === "verified" && !!run.authorization.goal;
// standalone: authorization.goal === null → authorized === false
const proof = authorized && !this.terminalConflicts.has(run.runId)
  ? this.terminalProofs.get(run.runId) ?? null
  : null;  // ← 永远 null
```

## 身份、事件与资源顺序

- 入口：public coding dispatch `execution.worktree=true`（合法 production 入口）。
- 权威身份：Root Broker owned run（runId/asyncDir/sessionId/pid/agentProfile 绑定完整）、workspace ledger v2 绑定。
- 合法事件顺序：child 进程退出 → runner close → finalizeProcessTerminal 写 artifact → Host 事件总线发射 process-terminal → broker observeTerminal → acceptTerminalProof → terminalProofs.set。
- 首个偏离点：executorProofSnapshot 把 Goal settlement 的授权语义错误地复用为 terminal proof 可见性门禁。

这不是 fixture 拼装或绕过 public 入口；事件确实到达且被接受，但查询投影层错误地隐藏了它。

## 可观察影响

- 所有 standalone managed worktree child 的 `subagent_worktree status` 永远带 `terminal-unobserved`。
- `discard`/`release` 处置被阻塞（`observed(proof)` 为 false）。
- 历史 529 条 proof debt 中大量 `terminal-unobserved` 的直接根因。
- 真实 `worktree:true` E2E 无法完成 proof→release 链。

## TDD 修复边界

### RED

在 `test/root-subagent-broker.test.mjs` 增加：非 Goal owned run 注册后 observeTerminal 一个合法 observed proof，`inspectExecutionProof` 的 `terminal` 应非 null。当前实现返回 null → 断言失败。

### GREEN

`executorProofSnapshot` 中 terminal proof 可见性与 Goal 授权分离：

```ts
// 修复前：
const proof = authorized && !this.terminalConflicts.has(run.runId)
  ? this.terminalProofs.get(run.runId) ?? null : null;

// 修复后：terminal 观察是进程事实，不以 Goal 授权为前提
const proof = !this.terminalConflicts.has(run.runId)
  ? this.terminalProofs.get(run.runId) ?? null : null;
```

`authorization.state` 字段继续独立报告 Goal 验证状态，不受影响。Goal settlement 语义（`inspectExecutionProofForSettlement` 的 artifact 读取）不变。

### 验收

- RED 后 GREEN；Root Broker focused suite 回归。
- 真实 `worktree:true` Host E2E 的 proof/release 断言通过。
- typecheck、diff-check、无 staged。
