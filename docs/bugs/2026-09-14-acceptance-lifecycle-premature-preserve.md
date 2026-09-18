# Acceptance lifecycle premature preserve（2026-09-14）

## 现场源码级归因（afDr4h）

本轮把“多次 integration attempt 很快耗尽 guard”的初步猜测与保留现场逐项核对后，定位到更具体的首因：**现场只有一次真正 enqueue，随后第一次 advance RPC 在 broker 参数校验阶段失败；preserve reason 的名字把它伪装成了 guard exhaustion。**

### 现场时间线与每次失败

1. `diagnostics/root-a/root-records.jsonl` 中出现 4 个 `agent_end`（记录 26/41/68/93），但它们属于 root Host 的多轮 agent 生命周期，不能等同于 4 次 child Auto Integration。child transcript 中最终 acceptance report 直到 `2026-09-14T14:42:43.313Z` 才输出。
2. child 在最终输出前的失败是业务/TDD 操作失败，而非 integration attempt：读取尚不存在的 `test/pipeline.test.mjs`、缺少 `package.json`、RED 测试断言失败、一次 edit 精确匹配失败、两次 commit message hook 拒绝、一次未暂存 commit。这些都在 child transcript 中有对应 tool result；随后 `553e249` 于 `14:42:22.985Z` 成功提交，worktree clean。
3. 最终 `agent_end` 进入 `createChildIntegrationLifecycle.advance()`。`prepareAutoIntegration()` 成功 enqueue；现场 queue item `164b1046-*.json` 的 `authorizedWorkspaceHead=553e249...`，但 `state=preserved, revision=1, admissionGeneration=0`，证明它没有经历 admission/rebase/prepared 的持久状态迁移，而是 enqueue 后直接 preserve。
4. enqueue 后 lifecycle 原来调用 `advanceAutoIntegration({ ...binding, continue: false })`。broker 协议 `coordinatorParams()` 对 `advance_auto_integration` 执行 `exactObject(input, ..., [])`，因此 `runId` 等额外字段在到达 coordinator 之前即被拒绝。用现场 runId 形状对同一 `parseBrokerRequest()` 路径复现得到确切错误：`BrokerProtocolError: params.input contains unknown field runId`。生产 `subagent-runtime.ts` 即使会忽略 advance input，也没有机会收到这个请求。这是该现场唯一实际 integration attempt 的具体错误。
5. lifecycle 的 `catch` 将此参数校验/RPC错误统一视为不可恢复，立刻调用 `preserveIntegrationDebt()` 并把内存 record 置 `terminal=true`。`integration-queue.ts#preserveByBinding()` 又把所有 preserve 固定写成 `preserveReason="integration-completion-guard-exhausted"`，所以该 reason 并不证明 conflict/no-progress budget 真的耗尽。现场 `preservedAt=14:42:44.306Z` 与最终 report 仅相隔约 1 秒，和这条同步失败链一致。
6. terminal record 使后续 `agent_end` 无法再推进；main 留在 base，terminal proof 只能保持 pending/debt，这是 preserve 的因果下游。

## 原缺陷触发链

非最终 `agent_end`（provider retry/error）同样会触发 `advance()`。此时 child 可能仍 dirty、尚未形成 clean committed HEAD，或者 broker/coordinator 暂时未就绪。旧逻辑把未识别异常统一转成 terminal preserve；同时 lifecycle 给空输入的 broker operation 注入了私有 binding，导致本应正常的最终 advance 也被协议拒绝。两类失败都不是 conflict digest 无进展，却会永久阻断后续 agent_end。

## 本轮修复

1. lifecycle 调用 wire-level `advanceAutoIntegration({})`，不再把 Host binding 或 continuation flag 注入 broker 的空参数 operation。
2. conflict continuation 改由 coordinator 根据 durable queue item 的 `state === "resolving-conflict"` 推导；模型和 child wire 均不持有该可信控制位。
3. `BROKER_DISCONNECTED`、`BROKER_TIMEOUT`、`GRANT_NOT_READY`、暂时性 coordinator transport/Host not-ready，以及 workspace clean-commit admission race 被分类为 retryable：不 preserve、不置 terminal，也不消耗 conflict guard；后续 `agent_end` 可继续。
4. `not-ready`/dirty/queued/admitted/rebasing/prepared 仍保持 lifecycle live。完成时清除待执行 retry timer，避免完成后的空转回调。
5. terminal no-progress guard 只在 resolving conflict 返回**相同 conflict digest**（或 coordinator 明确 `noProgress=true`）时耗尽。digest 变化代表真实进展，不再因固定 continuation 次数被 preserve。
6. 明确不可恢复的 binding/identity 等失败仍 fail closed，并只 preserve 一次；session shutdown 仍保留未完成 debt。

## TDD 覆盖

新增/更新用例先证明 RED，再修到 GREEN：

- 中间 `BROKER_DISCONNECTED` 的 `agent_end` 不 preserve；后续 `agent_end` 使用空 advance input 并完成 integration。
- workspace `not-ready` 不消耗 terminal guard，后续 `agent_end` 可完成。
- 不变 conflict digest 才 preserve；连续变化 digest 不因次数耗尽。
- 原有不可重试错误、reload 去重、conflict follow-up、recovery restart 语义继续覆盖。

## 既有接线缺口（前序已修）

1. `connectRuntimeCoordinator` 已把 `recoveryEventSink` 接到 coordinator server。
2. broker 已声明并消费 `recovery.event` / `recovery-event.v1` push。
3. Acceptance RPC harness 已自动应答 UI request，并在 diagnostics 保留 `method` 字段。

本轮未运行真实 LLM probe；真实链路复验由独立验收执行。

## R8 归因补录（session_shutdown 竞态）

R8 的关键竞态不是集成失败，而是 `session_shutdown` 在首次 enqueue 后、admission 尚未完成时无条件调用 `preserveIntegrationDebt(resolveBinding())`。该路径发生了 **零次真正的 admission/rebase/publish 尝试**，却将 queued item 终止为 `preserved`，使后续 `agent_end` 或 coordinator daemon 无法继续 durable 状态机。固定的 `integration-completion-guard-exhausted` 标签进一步误导诊断：它描述了 preserve 的既有标签，并不能证明 conflict/no-progress guard 真的耗尽。

修复后 shutdown 先读取 coordinator 的 durable queue state；`queued`、`admission-pending`、`admitted`、`rebasing`、`resolving-conflict`、`prepared` 均保留为可继续状态，不再把 shutdown 当作 disposition。仅对明确终态/不可恢复状态生成 recovery debt；coordinator transport 不可用时执行一次有界的显式 debt 尝试，不无限等待或静默丢弃意图。
