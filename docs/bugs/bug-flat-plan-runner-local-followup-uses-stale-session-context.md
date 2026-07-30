# Bug：durable Plan Runner 本地 follow-up 使用 stale session context

## 1. 现象

Plan Runner 的 `agent_settled` 在可继续执行时仍本地调用
`pi.sendMessage({ customType: "pi-plan-follow-up-v1", ... }, { triggerTurn: true, deliverAs: "followUp" })`。
已保存的现场证据显示该 `pi-plan-follow-up-v1` 已写入；随后旧 generation 收到 exact
stale-context 原文：`Caller generation is stale`。同一现场已有 official terminal proof
`state:"observed"`，且 run 为 resumable，却只产生 1 个 generation，没有第二个 run。

## 2. 影响

session replacement 后，旧 Plan Runner 的本地 Pi context 已失效。本地 `triggerTurn` 既不能在
新 session 上继续协调，也不会向 Root durable broker 登记 wake intent，因而阻断本应由
official observed proof 驱动的 revival。Plan 停在可继续或需要 Gate 继续的中间状态，终态摘要
不应被借机扩大成本轮修复范围。

## 3. 复现

1. 以注入 `requestCallerFollowUp` 的 Root durable 模式启动 Plan Runner，并打开可继续的 Plan。
2. 令 runner settle，使 `agent_settled` 的 `canContinue` 分支写入 `pi-plan-follow-up-v1`。
3. 在 follow-up 被本地 Pi 消费前替换 session；保留该 run 的 official terminal proof
   `state:"observed"`，使其满足 resumable 条件。
4. 观察本地旧 context 报 `Caller generation is stale`；现场只有 generation 1，未出现第二个
   resumed run。

## 4. 根因

`agent_settled` 的 `canContinue` 分支及需要继续的 Gate 分支没有区分 durable capability。
即使 `requestCallerFollowUp` 可用，仍调用 local
`pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`。Root broker 在 replacement
后以新的 runId/generation 代表同一逻辑 caller；旧 Pi context 不再是该 caller 的有效 generation，
所以本地 follow-up 使用了 stale session context，而 broker 从未得到可触发 revival 的 wake。

## 5. 修复

在 durable 模式且注入 `requestCallerFollowUp` 时，`canContinue` 以及需要继续的 Gate 分支调用
`requestCallerFollowUp({ wakeId: "plan-opened", reason: "plan-opened" })`，不再 local send。
该 wake 由 Root broker 在同 generation 消费后移除，后续需要继续时可以重新登记并触发新的
generation。没有 `requestCallerFollowUp` capability 的 legacy 模式维持现有本地
`pi.sendMessage(...triggerTurn...)` 行为。terminal summary 路径不在本轮变更范围内。

## 6. 验证

- 独立 unit RED/GREEN：durable `canContinue` 只登记 wake、不调用 `sendMessage`；legacy 仍调用
  本地 send；需要继续的 Gate 同样走 durable wake。
- 真实 Harness：保留 `state:"observed"` official proof 后产生第二个 generation，且不存在
  stale-context 错误。
- 提交前执行 `git diff --check HEAD^ HEAD`、`git diff-tree --no-commit-id --name-only -r HEAD` 和
  `git diff --cached --quiet`；提交仅包含本缺陷文档。
