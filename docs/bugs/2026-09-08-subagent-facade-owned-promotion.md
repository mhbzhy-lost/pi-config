# Facade started 与 Host owned run 合流误判

## 症状

R13 真实 sanitized Root Pi RPC 链在 `goal_init → status → dispatch → subagent` 中，Root model 按合约调用；约 27 秒内 `subagent` 返回：

```text
SUBAGENT_RPC_FAILED: Facade run identity conflicts
```

失败返回没有 `runId` 或 `asyncDir`。仅重跑一次，错误稳定；同一主会话也曾在该错误后延迟看到 spawn，证明这不是模型、status 或日志 proof 问题，而是 production 可达的 started/Host authority 竞态。

## 事件与 authority 顺序

1. RPC workflow leaf 同步发出 `subagent:async-started`，其 facade 事实包含 `runId`、`sessionId`、`asyncDir`、`pid` 和 canonical agent。
2. child-start collector 把该观察事实交给 Host；Host 以 deep-frozen Goal ticket/`RunAuthorization` 登记同一 binding。
3. 原 broker 将 Host authorization 再写成 facade，且把 Host `kind: "coding"` 当作 facade `kind`；started facade 的 `kind: "executor"` 因而被误认为 identity drift。

首个偏离是第 3 步：facade 分类字段并非共有 process identity，更不是 authority。错误发生在 Goal bind 之前，因此 tool reply 丢失 `runId`/`asyncDir`。

## 修复与边界

Root Broker 现在以单一 promotion transition 比对共同事实：`runId`、`asyncDir`、`sessionId`、`pid` 与 exact canonical agent/profile。匹配时仅 Host deep-frozen authorization 创建 owned record，并删除 facade 与任何 promotion 前 facade terminal 记录；后者不得被转换为 settlement proof。`kind` 不参与跨域 identity 比对。

反向顺序中，Host owned record 已存在时，exact started 事件只观察该唯一 owned record；不创建 facade duplicate。任一共有字段、已有 facade duplicate、或后续 owned started process identity 漂移保持 fail closed。facade/started 永不创建 grant、`root.subscribe`、`acceptance.submit` 或 Goal settlement authority；原生 started 缺失的 authority 字段只能由 Host authorization 提供。
